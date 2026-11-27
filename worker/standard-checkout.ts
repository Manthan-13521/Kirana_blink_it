import { Hono } from 'hono'
import { authorizeOrder,checkoutAccess,json,now,one,order,Problem,role,statement } from './shared'
import type { Ctx,Env } from './shared'
import { applyRefundEvent,refundSelect,submitRefund } from './checkout-payments'
import type { Entity,PaymentEvent,Refund } from './checkout-payments'
import { checkoutCredentials,identifier,paymentCredentials,paymentHoldSeconds,provider,uuid,validWebhook } from './payment-provider'
import type { Credentials,PaymentMode } from './payment-provider'
import { reserve } from './budget'

type Intent={order_id:string;provider_order_id:string|null;payment_id:string|null;mode:PaymentMode;expires_at:number;checkout_config_id:string|null}
const encoder=new TextEncoder()
const pendingSql=`o.status='awaiting_payment' AND o.payment_status='unpaid' AND s.accepting=1 AND s.enable_online=1
    AND CASE o.fulfillment WHEN 'delivery' THEN s.enable_delivery WHEN 'pickup' THEN s.enable_pickup ELSE 0 END=1`
export const checkoutPayments=new Hono<Env>()

checkoutPayments.post('/orders/:id/payment',async c=>{
  const customer=role(c,'customer'),credentials=checkoutCredentials(c.env),db=c.env.DB
  if(!credentials||!checkoutAccess(c))throw new Problem(503,'Online payment is unavailable.')
  const row=await order(db,c.req.param('id'));authorizeOrder(customer,row)
  const time=now(),expires=row.created_at+paymentHoldSeconds
  if(row.status!=='awaiting_payment'||row.payment_method!=='online'||row.payment_status!=='unpaid'||expires<=time||row.total<100){
    throw new Problem(409,'This payment window has closed.')
  }
  const details=(providerOrderId:string)=>c.json({
    key:credentials.key,orderId:providerOrderId,amount:row.total,currency:'INR',mode:credentials.mode,
  })
  const stored=await one<Intent&{can_start:number}>(db,`SELECT p.*,(${pendingSql}) AS can_start FROM orders o
    JOIN settings s ON s.id=1 LEFT JOIN order_checkout_payments p ON p.order_id=o.id WHERE o.id=?`,row.id)
  if(!stored?.can_start)throw new Problem(409,'This payment window has closed or the store changed its checkout settings.')
  if(stored.order_id&&(stored.mode!==credentials.mode||stored.checkout_config_id!==credentials.checkoutConfig))throw new Problem(409,'The payment configuration changed. Start a fresh order after this payment window closes.')
  if(stored.provider_order_id)return details(stored.provider_order_id)
  const inserted=await statement(db,`INSERT OR IGNORE INTO order_checkout_payments(order_id,mode,expires_at,checkout_config_id)
    SELECT o.id,?,?,? FROM orders o JOIN settings s ON s.id=1 WHERE o.id=? AND ${pendingSql}
    AND NOT EXISTS(SELECT 1 FROM order_payment_links l WHERE l.order_id=o.id AND l.link_id IS NOT NULL)`,
    credentials.mode,expires,credentials.checkoutConfig,row.id).run()
  const claimed=await statement(db,`UPDATE order_checkout_payments SET next_create_at=?
    WHERE order_id=? AND mode=? AND checkout_config_id IS ? AND expires_at>? AND next_create_at<=? AND provider_order_id IS NULL
      AND EXISTS(SELECT 1 FROM orders o JOIN settings s ON s.id=1 WHERE o.id=? AND ${pendingSql})`,
    time+12,row.id,credentials.mode,credentials.checkoutConfig,time,time,row.id).run()
  if(!claimed.meta.changes)throw new Problem(409,'Checkout is being prepared or the payment window has closed. Refresh this order before retrying.')
  if(!await reserve(db,'razorpay-order',1,credentials.mode==='test'?200:1200)){
    throw new Problem(429,'The online payment limit was reached. Try again later.')
  }
  let razorOrder:Entity|undefined
  if(!inserted.meta.changes){
    const r=await provider(credentials,'/orders?receipt='+row.id+'&count=2')
    if(!r.ok)throw new Problem(503,'Razorpay has not confirmed this order. Retry shortly.')
    const {items}=await r.json<{items?:Entity[]}>()
    if(!Array.isArray(items)||items.length>1||items.some(item=>item.receipt!==row.id)){
      throw new Problem(503,'Razorpay returned an unexpected order.')
    }
    razorOrder=items[0]
  }
  if(!razorOrder){
    // Razorpay treats this receipt as unique, including when a previous response was lost.
    const r=await provider(credentials,'/orders',{
      method:'POST',body:JSON.stringify({amount:row.total,currency:'INR',receipt:row.id,partial_payment:false,
        ...(credentials.checkoutConfig?{checkout_config_id:credentials.checkoutConfig,
          notes:{kirana_checkout_config:credentials.checkoutConfig}}:{}),
      }),
    })
    if(r.ok)razorOrder=await r.json<Entity>()
  }
  if(!identifier(razorOrder?.id,'order')||razorOrder?.amount!==row.total||razorOrder.currency!=='INR'||razorOrder.receipt!==row.id||
     credentials.checkoutConfig&&razorOrder.notes?.kirana_checkout_config!==credentials.checkoutConfig){
    throw new Problem(503,'Razorpay has not confirmed this order. Retry shortly.')
  }
  const saved=await statement(db,`UPDATE order_checkout_payments SET provider_order_id=? WHERE order_id=?
    AND provider_order_id IS NULL AND mode=?`,razorOrder.id,row.id,credentials.mode).run()
  if(!saved.meta.changes)throw new Problem(409,'Checkout is already being prepared. Refresh this order.')
  if(razorOrder.status==='paid'||now()>=expires||
    !await one(db,`SELECT 1 FROM orders o JOIN settings s ON s.id=1 WHERE o.id=? AND ${pendingSql}`,row.id)){
    throw new Problem(409,'This checkout is closed or awaiting confirmation. Check the order status before retrying.')
  }
  return details(razorOrder.id)
})

