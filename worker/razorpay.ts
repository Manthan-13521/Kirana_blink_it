import { Hono } from 'hono'
import { all,json,now,one,Problem,role,S,statement } from './shared'
import type { Env } from './shared'
import { reserve } from './budget'
import { applyOrderPaymentEvent } from './checkout-payments'
import { identifier,provider,safePaymentLink,testCredentials,validWebhook } from './payment-provider'

export const razorpay=new Hono<Env>()
const value=100
type Payment={reference:string;owner_id:string;link_id:string|null;url:string|null;payment_id:string|null;refund_id:string|null;amount:number;status:string;created_at:number}
export { validWebhook } from './payment-provider'
const listed='reference,url,amount,status,created_at'
razorpay.get('/admin/payments/test',async c=>{
  const actor=role(c,'owner'), credentials=testCredentials(c.env)
  if(!credentials)return c.json({enabled:false,attempts:[]})
  return c.json({enabled:true,attempts:await all(c.env.DB,`SELECT ${listed} FROM test_payments WHERE owner_id=? ORDER BY created_at DESC LIMIT 10`,actor.id)})
})
razorpay.post('/admin/payments/test',async c=>{
  const actor=role(c,'owner'), credentials=testCredentials(c.env)
  if(!credentials)throw new Problem(503,'Razorpay test credentials are not configured.')
  const data=await json(c), reference=S(data.reference,'test checkout reference',36)
  if(!/^[a-f0-9-]{36}$/.test(reference))throw new Problem(400,'Invalid test checkout reference.')
  const db=c.env.DB
  const existing=await one<Payment>(db,'SELECT * FROM test_payments WHERE reference=? AND owner_id=?',reference,actor.id)
  if(existing&&existing.status!=='creating')return c.json({reference,url:existing.url,status:existing.status})
  if(!await reserve(db,'razorpay-link',1,30,2))throw new Problem(429,'The test payment limit was reached.')
  const created=await statement(db,"INSERT OR IGNORE INTO test_payments(reference,owner_id,amount,status,created_at) VALUES(?,?,?,'creating',?)",reference,actor.id,value,now()).run()
  let link:{id?:string;short_url?:string;reference_id?:string;amount?:number;currency?:string}
  if(created.meta.changes){
    const r=await provider(credentials,'/payment_links',{method:'POST',body:JSON.stringify({
      amount:value,currency:'INR',accept_partial:false,reference_id:reference,description:'Kirana staging · test payment',
      notify:{sms:false,email:false},reminder_enable:false,expire_by:now()+3600,
    })})
    if(r.status===401||r.status===403){
      await statement(db,"UPDATE test_payments SET status='cancelled' WHERE reference=? AND status='creating'",reference).run()
      throw new Problem(503,'Razorpay rejected the test credentials.')
    }
    if(!r.ok)throw new Problem(503,'Razorpay could not create the test link. Retry the same reference to recover it.')
    link=await r.json<typeof link>()
  }else{
    if(!existing)throw new Problem(409,'The test reference is already in use.')
    const r=await provider(credentials,'/payment_links?reference_id='+reference)
    if(!r.ok)throw new Problem(503,'Could not recover the test link.')
    const result=await r.json<{payment_links?:typeof link[]}>()
    const match=result.payment_links?.find(item=>item.reference_id===reference)
    if(!match)throw new Problem(409,'The test link is pending. Check Razorpay before issuing a new reference.')
    link=match
  }
  if(!identifier(link.id,'plink')||!safePaymentLink(link.short_url)||link.reference_id!==reference||link.amount!==value||link.currency!=='INR'){
    throw new Problem(503,'Razorpay returned an unexpected test link.')
  }
  await statement(db,"UPDATE test_payments SET link_id=?,url=?,status='open' WHERE reference=? AND owner_id=? AND status='creating'",
    link.id,link.short_url,reference,actor.id).run()
  return c.json({reference,url:link.short_url,status:'open'})
})
razorpay.post('/admin/payments/test/:reference/refund',async c=>{
  const actor=role(c,'owner'),credentials=testCredentials(c.env)
  if(!credentials)throw new Problem(503,'Razorpay test credentials are not configured.')
  const db=c.env.DB, reference=c.req.param('reference')
  const payment=await one<Payment>(db,'SELECT * FROM test_payments WHERE reference=? AND owner_id=?',reference,actor.id)
  if(!payment||!identifier(payment.payment_id,'pay'))throw new Problem(404,'No captured test payment found.')
  if(payment.status==='refunded')return c.json({status:'refunded'})
  if(!['paid','refunding'].includes(payment.status))throw new Problem(409,'The test payment cannot be refunded.')
  if(!await reserve(db,'razorpay-test',1,30,2))throw new Problem(429,'The test payment limit was reached.')
  await statement(db,"UPDATE test_payments SET status='refunding' WHERE reference=? AND status='paid'",reference).run()
  const r=await provider(credentials,'/payments/'+payment.payment_id+'/refund',{
    method:'POST',headers:{'X-Refund-Idempotency':reference},body:JSON.stringify({amount:value,speed:'normal'}),
  })
  if(!r.ok)throw new Problem(503,'Razorpay has not confirmed this refund. Retry the same refund.')
  const refund=await r.json<{id?:string;payment_id?:string;amount?:number;status?:string}>()
  if(!identifier(refund.id,'rfnd')||refund.payment_id!==payment.payment_id||refund.amount!==value){
    throw new Problem(503,'Razorpay returned an unexpected refund.')
  }
  const status=refund.status==='processed'?'refunded':'refunding'
  await statement(db,"UPDATE test_payments SET refund_id=?,status=? WHERE reference=? AND status='refunding'",
    refund.id,status,reference).run()
  return c.json({status})
})
razorpay.post('/webhooks/razorpay',async c=>{
  const credentials=testCredentials(c.env)
  if(!credentials)throw new Problem(404,'Razorpay staging webhook unavailable.')
  const body=await c.req.arrayBuffer(),signature=c.req.header('X-Razorpay-Signature')??''
  if(!await validWebhook(body,signature,credentials.webhook))throw new Problem(403,'Invalid webhook signature.')
  type Entity={id?:string;reference_id?:string;amount?:number;amount_paid?:number;currency?:string;status?:string;payment_id?:string}
  let event:{event?:string;payload?:Record<string,{entity?:Entity}>}
  try{event=JSON.parse(new TextDecoder().decode(body))}catch{throw new Problem(400,'Invalid webhook body.')}
  const link=event.payload?.payment_link?.entity, payment=event.payload?.payment?.entity, refund=event.payload?.refund?.entity
  const db=c.env.DB
  if(await applyOrderPaymentEvent(db,event))return c.json({ok:true})
  if(event.event==='payment_link.paid'&&identifier(link?.id,'plink')&&identifier(payment?.id,'pay')&&
    link?.amount===value&&link.currency==='INR'&&link.amount_paid===value&&payment?.currency==='INR'&&payment.amount===value&&payment.status==='captured'){
    await statement(db,`UPDATE test_payments SET status='paid',payment_id=?
      WHERE reference=? AND link_id=? AND amount=? AND payment_id IS NULL AND status='open'`,payment.id,link.reference_id??'',link.id,value).run()
  }else if(event.event==='refund.processed'&&identifier(refund?.id,'rfnd')&&identifier(refund?.payment_id,'pay')&&refund?.amount===value){
    await statement(db,"UPDATE test_payments SET refund_id=?,status='refunded' WHERE payment_id=? AND status='refunding' AND (refund_id IS NULL OR refund_id=?)",
      refund.id,refund.payment_id,refund.id).run()
  }else if(identifier(link?.id,'plink')&&['payment_link.cancelled','payment_link.expired'].includes(event.event??'')){
    await statement(db,"UPDATE test_payments SET status=? WHERE link_id=? AND status='open'",event.event==='payment_link.cancelled'?'cancelled':'expired',link.id).run()
  }
  return c.json({ok:true})
})
