import { Hono } from 'hono'
import { deleteCookie,getCookie,setCookie } from 'hono/cookie'
import { digest,id,json,now,one,Problem,S,statement,token } from './shared'
import type { Ctx,Env,Role } from './shared'
import { reserve } from './budget'

const callback='/api/auth/google/callback'
const oauthCookie='__Host-kirana_google'
const workspacePath={shop:'/',owner:'/owner',rider:'/rider'} as const
type Workspace=keyof typeof workspacePath
export const googleAuth=new Hono<Env>()
const invalid=()=>new Problem(403,'Google identity could not be verified.')
function decode(segment:string){
  return Uint8Array.from(atob(segment.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0))
}
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
type Profile={sub:string;email:string;email_verified:boolean;name?:string;hd?:string}
type GoogleKey=JsonWebKey&{kid?:string}
let googleKeys:{keys:GoogleKey[];expires:number}|undefined

async function signingKey(kid:string){
  if(googleKeys&&googleKeys.expires>now()){
    const key=googleKeys.keys.find(item=>item.kid===kid)
    if(key)return key
    // Refresh on a new key, with a short floor to avoid repeated network calls.
    if(googleKeys.expires-now()>840)return null
  }
  const r=await fetch('https://www.googleapis.com/oauth2/v3/certs',{redirect:'manual',signal:AbortSignal.timeout(6000)})
  if(!r.ok)throw invalid()
  const data=await r.json<{keys?:GoogleKey[]}>()
  if(!Array.isArray(data.keys)||data.keys.length>20)throw invalid()
  googleKeys={keys:data.keys,expires:now()+900}
  return data.keys.find(item=>item.kid===kid)??null
}

export async function verifyGoogleIdentity(raw:string,client:string,nonce:string,keyFor=signingKey,time=now()):Promise<Profile>{
  if(raw.length>12000||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(raw))throw invalid()
  const [encodedHead,encodedBody,signature]=raw.split('.')
  let head:{alg?:string;kid?:string}, claims:Profile&{iss:string;aud:string|string[];azp?:string;exp:number;iat:number;nonce:string}
  try{
    const decoder=new TextDecoder()
    head=JSON.parse(decoder.decode(decode(encodedHead)))
    claims=JSON.parse(decoder.decode(decode(encodedBody)))
  }catch{throw invalid()}
  if(head?.alg!=='RS256'||typeof head.kid!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(head.kid)||!claims)throw invalid()
  const audience=Array.isArray(claims.aud)?claims.aud.includes(client)&&(claims.aud.length===1||claims.azp===client):claims.aud===client
  if(!audience||claims.azp&&claims.azp!==client||!['https://accounts.google.com','accounts.google.com'].includes(claims.iss)||
    claims.nonce!==nonce||!Number.isSafeInteger(claims.exp)||claims.exp<=time||!Number.isSafeInteger(claims.iat)||claims.iat>time+60||
    typeof claims.sub!=='string'||!/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)||
    typeof claims.email!=='string'||!/^\S+@\S+$/.test(claims.email)||claims.email_verified!==true)throw invalid()
  const jwk=await keyFor(head.kid)
  if(!jwk||jwk.kty!=='RSA')throw invalid()
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify'])
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(signature),new TextEncoder().encode(encodedHead+'.'+encodedBody)))throw invalid()
  return claims
}

function configuration(c:Ctx){
  const {GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET,GOOGLE_ORIGIN}=c.env
  if(!GOOGLE_CLIENT_ID||!GOOGLE_CLIENT_SECRET||!GOOGLE_ORIGIN)return null
  const url=new URL(c.req.url)
  if(url.protocol!=='https:'||url.origin!==GOOGLE_ORIGIN)return null
  return {clientId:GOOGLE_CLIENT_ID,secret:GOOGLE_CLIENT_SECRET,redirect:GOOGLE_ORIGIN+callback}
}
async function start(c:Ctx,data:Record<string,unknown>){
  const config=configuration(c)
  if(!config)throw new Problem(503,'Google sign-in is unavailable.')
  if(c.req.header('sec-fetch-site')==='cross-site')throw new Problem(403,'Start sign-in from the store.')
  const workspace=data.workspace??'shop'
  if(workspace!=='shop'&&workspace!=='owner'&&workspace!=='rider')throw new Problem(400,'Invalid workspace.')
  const invite=S(data.invite??'','invitation',64,false)
  if(invite&&(workspace==='shop'||!/^[a-f0-9]{64}$/.test(invite)))throw new Problem(400,'Invalid invitation code.')
  if(!await reserve(c.env.DB,'google-oauth',1,2000))throw new Problem(429,'Sign-in is busy. Try again later.')
  const state=token(), binding=token(), verifier=token()
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))
  await statement(c.env.DB,`INSERT INTO oauth_requests(state,binding,verifier,workspace,expires_at,return_checkout,invite_hash)
    VALUES(?,?,?,?,?,?,?)`,state,await digest(binding),verifier,workspace,now()+600,
    Number(workspace==='shop'&&data.checkout===true),invite?await digest(invite):null).run()
  setCookie(c,oauthCookie,binding,{path:'/',httpOnly:true,secure:true,sameSite:'Lax',maxAge:600})
  const query=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirect,response_type:'code',scope:'openid email profile',state,nonce:state,code_challenge:encode(bytes),code_challenge_method:'S256',prompt:'select_account'})
  return 'https://accounts.google.com/o/oauth2/v2/auth?'+query
}
googleAuth.get('/auth/google/status',c=>c.json({enabled:Boolean(configuration(c))}))
googleAuth.get('/auth/google',async c=>c.redirect(await start(c,{workspace:c.req.query('workspace')})))
googleAuth.post('/auth/google',async c=>c.json({url:await start(c,await json(c))}))

