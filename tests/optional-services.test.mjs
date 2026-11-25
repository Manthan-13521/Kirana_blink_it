import assert from 'node:assert/strict'
import { createHmac,generateKeyPairSync,verify } from 'node:crypto'
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
