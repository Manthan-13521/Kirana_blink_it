import assert from 'node:assert/strict'
import { createHmac,generateKeyPairSync,sign,verify } from 'node:crypto'
import { readFile,readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({resolve(specifier,context,next){
  if(context.parentURL?.includes('/worker/')&&specifier.startsWith('./')&&!specifier.endsWith('.ts'))return next(specifier+'.ts',context)
  return next(specifier,context)
}})
const { optimizeMatrix,roadTimes }=await import('../worker/routing.ts')
const { pushEndpoint,vapidHeader }=await import('../worker/push.ts')
const { validWebhook }=await import('../worker/razorpay.ts')

test('road ordering uses asymmetric driving times and only sends coordinates',async()=>{
  const locations=[[78.41,17.41],[78.43,17.45],[78.46,17.44]]
  const response=await roadTimes('fixture-token',locations,async(url,init)=>{
    assert.equal(new URL(url).origin,'https://api.geoapify.com')
    assert.equal(init.redirect,'error')
    const data=JSON.parse(init.body)
    assert.deepEqual(data.sources.map(x=>x.location),locations)
    const times=[[0,12,3],[5,0,4],[9,2,0]]
    return Response.json({sources_to_targets:times.map((row,i)=>row.map((time,j)=>({time,distance:700,from_index:i,to_index:j})))})
  })
  assert.deepEqual(optimizeMatrix(response),{indices:[2,1],seconds:5})
  await assert.rejects(roadTimes('fake',locations,async()=>Response.json({sources_to_targets:[]})),/incomplete matrix/)
  await assert.rejects(roadTimes('fake',locations,async()=>new Response(null,{status:429})),/unavailable/)
})

test('push destination allowlist and signed VAPID assertion keep user data out of pushes',async()=>{
  const allowed='https://fcm.googleapis.com/fcm/send/synthetic'
  assert.equal(pushEndpoint(allowed).href,allowed)
  for(const url of ['http://fcm.googleapis.com/fcm/send/a','https://fcm.googleapis.com.evil.test/fcm/send/a',
    'https://fcm.googleapis.com/private','https://push.apple.com.evil.test/path123456789','https://127.0.0.1/fcm/send/a',
    'https://fcm.googleapis.com:9000/fcm/send/a','https://name@fcm.googleapis.com/fcm/send/a']){
    assert.equal(pushEndpoint(url),null)
  }
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
  const privateKey=await crypto.subtle.importKey('jwk',keys.privateKey.export({format:'jwk'}),{name:'ECDSA',namedCurve:'P-256'},false,['sign'])
  const header=await vapidHeader(privateKey,'synthetic_key','https://fcm.googleapis.com','mailto:test@example.com',1800000000)
  const [content]=header.slice(8).split(',')
  const [claims,body,signature]=content.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),{
    aud:'https://fcm.googleapis.com',exp:1800000000,sub:'mailto:test@example.com',
  })
  assert.ok(verify('sha256',Buffer.from(claims+'.'+body),{key:keys.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')))
})

test('Razorpay signature applies to exact webhook bytes and rejects malformed signatures',async()=>{
  const secret='local-fixture-webhook-authentication'
  const body='{"event": "payment_link.paid"}'
  const sign=createHmac('sha256',secret).update(body).digest('hex')
  const raw=new TextEncoder()
  assert.equal(await validWebhook(raw.encode(body).buffer,sign,secret),true)
  assert.equal(await validWebhook(raw.encode(body+' ').buffer,sign,secret),false)
  assert.equal(await validWebhook(raw.encode(body).buffer,'invalid',secret),false)
})

test('Media validation rejects an oversized decoded image and accepts bounded fixture bytes',async()=>{
  const {validMedia}=await import('../worker/media-format.ts')
  const file=await readFile(new URL('../public/catalog/01.webp',import.meta.url))
  const bytes=new Uint8Array(file).buffer
  assert.equal(validMedia(bytes,'image/webp'),true)
  assert.equal(validMedia(bytes,'image/jpeg'),false)
  const changed=bytes.slice(0)
  new DataView(changed).setUint16(26,16000,true)
  assert.equal(validMedia(changed,'image/webp'),false)
})

test('optional-service quota refuses excess work and recovers on the next UTC day',async()=>{
  const {reserve}=await import('../worker/budget.ts')
  const sqlite=new DatabaseSync(':memory:')
  try{
    sqlite.exec(`CREATE TABLE service_budget(service TEXT PRIMARY KEY,day INTEGER NOT NULL,used INTEGER NOT NULL,last_at INTEGER NOT NULL);
      CREATE TABLE orders(id TEXT PRIMARY KEY,total INTEGER NOT NULL);
      INSERT INTO orders VALUES('committed-order',4200)`)
    const db={prepare:sql=>({bind:(...params)=>({first:async()=>sqlite.prepare(sql).get(...params)??null})})}
    assert.equal(await reserve(db,'routing',9,10),true)
    assert.equal(await reserve(db,'routing',2,10),false)
    assert.equal(await reserve(db,'routing',1,10),true)
    assert.equal(sqlite.prepare("SELECT used FROM service_budget WHERE service='routing'").get().used,10)
    sqlite.exec("UPDATE service_budget SET day=day-1 WHERE service='routing'")
    assert.equal(await reserve(db,'routing',9,10),true)
    assert.equal(sqlite.prepare("SELECT used FROM service_budget WHERE service='routing'").get().used,9)
    assert.equal(sqlite.prepare('SELECT total FROM orders').get().total,4200)
  }finally{sqlite.close()}
})

test('the D1 insert guard rejects an unavailable fulfillment method even with the current revision',async()=>{
  const sqlite=new DatabaseSync(':memory:')
  try{
    const migrations=new URL('../migrations/',import.meta.url)
    for(const file of (await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort()){
      sqlite.exec(await readFile(new URL(file,migrations),'utf8'))
    }
    sqlite.exec('UPDATE settings SET enable_delivery=0,revision=1 WHERE id=1')
    const insert=sqlite.prepare(`INSERT INTO orders
      (id,account_id,request_key,request_fingerprint,channel,fulfillment,status,payment_method,payment_status,
        subtotal,fees,total,tax,slot_start,slot_end,billing_json,created_at,updated_at,config_revision)
      VALUES (?,'demo-customer',?,'test','online',?,'placed','cash','cash_due',
        100,0,100,0,2000000000,2000003600,'{}',1750000000,1750000000,?)`)
    assert.throws(()=>insert.run('blocked','blocked','delivery',1),/fulfillment_unavailable/)
    assert.throws(()=>insert.run('stale','stale','pickup',0),/catalog_changed/)
    assert.equal(insert.run('allowed','allowed','pickup',1).changes,1)
    sqlite.exec('UPDATE settings SET enable_pickup=0,revision=2 WHERE id=1')
    assert.throws(()=>insert.run('closed','closed','pickup',2),/store_paused/)
    assert.equal(sqlite.prepare('SELECT count(*) count FROM orders').get().count,1)
  }finally{sqlite.close()}
})

async function integrationFixture(t){
  const sqlite=new DatabaseSync(':memory:')
  t.after(()=>sqlite.close())
  const directory=new URL('../migrations/',import.meta.url)
  for(const file of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()){
    sqlite.exec(await readFile(new URL(file,directory),'utf8'))
  }
  const bind=(sql,params)=>({
    first:async()=>sqlite.prepare(sql).get(...params)??null,
    run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...params).changes)}}),
  })
  const db={prepare:sql=>({...bind(sql,[]),bind:(...params)=>bind(sql,params)}),batch:async commands=>{
    sqlite.exec('BEGIN')
    try{
      const result=[]
      for(const command of commands)result.push(await command.run())
      sqlite.exec('COMMIT')
      return result
    }catch(error){sqlite.exec('ROLLBACK');throw error}
  }}
  return {sqlite,db}
}

