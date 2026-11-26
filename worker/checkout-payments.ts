import { Hono } from 'hono'
import { all,authorizeOrder,now,one,order,Problem,role,statement } from './shared'
import type { Env,Order } from './shared'
import { identifier,provider,safePaymentLink,testCredentials,uuid,validWebhook } from './payment-provider'
import { reserve } from './budget'

export const checkoutPayments=new Hono<Env>()
const holdSeconds=900
type Link={link_id:string|null;url:string|null;payment_id:string|null;expires_at:number}
type ProviderLink={id?:string;short_url?:string;reference_id?:string;amount?:number;currency?:string}
type Refund={id:string;order_id:string;case_id:string|null;actor:string;amount:number;status:string;provider_id:string|null;payment_id:string}
type Entity={id?:string;reference_id?:string;amount?:number;amount_paid?:number;currency?:string;status?:string;payment_id?:string;notes?:Record<string,unknown>}
type Event={event?:string;payload?:Record<string,{entity?:Entity}>}

checkoutPayments.post('/orders/:id/payment-link',async c=>{
  const customer=role(c,'customer'),credentials=testCredentials(c.env),db=c.env.DB
  if(!credentials||!c.get('stagingCheckout')||!c.env.GOOGLE_ORIGIN)throw new Problem(503,'Razorpay Test Mode checkout is unavailable.')
  const row=await order(db,c.req.param('id'));authorizeOrder(customer,row)
  const expires=row.created_at+holdSeconds
  if(row.status!=='awaiting_payment'||row.payment_method!=='online'||row.payment_status!=='unpaid'||now()>=expires){
    throw new Problem(409,'This payment window has closed.')
  }
  const existing=await one<Link>(db,'SELECT link_id,url,payment_id,expires_at FROM order_payment_links WHERE order_id=?',row.id)
  if(existing?.url&&safePaymentLink(existing.url))return c.json({url:existing.url})
  if(row.total<100)throw new Problem(409,'Razorpay Test Mode requires a total of at least ₹1.')
  const inserted=await statement(db,`INSERT OR IGNORE INTO order_payment_links(order_id,expires_at)
    SELECT o.id,? FROM orders o JOIN settings s ON s.id=1 WHERE o.id=? AND o.status='awaiting_payment'
      AND o.payment_status='unpaid' AND o.created_at>? AND s.accepting=1 AND s.enable_online=1
      AND CASE o.fulfillment WHEN 'delivery' THEN s.enable_delivery WHEN 'pickup' THEN s.enable_pickup ELSE 0 END=1`,
    expires,row.id,now()-holdSeconds).run()
  if(!inserted.meta.changes&&!existing)throw new Problem(409,'The payment window or fulfillment method is unavailable. Refresh your order.')
  let link:ProviderLink|undefined
  if(!inserted.meta.changes){
    if(!await reserve(db,'razorpay-recover',1,60))throw new Problem(429,'Payment recovery is busy. Retry shortly.')
    const r=await provider(credentials,'/payment_links?reference_id='+row.id)
    if(!r.ok)throw new Problem(503,'Razorpay has not confirmed this link. Retry shortly.')
    const result=await r.json<ProviderLink&{payment_links?:ProviderLink[]}>()
    link=result.reference_id===row.id?result:result.payment_links?.find(item=>item.reference_id===row.id)
    if(!link&&result.payment_links?.length!==0)throw new Problem(503,'Razorpay returned an unexpected payment link.')
  }
  if(!link){
    // The provider enforces unique reference IDs across create retries.
    if(!await reserve(db,'razorpay-link',1,30))throw new Problem(429,'The daily payment test limit was reached.')
    const response=await provider(credentials,'/payment_links',{
      method:'POST',body:JSON.stringify({amount:row.total,currency:'INR',accept_partial:false,reference_id:row.id,expire_by:expires,
        description:'Kirana staging order (test only)',notify:{email:false,sms:false},reminder_enable:false,
        callback_url:c.env.GOOGLE_ORIGIN+'/api/payments/return/'+row.id,callback_method:'get'}),
    })
    if(response.ok)link=await response.json<ProviderLink>()
  }
  if(!link||!identifier(link.id,'plink')||!safePaymentLink(link.short_url)||link.reference_id!==row.id||link.amount!==row.total||link.currency!=='INR'){
    throw new Problem(503,'The payment link is pending. Retry this order to recover it.')
  }
  const saved=await statement(db,`UPDATE order_payment_links SET link_id=?,url=? WHERE order_id=?
    AND (link_id IS NULL OR link_id=?) AND expires_at>? AND payment_id IS NULL
    AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status='awaiting_payment')`,link.id,link.short_url,row.id,link.id,now(),row.id).run()
  if(!saved.meta.changes)throw new Problem(409,'This payment window has closed.')
  return c.json({url:link.short_url})
})

