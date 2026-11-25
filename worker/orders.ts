import { Hono } from 'hono'
import { all,audit,authorizeOrder,availableSlot,configuredSlot,digest,errorMap,I,id,json,now,one,order,parseLines,Problem,publicOrderFields,role,S,services,shop,shopDayStart,slots,statement,localhost } from './shared'
import type { Address, Ctx, Env, Order, Product } from './shared'

export const orders = new Hono<Env>()
const terminal = new Set(['completed','cancelled','rejected','failed'])
const release = new Set(['rejected','cancelled'])
const profileFields = 'id,label,recipient,phone,line1,locality,landmark,pin,latitude,longitude'
const calculatedTax = (total:number,bps:number)=>Math.round(total*bps/(10000+bps))

async function quote(c:Ctx, data:Record<string,unknown>, pos:boolean, placing=false) {
  const account=role(c,...(pos?['owner','staff'] as const:['customer'] as const))
  const db=c.env.DB
  if(!pos&&c.env.APP_MODE==='staging') throw new Problem(503,'This storefront is a preview. Online orders are closed.')
  const input=parseLines(data.items)
  const { fulfillment, method } = data
  if (pos?fulfillment!=='counter':(fulfillment!=='pickup'&&fulfillment!=='delivery')) throw new Problem(400,'Invalid fulfillment method.')
  if (pos?(method!=='cash'&&method!=='counter_upi'):(method!=='cash'&&method!=='online')) throw new Problem(400,'Invalid payment method.')
  const config=await shop(db)
  if (!pos && !config.accepting) throw new Problem(409,'The store is paused.')
  if (!pos && (method==='online'?!config.enable_online:!config.enable_cod)) throw new Problem(409,'That payment method is unavailable.')
  if (!pos && method==='online' && !localhost(c)) throw new Problem(503,'Online payment provider has not been configured.')
  const products=await all<Product>(db,`SELECT id,sku,name,unit,step,price,stock,min_steps,max_steps,tax_bps,hsn FROM products WHERE id IN (${input.map(()=>'?').join(',')}) AND active=1 AND (expiry IS NULL OR expiry>=date('now','+330 minutes'))`, ...input.map(i=>i.id))
  const byId=new Map(products.map(p=>[p.id,p]))
  const items=input.map(({id,steps})=>{
    const item=byId.get(id)
    if (!item||steps<item.min_steps||steps>item.max_steps||steps*item.step>item.stock) {
      throw new Problem(409,`${item?.name||'A product'} is unavailable in that quantity.`,'stock')
    }
    const total=item.price*steps
    return {id,steps,quantity:steps*item.step,item,total,tax:config.registered?calculatedTax(total,item.tax_bps):0}
  })
  const subtotal=items.reduce((sum,item)=>sum+item.total,0)
  const tax=items.reduce((sum,item)=>sum+item.tax,0)
  if (!pos&&subtotal<config.minimum_order) throw new Problem(400,'The basket is below the store minimum.')
  let address:Address|null=null
  let slot:{start:number;end:number}|null=null
  if (!pos) {
    if (fulfillment==='delivery') {
      const addressId=S(data.addressId,'delivery address',80)
      address=await one<Address>(db,`SELECT ${profileFields} FROM addresses WHERE id=? AND account_id=?`,addressId,account.id)
      if (!address||!services(config,address)) throw new Problem(422,'That address is outside the delivery area. Try store pickup.')
    }
    const requestedSlot=I(data.slot,0,4102444800,'time window')
    slot=configuredSlot(config,requestedSlot)
    // The insert trigger checks capacity atomically with the order and stock writes.
    if (!slot||(!placing&&!await availableSlot(db,config,fulfillment as 'pickup'|'delivery',slot))){
      throw new Problem(409,'Choose the next available window or switch fulfillment.','slot_full')
    }
  }
  const fees=fulfillment==='delivery'&&subtotal<config.free_delivery?config.delivery_fee:0
  const note=S(data.note??'','note',280,false)
  const version=await digest(JSON.stringify({revision:config.revision,items:items.map(i=>[i.id,i.quantity,i.item.price,i.tax]),subtotal,fees,tax,fulfillment,method,address,slot:slot?.start,note}))
  return {config,items,subtotal,tax,fees,total:subtotal+fees,address,slot,fulfillment,method,note,version,account}
}

