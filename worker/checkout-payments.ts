import { all,now,one,Problem,statement } from './shared'
import type { Env,Order } from './shared'
import { identifier,paymentHoldSeconds,provider,testCredentials,uuid } from './payment-provider'
import type { Credentials,PaymentMode } from './payment-provider'

type Link={link_id:string|null;payment_id:string|null;expires_at:number}
export type Refund={id:string;order_id:string;case_id:string|null;actor:string;amount:number;status:string;provider_id:string|null;payment_id:string;mode:PaymentMode;failed_at:number|null}
export type Entity={id?:string;order_id?:string;reference_id?:string;receipt?:string;amount?:number;amount_paid?:number;currency?:string;status?:string;payment_id?:string;notes?:Record<string,unknown>}
export type PaymentEvent={event?:string;created_at?:number;payload?:Record<string,{entity?:Entity}>}

// Refund scans start with the local job index and join each payment source by its order key.
export const refundSelect=`SELECT r.*,COALESCE(n.payment_id,l.payment_id) AS payment_id,COALESCE(n.mode,'test') AS mode
  FROM order_provider_refunds r
  LEFT JOIN order_checkout_payments n ON n.order_id=r.order_id AND n.payment_id IS NOT NULL
  LEFT JOIN order_payment_links l ON l.order_id=r.order_id AND l.payment_id IS NOT NULL`

export async function applyOrderPaymentEvent(db:D1Database,event:PaymentEvent,time=now()){
  const link=event.payload?.payment_link?.entity,payment=event.payload?.payment?.entity
  const kind=event.event??''
  if(!uuid(link?.reference_id)||!identifier(link?.id,'plink'))return false
  const orderId=link.reference_id
  const stored=await one<Link>(db,'SELECT link_id,payment_id,expires_at FROM order_payment_links WHERE order_id=?',orderId)
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
    SELECT ?,o.id,?,?,?,'queued',?,? FROM orders o
    WHERE o.id=? AND o.status=? AND o.payment_status='paid' AND (
      EXISTS(SELECT 1 FROM order_checkout_payments p WHERE p.order_id=o.id AND p.payment_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM order_payment_links p WHERE p.order_id=o.id AND p.payment_id IS NOT NULL))
    AND (? IS NULL OR EXISTS(SELECT 1 FROM cases WHERE id=? AND order_id=o.id AND status='open'))
    AND ?<=o.total-COALESCE((SELECT SUM(amount) FROM refunds WHERE order_id=o.id),0)
      -COALESCE((SELECT SUM(amount) FROM order_provider_refunds WHERE order_id=o.id AND status<>'processed'),0)`,
    key,request.caseId,actor,request.amount,time,time,row.id,row.status,request.caseId,request.caseId,request.amount)
  const statements=[proposed,statement(db,`INSERT INTO audit(actor,action,subject,detail,created_at)
    SELECT ?,'payment.refund.queue',?,?,? WHERE changes()=1`,actor,row.id,key,time)]
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
    statement(db,`UPDATE order_provider_refunds SET status='processed',provider_id=?,failed_at=NULL WHERE id=? AND status<>'processed'
      AND (provider_id IS NULL OR provider_id=?)`,providerId,job.id,providerId),
    statement(db,`INSERT INTO refunds(id,order_id,case_id,amount,actor,created_at)
      SELECT id,order_id,case_id,amount,actor,? FROM order_provider_refunds WHERE id=? AND changes()=1`,time,job.id),
  ])
}
export async function applyRefundEvent(db:D1Database,kind:string,refund:Entity|undefined,mode:PaymentMode,time:number){
  if(!['refund.created','refund.processed','refund.failed'].includes(kind)||!identifier(refund?.id,'rfnd')||
     !identifier(refund?.payment_id,'pay')||!Number.isSafeInteger(refund?.amount))return false
  const reference=refund?.notes?.kirana_refund
  const job=await one<Refund>(db,`${refundSelect} WHERE r.provider_id=? OR (r.id=? AND r.provider_id IS NULL) LIMIT 1`,refund.id,typeof reference==='string'?reference:'')
  if(!job)return false
  if(job.mode===mode&&job.payment_id===refund.payment_id&&job.amount===refund.amount){
    await updateRefund(db,job,refund.id,kind,time)
  }
  return true
}

async function updateRefund(db:D1Database,job:Refund,id:string,kind:string,time:number){
  if(kind==='refund.processed'){
    await finishRefund(db,job,id,time)
  }else if(kind==='refund.created'){
    await statement(db,`UPDATE order_provider_refunds SET status='submitted',provider_id=?
      WHERE id=? AND status='queued' AND failed_at IS NULL AND (provider_id IS NULL OR provider_id=?)`,id,job.id,id).run()
  }else{
    await statement(db,`UPDATE order_provider_refunds SET status='submitted',provider_id=?,failed_at=?
      WHERE id=? AND status<>'processed' AND failed_at IS NULL AND (provider_id IS NULL OR provider_id=?)`,id,time,job.id,id).run()
  }
}

export async function submitRefund(db:D1Database,job:Refund,credentials:Credentials,time=now()){
  if(credentials.mode!==job.mode||job.failed_at||job.status==='processed'||!identifier(job.payment_id,'pay'))return
  const claimed=await statement(db,`UPDATE order_provider_refunds SET next_attempt=? WHERE id=? AND status<>'processed'
    AND failed_at IS NULL AND next_attempt<=?`,time+(job.mode==='live'?30:600),job.id,time).run()
  if(!claimed.meta.changes)return
  const base='/payments/'+job.payment_id+'/refund'
  const r=job.provider_id&&identifier(job.provider_id,'rfnd')
    ?await provider(credentials,base+'s/'+job.provider_id)
    :await provider(credentials,base,{method:'POST',headers:{'X-Refund-Idempotency':job.id},
      body:JSON.stringify({amount:job.amount,speed:'normal',notes:{kirana_refund:job.id}})})
  if(!r.ok){await r.body?.cancel();throw new Problem(503,'Razorpay has not confirmed this refund. Retry the same refund.')}
  const confirmed=await r.json<Entity>()
  if(!identifier(confirmed.id,'rfnd')||confirmed.payment_id!==job.payment_id||confirmed.amount!==job.amount){
    throw new Problem(503,'Razorpay returned an unexpected refund.')
  }
  await updateRefund(db,job,confirmed.id,confirmed.status==='processed'?'refund.processed':
    confirmed.status==='failed'?'refund.failed':'refund.created',time)
}

export async function runPaymentMaintenance(env:Env['Bindings']){
  if(!['staging','production'].includes(env.APP_MODE??''))return
  const db=env.DB,time=now()
  await statement(db,`UPDATE orders SET status='cancelled',payment_status='void',stocked=0,slot_retained=0,updated_at=?
    WHERE id IN(SELECT id FROM orders WHERE status='awaiting_payment' AND payment_method='online' AND created_at<? LIMIT 25)`,
    time,time-paymentHoldSeconds).run()
  const credentials=testCredentials(env)
  if(!credentials)return
  const jobs=await all<Refund>(db,`${refundSelect}
    WHERE r.status<>'processed' AND r.failed_at IS NULL AND (n.mode='test' OR n.mode IS NULL AND l.payment_id IS NOT NULL)
      AND r.next_attempt<=? ORDER BY r.next_attempt,r.id LIMIT 4`,time)
  await Promise.allSettled(jobs.map(job=>submitRefund(db,job,credentials,time)))
}