checkoutPayments.get('/payments/return/:id',async c=>{
  const credentials=testCredentials(c.env),id=c.req.param('id')
  if(!credentials||!uuid(id))throw new Problem(404,'Payment return is unavailable.')
  const link=c.req.query('razorpay_payment_link_id'),reference=c.req.query('razorpay_payment_link_reference_id')
  const payment=c.req.query('razorpay_payment_id'),state=c.req.query('razorpay_payment_link_status')
  const record=await one<Link>(c.env.DB,'SELECT link_id FROM order_payment_links WHERE order_id=?',id)
  if(!record||reference!==id||record.link_id!==link||!identifier(link,'plink')||!identifier(payment,'pay')||state!=='paid'||
     !await validWebhook(new TextEncoder().encode([link,reference,state,payment].join('|')).buffer,c.req.query('razorpay_signature')??'',credentials.secret)){
    return c.redirect('/?payment=review',303)
  }
  // The signed return only opens the receipt. A signed captured-payment event changes the ledger.
  return c.redirect('/?order='+id,303)
})

export async function applyOrderPaymentEvent(db:D1Database,event:Event,time=now()){
  const link=event.payload?.payment_link?.entity,payment=event.payload?.payment?.entity,refund=event.payload?.refund?.entity
  const kind=event.event??''
  if(kind==='refund.processed'&&identifier(refund?.id,'rfnd')&&identifier(refund?.payment_id,'pay')&&typeof refund?.amount==='number'){
    const reference=refund.notes?.kirana_refund
    const job=await one<Refund>(db,`SELECT r.*,p.payment_id FROM order_provider_refunds r JOIN order_payment_links p ON p.order_id=r.order_id
      WHERE r.id=? OR r.provider_id=? LIMIT 1`,typeof reference==='string'?reference:'',refund.id)
    if(!job)return false
    if(job.payment_id===refund.payment_id&&job.amount===refund.amount)await finishRefund(db,job,refund.id,time)
    return true
  }
  if(!uuid(link?.reference_id)||!identifier(link?.id,'plink'))return false
  const orderId=link.reference_id
  const stored=await one<Link>(db,'SELECT link_id,url,payment_id,expires_at FROM order_payment_links WHERE order_id=?',orderId)
  if(!stored||stored.link_id!==link.id)return false
  if(kind==='payment_link.paid'&&identifier(payment?.id,'pay')&&payment.status==='captured'&&payment.currency==='INR'&&link.currency==='INR'&&
     Number.isSafeInteger(payment.amount)&&payment.amount===link.amount&&payment.amount===link.amount_paid){
    const timely=Number(time<stored.expires_at)
    await db.batch([
      statement(db,`UPDATE order_payment_links SET payment_id=?,captured_at=? WHERE order_id=? AND link_id=? AND payment_id IS NULL
        AND EXISTS(SELECT 1 FROM orders WHERE id=? AND total=? AND payment_method='online' AND status IN('awaiting_payment','cancelled','rejected'))`,
        payment.id,time,orderId,link.id,orderId,payment.amount),
      statement(db,`UPDATE orders SET
        status=CASE WHEN status='awaiting_payment' AND ?=1 THEN 'placed' WHEN status='awaiting_payment' THEN 'cancelled' ELSE status END,
        stocked=CASE WHEN status='awaiting_payment' AND ?=1 THEN stocked ELSE 0 END,
        slot_retained=CASE WHEN status='awaiting_payment' AND ?=1 THEN slot_retained ELSE 0 END,
        payment_status='paid',updated_at=? WHERE id=? AND changes()=1`,timely,timely,timely,time,orderId),
      statement(db,`INSERT INTO order_provider_refunds(id,order_id,actor,amount,status,next_attempt,created_at)
        SELECT 'late-'||id,id,account_id,total,'queued',?,? FROM orders
        WHERE id=? AND status IN('cancelled','rejected') AND changes()=1`,time,time,orderId),
    ])
  }else if(['payment_link.cancelled','payment_link.expired'].includes(kind)){
    await statement(db,`UPDATE orders SET status='cancelled',payment_status='void',stocked=0,slot_retained=0,updated_at=?
      WHERE id=? AND status='awaiting_payment' AND payment_status='unpaid'`,time,orderId).run()
  }
  return true
}

