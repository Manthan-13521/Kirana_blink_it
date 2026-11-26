import type { Context } from 'hono'

export type Role = 'customer' | 'owner' | 'staff' | 'rider'
export type Account = { id: string; role: Role; name: string; phone: string }
export type Env = {
  Bindings: {
    DB: D1Database; MEDIA: D1Database; APP_MODE?: string; ASSETS?: Fetcher
    GOOGLE_CLIENT_ID?:string; GOOGLE_CLIENT_SECRET?:string; GOOGLE_ORIGIN?:string
    GOOGLE_OWNER_EMAILS?:string; GOOGLE_RIDER_EMAIL?:string; STAGING_CHECKOUT_EMAILS?:string
    MEDIA_STATIC_ORIGIN?:string; GEOAPIFY_KEY?:string; VAPID_PUBLIC_KEY?:string; VAPID_PRIVATE_JWK?:string; VAPID_CONTACT?:string
    RAZORPAY_KEY_ID?:string; RAZORPAY_KEY_SECRET?:string; RAZORPAY_WEBHOOK_SECRET?:string
  }
  Variables: { account: Account; localEntry: boolean; stagingCheckout:boolean }
}
export type Ctx = Context<Env>
export type Shop = {
  id: number
  revision: number
  name: string
  tagline: string
  locality: string
  phone: string
  address: string
  pin_codes: string
  latitude: number
  longitude: number
  radius_km: number
  open_hour: number
  close_hour: number
  preparation: number
  window_minutes: number
  delivery_capacity: number
  pickup_capacity: number
  delivery_fee: number
  free_delivery: number
  minimum_order: number
  accepting: number
  registered: number
  gstin: string
  policy: string
  brand_color: string
  enable_delivery: number
  enable_pickup: number
  enable_cod: number
  enable_online: number
}
export type Product = {
  id: string; sku: string; name: string; brand: string; description: string; category: string
  subcategory: string; unit: 'g'|'ml'|'pc'; step: number; price: number; mrp: number
  stock: number; threshold: number; min_steps: number; max_steps: number; tax_bps: number
  hsn: string; image: string|null; active: number; featured: number; expiry: string|null
}
export type Address = { id: string; label: string; recipient: string; phone: string; line1: string; locality: string; landmark: string; pin: string; latitude: number|null; longitude: number|null }
export type Order = {
  id: string; account_id: string; request_fingerprint: string; channel: 'online'|'pos'
  fulfillment: 'pickup'|'delivery'|'counter'; status: string; payment_method: string; payment_status: string
  subtotal: number; fees: number; total: number; tax: number; slot_start: number|null; slot_end: number|null
  address_json: string|null; billing_json: string; note: string; assigned_to: string|null; route_rank: number
  slot_retained: number; stocked: number; reconciled: number; created_at: number; updated_at: number
}

type ProblemStatus=400|401|403|404|409|413|422|429|503
export class Problem extends Error {
  readonly status:ProblemStatus
  readonly code?:string
  constructor(status:ProblemStatus,message:string,code?:string){
    super(message)
    this.status=status
    this.code=code
  }
}
export const now = () => Math.floor(Date.now() / 1000)
export const id = () => crypto.randomUUID()
export const I = (x: unknown, lo: number, hi: number, label: string) => {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < lo || x > hi) throw new Problem(400, `Invalid ${label}.`)
  return x
}
export function S(x: unknown, label: string, max: number, required = true) {
  if (typeof x !== 'string' || x.trim().length > max || (required && !x.trim())) throw new Problem(400, `Invalid ${label}.`)
  return x.trim()
}
export function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Problem(400,'Expected an object.')
  return value as Record<string, unknown>
}
export async function json(c: Ctx) {
  if (!c.req.header('content-type')?.startsWith('application/json')) throw new Problem(400,'Send JSON.')
  try { return obj(await c.req.json()) } catch (e) { if (e instanceof Problem) throw e; throw new Problem(400,'Invalid JSON.') }
}
export const one = <T>(db: D1Database, query: string, ...params: unknown[]) => db.prepare(query).bind(...params).first<T>()
export const all = async <T>(db: D1Database, query: string, ...params: unknown[]) => (await db.prepare(query).bind(...params).all<T>()).results
export const statement = (db: D1Database, query: string, ...params: unknown[]) => db.prepare(query).bind(...params)
export async function shop(db: D1Database) {
  const row = await one<Shop>(db,'SELECT * FROM settings WHERE id=1')
  if (!row) throw new Problem(503,'Store setup has not been completed.')
  return row
}
export const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2,'0')).join('')
export async function digest(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('')
}
export function localhost(c: Ctx) {
  return c.get('localEntry') && c.env.APP_MODE === 'local' && ['localhost','127.0.0.1','[::1]'].includes(new URL(c.req.url).hostname)
}
export function role(c: Ctx, ...roles: Role[]) {
  const account = c.get('account')
  if (!account) throw new Problem(401,'Sign in to continue.')
  if (!roles.includes(account.role)) throw new Problem(403,'This account cannot perform that action.')
  return account
}
export function audit(db:D1Database,actor:string,action:string,subject:string,detail='') {
  return statement(db,'INSERT INTO audit(actor,action,subject,detail,created_at) VALUES(?,?,?,?,?)',actor,action,subject,detail,now())
}
export function coordinate(value: unknown, max: number) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value)>max) throw new Problem(400,'Invalid map coordinates.')
  return value
}
export function distance(a:number,b:number,x:number,y:number) {
  const rad = Math.PI/180
  const h = Math.sin((x-a)*rad/2)**2 + Math.cos(a*rad)*Math.cos(x*rad)*Math.sin((y-b)*rad/2)**2
  return 6371*2*Math.asin(Math.min(1,Math.sqrt(h)))
}
export function services(config: Shop, address: Address) {
  const pin = config.pin_codes.split(',').map(part=>part.trim()).filter(Boolean)
  if (address.latitude !== null && address.longitude !== null) {
    return distance(config.latitude,config.longitude,address.latitude,address.longitude) <= config.radius_km
  }
  return pin.includes(address.pin)
}

