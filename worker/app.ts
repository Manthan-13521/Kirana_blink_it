import { Hono } from 'hono'
import { deleteCookie,getCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { catalog } from './catalog'
import { orders } from './orders'
import { routing } from './routing'
import { push } from './push'
import { capacity } from './capacity'
import { razorpay } from './razorpay'
import { checkoutPayments,runPaymentMaintenance } from './checkout-payments'
import { testCredentials } from './payment-provider'
import { jpegMime,mediaFileId,webpMime } from './media-format'
import { googleAuth } from './google-auth'
import { all,audit,coordinate,digest,errorMap,I,id,json,localhost,now,one,onlineOrderingAvailable,parseLines,Problem,role,S,services,shop,statement,token } from './shared'
import type { Account,Address,Env } from './shared'

const COOKIE='kirana_session'
const DAY=86400
const profileFields='id,label,recipient,phone,line1,locality,landmark,pin,latitude,longitude'
const publicSettings=async(db:D1Database)=>{ const {id,gstin,...settings}=await shop(db); return settings }
export function application(localRoutes?:Hono<Env>) {
  const app=new Hono<Env>(), api=new Hono<Env>()
  app.onError((err,c)=>{
    const problem=err instanceof Problem?err:errorMap(err)
    if(problem) return c.json({error:problem.message,code:problem.code},problem.status)
    console.error('Request failed',err)
    return c.json({error:'Something went wrong. Please try again.'},500)
  })
  app.use('*',async(c,next)=>{
    await next()
    c.header('X-Content-Type-Options','nosniff')
    c.header('Referrer-Policy',(c.req.path.startsWith('/api/auth/google')||c.req.path.startsWith('/api/payments/return/'))?'no-referrer':'strict-origin-when-cross-origin')
    c.header('X-Frame-Options','DENY')
  })
  api.use('*',bodyLimit({maxSize:96*1024,onError:c=>c.json({error:'Request is too large.'},413)}))
  api.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store')
    c.set('localEntry',Boolean(localRoutes))
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&c.req.path!=='/api/webhooks/razorpay'){
      const origin=c.req.header('origin')
      if(origin!==new URL(c.req.url).origin||c.req.header('sec-fetch-site')==='cross-site') throw new Problem(403,'Request origin is not permitted.')
    }
    const publicPath=/^\/api\/(store|categories|catalog(?:\/[^/]+)?|slots|health)$/.test(c.req.path)
    const privateStore=c.env.APP_MODE==='staging'&&Boolean(c.env.STAGING_CHECKOUT_EMAILS)&&
      (c.req.path==='/api/store'||c.req.path==='/api/slots')
    const session=publicPath&&!privateStore?undefined:getCookie(c,COOKIE)
    c.set('stagingCheckout',false)
    if(session&&/^[a-f0-9]{64}$/.test(session)){
      const account=await one<Account&{staging_checkout:string|null}>(c.env.DB,`SELECT accounts.id,role,name,phone,staging_checkout FROM sessions JOIN accounts ON accounts.id=sessions.account_id WHERE hash=? AND expires_at>? AND active=1`,await digest(session),now())
      if(account){
        const {staging_checkout,...actor}=account
        c.set('account',actor)
        c.set('stagingCheckout',c.env.APP_MODE==='staging'&&actor.role==='customer'&&Boolean(staging_checkout&&c.env.STAGING_CHECKOUT_EMAILS)&&
          staging_checkout===await digest(c.env.STAGING_CHECKOUT_EMAILS??''))
      }
    }
    await next()
  })

  api.get('/health',c=>c.json({ok:true,mode:localhost(c)?'local':'configured'}))
  api.get('/store',async c=>{
    if(!localhost(c)&&!(c.env.APP_MODE==='staging'&&c.env.STAGING_CHECKOUT_EMAILS))c.header('Cache-Control','public, max-age=20')
    const settings=await publicSettings(c.env.DB)
    return c.json({settings:{...settings,enable_online:Number(settings.enable_online&&(localhost(c)||Boolean(testCredentials(c.env)))),accepting:Number((c.env.APP_MODE!=='staging'||c.get('stagingCheckout'))&&onlineOrderingAvailable(settings))},local:localhost(c)})
  })
  api.get('/me',c=>c.json({account:c.get('account')??null,local:localhost(c)}))
  api.post('/auth/logout',async c=>{
    const current=getCookie(c,COOKIE)
    if(current) await statement(c.env.DB,'DELETE FROM sessions WHERE hash=?',await digest(current)).run()
    deleteCookie(c,COOKIE,{path:'/'})
    return c.json({ok:true})
  })
  api.put('/me',async c=>{
    const actor=role(c,'customer','owner','staff','rider'), data=await json(c)
    const name=S(data.name,'name',80),phone=S(data.phone??'','phone',24,false)
    if(phone&&!/^[+()0-9 -]+$/.test(phone)) throw new Problem(400,'Invalid phone number.')
    await statement(c.env.DB,'UPDATE accounts SET name=?,phone=? WHERE id=?',name,phone,actor.id).run()
    return c.json({id:actor.id,role:actor.role,name,phone})
  })
  api.get('/addresses',async c=>{
    const actor=role(c,'customer')
    return c.json(await all(c.env.DB,`SELECT ${profileFields} FROM addresses WHERE account_id=? ORDER BY created_at DESC LIMIT 20`,actor.id))
  })
  api.post('/addresses',async c=>{
    const actor=role(c,'customer'),db=c.env.DB,data=await json(c)
    const pin=S(data.pin,'PIN code',6)
    if(!/^\d{6}$/.test(pin)) throw new Problem(400,'Enter a six-digit PIN code.')
    const row:Address={id:id(),label:S(data.label,'label',30),recipient:S(data.recipient,'recipient',80),phone:S(data.phone,'phone',22),line1:S(data.line1,'street address',200),locality:S(data.locality,'locality',70),landmark:S(data.landmark??'','landmark',100,false),pin,latitude:coordinate(data.latitude,90),longitude:coordinate(data.longitude,180)}
    if(!/^[+()0-9 -]{8,22}$/.test(row.phone)||(row.latitude===null)!==(row.longitude===null)) throw new Problem(400,'Check the phone number and location.')
    const result=await statement(db,`INSERT INTO addresses(id,account_id,label,recipient,phone,line1,locality,landmark,pin,latitude,longitude,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM addresses WHERE account_id=?)<20`,row.id,actor.id,row.label,row.recipient,row.phone,row.line1,row.locality,row.landmark,pin,row.latitude,row.longitude,now(),actor.id).run()
    if(!result.meta.changes) throw new Problem(409,'Remove an old address to add a new one.')
    return c.json({...row,serviceable:services(await shop(db),row)},201)
  })
  api.delete('/addresses/:id',async c=>{
    const actor=role(c,'customer')
    const result=await statement(c.env.DB,'DELETE FROM addresses WHERE id=? AND account_id=?',c.req.param('id'),actor.id).run()
    if(!result.meta.changes) throw new Problem(404,'Address not found.')
    return c.json({ok:true})
  })
  api.get('/cart',async c=>{
    const account=role(c,'customer')
    const rows=await all<Record<string,unknown>>(c.env.DB,`SELECT p.id,p.name,p.sku,p.unit,p.step,p.price,p.mrp,p.image,
      min(p.stock,p.step*p.max_steps) stock,p.min_steps,p.max_steps,
      min(CAST(json_extract(j.value,'$.steps') AS INTEGER),p.stock/p.step,p.max_steps) steps
      FROM carts JOIN json_each(carts.items) j JOIN products p ON p.id=json_extract(j.value,'$.id')
      WHERE carts.account_id=? AND carts.updated_at>? AND p.active=1
        AND (p.expiry IS NULL OR p.expiry>=date('now','+330 minutes'))
        AND min(CAST(json_extract(j.value,'$.steps') AS INTEGER),p.stock/p.step,p.max_steps)>=p.min_steps
      LIMIT 40`,account.id,now()-2*DAY)
    return c.json({items:rows.map(({id,steps})=>({id,steps})),lines:rows.map(({steps,...product})=>({steps,product}))})
  })
  api.put('/cart',async c=>{
    const account=role(c,'customer'), data=await json(c)
    const items=Array.isArray(data.items)&&!data.items.length?[]:parseLines(data.items)
    if(!items.length) await statement(c.env.DB,'DELETE FROM carts WHERE account_id=?',account.id).run()
    else await statement(c.env.DB,`INSERT INTO carts(account_id,items,updated_at) VALUES(?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET items=excluded.items,updated_at=excluded.updated_at`,account.id,JSON.stringify(items),now()).run()
    return c.json({ok:true})
  })
  api.get('/notices',async c=>{
    const account=role(c,'customer','owner','staff','rider')
    const db=c.env.DB
    const [notices,pref]=await Promise.all([
      all(db,'SELECT id,order_id,message,created_at,read_at FROM notices WHERE account_id=? ORDER BY id DESC LIMIT 25',account.id),
      one<{enabled:number}>(db,'SELECT enabled FROM push_preferences WHERE account_id=?',account.id),
    ])
    return c.json({notices,enabled:Boolean(pref?.enabled)})
  })
  api.put('/notices/preferences',async c=>{
    const account=role(c,'customer','owner','staff','rider'),data=await json(c)
    if(typeof data.enabled!=='boolean') throw new Problem(400,'Invalid preference.')
    await statement(c.env.DB,`INSERT INTO push_preferences(account_id,enabled,updated_at) VALUES(?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`,account.id,Number(data.enabled),now()).run()
    return c.json({ok:true})
  })
  api.post('/notices/read',async c=>{
    const account=role(c,'customer','owner','staff','rider')
    await statement(c.env.DB,'UPDATE notices SET read_at=? WHERE account_id=? AND read_at IS NULL',now(),account.id).run()
    return c.json({ok:true})
  })

  api.get('/admin/settings',async c=>{ role(c,'owner','staff'); return c.json(await shop(c.env.DB)) })
  api.put('/admin/settings',async c=>{
    const actor=role(c,'owner'),db=c.env.DB,data=await json(c)
    const pinCodes=S(data.pin_codes,'PIN codes',240,false)
    if(pinCodes.split(',').filter(Boolean).some(pin=>!/^\d{6}$/.test(pin.trim()))) throw new Problem(400,'Enter comma-separated six-digit PIN codes.')
    const latitude=coordinate(data.latitude,90),longitude=coordinate(data.longitude,180)
    const radius=coordinate(data.radius_km,60),color=S(data.brand_color,'brand colour',7)
    if(latitude===null||longitude===null||radius===null||radius<=0||!/^#[0-9a-f]{6}$/i.test(color)) throw new Problem(400,'Check the coordinates, delivery radius and colour.')
    const open=I(data.open_hour,0,23,'opening hour'), close=I(data.close_hour,open+1,24,'closing hour')
    const gstin=S(data.gstin??'','GSTIN',15,false).toUpperCase(), registered=I(data.registered??0,0,1,'tax registration')
    if(registered&&!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) throw new Problem(400,'A valid GSTIN is required for tax invoices.')
    const values={
      name:S(data.name,'store name',100),tagline:S(data.tagline??'','tagline',80,false),locality:S(data.locality,'locality',100),
      phone:S(data.phone,'phone',24),address:S(data.address,'store address',220),pin_codes:pinCodes,
      latitude,longitude,radius_km:radius,open_hour:open,close_hour:close,
      preparation:I(data.preparation,0,180,'preparation minutes'),window_minutes:I(data.window_minutes,15,180,'window minutes'),
      delivery_capacity:I(data.delivery_capacity,1,100,'delivery capacity'),pickup_capacity:I(data.pickup_capacity,1,250,'pickup capacity'),
      delivery_fee:I(data.delivery_fee,0,100000,'delivery fee'),free_delivery:I(data.free_delivery,0,10000000,'free delivery threshold'),
      minimum_order:I(data.minimum_order,0,10000000,'minimum order'),accepting:I(data.accepting,0,1,'store availability'),
      registered,gstin,policy:S(data.policy??'','shop policy',1000,false),brand_color:color,
      enable_cod:I(data.enable_cod,0,1,'cash setting'),enable_online:I(data.enable_online,0,1,'online setting'),
      ...(data.enable_delivery===undefined?{}:{enable_delivery:I(data.enable_delivery,0,1,'home delivery setting')}),
      ...(data.enable_pickup===undefined?{}:{enable_pickup:I(data.enable_pickup,0,1,'store pickup setting')}),
    }
    if(values.accepting&&!values.enable_cod&&!values.enable_online) throw new Problem(400,'Enable at least one payment method.')
    await db.batch([statement(db,'UPDATE settings SET '+Object.keys(values).map(k=>k+'=?').join(',')+',revision=revision+1 WHERE id=1',...Object.values(values)),audit(db,actor.id,'store.configure','settings')])
    return c.json({ok:true})
  })
  api.get('/admin/team',async c=>{
    role(c,'owner')
    return c.json(await all(c.env.DB,"SELECT id,name,role,active FROM accounts WHERE role IN ('owner','staff','rider') ORDER BY active DESC,name LIMIT 50"))
  })
  api.post('/admin/team/invite',async c=>{
    const actor=role(c,'owner'),db=c.env.DB,data=await json(c)
    const choice=S(data.role,'role',12)
    if(!['staff','rider'].includes(choice)) throw new Problem(400,'Invalid invitation role.')
    if(choice==='rider'&&await one(db,"SELECT id FROM accounts WHERE role='rider' AND active=1")) throw new Problem(409,'Remove or deactivate the current partner before inviting another.')
    const email=S(data.email??'','invitation email',254, !localhost(c)).toLowerCase()
    if(email&&!/^\S+@\S+\.\S+$/.test(email))throw new Problem(400,'Enter the invited Google account email.')
    const code=token(),hash=await digest(code),time=now()
    await db.batch([statement(db,'INSERT INTO invites(hash,role,expires_at,target_email_hash) VALUES(?,?,?,?)',hash,choice,time+DAY,email?await digest(email):null),audit(db,actor.id,'team.invite',choice)])
    return c.json({code,expires_at:time+DAY},201)
  })
  api.post('/admin/team/:id/revoke',async c=>{
    const actor=role(c,'owner'),db=c.env.DB,accountId=c.req.param('id')
    const time=now()
    const updated=await db.batch([
      statement(db,`UPDATE accounts SET active=0 WHERE id=? AND role IN('rider','staff') AND active=1
        AND NOT EXISTS(SELECT 1 FROM orders WHERE assigned_to=? AND status='out_for_delivery')`,accountId,accountId),
      statement(db,'DELETE FROM sessions WHERE account_id=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND active=0)',accountId,accountId),
      statement(db,`UPDATE orders SET assigned_to=NULL,route_rank=0,updated_at=? WHERE assigned_to=? AND status IN('accepted','packing','ready') AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND active=0)`,time,accountId,accountId),
      audit(db,actor.id,'team.revoke',accountId),
    ])
    if(!updated[0].meta.changes) throw new Problem(409,'Close any in-progress delivery before revoking this account.')
    return c.json({ok:true})
  })

  api.get('/admin/summary',async c=>{
    role(c,'owner','staff')
    const db=c.env.DB, days=I(Number(c.req.query('days')??1),1,30,'report range')
    const since=Math.floor((now()+19800)/DAY)*DAY-19800-(days-1)*DAY
    type Alert={id:string;name:string;stock:number;threshold:number;unit:string;expiry:string|null}
    const [metrics,lowStock,expiry,refunds,cases]=await Promise.all([
      one<Record<string,number>>(db,`SELECT COUNT(*) total,
        COALESCE(SUM(channel='online'),0) online_orders,
        COALESCE(SUM(channel='pos'),0) walk_in,
        COALESCE(SUM(status IN('placed','accepted','packing','ready','out_for_delivery')),0) pending,
        COALESCE(SUM(status='completed'),0) completed,
        COALESCE(SUM(CASE WHEN status='completed' THEN total ELSE 0 END),0) gross,
        COALESCE(SUM(CASE WHEN channel='online' AND fulfillment='pickup' AND payment_method='cash' AND payment_status='cash_collected' THEN total ELSE 0 END),0) pickup_cash,
        COALESCE(SUM(CASE WHEN fulfillment='delivery' AND payment_status='cash_collected' AND reconciled=0 THEN total ELSE 0 END),0) rider_cash
        FROM orders WHERE created_at>=?`,since),
      all<Alert>(db,'SELECT id,name,stock,threshold,unit,expiry FROM products INDEXED BY products_low_stock WHERE active=1 AND stock<=threshold ORDER BY stock,id LIMIT 20'),
      all<Alert>(db,"SELECT id,name,stock,threshold,unit,expiry FROM products INDEXED BY products_upcoming_expiry WHERE active=1 AND expiry IS NOT NULL AND expiry<=date(?,'unixepoch','+330 minutes','+7 day') ORDER BY expiry,id LIMIT 20",now()),
      one<{refunds:number}>(db,'SELECT COALESCE(SUM(amount),0) refunds FROM refunds WHERE created_at>=?',since),
      one<{count:number}>(db,"SELECT COUNT(*) count FROM cases WHERE status='open'"),
    ])
    const alerts=new Map([...expiry,...lowStock].map(row=>[row.id,row]))
    const low=Array.from(alerts.values()).slice(0,20)
    return c.json({metrics,low,refunds:refunds?.refunds??0,cases:cases?.count??0})
  })
  api.get('/admin/report',async c=>{
    role(c,'owner','staff')
    const days=I(Number(c.req.query('days')??7),1,30,'report days')
    const since=Math.floor((now()+19800)/DAY)*DAY-19800-(days-1)*DAY
    return c.json(await all(c.env.DB,`SELECT date(created_at+19800,'unixepoch') day,channel,fulfillment,payment_method,
      COUNT(*) order_count,SUM(total) gross FROM orders
      WHERE status='completed' AND created_at>=? GROUP BY day,channel,fulfillment,payment_method ORDER BY day DESC`,since))
  })
  if(localRoutes)api.route('/',localRoutes)
  else api.route('/',googleAuth)
  api.route('/',catalog)
  api.route('/',orders)
  api.route('/',routing)
  api.route('/',push)
  api.route('/',capacity)
  api.route('/',razorpay)
  api.route('/',checkoutPayments)
  app.route('/api',api)
  app.get('/media/:id',async c=>{
    const file=c.req.param('id'),jpeg=file.endsWith('.jpg'),mime=jpeg?jpegMime:webpMime
    if(!/^[a-f0-9-]{36}(?:\.jpg)?$/.test(file))return c.notFound()
    const asset=c.env.MEDIA_STATIC_ORIGIN
    if(asset){
      try{
        const response=await fetch(asset+'/media/'+file+(jpeg?'':'.webp'),{
          signal:AbortSignal.timeout(1800),redirect:'error',
        })
        if(response.ok&&response.headers.get('Content-Type')?.startsWith(mime)){
          return new Response(response.body,{headers:{
            'Content-Type':mime,'Cache-Control':'public, max-age=86400, immutable','X-Content-Type-Options':'nosniff',
          }})
        }
        await response.body?.cancel()
      }catch{/* Newly uploaded images remain available from the media binding. */}
    }
    const row=await one<{payload:number[]|ArrayBuffer}>(c.env.MEDIA,'SELECT payload FROM media WHERE id=? AND mime=?',mediaFileId('/media/'+file),mime)
    if(!row) return c.notFound()
    return new Response(row.payload instanceof ArrayBuffer?row.payload:new Uint8Array(row.payload),{headers:{'Content-Type':mime,'Cache-Control':'public, max-age=86400, immutable','X-Content-Type-Options':'nosniff'}})
  })
  app.notFound(c=>c.json({error:'Not found.'},404))
  return {
    fetch:app.fetch,
    scheduled(_event:ScheduledController,env:Env['Bindings'],context:ExecutionContext){context.waitUntil(Promise.all([cleanup(env,Boolean(localRoutes)&&env.APP_MODE==='local'),runPaymentMaintenance(env)]))},
  }
}