function authoritativeEmail(profile:Profile){
  const email=profile.email.toLowerCase(),domain=email.split('@').at(-1)
  return profile.email_verified===true&&
    (domain==='gmail.com'||Boolean(domain&&typeof profile.hd==='string'&&profile.hd.toLowerCase()===domain))?email:null
}

function authorizedEmail(email:string|null,allowlist?:string){
  return Boolean(email&&allowlist?.split(',').some(entry=>entry.trim().toLowerCase()===email))
}

export async function googleWorkspace(env:Env['Bindings'],profile:Profile,requested:Workspace,invite:string|null):Promise<Workspace>{
  if(invite)return requested
  const email=authoritativeEmail(profile)
  if(authorizedEmail(email,env.GOOGLE_OWNER_EMAILS))return 'owner'
  if(authorizedEmail(email,env.GOOGLE_RIDER_EMAIL))return 'rider'
  const identity=await one<{workspace:'rider'|'owner'}>(env.DB,`SELECT g.workspace FROM google_identities g
    JOIN accounts a ON a.id=g.account_id
    WHERE g.subject=? AND g.workspace IN ('rider','owner') AND g.invited=1 AND a.active=1
      AND (g.workspace='rider' AND a.role='rider' OR g.workspace='owner' AND a.role='staff')
    ORDER BY (g.workspace='rider') DESC LIMIT 1`,profile.sub)
  return identity?.workspace??'shop'
}

export async function resolveGoogleAccount(env:Env['Bindings'],profile:Profile,workspace:Workspace,invite:string|null){
  const db=env.DB,email=authoritativeEmail(profile)
  const allowlist=workspace==='owner'?env.GOOGLE_OWNER_EMAILS:env.GOOGLE_RIDER_EMAIL
  const allowed=authorizedEmail(email,allowlist)
  const account=await one<{id:string;role:Role;active:number;invited:number}>(db,`SELECT a.id,a.role,a.active,g.invited FROM google_identities g
    JOIN accounts a ON a.id=g.account_id WHERE g.subject=? AND g.workspace=?`,profile.sub,workspace)
  if(account?.active){
    if(workspace==='owner'&&allowed&&account.role==='staff'&&account.invited){
      await db.batch([
        statement(db,"UPDATE accounts SET role='owner' WHERE id=? AND role='staff' AND active=1",account.id),
        statement(db,"INSERT INTO audit(actor,action,subject,created_at) SELECT ?,'owner.allowlisted',?,? WHERE changes()=1",account.id,account.id,now()),
        statement(db,'DELETE FROM sessions WHERE account_id=? AND changes()=1',account.id),
      ])
      return account.id
    }
    if(workspace==='shop'&&account.role==='customer'||
      workspace==='owner'&&(account.role==='staff'&&Boolean(account.invited)||account.role==='owner'&&allowed)||
      workspace==='rider'&&account.role==='rider'&&(Boolean(account.invited)||allowed))return account.id
    throw new Problem(403,'This Google account is not authorized for this workspace.')
  }
  const accountId=id(),name=typeof profile.name==='string'&&profile.name.trim()?profile.name.trim().slice(0,80):'Store account'
  const riderGuard=workspace==='rider'?"AND NOT EXISTS(SELECT 1 FROM accounts WHERE role='rider' AND active=1)":''
  // Revoked team identities can only be reconnected by a fresh owner invitation.
  if(invite&&workspace!=='shop'&&email){
    const role=workspace==='owner'?'staff':'rider',time=now()
    const result=await db.batch([
      statement(db,`INSERT INTO accounts(id,role,name) SELECT ?,?,?
        WHERE EXISTS(SELECT 1 FROM invites WHERE hash=? AND role=? AND target_email_hash=? AND used_at IS NULL AND expires_at>?)
        AND NOT EXISTS(SELECT 1 FROM google_identities g JOIN accounts a ON a.id=g.account_id WHERE g.subject=? AND g.workspace=? AND a.active=1)
        ${riderGuard}`,accountId,role,name,invite,role,await digest(email),time,profile.sub,workspace),
      statement(db,`INSERT INTO google_identities(subject,workspace,account_id,invited) SELECT ?,?,?,1 WHERE changes()=1
        ON CONFLICT(subject,workspace) DO UPDATE SET account_id=excluded.account_id,invited=1`,profile.sub,workspace,accountId),
      statement(db,'UPDATE invites SET used_at=? WHERE hash=? AND changes()=1',time,invite),
    ])
    if(result[0].meta.changes)return accountId
    throw new Problem(403,'The invitation is expired, assigned to a different Google account, or no longer available.')
  }
  if(account||workspace!=='shop'&&!allowed)throw new Problem(403,'This Google account is not authorized for this workspace.')
  const role=workspace==='shop'?'customer':workspace
  await db.batch([
    statement(db,`INSERT INTO accounts(id,role,name) SELECT ?,?,? WHERE NOT EXISTS
      (SELECT 1 FROM google_identities WHERE subject=? AND workspace=?) ${riderGuard}`,accountId,role,name,profile.sub,workspace),
    statement(db,'INSERT INTO google_identities(subject,workspace,account_id) SELECT ?,?,? WHERE changes()=1',profile.sub,workspace,accountId),
  ])
  const created=await one<{id:string}>(db,`SELECT a.id FROM google_identities g JOIN accounts a ON a.id=g.account_id
    WHERE g.subject=? AND g.workspace=? AND a.role=? AND a.active=1`,profile.sub,workspace,role)
  if(!created)throw new Problem(403,'This account is inactive or a rider is already assigned.')
  return created.id
}

