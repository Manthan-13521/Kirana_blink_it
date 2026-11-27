// Dedicated synthetic test entrypoint. Never included in a store release.
import qa from './qa'
import { digest,now } from './shared'
import type { Env } from './shared'

type Bindings=Env['Bindings']&{BENCHMARK_TOKEN_SHA256?:string;BENCHMARK_UNTIL?:string}
export default {
  async fetch(request:Request,env:Bindings,context:ExecutionContext){
    const provided=request.headers.get('Authorization')??''
    const until=Number(env.BENCHMARK_UNTIL)
    const path=new URL(request.url).pathname
    const time=now()
    if(env.APP_MODE!=='benchmark'||!env.BENCHMARK_TOKEN_SHA256||!Number.isFinite(until)||time>=until||
      time<until-5*3600||!/^Bearer [a-f0-9]{64}$/.test(provided)||
      await digest(provided.slice(7))!==env.BENCHMARK_TOKEN_SHA256||!/^\/(api|media)\//.test(path)){
      return new Response('Not found',{status:404})
    }
    if(request.method==='GET'&&path==='/api/__benchmark/catalog-size'){
      const result=await env.DB.prepare('SELECT COUNT(*) AS total FROM products').all<{total:number}>()
      return Response.json(result.results[0],{headers:{
        'Cache-Control':'no-store',
        'X-Kirana-D1':JSON.stringify({reads:result.meta.rows_read??0,writes:0,statements:1}),
      }})
    }
    if(request.method==='GET'&&path==='/api/__benchmark/integrity'){
      const results=await env.DB.batch([
        env.DB.prepare('SELECT COUNT(*) AS skus,COALESCE(MIN(stock),0) AS minStock,COALESCE(SUM(stock),0) AS stockUnits FROM products WHERE active=1'),
        env.DB.prepare(`SELECT SUM(status='completed' AND channel='online') AS online,
          SUM(status='completed' AND channel='pos') AS counter,
          SUM(status='awaiting_payment') AS pending,
          SUM(status='completed' AND payment_status NOT IN ('paid','cash_collected','refunded')) AS paymentMismatch,
          SUM(status='completed' AND fulfillment='delivery' AND payment_status='cash_collected' AND reconciled=0) AS cashUnreconciled
          FROM orders`),
        env.DB.prepare(`SELECT COUNT(*) AS badTotals FROM orders o WHERE o.subtotal<>(
          SELECT COALESCE(SUM(i.line_total),0) FROM order_items i WHERE i.order_id=o.id
        ) OR o.total<>o.subtotal+o.fees`),
        env.DB.prepare(`SELECT COUNT(*) AS duplicateCompletions FROM (
          SELECT order_id FROM order_events WHERE status='completed' GROUP BY order_id HAVING COUNT(*)>1
        )`),
      ])
      const metrics=Object.assign({},...results.map(row=>row.results[0]))
      return Response.json({...metrics,sizeBytes:results[0].meta.size_after??null},{headers:{
        'Cache-Control':'no-store',
        'X-Kirana-D1':JSON.stringify({
          reads:results.reduce((total,row)=>total+(row.meta.rows_read??0),0),
          writes:results.reduce((total,row)=>total+(row.meta.rows_written??0),0),statements:results.length,
        }),
      }})
    }
    const original=new URL(request.url), local=new URL(original.pathname+original.search,'https://127.0.0.1')
    const headers=new Headers(request.headers)
    headers.delete('Authorization')
    // Bench traffic uses only the isolated fixture database and synthetic identities.
    if(headers.get('Origin')===original.origin)headers.set('Origin',local.origin)
    return qa.fetch(new Request(local,new Request(request,{headers})),{...env,APP_MODE:'local'},context)
  },
}