async function create(c:Ctx,pos:boolean) {
  const data=await json(c)
  const account=role(c,...(pos?['owner','staff'] as const:['customer'] as const))
  const db=c.env.DB
  const key=S(data.key,'checkout ID',80)
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(key)) throw new Problem(400,'Invalid checkout ID.')
  const fingerprint=await digest(JSON.stringify(data))
  const prior=async()=>{
    const current=await one<Pick<Order,'id'|'request_fingerprint'>>(db,'SELECT id,request_fingerprint FROM orders WHERE account_id=? AND request_key=?',account.id,key)
    if (current && current.request_fingerprint!==fingerprint) throw new Problem(409,'This checkout ID belongs to a different basket.')
    return current
  }
  const existing=await prior()
  if(existing) return c.json({id:existing.id,replayed:true})
  const orderId=id()
  try {
    const q=await quote(c,data,pos,true)
    if(data.version!==q.version) throw new Problem(409,'The quote changed. Review the latest total.','quote_changed')
    const time=now()
    const state=pos?'completed':q.method==='online'?'awaiting_payment':'placed'
    const funds=pos?(q.method==='cash'?'cash_collected':'paid'):q.method==='online'?'unpaid':'cash_due'
    const receipt=JSON.stringify({name:q.config.name,address:q.config.address,phone:q.config.phone,gstin:q.config.gstin,registered:q.config.registered,buyer:q.address?.recipient??(pos?'Walk-in customer':account.name)})
    await db.batch([
      statement(db,`INSERT INTO orders(id,account_id,request_key,request_fingerprint,channel,fulfillment,status,payment_method,payment_status,subtotal,fees,total,tax,slot_start,slot_end,address_json,billing_json,note,created_at,updated_at,config_revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,orderId,account.id,key,fingerprint,pos?'pos':'online',q.fulfillment,state,q.method,funds,q.subtotal,q.fees,q.total,q.tax,q.slot?.start??null,q.slot?.end??null,q.address?JSON.stringify(q.address):null,receipt,q.note,time,time,q.config.revision),
      ...q.items.map(({item,quantity,total,tax})=>statement(db,`INSERT INTO order_items(order_id,product_id,sku,name,unit,step,quantity,price,line_total,tax,tax_bps,hsn) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,orderId,item.id,item.sku,item.name,item.unit,item.step,quantity,item.price,total,tax,item.tax_bps,item.hsn)),
      audit(db,account.id,pos?'counter.sale':'order.create',orderId),
    ])
  } catch(e) {
    const concurrent=await prior()
    if(concurrent) return c.json({id:concurrent.id,replayed:true})
    throw errorMap(e)??e
  }
  return c.json({id:orderId},201)
}