export function validCheckoutSignature(orderId:string,paymentId:string,signature:string,secret:string){
  return validWebhook(encoder.encode(orderId+'|'+paymentId).buffer,signature,secret)
}

checkoutPayments.post('/orders/:id/payment/verify',async c=>{
  const customer=role(c,'customer'),credentials=paymentCredentials(c.env),db=c.env.DB
  if(!credentials)throw new Problem(503,'Online payment verification is unavailable.')
  const row=await order(db,c.req.param('id'));authorizeOrder(customer,row)
  const result=await json(c)
  const intent=await one<Intent>(db,'SELECT * FROM order_checkout_payments WHERE order_id=?',row.id)
  if(!intent||intent.mode!==credentials.mode||!identifier(intent.provider_order_id,'order')||
     result.razorpay_order_id!==intent.provider_order_id||!identifier(result.razorpay_payment_id,'pay')||
     typeof result.razorpay_signature!=='string'||
     !await validCheckoutSignature(intent.provider_order_id,result.razorpay_payment_id,result.razorpay_signature,credentials.secret)){
    throw new Problem(403,'Payment could not be verified.')
  }
  if(intent.payment_id===result.razorpay_payment_id)return c.json({state:['cancelled','rejected'].includes(row.status)?'refund_review':'confirmed'})
  if(intent.payment_id)throw new Problem(409,'A different payment is already recorded for this order.')
  if(!await reserve(db,'razorpay-verify',1,2400))throw new Problem(429,'Payment verification is busy. Check your order status shortly.')
  const r=await provider(credentials,'/payments/'+result.razorpay_payment_id)
  if(!r.ok)throw new Problem(503,'Razorpay has not confirmed this payment. Check your order status shortly.')
  const payment=await r.json<Entity>()
  if(payment.id!==result.razorpay_payment_id||payment.order_id!==intent.provider_order_id||
    payment.amount!==row.total||payment.currency!=='INR')throw new Problem(403,'Payment could not be verified.')
  if(payment.status!=='captured')return c.json({state:'pending'},202)
  if(!await captureRecorded(db,payment,credentials.mode,row.id))throw new Problem(409,'Payment needs reconciliation. Check this order before retrying.')
  const current=await order(db,row.id)
  return c.json({state:current.status==='awaiting_payment'?'pending':['cancelled','rejected'].includes(current.status)?'refund_review':'confirmed'})
})

