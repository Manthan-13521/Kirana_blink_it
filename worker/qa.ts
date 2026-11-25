// Used only by the disposable loopback benchmark. The release excludes this entry.
import { application } from './app'
import { localRoutes } from './local-integrations'
import type { Env } from './shared'

type Count = { reads:number; writes:number; statements:number }
const app=application(localRoutes)
function instrument(db:D1Database, count:Count):D1Database {
  const original=new WeakMap<D1PreparedStatement,D1PreparedStatement>()
  const add=<T>(result:D1Result<T>)=>{
    count.reads+=result.meta.rows_read??0
    count.writes+=result.meta.rows_written??0
    count.statements++
    return result
  }
  const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>{
    const proxy=new Proxy(stmt,{
      get(target,prop,receiver){
        if(prop==='bind')return (...params:unknown[])=>wrap(target.bind(...params))
        if(prop==='first')return async(column?:string)=>{
          const response=add(await target.all<Record<string,unknown>>())
          const row=response.results[0]
          return column?row?.[column]??null:row??null
        }
        if(prop==='run'||prop==='all')return async()=>add(await target[prop]())
        const value=Reflect.get(target,prop,receiver)
        return typeof value==='function'?value.bind(target):value
      },
    })
    original.set(proxy,stmt)
    return proxy
  }
  return new Proxy(db,{
    get(target,prop,receiver){
      if(prop==='prepare')return (text:string)=>wrap(target.prepare(text))
      if(prop==='batch')return async (statements:D1PreparedStatement[])=>
        (await target.batch(statements.map(stmt=>original.get(stmt)??stmt))).map(add)
      const value=Reflect.get(target,prop,receiver)
      return typeof value==='function'?value.bind(target):value
    },
  })
}
export default {
  ...app,
  async fetch(request:Request, env:Env['Bindings'], ctx:ExecutionContext){
    const url=new URL(request.url)
    if(env.APP_MODE!=='local'||url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/api/')) {
      return app.fetch(request,env,ctx)
    }
    const count:Count={reads:0,writes:0,statements:0}
    const response=await app.fetch(request,{...env,DB:instrument(env.DB,count),MEDIA:instrument(env.MEDIA,count)},ctx)
    const headers=new Headers(response.headers)
    headers.set('X-Kirana-D1',JSON.stringify(count))
    return new Response(response.body,{status:response.status,headers})
  },
}