test('Google ID tokens are bound to the configured client and one-time nonce',async()=>{
  const {verifyGoogleIdentity}=await import('../worker/google-auth.ts')
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048})
  const now=1800000000,nonce='state-for-this-browser',client='web-client'
  const claims={iss:'https://accounts.google.com',aud:client,sub:'stable-user-321',email:'owner@gmail.com',
    email_verified:true,nonce,iat:now-2,exp:now+300}
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
  const jwt=(changes={})=>{
    const payload=encode({alg:'RS256',kid:'test-key'})+'.'+encode({...claims,...changes})
    return payload+'.'+sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url')
  }
  const key=async kid=>kid==='test-key'?publicKey.export({format:'jwk'}):null
  assert.equal((await verifyGoogleIdentity(jwt(),client,nonce,key,now)).sub,claims.sub)
  for(const change of [{nonce:'different'},{aud:'unexpected'},{exp:now},{email_verified:false},{iss:'https://invalid.test'}]){
    await assert.rejects(verifyGoogleIdentity(jwt(change),client,nonce,key,now),/could not be verified/)
  }
  const unsigned=jwt().split('.')
  unsigned[1]=encode({...claims,email:'different@gmail.com'})
  await assert.rejects(verifyGoogleIdentity(unsigned.join('.'),client,nonce,key,now),/could not be verified/)
})

