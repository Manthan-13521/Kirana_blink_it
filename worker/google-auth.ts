import { Hono } from 'hono'
import { deleteCookie,getCookie,setCookie } from 'hono/cookie'
import { digest,id,now,one,Problem,statement,token } from './shared'
import type { Ctx,Env } from './shared'

const callback='/api/auth/google/callback'
const oauthCookie='__Host-kirana_google'
const workspacePath={shop:'/',owner:'/owner',rider:'/rider'} as const
type Workspace=keyof typeof workspacePath
export const googleAuth=new Hono<Env>()
googleAuth.use('/auth/google/*',async(c,next)=>{c.header('Referrer-Policy','no-referrer');await next()})

function configuration(c:Ctx){
  const {GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET,GOOGLE_ORIGIN}=c.env
  if(!GOOGLE_CLIENT_ID||!GOOGLE_CLIENT_SECRET||!GOOGLE_ORIGIN)return null
  const url=new URL(c.req.url)
  if(url.protocol!=='https:'||url.origin!==GOOGLE_ORIGIN)return null
  return {clientId:GOOGLE_CLIENT_ID,secret:GOOGLE_CLIENT_SECRET,redirect:GOOGLE_ORIGIN+callback}
}
googleAuth.get('/auth/google/status',c=>c.json({enabled:Boolean(configuration(c))}))
googleAuth.get('/auth/google',async c=>{
  const config=configuration(c)
  if(!config)throw new Problem(503,'Google sign-in is unavailable.')
  if(c.req.header('sec-fetch-site')==='cross-site')throw new Problem(403,'Start sign-in from the store.')
  const requested=c.req.query('workspace')??'shop'
  if(requested!=='shop'&&requested!=='owner'&&requested!=='rider')throw new Problem(400,'Invalid workspace.')
  const state=token(), binding=token(), verifier=token()
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))
  const challenge=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
  await statement(c.env.DB,'INSERT INTO oauth_requests(state,binding,verifier,workspace,expires_at) VALUES(?,?,?,?,?)',state,await digest(binding),verifier,requested,now()+600).run()
  setCookie(c,oauthCookie,binding,{path:'/',httpOnly:true,secure:true,sameSite:'Lax',maxAge:600})
  const query=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirect,response_type:'code',scope:'openid email profile',state,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'})
  return c.redirect('https://accounts.google.com/o/oauth2/v2/auth?'+query)
})
googleAuth.get('/auth/google/callback',async c=>{
  const config=configuration(c)
  if(!config)throw new Problem(503,'Google sign-in is unavailable.')
  const state=c.req.query('state'), code=c.req.query('code'),binding=getCookie(c,oauthCookie)
  if(!state||!binding||!code||!/^\w{64}$/.test(state)||!/^\w{64}$/.test(binding)||code.length>2048){
    throw new Problem(400,'Start Google sign-in again.')
  }
  const db=c.env.DB
  const pending=await one<{verifier:string;workspace:Workspace}>(db,
    'DELETE FROM oauth_requests WHERE state=? AND binding=? AND expires_at>? RETURNING verifier,workspace',
    state,await digest(binding),now())
  if(!pending)throw new Problem(400,'This sign-in link has expired or was already used.')
  deleteCookie(c,oauthCookie,{path:'/',secure:true,httpOnly:true,sameSite:'Lax'})
  const grant=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
    body:new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,client_secret:config.secret,code,code_verifier:pending.verifier,redirect_uri:config.redirect}),
  })
  if(!grant.ok)throw new Problem(403,'Google could not complete sign-in.')
  const {access_token:accessToken}=await grant.json<{access_token?:string}>()
  if(!accessToken)throw new Problem(403,'Google could not complete sign-in.')
  const response=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{
    redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:'Bearer '+accessToken},
  })
  if(!response.ok)throw new Problem(403,'Google identity could not be verified.')
  const profile=await response.json<{sub?:string;email?:string;email_verified?:boolean;name?:string;hd?:string}>()
  if(typeof profile.sub!=='string'||!/^[A-Za-z0-9_-]{1,255}$/.test(profile.sub)||typeof profile.email!=='string'||profile.email_verified!==true){
    throw new Problem(403,'Use a verified Google account.')
  }
  const workspace=pending.workspace
  const verifiedEmail=profile.email.toLowerCase()
  const domain=verifiedEmail.split('@').at(-1)
  const authoritative=domain==='gmail.com'||Boolean(domain&&profile.hd?.toLowerCase()===domain)
  const allowed=workspace==='owner'?c.env.GOOGLE_OWNER_EMAILS:c.env.GOOGLE_RIDER_EMAIL
  if(workspace!=='shop'&&(!authoritative||!allowed?.split(',').some(email=>email.trim().toLowerCase()===verifiedEmail))){
    throw new Problem(403,'This Google account is not authorized for this workspace.')
  }

  const accountId=id(), accountRole=workspace==='shop'?'customer':workspace, name=profile.name?.trim().slice(0,80)||'Store customer'
  const riderGuard=workspace==='rider'?"AND NOT EXISTS(SELECT 1 FROM accounts WHERE role='rider' AND active=1)":''
  await db.batch([
    statement(db,`INSERT INTO accounts(id,role,name) SELECT ?,?,? WHERE NOT EXISTS
      (SELECT 1 FROM google_identities WHERE subject=? AND workspace=?) ${riderGuard}`,accountId,accountRole,name,profile.sub,workspace),
    statement(db,`INSERT INTO google_identities(subject,workspace,account_id) SELECT ?,?,? WHERE changes()=1`,profile.sub,workspace,accountId),
  ])
  const account=await one<{id:string}>(db,
    'SELECT accounts.id FROM google_identities JOIN accounts ON accounts.id=google_identities.account_id WHERE subject=? AND workspace=? AND role=? AND active=1',
    profile.sub,workspace,accountRole)
  if(!account)throw new Problem(403,'This account is inactive or a rider is already assigned.')
  const session=token(), age=8*3600, old=getCookie(c,'kirana_session')
  await db.batch([
    statement(db,'INSERT INTO sessions(hash,account_id,expires_at) VALUES(?,?,?)',await digest(session),account.id,now()+age),
    ...(old&&/^[a-f0-9]{64}$/.test(old)?[statement(db,'DELETE FROM sessions WHERE hash=?',await digest(old))]:[]),
  ])
  setCookie(c,'kirana_session',session,{path:'/',httpOnly:true,secure:true,sameSite:'Lax',maxAge:age})
  return c.redirect(workspacePath[workspace],303)
})
