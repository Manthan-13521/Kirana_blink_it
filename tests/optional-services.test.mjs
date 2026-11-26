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
const { distinctDestinations,nearbyStops,optimizeMatrix,roadTimes,routeCredits }=await import('../worker/routing.ts')
const { pushEndpoint,vapidHeader }=await import('../worker/push.ts')
const { validWebhook }=await import('../worker/razorpay.ts')

test('road ordering minimizes driving time and meters without requesting depot-return legs',async()=>{
  const locations=[[78.41,17.41],[78.43,17.45],[78.46,17.44]]
  const response=await roadTimes('fixture-token',locations,async(url,init)=>{
    assert.equal(url,'https://api.geoapify.com/v1/routematrix')
    assert.equal(init.headers['x-api-key'],'fixture-token')
    assert.equal(init.redirect,'manual')
    const data=JSON.parse(init.body)
    assert.deepEqual(data.sources.map(x=>x.location),locations)
    assert.deepEqual(data.targets.map(x=>x.location),locations.slice(1))
    const times=[[12,3],[0,4],[2,0]]
    const meters=[[900,700],[0,800],[300,0]]
    return Response.json({sources_to_targets:times.map((row,i)=>row.map((time,j)=>({time,distance:meters[i][j],from_index:i,to_index:j})))})
  })
  assert.deepEqual(optimizeMatrix(response),{indices:[2,1],seconds:5,meters:1000})
  const leg=(seconds,meters)=>({seconds,meters})
  const zero=leg(0,0)
  assert.deepEqual(optimizeMatrix([[zero,leg(1,8),leg(1,2)],[zero,zero,leg(1,1)],[zero,leg(1,1),zero]]),
    {indices:[2,1],seconds:2,meters:3})
  await assert.rejects(roadTimes('fake',locations,async()=>Response.json({sources_to_targets:[]})),/incomplete matrix/)
  await assert.rejects(roadTimes('fake',locations,async()=>new Response(null,{status:429})),/unavailable/)
  await assert.rejects(roadTimes('fake',locations,async()=>new Response(null,{status:302})),{code:'geoapify_http_302'})
})

test('nearby batches preserve the dispatch anchor and bill once per distinct destination',()=>{
  const first={id:'oldest',location:[78.42,17.41]}
  const far={id:'far',location:[78.50,17.41]}
  const nearby=Array.from({length:12},(_,i)=>({id:'near-'+i,location:[78.42+i/1000,17.41]}))
  const chosen=nearbyStops([first,far,...nearby])
  assert.equal(chosen.length,12)
  assert.equal(chosen[0],first)
  assert.ok(!chosen.includes(far))
  assert.equal(chosen.includes(nearby[11]),false)
  const unique=distinctDestinations(chosen)
  assert.deepEqual(unique[0].ids,['oldest','near-0'])
  assert.equal(unique.length,11)
  assert.deepEqual([2,5,12].map(routeCredits),[6,30,130])
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
    all:async()=>({results:sqlite.prepare(sql).all(...params)}),
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
  const {applyOrderPaymentEvent,applyRefundEvent,queueOrderRefund}=await import('../worker/checkout-payments.ts')
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
  await applyRefundEvent(db,'refund.processed',refund('rfnd_cancel123','cancel-'+timely,'pay_timely123',4200).payload.refund.entity,'test',time)
  assert.equal(row(timely).payment_status,'paid')
  await applyRefundEvent(db,'refund.processed',refund('rfnd_cancel123','cancel-'+timely,'pay_timely123',4300).payload.refund.entity,'test',time)
  await applyRefundEvent(db,'refund.processed',refund('rfnd_cancel123','cancel-'+timely,'pay_timely123',4300).payload.refund.entity,'test',time)
  assert.equal(row(timely).payment_status,'refunded')
  assert.equal(sqlite.prepare('SELECT COUNT(*) as n FROM refunds WHERE order_id=?').get(timely).n,1)
  await applyOrderPaymentEvent(db,capture(late,'plink_late123','pay_late123',4300),time+401)
  assert.equal(row(late).status,'cancelled')
  assert.equal(row(late).slot_retained,0)
  assert.equal(pending(late),1)
})

