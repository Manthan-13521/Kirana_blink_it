import { spawn,spawnSync } from 'node:child_process'
import { cp,mkdtemp,readdir,readFile,rm,symlink,writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

const env={...process.env,WRANGLER_SEND_METRICS:'false'}
const config=['--config','wrangler.local.jsonc','--local']
const wrangler=resolve(process.platform==='win32'?'node_modules/.bin/wrangler.cmd':'node_modules/.bin/wrangler')
async function allocate(){
  const server=createServer().listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve))
  const {port}=server.address()
  await new Promise(resolve=>server.close(resolve))
  return port
}
export async function harness(seed,{entry='index',mode,vars={}}={}){
  const workspace=await mkdtemp(join(tmpdir(),'kirana-local-test-'))
  const state=join(workspace,'state')
  const args=[...config,'--persist-to',state]
  const run=command=>{
    const job=spawnSync(wrangler,[...command,...args],{cwd:workspace,env,encoding:'utf8'})
    assert.equal(job.status,0,job.error?.message||job.stderr||job.stdout)
  }
  let worker
  const stop=async()=>{
    if(worker&&worker.exitCode===null&&worker.signalCode===null){
      const done=new Promise(resolve=>worker.once('close',resolve))
      if(process.platform==='win32')worker.kill()
      else process.kill(-worker.pid,'SIGTERM')
      await Promise.race([done,delay(2500)]);if(worker.exitCode===null&&worker.signalCode===null&&process.platform!=='win32'){try{process.kill(-worker.pid,'SIGKILL')}catch{}}
    }
    await rm(workspace,{recursive:true,force:true})
  }
  try{
    // Snapshot the Worker and built assets so the preview's file watcher cannot reload tests.
    await Promise.all([
      ...['wrangler.local.jsonc','package.json','dist','worker','migrations','media-migrations'].map(file=>cp(file,join(workspace,file),{recursive:true})),
      symlink(resolve('node_modules'),join(workspace,'node_modules'),process.platform==='win32'?'junction':'dir'),
    ])
    if(entry!=='index'||mode||Object.keys(vars).length){
      const configPath=join(workspace,'wrangler.local.jsonc')
      const parsed=JSON.parse(await readFile(configPath,'utf8'))
      parsed.main='worker/'+entry+'.ts'
      Object.assign(parsed.vars,vars)
      if(mode)parsed.vars.APP_MODE=mode
      await writeFile(configPath,JSON.stringify(parsed))
    }
    run(['d1','migrations','apply','DB'])
    run(['d1','migrations','apply','MEDIA'])
    if(seed)run(['d1','execute','DB','--file',seed])
    const port=await allocate()
    // Let the kernel allocate the inspector port for parallel preview instances.
    worker=spawn(wrangler,['dev',...args,'--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--log-level','error'],{cwd:workspace,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
    let logs=''
    worker.stdout.on('data',data=>{logs=(logs+data).slice(-7000)})
    worker.stderr.on('data',data=>{logs=(logs+data).slice(-7000)})
    const base='http://127.0.0.1:'+port
    const deadline=Date.now()+20000
    while(Date.now()<deadline){
      const ready=await fetch(base+'/api/health').then(r=>r.ok,()=>false)
      if(ready)return {base,stop,logs:()=>logs,workerResources:()=>resources(worker.pid),databaseSize:()=>databaseSizes(state),readBusiness:(sql,...params)=>withDatabase(state,'orders',db=>db.prepare(sql).all(...params))}
      if(worker.exitCode!==null)break
      await delay(200)
    }
    throw new Error('Local Wrangler did not become ready. '+logs)
  }catch(e){await stop();throw e}
}

export const session=(base,observe)=>{
  let cookie=''
  return async(path,{method='GET',body,headers={},raw,expected=200,disconnectAfterHeaders=false}={})=>{
    const started=performance.now()
    let reply
    const connection=disconnectAfterHeaders?new AbortController():undefined
    try{
      reply=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:base}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?raw:JSON.stringify(body),signal:connection?.signal})
    }catch(error){observe?.({path,method,status:0,ms:performance.now()-started});throw error}
    const set=reply.headers.get('set-cookie')
    if(set)cookie=set.split(';',1)[0]
    connection?.abort()
    const contentType=reply.headers.get('content-type')
    const content=contentType?.includes('application/json')?await reply.json():new Uint8Array(await reply.arrayBuffer())
    const metered=reply.headers.get('x-kirana-d1')
    observe?.({path,method,status:reply.status,ms:performance.now()-started,d1:metered?JSON.parse(metered):null})
    assert.equal(reply.status,expected,`${method} ${path}: ${content instanceof Uint8Array?new TextDecoder().decode(content.slice(0,400)):JSON.stringify(content)}`)
    return content
  }
}
export const action=(call,path,body={},expected=200,method='POST')=>call('/api'+path,{method,body,expected})
export async function login(base,role,observe){
  const call=session(base,observe)
  const result=await action(call,'/auth/demo',{role})
  assert.equal(result.role,role)
  return call
}

function resources(group){
  const output=spawnSync('ps',['-A','-o','pgid=,rss=,time=,comm='],{encoding:'utf8'})
  if(output.status!==0)return null
  const workerd=output.stdout.split('\n').map(line=>line.trim().split(/\s+/,4))
    .filter(([pgid,,,command])=>Number(pgid)===group&&command?.includes('workerd'))
  if(!workerd.length)return null
  return workerd.reduce((sum,[,rss,cpu])=>{
    const seconds=cpu.split(':').reduce((time,part)=>time*60+Number(part),0)
    return {rss_kib:sum.rss_kib+Number(rss),cpu_seconds:sum.cpu_seconds+seconds}
  },{rss_kib:0,cpu_seconds:0})
}

async function withDatabase(state,table,callback){
  const files=(await readdir(state,{recursive:true,withFileTypes:true})).filter(entry=>entry.name.endsWith('.sqlite'))
  for(const file of files){
    const db=new DatabaseSync(join(file.parentPath??file.path,file.name),{readOnly:true})
    try{
      if(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(table))return callback(db)
    }finally{db.close()}
  }
  throw new Error('Expected SQLite table '+table)
}

async function databaseSizes(state){
  const stats={}
  for(const table of ['orders','media']){
    stats[table]=await withDatabase(state,table,db=>{
      const pages=db.prepare('PRAGMA page_count').get().page_count
      const free=db.prepare('PRAGMA freelist_count').get().freelist_count
      const size=db.prepare('PRAGMA page_size').get().page_size
      return {allocated_bytes:pages*size,used_bytes:(pages-free)*size}
    })
  }
  return stats
}
export async function place(call,request,expected=201){
  const quote=await action(call,'/quote',request)
  return action(call,request.fulfillment==='counter'?'/pos':'/orders',{...request,version:quote.version,key:crypto.randomUUID()},expected)
}