export async function queueOrderRefund(db:D1Database,row:Order,actor:string,request:{
  caseId:string|null;amount:number;cancel?:'cancelled'|'rejected';response?:string
}){
  const key=request.caseId??'cancel-'+row.id,time=now()
  const proposed=statement(db,`INSERT OR IGNORE INTO order_provider_refunds(id,order_id,case_id,actor,amount,status,next_attempt,created_at)
    SELECT ?,o.id,?,?,?,'queued',?,? FROM orders o JOIN order_payment_links p ON p.order_id=o.id
    WHERE o.id=? AND o.status=? AND o.payment_status='paid' AND p.payment_id IS NOT NULL
    AND (? IS NULL OR EXISTS(SELECT 1 FROM cases WHERE id=? AND order_id=o.id AND status='open'))
    AND ?<=o.total-COALESCE((SELECT SUM(amount) FROM refunds WHERE order_id=o.id),0)
      -COALESCE((SELECT SUM(amount) FROM order_provider_refunds WHERE order_id=o.id AND status<>'processed'),0)`,
    key,request.caseId,actor,request.amount,time,time,row.id,row.status,request.caseId,request.caseId,request.amount)
  const statements=[proposed]
  if(request.cancel)statements.push(statement(db,`UPDATE orders SET status=?,stocked=0,slot_retained=0,updated_at=?
    WHERE id=? AND status=? AND changes()=1`,request.cancel,time,row.id,row.status))
  if(!request.caseId&&request.response)statements.push(statement(db,`UPDATE order_events SET note=? WHERE id=(
    SELECT id FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 1) AND changes()=1`,request.response,row.id))
  if(request.caseId)statements.push(statement(db,`UPDATE cases SET status='approved',response=?,updated_at=?
    WHERE id=? AND status='open' AND changes()=1`,request.response??'',time,request.caseId))
  const result=await db.batch(statements)
  if(!result[0].meta.changes)throw new Problem(409,'The order state or refundable amount changed.')
}

export async function finishRefund(db:D1Database,job:Refund,providerId:string,time:number){
  await db.batch([
    statement(db,`UPDATE order_provider_refunds SET status='processed',provider_id=? WHERE id=? AND status<>'processed'
      AND (provider_id IS NULL OR provider_id=?)`,providerId,job.id,providerId),
    statement(db,`INSERT INTO refunds(id,order_id,case_id,amount,actor,created_at)
      SELECT id,order_id,case_id,amount,actor,? FROM order_provider_refunds WHERE id=? AND changes()=1`,time,job.id),
  ])
}
export async function runPaymentMaintenance(env:Env['Bindings']){
  if(env.APP_MODE!=='staging')return
  const db=env.DB,time=now()
  await statement(db,`UPDATE orders SET status='cancelled',payment_status='void',stocked=0,slot_retained=0,updated_at=?
    WHERE id IN(SELECT id FROM orders WHERE status='awaiting_payment' AND payment_method='online' AND created_at<? LIMIT 25)`,
    time,time-holdSeconds).run()
  const credentials=testCredentials(env)
  if(!credentials)return
  const jobs=await all<Refund>(db,`SELECT r.*,p.payment_id FROM order_provider_refunds r JOIN order_payment_links p ON p.order_id=r.order_id
    WHERE r.status<>'processed' AND r.next_attempt<=? ORDER BY r.next_attempt,r.id LIMIT 4`,time)
  await Promise.allSettled(jobs.map(async job=>{
    const claimed=await statement(db,`UPDATE order_provider_refunds SET next_attempt=? WHERE id=? AND status<>'processed' AND next_attempt<=?`,
      time+600,job.id,time).run()
    if(!claimed.meta.changes||!identifier(job.payment_id,'pay'))return
    const base='/payments/'+job.payment_id+'/refund'
    const r=job.provider_id&&identifier(job.provider_id,'rfnd')
      ?await provider(credentials,base+'s/'+job.provider_id)
      :await provider(credentials,base,{method:'POST',headers:{'X-Refund-Idempotency':job.id},
        body:JSON.stringify({amount:job.amount,speed:'normal',notes:{kirana_refund:job.id}})})
    if(!r.ok){await r.body?.cancel();return}
    const confirmed=await r.json<Entity>()
    if(!identifier(confirmed.id,'rfnd')||confirmed.payment_id!==job.payment_id||confirmed.amount!==job.amount)return
    if(confirmed.status==='processed')await finishRefund(db,job,confirmed.id,time)
    else await statement(db,"UPDATE order_provider_refunds SET status='submitted',provider_id=? WHERE id=? AND status<>'processed'",confirmed.id,job.id).run()
  }))
}