test('Standard Checkout flags require matching modes and explicit live collection approval',async()=>{
  const {paymentCredentials,checkoutCredentials,testCredentials}=await import('../worker/payment-provider.ts')
  const base={APP_MODE:'staging',RAZORPAY_KEY_SECRET:'fixture',RAZORPAY_WEBHOOK_SECRET:'fixture'}
  const live={...base,RAZORPAY_KEY_ID:'rzp_live_Fixture'}
  assert.equal(paymentCredentials(live),null)
  const optedIn={...live,RAZORPAY_MODE:'live'}
  assert.equal(paymentCredentials(optedIn).mode,'live')
  assert.equal(checkoutCredentials(optedIn),null)
  assert.equal(testCredentials({...optedIn,RAZORPAY_LIVE_CHECKOUT:'enabled'}),null)
  const collection={...optedIn,RAZORPAY_LIVE_CHECKOUT:'enabled'}
  assert.equal(checkoutCredentials(collection),null)
  assert.equal(checkoutCredentials({...collection,RAZORPAY_UPI_CONFIG_ID:'card_config'}),null)
  assert.equal(checkoutCredentials({...collection,RAZORPAY_UPI_CONFIG_ID:'config_UPIFixture'}).checkoutConfig,'config_UPIFixture')
  const {checkoutDisplay}=await import('../src/razorpay-checkout.ts')
  assert.deepEqual(checkoutDisplay('live').display.blocks.upi.instruments,[{method:'upi'}])
  assert.equal(checkoutDisplay('live').display.preferences.show_default_blocks,false)
  assert.equal(checkoutDisplay('test'),undefined)
  assert.equal(checkoutCredentials({...optedIn,APP_MODE:'local',RAZORPAY_LIVE_CHECKOUT:'enabled'}),null)
  assert.equal(checkoutCredentials({...base,RAZORPAY_KEY_ID:'rzp_test_Fixture'}).mode,'test')
})

