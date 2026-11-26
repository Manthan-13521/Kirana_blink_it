import type { Env } from './shared'
export type PaymentMode='test'|'live'
export type Credentials={key:string;secret:string;webhook:string;mode:PaymentMode}
type Bindings=Env['Bindings']
export const paymentHoldSeconds=900
export function paymentCredentials(env:Bindings):Credentials|null{
  const {APP_MODE,RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET,RAZORPAY_WEBHOOK_SECRET}=env
  if(!['staging','production'].includes(APP_MODE??'')||!RAZORPAY_KEY_ID||!RAZORPAY_KEY_SECRET||!RAZORPAY_WEBHOOK_SECRET)return null
  const mode=env.RAZORPAY_MODE??'test'
  if(mode!=='test'&&mode!=='live'||mode==='test'&&APP_MODE!=='staging')return null
  if(!new RegExp('^rzp_'+mode+'_[A-Za-z0-9]+$').test(RAZORPAY_KEY_ID))return null
  return {key:RAZORPAY_KEY_ID,secret:RAZORPAY_KEY_SECRET,webhook:RAZORPAY_WEBHOOK_SECRET,mode}
}
export function testCredentials(env:Bindings){
  const credentials=paymentCredentials(env)
  return credentials?.mode==='test'?credentials:null
}
export function checkoutCredentials(env:Bindings){
  const credentials=paymentCredentials(env)
  if(!credentials)return null
  if(credentials.mode==='test')return {...credentials,checkoutConfig:null}
  const checkoutConfig=env.RAZORPAY_UPI_CONFIG_ID
  if(env.RAZORPAY_LIVE_CHECKOUT!=='enabled'||!identifier(checkoutConfig,'config'))return null
  return {...credentials,checkoutConfig}
}
export const identifier=(id:unknown,prefix:string):id is string=>typeof id==='string'&&new RegExp('^'+prefix+'_[A-Za-z0-9]{6,60}$').test(id)
export const uuid=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
export async function validWebhook(body:ArrayBuffer,signature:string,secret:string){
  if(!/^[a-f0-9]{64}$/i.test(signature))return false
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify'])
  const bytes=Uint8Array.from(signature.match(/../g)!,hex=>parseInt(hex,16))
  return crypto.subtle.verify('HMAC',key,bytes,body)
}
export function provider(credentials:Credentials,path:string,options:RequestInit={}){
  return fetch('https://api.razorpay.com/v1'+path,{...options,redirect:'manual',signal:AbortSignal.timeout(6500),
    headers:{Authorization:'Basic '+btoa(credentials.key+':'+credentials.secret),'Content-Type':'application/json',...options.headers}})
}
export function safePaymentLink(url:unknown):url is string{
  if(typeof url!=='string')return false
  try{const path=new URL(url);return path.origin==='https://rzp.io'&&!path.username&&!path.password}catch{return false}
}
