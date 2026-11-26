import { Hono } from 'hono'
import { all,json,now,Problem,role,S,statement } from './shared'
import type { Ctx,Env } from './shared'
import { reserve } from './budget'

export const push=new Hono<Env>()
export const pushDailyCap=1500
const encode=(value:Uint8Array)=>btoa(String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
const text=(value:object)=>encode(new TextEncoder().encode(JSON.stringify(value)))

export function pushEndpoint(raw:string){
  let url:URL
  try{url=new URL(raw)}catch{return null}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return null
  const host=url.hostname
  const allowed=host==='fcm.googleapis.com'&&/^\/(fcm\/send|wp)\//.test(url.pathname)||
    host==='updates.push.services.mozilla.com'&&/^\/wpush\/v[12]\//.test(url.pathname)||
    (host==='web.push.apple.com'||host.endsWith('.push.apple.com'))&&url.pathname.length>12
  return allowed?url:null
}

let signingKey:{raw:string;key:Promise<CryptoKey>}|undefined
function configuration(env:Env['Bindings']){
  const {VAPID_PUBLIC_KEY,VAPID_PRIVATE_JWK,VAPID_CONTACT}=env
  if(!VAPID_PUBLIC_KEY||!/^[A-Za-z0-9_-]{87}$/.test(VAPID_PUBLIC_KEY)||
    !VAPID_PRIVATE_JWK||!VAPID_CONTACT||!/^mailto:[^\s]+@[^\s]+$/.test(VAPID_CONTACT))return null
  return {publicKey:VAPID_PUBLIC_KEY,privateJwk:VAPID_PRIVATE_JWK,contact:VAPID_CONTACT}
}
export async function vapidHeader(key:CryptoKey,publicKey:string,audience:string,contact:string,expires:number){
  const input=text({typ:'JWT',alg:'ES256'})+'.'+text({aud:audience,exp:expires,sub:contact})
  const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(input)))
  return 'vapid t='+input+'.'+encode(signature)+', k='+publicKey
}

push.get('/notices/push',c=>{
  role(c,'customer')
  return c.json({publicKey:configuration(c.env)?.publicKey??null})
})
push.put('/notices/push',async c=>{
  const account=role(c,'customer'), data=await json(c)
  if(!configuration(c.env))throw new Problem(503,'Browser push is not configured.')
  const endpoint=pushEndpoint(S(data.endpoint,'push endpoint',2048))
  if(!endpoint)throw new Problem(400,'This browser push service is unsupported.')
  const db=c.env.DB
  await db.batch([
    statement(db,`INSERT INTO push_subscriptions(endpoint,account_id,created_at) VALUES(?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET account_id=excluded.account_id,created_at=excluded.created_at`,endpoint.href,account.id,now()),
    statement(db,`DELETE FROM push_subscriptions WHERE account_id=? AND endpoint<>? AND endpoint NOT IN
      (SELECT endpoint FROM push_subscriptions WHERE account_id=? AND endpoint<>? ORDER BY created_at DESC,endpoint LIMIT 1)`,
      account.id,endpoint.href,account.id,endpoint.href),
  ])
  return c.json({ok:true})
})
push.delete('/notices/push',async c=>{
  const account=role(c,'customer'), data=await json(c)
  const endpoint=pushEndpoint(S(data.endpoint,'push endpoint',2048))
  if(endpoint)await statement(c.env.DB,'DELETE FROM push_subscriptions WHERE endpoint=? AND account_id=?',endpoint.href,account.id).run()
  return c.json({ok:true})
})

async function sendPush(env:Env['Bindings'],accountId:string){
  const config=configuration(env)
  if(!config)return
  const subscriptions=await all<{endpoint:string}>(env.DB,'SELECT endpoint FROM push_subscriptions WHERE account_id=? ORDER BY created_at DESC LIMIT 2',accountId)
  if(!subscriptions.length||!await reserve(env.DB,'web-push',subscriptions.length,pushDailyCap))return
  if(signingKey?.raw!==config.privateJwk){
    signingKey={raw:config.privateJwk,key:crypto.subtle.importKey('jwk',JSON.parse(config.privateJwk),
      {name:'ECDSA',namedCurve:'P-256'},false,['sign'])}
  }
  const key=await signingKey.key,expiry=now()+6*3600
  await Promise.allSettled(subscriptions.map(async({endpoint})=>{
    const url=pushEndpoint(endpoint)
    if(!url)return
    const authorization=await vapidHeader(key,config.publicKey,url.origin,config.contact,expiry)
    const r=await fetch(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),
      headers:{Authorization:authorization,TTL:'1800',Urgency:'normal'}})
    if(r.status===404||r.status===410)await statement(env.DB,'DELETE FROM push_subscriptions WHERE endpoint=? AND account_id=?',endpoint,accountId).run()
    await r.body?.cancel()
  }))
}

export function queuePush(c:Ctx,accountId:string,status:string){
  if(configuration(c.env)&&['ready','out_for_delivery','completed','cancelled','failed','rejected'].includes(status)){
    c.executionCtx.waitUntil(sendPush(c.env,accountId).catch(()=>console.warn('Web Push delivery unavailable')))
  }
}