test('Standard Checkout retries one provider order and accepts only matching captured payment',async t=>{
  const {Hono}=await import('hono')
  const {checkoutPayments}=await import('../worker/standard-checkout.ts')
  const {sqlite,db}=await integrationFixture(t)
  const orderId='33333333-3333-4333-8333-333333333333',providerId='order_fixture123',paymentId='pay_fixture123'
  const time=Math.floor(Date.now()/1000),secret='synthetic-checkout-secret'
  seedPending(sqlite,orderId,time)
  sqlite.exec('UPDATE settings SET enable_online=1')
  const app=new Hono()
  app.use('*',async(c,next)=>{
    c.set('account',{id:c.req.header('x-fixture-account')??'demo-customer',role:'customer',name:'Synthetic',phone:''})
    c.set('stagingCheckout',c.req.header('x-fixture-preview')==='yes')
    await next()
  })
  app.onError((error,c)=>c.json({error:error.message},error.status??500))
  app.route('/',checkoutPayments)
  const env={DB:db,APP_MODE:'staging',RAZORPAY_KEY_ID:'rzp_test_Fixture',RAZORPAY_KEY_SECRET:secret,RAZORPAY_WEBHOOK_SECRET:'synthetic-wh-secret'}
  const providerOrder={id:providerId,receipt:orderId,amount:4300,currency:'INR',status:'created'}
  let creates=0,retrieves=0,paymentStatus='authorized',recover=false,readAmount=4300
  const original=globalThis.fetch
  t.after(()=>{globalThis.fetch=original})
  globalThis.fetch=async (url,init)=>{
    const path=new URL(url)
    assert.equal(path.origin,'https://api.razorpay.com')
    assert.equal(init.redirect,'manual')
    if(path.pathname==='/v1/orders'&&init.method==='POST'){
      creates++
      assert.deepEqual(JSON.parse(init.body),{amount:4300,currency:'INR',receipt:orderId,partial_payment:false})
      return new Response(null,{status:503})
    }
    if(path.pathname==='/v1/orders'&&path.searchParams.get('receipt')===orderId){
      retrieves++
      assert.ok(recover)
      return Response.json({items:[providerOrder]})
    }
    assert.equal(path.pathname,'/v1/payments/'+paymentId)
    return Response.json({id:paymentId,order_id:providerId,amount:readAmount,currency:'INR',status:paymentStatus})
  }
  const post=(suffix='',body={},headers={'x-fixture-preview':'yes'})=>app.request('/orders/'+orderId+'/payment'+suffix,
    {method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)},env)
  assert.equal((await post('',{},{})).status,503)
  assert.equal((await post('',{}, {'x-fixture-preview':'yes','x-fixture-account':'another-account'})).status,404)
  sqlite.exec('UPDATE settings SET enable_pickup=0')
  assert.equal((await post()).status,409)
  assert.equal(creates,0)
  sqlite.exec('UPDATE settings SET enable_pickup=1')
  assert.equal((await post()).status,503)
  assert.equal((await post()).status,409)
  assert.equal(creates,1)
  assert.equal(retrieves,0)
  recover=true
  sqlite.exec('UPDATE order_checkout_payments SET next_create_at=0')
  const [challenge,repeat]=await Promise.all([post(),post()])
  assert.deepEqual([challenge.status,repeat.status].sort(),[200,409])
  assert.equal(creates,1)
  assert.equal(retrieves,1)
  assert.equal((await post()).status,200)
  const signature=createHmac('sha256',secret).update(providerId+'|'+paymentId).digest('hex')
  const proof={razorpay_order_id:providerId,razorpay_payment_id:paymentId,razorpay_signature:signature}
  assert.equal((await post('/verify',{...proof,razorpay_order_id:'order_other123'})).status,403)
  assert.equal((await post('/verify',{...proof,razorpay_signature:'0'.repeat(64)})).status,403)
  readAmount=4400
  assert.equal((await post('/verify',proof)).status,403)
  readAmount=4300
  assert.equal((await post('/verify',proof)).status,202)
  assert.equal(sqlite.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status,'awaiting_payment')
  paymentStatus='captured'
  assert.deepEqual(await (await post('/verify',proof)).json(),{state:'confirmed'})
  assert.deepEqual(await (await post('/verify',proof)).json(),{state:'confirmed'})
  assert.equal((await post('/cancel')).status,409)

  const liveId='77777777-7777-4777-8777-777777777777'
  seedPending(sqlite,liveId,time)
  const liveEnv={...env,RAZORPAY_MODE:'live',RAZORPAY_KEY_ID:'rzp_live_Fixture',RAZORPAY_LIVE_CHECKOUT:'enabled'}
  const conf='config_UPIFixture'
  let liveCalls=0
  globalThis.fetch=async (url,init)=>{
    liveCalls++
    assert.equal(new URL(url).pathname,'/v1/orders')
    const body=JSON.parse(init.body)
    assert.equal(body.checkout_config_id,conf)
    assert.equal(body.receipt,liveId)
    assert.equal(body.notes.kirana_checkout_config,conf)
    return Response.json({...providerOrder,id:'order_upiFixture',receipt:liveId,notes:body.notes})
  }
  const live=(vars)=>app.request('/orders/'+liveId+'/payment',{method:'POST',headers:{'x-fixture-preview':'yes'}},{...liveEnv,...vars})
  assert.equal((await live({})).status,503)
  assert.equal((await live({RAZORPAY_UPI_CONFIG_ID:conf})).status,200)
  assert.equal((await live({RAZORPAY_UPI_CONFIG_ID:'config_NextFixture'})).status,409)
  assert.equal(liveCalls,1)
})

function seedPending(db,id,time){
  db.exec("UPDATE products SET price=4300,mrp=4300 WHERE id='tomato'")
  db.prepare(`INSERT INTO orders(id,account_id,request_key,request_fingerprint,channel,fulfillment,status,payment_method,payment_status,
    subtotal,fees,total,tax,slot_start,slot_end,billing_json,created_at,updated_at,config_revision)
    VALUES(?,'demo-customer',?,'fixture','online','pickup','awaiting_payment','online','unpaid',4300,0,4300,0,?,?, '{}',?,?,(SELECT revision FROM settings WHERE id=1))`)
    .run(id,id,time+900,time+3600,time-500,time-500)
  db.prepare(`INSERT INTO order_items(order_id,product_id,sku,name,unit,step,quantity,price,line_total,tax,tax_bps,hsn)
    SELECT ?,id,sku,name,unit,step,step,price,price,0,tax_bps,hsn FROM products WHERE id='tomato'`).run(id)
}