export const shopDayStart=(time:number)=>Math.floor((time+19800)/86400)*86400-19800

export function configuredSlot(config:Shop,start:number,time=now()){
  const day=shopDayStart(start)
  const opening=day+config.open_hour*3600, closing=day+config.close_hour*3600
  const length=config.window_minutes*60, end=start+length
  if(start<time+config.preparation*60 || day>=shopDayStart(time)+4*86400 ||
    start<opening || end>closing || (start-opening)%length!==0)return null
  return {start,end}
}

export async function availableSlot(db:D1Database,config:Shop,fulfillment:'pickup'|'delivery',slot:{start:number;end:number}){
  // Existing bookings can overlap if the owner has changed the window length.
  const row=await one<{used:number}>(db,`SELECT COUNT(*) used FROM orders
    WHERE channel='online' AND fulfillment=? AND slot_retained=1
      AND slot_start>=? AND slot_start<? AND slot_end>?`,fulfillment,slot.start-10800,slot.end,slot.start)
  return (row?.used??0)<(fulfillment==='delivery'?config.delivery_capacity:config.pickup_capacity)
}

export type Fulfillment='delivery'|'pickup'
export const onlineOrderingAvailable=(config:Pick<Shop,'accepting'|'enable_delivery'|'enable_pickup'>)=>Boolean(config.accepting&&(config.enable_delivery||config.enable_pickup))
export const fulfillmentEnabled=(config:Pick<Shop,'enable_delivery'|'enable_pickup'>,mode:Fulfillment)=>Boolean(mode==='delivery'?config.enable_delivery:config.enable_pickup)

export async function slots(db:D1Database,config:Shop, fulfillment:Fulfillment, time=now()) {
  if (!config.accepting||!fulfillmentEnabled(config,fulfillment)) return []
  const day=shopDayStart(time)
  const result: { start:number; end:number; remaining:number }[]=[]
  const usage = await all<{slot_start:number;slot_end:number;used:number}>(db,`SELECT slot_start,slot_end,COUNT(*) used FROM orders
    WHERE channel='online' AND fulfillment=? AND slot_retained=1 AND slot_start>=? AND slot_start<? AND slot_end>?
    GROUP BY slot_start,slot_end`,fulfillment,day-10800,day+4*86400,day)
  const capacity=fulfillment==='delivery'?config.delivery_capacity:config.pickup_capacity
  for(let i=0;i<4 && result.length<12;i++){
    const opening=day+i*86400+config.open_hour*3600
    const closing=day+i*86400+config.close_hour*3600
    for(let start=opening; start+(config.window_minutes*60)<=closing && result.length<12;start+=config.window_minutes*60) {
      if(start<time+config.preparation*60) continue
      const end=start+config.window_minutes*60
      const remaining=capacity-usage.reduce((sum,window)=>window.slot_start<end&&window.slot_end>start?sum+window.used:sum,0)
      if (remaining>0) result.push({start,end,remaining})
    }
  }
  return result
}

export function parseLines(input:unknown) {
  if (!Array.isArray(input) || !input.length || input.length>40) throw new Problem(400,'Select 1–40 different products.')
  const lines = input.map(raw=>{const item=obj(raw);return {id:S(item.id,'product',80),steps:I(item.steps,1,100,'quantity')}})
  if (new Set(lines.map(x=>x.id)).size!==lines.length) throw new Problem(400,'Duplicate product in basket.')
  return lines.sort((a,b)=>a.id.localeCompare(b.id))
}
export const publicOrderFields = 'id,channel,fulfillment,status,payment_method,payment_status,subtotal,fees,total,tax,slot_start,slot_end,note,created_at,updated_at,reconciled'
export async function order(db:D1Database, orderId:string) {
  const row=await one<Order>(db,'SELECT * FROM orders WHERE id=?',orderId)
  if(!row) throw new Problem(404,'Order not found.')
  return row
}
export function authorizeOrder(account:Account,row:Order) {
  const allowed = account.role==='owner'||account.role==='staff'||(account.role==='customer'&&row.account_id===account.id)||(account.role==='rider'&&row.assigned_to===account.id)
  if (!allowed) throw new Problem(404,'Order not found.')
}
export function errorMap(e: unknown) {
  const message=e instanceof Error?e.message:''
  if (message.includes('media_limit')) return new Problem(429,'The store image limit was reached. Try again tomorrow or remove unused images.')
  if (message.includes('slot_full')) return new Problem(409,'That window just filled. Select another window or store pickup.','slot_full')
  if (message.includes('insufficient_stock')) return new Problem(409,'A product has insufficient stock. Review the basket.','stock')
  if (message.includes('catalog_changed')) return new Problem(409,'A price or quantity limit changed. Review the basket.','quote_changed')
  if (message.includes('store_paused')) return new Problem(409,'Online ordering is temporarily unavailable.','store_paused')
  if (message.includes('fulfillment_unavailable')) return new Problem(409,'The selected order method is temporarily unavailable.','fulfillment_unavailable')
  if (message.includes('refund_limit')) return new Problem(409,'The refund exceeds the remaining paid amount.')
  if (message.includes('one_active_rider')||message.includes('accounts.role')) return new Problem(409,'An active delivery partner already exists.')
  if (message.includes('UNIQUE constraint')) return new Problem(409,'This record already exists.')
  return null
}