orders.post('/quote',async c=>{
  const data=await json(c)
  const q=await quote(c,data,data.fulfillment==='counter')
  return c.json({version:q.version,subtotal:q.subtotal,tax:q.tax,fees:q.fees,total:q.total})
})
orders.post('/orders', c=>create(c,false))
orders.post('/pos', c=>create(c,true))
orders.get('/slots',async c=>{
  const key=c.req.query('mode')
  if(key!=='pickup'&&key!=='delivery') throw new Problem(400,'Select delivery or store pickup.')
  if(c.env.APP_MODE==='staging')return c.json([])
  return c.json(await slots(c.env.DB,await shop(c.env.DB),key))
})
orders.get('/orders',async c=>{
  const account=role(c,'customer','owner','staff','rider')
  const db=c.env.DB
  const where:string[]=[], params:unknown[]=[]
  if(account.role==='customer') { where.push("account_id=? AND channel='online'");params.push(account.id) }
  if(account.role==='rider') { where.push("assigned_to=? AND fulfillment='delivery' AND status NOT IN('rejected','cancelled')");params.push(account.id) }
  const filter=c.req.query('status')
  if(filter&&filter!=='all') { where.push('status=?');params.push(S(filter,'order status',30)) }
  const before=c.req.query('before')
  if(before) {
    const [time,ident]=before.split('.')
    where.push('(created_at,id)<(?,?)');params.push(I(Number(time),0,4102444800,'cursor'),S(ident,'cursor',80))
  }
  const owned=account.role==='owner'||account.role==='staff'
  const rider=account.role==='rider'
  const whereSql=where.length?'WHERE '+where.join(' AND '):''
  const orderBy='created_at DESC,id DESC'
  const address=rider?",CASE WHEN status NOT IN('completed','failed','cancelled','rejected') THEN address_json END AS address_json":owned?',address_json':''
  const results=await all<Record<string,unknown>>(db,`SELECT ${publicOrderFields},route_rank,assigned_to${address}
    FROM orders ${whereSql} ORDER BY ${orderBy} LIMIT 41`,...params)
  const last=results[39]
  return c.json({orders:results.slice(0,40),next:results.length>40?`${last.created_at}.${last.id}`:null})
})
orders.get('/orders/:id',async c=>{
  const account=role(c,'customer','owner','staff','rider'), db=c.env.DB
  const row=await order(db,c.req.param('id'));authorizeOrder(account,row)
  const canAccessContact=account.role!=='rider'||!terminal.has(row.status)
  const [items,events,cases,refunds]=await Promise.all([
    all(db,'SELECT * FROM order_items WHERE order_id=? ORDER BY product_id',row.id),
    all(db,'SELECT status,note,created_at FROM order_events WHERE order_id=? ORDER BY id',row.id),
    account.role==='rider'?[]:all(db,'SELECT id,kind,reason,response,status,created_at FROM cases WHERE order_id=? ORDER BY created_at DESC',row.id),
    account.role==='rider'?[]:all(db,'SELECT amount,created_at FROM refunds WHERE order_id=? ORDER BY created_at DESC',row.id),
  ])
  const sanitized=Object.fromEntries(publicOrderFields.split(',').map(k=>[k,row[k as keyof Order]]))
  return c.json({...sanitized,address:canAccessContact&&row.address_json?JSON.parse(row.address_json):null,invoice:account.role==='rider'?null:JSON.parse(row.billing_json),assigned_to:row.assigned_to,items,events,cases,refunds})
})

const ownerTransitions: Record<string,string[]> = {
  placed:['accepted','rejected','cancelled'],accepted:['packing','cancelled'],packing:['ready','cancelled'],
  ready:['completed','cancelled'],failed:[],
}
const riderTransitions:Record<string,string[]>={ready:['out_for_delivery'],out_for_delivery:['completed','failed']}
orders.post('/orders/:id/state',async c=>{
  const account=role(c,'owner','staff','rider'), db=c.env.DB, data=await json(c)
  const row=await order(db,c.req.param('id'));authorizeOrder(account,row)
  const next=S(data.status,'order status',30), time=now()
  const allowed=account.role==='rider'?riderTransitions:ownerTransitions
  if(!allowed[row.status]?.includes(next)) throw new Problem(409,'That status change is unavailable.')
  if(!release.has(next)&&!['paid','cash_due'].includes(row.payment_status)) throw new Problem(409,'The payment state does not permit fulfillment.')
  if(account.role!=='rider'&&next==='completed'&&row.fulfillment!=='pickup') throw new Problem(409,'The assigned rider must complete delivery.')
  if(account.role==='rider'&&row.fulfillment!=='delivery') throw new Problem(403,'Only delivery orders can be dispatched.')
  const closeCash=next==='completed'&&row.payment_status==='cash_due'
  if(closeCash&&I(data.cash,0,100000000,'cash collected')!==row.total) throw new Problem(409,'Recorded cash must match the order total.')
  if(next==='failed'&&!S(data.reason??'','failure note',280,false)) throw new Problem(400,'Provide a delivery failure reason.')
  const dismiss=release.has(next)
  if(dismiss&&row.payment_status==='paid'&&!localhost(c)) throw new Problem(503,'Refund provider is not configured.')
  const reason=S(data.reason??'','reason',280,false)
  const payment=closeCash?'cash_collected':dismiss&&row.payment_status!=='paid'?'void':row.payment_status
  const update=statement(db,`UPDATE orders SET status=?,payment_status=?,stocked=?,slot_retained=?,updated_at=?
    WHERE id=? AND status=? AND payment_status=? AND (?!='rider' OR assigned_to=?)`,next,payment,dismiss?0:row.stocked,dismiss?0:row.slot_retained,time,row.id,row.status,row.payment_status,account.role,account.id)
  const assertions=[
    statement(db,`UPDATE order_events SET note=? WHERE id=(SELECT id FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 1) AND changes()=1`,reason,row.id),
  ]
  if(dismiss&&row.payment_status==='paid') {
    assertions.push(statement(db,`INSERT INTO refunds(id,order_id,amount,actor,created_at)
      SELECT ?,id,total-COALESCE((SELECT SUM(amount) FROM refunds WHERE order_id=orders.id),0),?,?
      FROM orders WHERE id=? AND status=? AND payment_status='paid' AND changes()=1`,id(),account.id,time,row.id,next))
  }
  const result=await db.batch([update,...assertions])
  if(!result[0].meta.changes) throw new Problem(409,'This order changed. Refresh and try again.')
  return c.json({ok:true})
})