test('live webhooks record retries, late captures and refund lifecycle without moving money',async t=>{
  const {applyStandardEvent}=await import('../worker/standard-checkout.ts')
  const {runPaymentMaintenance,queueOrderRefund}=await import('../worker/checkout-payments.ts')
  const {sqlite,db}=await integrationFixture(t)
  const credentials={mode:'live',key:'rzp_live_Fixture',secret:'fixture',webhook:'fixture'}
  const orderId='44444444-4444-4444-8444-444444444444',lateId='55555555-5555-4555-8555-555555555555',time=1800000000
  const initial=sqlite.prepare("SELECT stock FROM products WHERE id='tomato'").get().stock
  for(const [id,provider] of [[orderId,'order_active123'],[lateId,'order_late123']]){
    seedPending(sqlite,id,time)
    sqlite.prepare('INSERT INTO order_checkout_payments(order_id,provider_order_id,mode,expires_at) VALUES(?,?,?,?)')
      .run(id,provider,'live',time+400)
  }
  const row=id=>sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id)
  const intent=id=>sqlite.prepare('SELECT * FROM order_checkout_payments WHERE order_id=?').get(id)
  const payment=(event,id,provider,status)=>({event,payload:{
    payment:{entity:{id,order_id:provider,status,amount:4300,currency:'INR'}},order:{entity:{id:provider,status:'paid'}},
  }})
  const apply=(event,at=time,config=credentials)=>applyStandardEvent(db,event,config,at)
  const failed=payment('payment.failed','pay_retry123','order_active123','failed')
  await apply(failed);await apply(failed,time+1)
  assert.equal(intent(orderId).failed_at,time)
  assert.equal(row(orderId).status,'awaiting_payment')
  assert.equal(row(orderId).stocked,1)
  const paid=payment('order.paid','pay_active123','order_active123','captured')
  await apply(paid,time,{...credentials,mode:'test'})
  assert.equal(row(orderId).status,'awaiting_payment')
  await apply(paid);await apply({...paid,event:'payment.captured'})
  assert.equal(row(orderId).status,'placed')
  assert.equal(intent(orderId).payment_id,'pay_active123')
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id=? AND status=?').get(orderId,'placed').n,1)
  const late=payment('payment.captured','pay_late123','order_late123','captured')
  await apply(late,time+401);await apply(late,time+402)
  assert.equal(row(lateId).status,'cancelled')
  assert.equal(row(lateId).stocked,0)
  assert.equal(row(lateId).slot_retained,0)
  assert.equal(sqlite.prepare("SELECT stock FROM products WHERE id='tomato'").get().stock,initial-
    sqlite.prepare("SELECT step FROM products WHERE id='tomato'").get().step)
  const lateJob='late-'+lateId
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM order_provider_refunds WHERE id=?').get(lateJob).n,1)
  sqlite.exec(`UPDATE orders SET status='completed' WHERE id='${orderId}'`)
  const caseId='66666666-6666-4666-8666-666666666666'
  sqlite.prepare("INSERT INTO cases(id,order_id,kind,reason,created_at,updated_at) VALUES(?,?,'refund','fixture',?,?)").run(caseId,orderId,time,time)
  await queueOrderRefund(db,row(orderId),'demo-owner',{caseId,amount:1000})
  const original=globalThis.fetch
  t.after(()=>{globalThis.fetch=original})
  globalThis.fetch=async()=>{throw new Error('Live cron must not make a Razorpay request.')}
  await runPaymentMaintenance({DB:db,APP_MODE:'staging',RAZORPAY_MODE:'live',RAZORPAY_LIVE_REFUNDS:'enabled',
    RAZORPAY_KEY_ID:credentials.key,RAZORPAY_KEY_SECRET:credentials.secret,RAZORPAY_WEBHOOK_SECRET:credentials.webhook})
  assert.equal(sqlite.prepare('SELECT status FROM order_provider_refunds WHERE id=?').get(lateJob).status,'queued')
  const refund=(name,id,job,paymentId,amount)=>apply({event:name,payload:{refund:{entity:{
    id,payment_id:paymentId,amount,notes:{kirana_refund:job},
  }}}})
  const args=['rfnd_active123',caseId,'pay_active123',1000]
  await refund('refund.created',...args)
  await refund('refund.failed',...args)
  await refund('refund.created',...args)
  assert.equal(sqlite.prepare('SELECT failed_at FROM order_provider_refunds WHERE id=?').get(caseId).failed_at,time)
  await refund('refund.processed',...args)
  await refund('refund.failed',...args)
  assert.equal(row(orderId).payment_status,'paid')
  assert.equal(sqlite.prepare('SELECT SUM(amount) AS total FROM refunds WHERE order_id=?').get(orderId).total,1000)
  const lateArgs=['rfnd_late123',lateJob,'pay_late123',4300]
  await refund('refund.processed',...lateArgs)
  await refund('refund.processed',...lateArgs)
  assert.equal(row(lateId).payment_status,'refunded')
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM refunds WHERE order_id=?').get(lateId).n,1)

})