checkoutPayments.post('/orders/:id/payment/cancel',async c=>{
  const customer=role(c,'customer'),db=c.env.DB
  const row=await order(db,c.req.param('id'));authorizeOrder(customer,row)
  const cancelled=await statement(db,`UPDATE orders SET status='cancelled',payment_status='void',stocked=0,slot_retained=0,updated_at=?
    WHERE id=? AND status='awaiting_payment' AND payment_method='online' AND payment_status='unpaid'`,now(),row.id).run()
  if(!cancelled.meta.changes&&!(row.status==='cancelled'&&row.payment_status==='void'))throw new Problem(409,'The payment or order status changed. Refresh this order.')
  return c.json({ok:true})
})

export async function applyCapturedPayment(db:D1Database,payment:Entity,mode:PaymentMode,time=now(),eventTime?:number){
  if(!identifier(payment.id,'pay')||!identifier(payment.order_id,'order')||payment.status!=='captured'||
     payment.currency!=='INR'||!Number.isSafeInteger(payment.amount))return false
  const intent=await one<Intent>(db,`SELECT * FROM order_checkout_payments
    WHERE provider_order_id=? AND mode=? AND payment_id IS NULL`,payment.order_id,mode)
  if(!intent)return false
  // Use the signed capture event time when available. Browser proofs and
  // provider lookups cannot establish the original capture time.
  const captureTime=typeof eventTime==='number'&&Number.isSafeInteger(eventTime)&&
    eventTime>=intent.expires_at-paymentHoldSeconds&&eventTime<=time?eventTime:time
  const timely=Number(captureTime<intent.expires_at)
  const applied=await db.batch([
    statement(db,`UPDATE order_checkout_payments SET payment_id=?,captured_at=? WHERE order_id=? AND mode=? AND payment_id IS NULL
      AND EXISTS(SELECT 1 FROM orders WHERE id=? AND total=? AND payment_method='online' AND status IN('awaiting_payment','cancelled','rejected'))`,
      payment.id,captureTime,intent.order_id,mode,intent.order_id,payment.amount),
    statement(db,`UPDATE orders SET
      status=CASE WHEN status='awaiting_payment' AND ?=1 THEN 'placed' WHEN status='awaiting_payment' THEN 'cancelled' ELSE status END,
      stocked=CASE WHEN status='awaiting_payment' AND ?=1 THEN stocked ELSE 0 END,
      slot_retained=CASE WHEN status='awaiting_payment' AND ?=1 THEN slot_retained ELSE 0 END,
      payment_status='paid',updated_at=? WHERE id=? AND changes()=1`,timely,timely,timely,time,intent.order_id),
    statement(db,`INSERT INTO order_provider_refunds(id,order_id,actor,amount,status,next_attempt,created_at)
      SELECT 'late-'||id,id,account_id,total,'queued',?,? FROM orders
      WHERE id=? AND status IN('cancelled','rejected') AND changes()=1`,time,time,intent.order_id),
  ])
  return Boolean(applied[0].meta.changes)
}

async function captureRecorded(db:D1Database,payment:Entity,mode:PaymentMode,orderId:string){
  return await applyCapturedPayment(db,payment,mode)||Boolean(await one(db,
    'SELECT 1 FROM order_checkout_payments WHERE order_id=? AND mode=? AND payment_id=?',orderId,mode,payment.id??''))
}

async function fetchCapturedPayment(credentials:Credentials,orderId:string){
  const r=await provider(credentials,'/orders/'+orderId+'/payments')
  if(!r.ok)throw new Problem(503,'Razorpay payment reconciliation is pending.')
  const {items}=await r.json<{items?:Entity[]}>()
  if(!Array.isArray(items))throw new Problem(503,'Razorpay returned an unexpected payment response.')
  return items.find(p=>p?.order_id===orderId&&p.status==='captured')
}