orders.post('/orders/:id/assign',async c=>{
  const actor=role(c,'owner','staff'), db=c.env.DB
  const row=await order(db,c.req.param('id'))
  if(row.fulfillment!=='delivery'||!['accepted','packing','ready'].includes(row.status)) throw new Problem(409,'Assign an active delivery order.')
  const rider=await one<{id:string}>(db,"SELECT id FROM accounts WHERE role='rider' AND active=1")
  if(!rider) throw new Problem(409,'Invite an active rider first.')
  const result=await db.batch([
    statement(db,`UPDATE orders SET assigned_to=?,route_rank=0,updated_at=? WHERE id=? AND status=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND active=1 AND role='rider')`,rider.id,now(),row.id,row.status,rider.id),
    audit(db,actor.id,'delivery.assign',row.id,rider.id),
  ])
  if(!result[0].meta.changes) throw new Problem(409,'Order changed.')
  return c.json({ok:true})
})
orders.post('/orders/:id/reconcile',async c=>{
  const account=role(c,'owner','staff'), db=c.env.DB
  const row=await order(db,c.req.param('id'))
  const result=await db.batch([
    statement(db,`UPDATE orders SET reconciled=1,updated_at=? WHERE id=? AND reconciled=0 AND status='completed' AND payment_status IN ('cash_collected','paid')`,now(),row.id),
    statement(db,"INSERT INTO audit(actor,action,subject,detail,created_at) SELECT ?,'payment.reconcile',?,'',? WHERE changes()=1",account.id,row.id,now()),
  ])
  if(!result[0].meta.changes && !(await order(db,row.id)).reconciled) throw new Problem(409,'Only completed, collected orders can be reconciled.')
  return c.json({ok:true})
})

orders.post('/orders/:id/shortage',async c=>{
  const actor=role(c,'owner','staff'), db=c.env.DB, data=await json(c), orderId=c.req.param('id')
  const productId=S(data.productId,'product',80),reason=S(data.reason,'shortage reason',180)
  const row=await order(db,orderId)
  const item=await one<{name:string}>(db,'SELECT name FROM order_items WHERE order_id=? AND product_id=?',orderId,productId)
  if(!item||!['placed','accepted','packing'].includes(row.status)) throw new Problem(409,'A shortage can only be recorded on an active order item.')
  const note='Item shortage · '+item.name+' · '+reason
  const status=await db.batch([
    statement(db,`INSERT INTO order_events(order_id,status,note,created_at) SELECT id,status,?,? FROM orders WHERE id=? AND status=?`,note,now(),orderId,row.status),
    statement(db,`INSERT INTO notices(account_id,order_id,message,created_at) SELECT account_id,id,?,? FROM orders WHERE id=? AND changes()=1`,note,now(),orderId),
    audit(db,actor.id,'order.shortage',orderId,note),
  ])
  if(!status[0].meta.changes) throw new Problem(409,'The order changed.')
  return c.json({ok:true})
})