test('Google workspaces enforce email-bound team invitations, single rider and revocation',async t=>{
  const {resolveGoogleAccount}=await import('../worker/google-auth.ts')
  const {digest}=await import('../worker/shared.ts')
  const {sqlite,db}=await integrationFixture(t)
  const email='team@gmail.com',profile={sub:'stable-subject',email,email_verified:true}
  const env={DB:db,GOOGLE_OWNER_EMAILS:'approved@gmail.com'}
  const expires=Math.floor(Date.now()/1000)+900
  const invite=async (hash,role)=>sqlite.prepare('INSERT INTO invites(hash,role,expires_at,target_email_hash) VALUES(?,?,?,?)')
    .run(hash,role,expires,await digest(email))
  const shopper=await resolveGoogleAccount(env,profile,'shop',null)
  assert.equal(await resolveGoogleAccount(env,profile,'shop',null),shopper)
  await assert.rejects(resolveGoogleAccount(env,profile,'owner',null),/not authorized/)
  await assert.rejects(resolveGoogleAccount(env,{...profile,email:'approved@gmail.com.invalid'},'owner',null),/not authorized/)
  await invite('fixture-staff','staff')
  await assert.rejects(resolveGoogleAccount(env,{...profile,email:'different@gmail.com'},'owner','fixture-staff'),/different Google account/)
  const staff=await resolveGoogleAccount(env,profile,'owner','fixture-staff')
  assert.notEqual(staff,shopper)
  assert.equal(sqlite.prepare('SELECT role FROM accounts WHERE id=?').get(staff).role,'staff')
  await assert.rejects(resolveGoogleAccount(env,{...profile,sub:'other-subject'},'owner','fixture-staff'),/expired/)
  sqlite.prepare('UPDATE accounts SET active=0 WHERE id=?').run(staff)
  await assert.rejects(resolveGoogleAccount(env,profile,'owner',null),/not authorized/)
  await invite('replacement','staff')
  assert.notEqual(await resolveGoogleAccount(env,profile,'owner','replacement'),staff)
  await invite('fixture-rider','rider')
  await assert.rejects(resolveGoogleAccount(env,profile,'rider','fixture-rider'),/no longer available/)
  sqlite.exec("UPDATE accounts SET active=0 WHERE role='rider'")
  assert.ok(await resolveGoogleAccount(env,profile,'rider','fixture-rider'))
})

test('Razorpay only settles matching captures and atomically queues late or owner refunds',async t=>{
  const {applyOrderPaymentEvent,queueOrderRefund}=await import('../worker/checkout-payments.ts')
  const {sqlite,db}=await integrationFixture(t)
  const timely='11111111-1111-4111-8111-111111111111',late='22222222-2222-4222-8222-222222222222',time=1800000000
  for(const [id,link] of [[timely,'plink_timely123'],[late,'plink_late123']]){
    sqlite.prepare(`INSERT INTO orders(id,account_id,request_key,request_fingerprint,channel,fulfillment,status,payment_method,payment_status,
      subtotal,fees,total,tax,slot_start,slot_end,billing_json,created_at,updated_at)
      VALUES(?,'demo-customer',?,'test','online','pickup','awaiting_payment','online','unpaid',4300,0,4300,0,?,?, '{}',?,?)`)
      .run(id,id,time+900,time+3600,time-500,time-500)
    sqlite.prepare('INSERT INTO order_payment_links(order_id,link_id,expires_at) VALUES(?,?,?)').run(id,link,time+400)
  }
  const row=id=>sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id)
  const pending=id=>sqlite.prepare("SELECT COUNT(*) as n FROM order_provider_refunds WHERE order_id=? AND status<>'processed'").get(id).n
  const capture=(id,link,payment,amount)=>({event:'payment_link.paid',payload:{
    payment_link:{entity:{id:link,reference_id:id,amount,amount_paid:amount,currency:'INR'}},
    payment:{entity:{id:payment,amount,currency:'INR',status:'captured'}},
  }})
  await applyOrderPaymentEvent(db,capture(timely,'plink_timely123','pay_timely123',4200),time)
  assert.equal(row(timely).status,'awaiting_payment')
  await applyOrderPaymentEvent(db,capture(timely,'plink_timely123','pay_timely123',4300),time)
  await applyOrderPaymentEvent(db,capture(timely,'plink_timely123','pay_replay123',4300),time)
  assert.equal(row(timely).status,'placed')
  assert.equal(sqlite.prepare('SELECT payment_id FROM order_payment_links WHERE order_id=?').get(timely).payment_id,'pay_timely123')
  assert.equal(row(timely).stocked,1)
  await queueOrderRefund(db,row(timely),'demo-owner',{caseId:null,amount:4300,cancel:'cancelled',response:'Cancelled by owner'})
  assert.equal(pending(timely),1)
  assert.equal(row(timely).stocked,0)
  await assert.rejects(queueOrderRefund(db,row(timely),'demo-owner',{caseId:null,amount:4300,cancel:'cancelled'}),/changed/)
  const refund=(id,key,payment,amount)=>({event:'refund.processed',payload:{
    refund:{entity:{id,amount,payment_id:payment,notes:{kirana_refund:key}}},
  }})
  await applyOrderPaymentEvent(db,refund('rfnd_cancel123','cancel-'+timely,'pay_timely123',4200),time)
  assert.equal(row(timely).payment_status,'paid')
  await applyOrderPaymentEvent(db,refund('rfnd_cancel123','cancel-'+timely,'pay_timely123',4300),time)
  await applyOrderPaymentEvent(db,refund('rfnd_cancel123','cancel-'+timely,'pay_timely123',4300),time)
  assert.equal(row(timely).payment_status,'refunded')
  assert.equal(sqlite.prepare('SELECT COUNT(*) as n FROM refunds WHERE order_id=?').get(timely).n,1)
  await applyOrderPaymentEvent(db,capture(late,'plink_late123','pay_late123',4300),time+401)
  assert.equal(row(late).status,'cancelled')
  assert.equal(row(late).slot_retained,0)
  assert.equal(pending(late),1)
})