async function reconcilePayment(c:Ctx,access:'owner'|'customer',id:string){
  const actor=role(c,access)
  const credentials=paymentCredentials(c.env),db=c.env.DB
  if(!credentials)throw new Problem(503,'Razorpay is not configured.')
  const row=await order(db,id)
  authorizeOrder(actor,row)
  const intent=await one<Intent>(db,'SELECT * FROM order_checkout_payments WHERE order_id=?',row.id)
  if(intent?.mode!==credentials.mode||!identifier(intent.provider_order_id,'order'))throw new Problem(404,'Razorpay order not found.')
  if(intent.payment_id)return c.json({verified:true})
  const customer=access==='customer'
  if(!await reserve(db,customer?'razorpay-customer-status':'razorpay-reconcile',1,customer?480:240,customer?1:0)){
    throw new Problem(429,'Payment reconciliation is busy. Try again later.')
  }
  const captured=await fetchCapturedPayment(credentials,intent.provider_order_id)
  if(!captured)return c.json({verified:false},202)
  if(!identifier(captured.id,'pay')||captured.amount!==row.total||captured.currency!=='INR'||
    !await captureRecorded(db,captured,credentials.mode,row.id))throw new Problem(409,'Razorpay payment details require review.')
  return c.json({verified:true})
}
checkoutPayments.post('/admin/orders/:id/payment/reconcile',c=>reconcilePayment(c,'owner',c.req.param('id')))
checkoutPayments.post('/orders/:id/payment/reconcile',c=>reconcilePayment(c,'customer',c.req.param('id')))

async function recordWebhookCapture(db:D1Database,payment:Entity,mode:PaymentMode,time:number,eventTime?:number){
  const applied=await applyCapturedPayment(db,payment,mode,time,eventTime)
  // Keep provider IDs, body bytes, signatures and customer data out of telemetry.
  console.info({event:'razorpay.capture.webhook',mode,applied})
}

export async function applyStandardEvent(db:D1Database,event:PaymentEvent,credentials:Credentials,time=now()){
  const kind=event.event??'',payment=event.payload?.payment?.entity,razorOrder=event.payload?.order?.entity
  if(kind==='payment.captured'){
    if(payment)await recordWebhookCapture(db,payment,credentials.mode,time,event.created_at)
    return true
  }
  if(kind==='order.paid'){
    if(payment&&(!razorOrder||razorOrder.id===payment.order_id)){
      await recordWebhookCapture(db,payment,credentials.mode,time,event.created_at)
    }else if(!payment&&identifier(razorOrder?.id,'order')&&razorOrder?.currency==='INR'&&razorOrder?.status==='paid'&&
      await one(db,'SELECT 1 FROM order_checkout_payments WHERE provider_order_id=? AND mode=? AND payment_id IS NULL',razorOrder.id,credentials.mode)){
      const captured=await fetchCapturedPayment(credentials,razorOrder.id)
      if(!captured)throw new Problem(503,'Razorpay payment reconciliation is pending.')
      await recordWebhookCapture(db,captured,credentials.mode,time,event.created_at)
    }
    return true
  }
  if(kind==='payment.failed'){
    if(identifier(payment?.order_id,'order')&&identifier(payment?.id,'pay')&&payment?.status==='failed'){
      await statement(db,`UPDATE order_checkout_payments SET failed_at=? WHERE provider_order_id=? AND mode=?
        AND payment_id IS NULL AND failed_at IS NULL`,time,payment.order_id,credentials.mode).run()
    }
    return true
  }
  return applyRefundEvent(db,kind,event.payload?.refund?.entity,credentials.mode,time)
}

checkoutPayments.post('/admin/payments/refunds/:id/submit',async c=>{
  role(c,'owner')
  const credentials=paymentCredentials(c.env),db=c.env.DB
  if(credentials?.mode!=='live'||c.env.RAZORPAY_LIVE_REFUNDS!=='enabled'){
    throw new Problem(503,'Live refund submission is disabled.')
  }
  const id=c.req.param('id')
  if(!uuid(id.replace(/^(late|cancel)-/,'')))throw new Problem(404,'Refund not found.')
  const job=await one<Refund>(db,`${refundSelect} WHERE r.id=? AND n.mode='live'`,id)
  if(!job)throw new Problem(404,'Refund not found.')
  if(job.failed_at)throw new Problem(409,'Razorpay reported a failed refund. Review it in the merchant dashboard.')
  await submitRefund(db,job,credentials)
  return c.json({ok:true})
})