orders.post('/orders/:id/cases',async c=>{
  const account=role(c,'customer'), db=c.env.DB, data=await json(c)
  const row=await order(db,c.req.param('id'));authorizeOrder(account,row)
  const kind=S(data.kind,'request type',15), reason=S(data.reason,'reason',400)
  if(!['cancel','return','refund','support'].includes(kind)) throw new Problem(400,'Invalid request type.')
  if(kind==='cancel'&&!['placed','accepted','packing','ready'].includes(row.status)) throw new Problem(409,'Cancellation is unavailable for that order.')
  if(kind==='return'&&row.status!=='completed') throw new Problem(409,'Returns apply to collected or delivered orders.')
  await statement(db,'INSERT INTO cases(id,order_id,kind,reason,created_at,updated_at) VALUES(?,?,?,?,?,?)',id(),row.id,kind,reason,now(),now()).run()
  return c.json({ok:true},201)
})
orders.get('/admin/cases',async c=>{
  role(c,'owner','staff')
  return c.json(await all(c.env.DB,`SELECT cases.*,orders.total,orders.payment_status FROM cases JOIN orders ON orders.id=cases.order_id WHERE cases.status='open' ORDER BY cases.created_at DESC LIMIT 50`))
})
orders.post('/admin/cases/:id',async c=>{
  const account=role(c,'owner','staff'),db=c.env.DB,data=await json(c)
  const caseId=c.req.param('id'), status=S(data.status,'resolution',15), response=S(data.response??'','response',400,false)
  const amount=I(data.amount??0,0,100000000,'refund amount')
  if(!['approved','declined','resolved'].includes(status)||amount&&status!=='approved') throw new Problem(400,'Invalid resolution.')
  const current=await one<{order_id:string;status:string;kind:string}>(db,'SELECT order_id,status,kind FROM cases WHERE id=?',caseId)
  if(!current||current.status!=='open') throw new Problem(409,'That request is closed.')
  const row=await order(db,current.order_id)
  if(current.kind==='cancel'&&status==='approved'){
    if(amount) throw new Problem(400,'Cancellation calculates any refund automatically.')
    if(!['placed','accepted','packing','ready'].includes(row.status)) throw new Problem(409,'That order can no longer be cancelled.')
    if(row.payment_status==='paid'&&!localhost(c)) throw new Problem(503,'Refund provider is not configured.')
    const time=now()
    const result=await db.batch([
      statement(db,`UPDATE orders SET status='cancelled',stocked=0,slot_retained=0,updated_at=?,
        payment_status=CASE WHEN payment_status='cash_due' THEN 'void' ELSE payment_status END
        WHERE id=? AND status=? AND EXISTS(SELECT 1 FROM cases WHERE id=? AND status='open')`,time,row.id,row.status,caseId),
      statement(db,"UPDATE cases SET status='approved',response=?,updated_at=? WHERE id=? AND status='open' AND changes()=1",response,time,caseId),
      statement(db,`INSERT INTO refunds(id,order_id,case_id,amount,actor,created_at)
        SELECT ?,id,?,total-COALESCE((SELECT SUM(amount) FROM refunds WHERE order_id=orders.id),0),?,?
        FROM orders WHERE id=? AND payment_status='paid' AND changes()=1`,id(),caseId,account.id,time,row.id),
      audit(db,account.id,'case.cancel',caseId,response),
    ])
    if(!result[0].meta.changes||!result[1].meta.changes) throw new Problem(409,'The order or request changed.')
    return c.json({ok:true})
  }
  if(amount&&!['completed','failed'].includes(row.status)) throw new Problem(409,'Complete fulfillment or approve cancellation before recording a cash or online refund.')
  if(amount&&row.fulfillment==='delivery'&&row.payment_method==='cash'&&!row.reconciled){
    throw new Problem(409,'Reconcile the rider cash collection before recording a refund.')
  }
  if(amount&&row.payment_method==='online'&&!localhost(c)) throw new Problem(503,'Refund provider is not configured.')
  const time=now()
  const operations:D1PreparedStatement[]=[]
  if(amount) operations.push(statement(db,`INSERT INTO refunds(id,order_id,case_id,amount,actor,created_at)
    SELECT ?,order_id,id,?,?,? FROM cases WHERE id=? AND status='open'`,id(),amount,account.id,time,caseId))
  operations.push(
    statement(db,"UPDATE cases SET status=?,response=?,updated_at=? WHERE id=? AND status='open'",status,response,time,caseId),
    audit(db,account.id,'case.'+status,caseId,response),
  )
  const result=await db.batch(operations)
  if(!result[amount?1:0].meta.changes) throw new Problem(409,'The request changed.')
  return c.json({ok:true})
})