googleAuth.get('/auth/google/callback',async c=>{
  const config=configuration(c)
  if(!config)throw new Problem(503,'Google sign-in is unavailable.')
  const state=c.req.query('state'),code=c.req.query('code'),binding=getCookie(c,oauthCookie)
  if(!state||!binding||!code||!/^[a-f0-9]{64}$/.test(state)||!/^[a-f0-9]{64}$/.test(binding)||code.length>2048){
    throw new Problem(400,'Start Google sign-in again.')
  }
  const db=c.env.DB
  const pending=await one<{verifier:string;workspace:Workspace;return_checkout:number;invite_hash:string|null}>(db,
    'DELETE FROM oauth_requests WHERE state=? AND binding=? AND expires_at>? RETURNING verifier,workspace,return_checkout,invite_hash',
    state,await digest(binding),now())
  if(!pending)throw new Problem(400,'This sign-in link has expired or was already used.')
  deleteCookie(c,oauthCookie,{path:'/',secure:true,httpOnly:true,sameSite:'Lax'})
  const grant=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),
    body:new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,client_secret:config.secret,code,code_verifier:pending.verifier,redirect_uri:config.redirect}),
  })
  if(!grant.ok)throw invalid()
  const {id_token:raw}=await grant.json<{id_token?:string}>()
  if(typeof raw!=='string')throw invalid()
  const profile=await verifyGoogleIdentity(raw,config.clientId,state)
  const workspace=await googleWorkspace(c.env,profile,pending.workspace,pending.invite_hash)
  const account=await resolveGoogleAccount(c.env,profile,workspace,pending.invite_hash)
  const checkoutAllowlist=c.env.STAGING_CHECKOUT_EMAILS
  const tester=c.env.APP_MODE==='staging'&&workspace==='shop'&&checkoutAllowlist&&
    authorizedEmail(authoritativeEmail(profile),checkoutAllowlist)?await digest(checkoutAllowlist):null
  const session=token(),age=8*3600,old=getCookie(c,'kirana_session')
  await db.batch([
    statement(db,'INSERT INTO sessions(hash,account_id,expires_at,staging_checkout) VALUES(?,?,?,?)',await digest(session),account,now()+age,tester),
    ...(old&&/^[a-f0-9]{64}$/.test(old)?[statement(db,'DELETE FROM sessions WHERE hash=?',await digest(old))]:[]),
  ])
  setCookie(c,'kirana_session',session,{path:'/',httpOnly:true,secure:true,sameSite:'Lax',maxAge:age})
  return c.redirect(workspace==='shop'?(pending.return_checkout?'/?checkout=resume':'/?signin=complete'):workspacePath[workspace],303)
})
