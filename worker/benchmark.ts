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
    if(env.APP_MODE!=='benchmark'||!env.BENCHMARK_TOKEN_SHA256||!Number.isFinite(until)||now()>until||
      now()<until-3*3600||!/^Bearer [a-f0-9]{64}$/.test(provided)||
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
    const original=new URL(request.url), local=new URL(original.pathname+original.search,'https://127.0.0.1')
    const headers=new Headers(request.headers)
    headers.delete('Authorization')
    // Bench traffic uses only the isolated fixture database and synthetic identities.
    if(headers.get('Origin')===original.origin)headers.set('Origin',local.origin)
    return qa.fetch(new Request(local,new Request(request,{headers})),{...env,APP_MODE:'local'},context)
  },
}