orders.get('/rider/route',async c=>{
  const actor=role(c,'rider','owner'), db=c.env.DB
  const config=await shop(db)
  const rider=actor.role==='rider'?actor:await one<{id:string}>(db,"SELECT id FROM accounts WHERE role='rider' AND active=1")
  const dayStart=shopDayStart(now())
  const [rows,summary]=rider?await Promise.all([
    all<{id:string;route_rank:number;address_json:string;status:string}>(db,`SELECT id,route_rank,address_json,status FROM orders WHERE assigned_to=? AND status IN('ready','out_for_delivery') ORDER BY route_rank,created_at LIMIT 30`,rider.id),
    one<{completed:number;cash:number;active:number}>(db,`SELECT
      (SELECT COUNT(*) FROM order_events AS event INDEXED BY completed_events_recent
       CROSS JOIN orders AS completed ON completed.id=event.order_id
       WHERE event.status='completed' AND event.created_at>=? AND completed.assigned_to=? AND completed.fulfillment='delivery') completed,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE assigned_to=? AND fulfillment='delivery' AND payment_status='cash_collected' AND reconciled=0) cash,
      (SELECT COUNT(*) FROM orders WHERE assigned_to=? AND status IN('ready','out_for_delivery')) active`,dayStart,rider.id,rider.id,rider.id),
  ]):[[],null]
  return c.json({summary:summary??{completed:0,cash:0,active:0},origin:{latitude:config.latitude,longitude:config.longitude},orders:rows.map(row=>({id:row.id,rank:row.route_rank,status:row.status,address:JSON.parse(row.address_json)}))})
})
orders.put('/rider/route',async c=>{
  const actor=role(c,'rider','owner'),db=c.env.DB,data=await json(c)
  const raw=data.orders
  if(!Array.isArray(raw)||raw.length>30) throw new Problem(400,'Invalid route.')
  const ids=raw.map(x=>S(x,'order ID',80))
  if(new Set(ids).size!==ids.length) throw new Problem(400,'Duplicate stop.')
  if(!ids.length) return c.json({ok:true})
  const rider=actor.role==='rider'?actor:await one<{id:string}>(db,"SELECT id FROM accounts WHERE role='rider' AND active=1")
  if(!rider) throw new Problem(409,'No rider is active.')
  const rows=await all<{id:string}>(db,`SELECT id FROM orders WHERE assigned_to=? AND status IN('ready','out_for_delivery') AND id IN (${ids.map(()=>'?').join(',')})`,rider.id,...ids)
  if(rows.length!==ids.length) throw new Problem(403,'One route stop is unavailable.')
  await db.batch(ids.map((orderId,i)=>statement(db,`UPDATE orders SET route_rank=? WHERE id=? AND assigned_to=? AND status IN('ready','out_for_delivery')`,i+1,orderId,rider.id)))
  return c.json({ok:true})
})