test('authenticated route suggestions reuse cached road plans and preserve manual fallback below the quota cap',async t=>{
  const {Hono}=await import('hono')
  const {routing,routingCreditCap}=await import('../worker/routing.ts')
  const {sqlite,db}=await integrationFixture(t)
  const time=Math.floor(Date.now()/1000)
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333']
  const coordinates=[[78.419,17.415],[78.419,17.415],[78.436,17.421]]
  for(const [index,id] of ids.entries()){
    seedPending(sqlite,id,time)
    sqlite.prepare("UPDATE orders SET status='ready',assigned_to='demo-rider',fulfillment='delivery',route_rank=?,address_json=? WHERE id=?")
      .run(index+1,JSON.stringify({longitude:coordinates[index][0],latitude:coordinates[index][1]}),id)
  }
  const original=globalThis.fetch
  t.after(()=>{globalThis.fetch=original})
  let calls=0
  globalThis.fetch=async (_url,{body})=>{
    calls++
    const points=JSON.parse(body)
    assert.equal(points.sources.length,3)
    assert.equal(points.targets.length,2)
    return Response.json({sources_to_targets:[
      [{time:91,distance:859},{time:512,distance:7344}],
      [{time:0,distance:0},{time:436,distance:6243}],
      [{time:241,distance:3397},{time:0,distance:0}],
    ]})
  }
  const app=new Hono()
  app.use('*',async(c,next)=>{c.set('account',{id:'demo-rider',role:'rider'});await next()})
  app.onError((err,c)=>c.json({error:err.message},err.status??500))
  app.route('/',routing)
  const request=(key='fixture-key')=>app.request('/rider/route/suggest',{method:'POST'},{DB:db,GEOAPIFY_KEY:key})
  const first=await request()
  assert.equal(first.status,200)
  assert.deepEqual(await first.json(),{ids,seconds:527,meters:7102,credits:6,provider:'Geoapify'})
  sqlite.prepare('UPDATE orders SET route_rank=8 WHERE id=?').run(ids[0])
  const cached=await request()
  assert.equal(cached.status,200)
  assert.deepEqual(await cached.json(),{ids:[ids[1],ids[0],ids[2]],seconds:527,meters:7102,credits:0,provider:'Geoapify'})
  assert.equal(sqlite.prepare("SELECT used FROM service_budget WHERE service='routing'").get().used,6)
  sqlite.prepare("UPDATE service_budget SET used=?,last_at=0 WHERE service='routing'").run(routingCreditCap)
  sqlite.exec('UPDATE routing_cache SET expires_at=0')
  const limited=await request()
  assert.equal(limited.status,429)
  assert.match((await limited.json()).error,/Arrange stops manually/)
  assert.equal(calls,1)
  const unconfigured=await request('')
  assert.equal(unconfigured.status,503)
  assert.match((await unconfigured.json()).error,/Arrange stops manually/)
})