async function cleanup(env:Env['Bindings'],expireTestPayments:boolean){
  const time=now(),db=env.DB
  await db.batch([
    ...(expireTestPayments?[statement(db,`UPDATE orders SET status='cancelled',payment_status='void',stocked=0,slot_retained=0,updated_at=?
      WHERE id IN (SELECT id FROM orders WHERE status='awaiting_payment' AND created_at<? LIMIT 25)`,time,time-900)]:[]),
    statement(db,'DELETE FROM oauth_requests WHERE state IN (SELECT state FROM oauth_requests WHERE expires_at<? LIMIT 200)',time),
    statement(db,'DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE expires_at<? LIMIT 200)',time),
    statement(db,'DELETE FROM carts WHERE account_id IN (SELECT account_id FROM carts WHERE updated_at<? LIMIT 200)',time-2*DAY),
    statement(db,'DELETE FROM invites WHERE hash IN (SELECT hash FROM invites WHERE expires_at<? LIMIT 200)',time),
    statement(db,'DELETE FROM notices WHERE id IN (SELECT id FROM notices WHERE created_at<? LIMIT 200)',time-2*DAY),
  ])
  const expired=await all<{id:string;mime:string}>(env.MEDIA,'SELECT id,mime FROM media WHERE expires_at<? LIMIT 25',time)
  if(!expired.length)return
  const used=await all<{image:string}>(db,`SELECT image FROM products WHERE image IN (${expired.map(()=>'?').join(',')})`,...expired.map(r=>'/media/'+r.id+(r.mime===jpegMime?'.jpg':'')))
  const retained=new Set(used.map(r=>mediaFileId(r.image)))
  const deletions=expired.filter(r=>!retained.has(r.id)).map(r=>statement(env.MEDIA,'DELETE FROM media WHERE id=? AND expires_at<?',r.id,time))
  if(deletions.length) await env.MEDIA.batch(deletions)
}
