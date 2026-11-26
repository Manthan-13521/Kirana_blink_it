import { Hono } from 'hono'
import { all,now,one,role } from './shared'
import type { Env } from './shared'
import { routingCreditCap } from './routing'
import { pushDailyCap } from './push'

export const capacity=new Hono<Env>()
capacity.get('/admin/capacity',async c=>{
  role(c,'owner')
  const day=Math.floor(now()/86400)
  const [storage,media,services]=await Promise.all([
    c.env.DB.prepare('SELECT 1').all(),
    one<{bytes:number;files:number;uploads:number}>(c.env.MEDIA,'SELECT bytes,files,CASE WHEN day=? THEN uploads ELSE 0 END AS uploads FROM media_usage WHERE id=1',day),
    all<{service:string;used:number}>(c.env.DB,'SELECT service,used FROM service_budget WHERE day=?',day),
  ])
  const measure=(name:string,used:number|null,limit:number)=>({name,used,limit,warning:used!==null&&used>=limit*.8})
  const used=(service:string)=>services.find(row=>row.service===service)?.used??0
  return c.json({measurements:[
    measure('Business database bytes',storage.meta.size_after??null,500_000_000),
    measure('Image payload bytes',media?.bytes??null,201326592),
    measure('Stored image versions',media?.files??null,6500),
    measure('Image uploads today',media?.uploads??null,300),
    measure('Routing credits reserved today',used('routing'),routingCreditCap),
    measure('Google sign-in attempts today',used('google-oauth'),2000),
    measure('Razorpay checkout order attempts today',used('razorpay-order'),c.env.RAZORPAY_MODE==='live'?1200:200),
    measure('Shopper Razorpay status checks today',used('razorpay-customer-status'),480),
    measure('Razorpay test link attempts today',used('razorpay-link'),30),
    measure('Push deliveries attempted today',used('web-push'),pushDailyCap),
  ]})
})
