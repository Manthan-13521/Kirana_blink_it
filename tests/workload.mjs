import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { action,harness,login,session } from './harness.mjs'

const online=Number(process.argv[2]??800)
assert.ok([800,1000,1500].includes(online),'Use 800, 1000 or 1500 online orders.')
const counter=300
const peakConcurrency=Number(process.argv[3]??32)
assert.ok(Number.isInteger(peakConcurrency)&&peakConcurrency>=16&&peakConcurrency<=48)
const riderDeliveries=60
const fixture=fileURLToPath(new URL('./workload-seed.sql',import.meta.url))
const instance=await harness(fixture,{entry:'qa'})
const data=[]
let peakRss=0
const sample=()=>{
  const resources=instance.workerResources()
  if(resources)peakRss=Math.max(resources.rss_kib,peakRss)
  return resources
}
const monitor=setInterval(sample,2000)
try{
  const guest=session(instance.base,r=>data.push(r))
  const owner=await login(instance.base,'owner',r=>data.push(r))
  const rider=await login(instance.base,'rider',r=>data.push(r))
  const clients=[]
  for(let i=0;i<peakConcurrency;i++){
    const customer=session(instance.base,r=>data.push(r))
    const name='Peak shopper '+i
    await action(customer,'/auth/register-local',{name,phone:'9000000010'})
    const address=await action(customer,'/addresses',{
      label:'Home',recipient:name,phone:'9000000010',line1:'Synthetic street',
      locality:'Test locality',landmark:'',pin:'500034',latitude:17.413,longitude:78.421,
    },201)
    clients.push({customer,addressId:address.id})
  }
  const pickup=await guest('/api/slots?mode=pickup')
  const delivery=await guest('/api/slots?mode=delivery')
  assert.ok(pickup.length>=10&&delivery.length>=8)
  const initialDb=await instance.databaseSize()
  const initialCpu=sample()?.cpu_seconds
  data.length=0
  const start=performance.now()
  const move=(who,id,status,extra={})=>action(who,'/orders/'+id+'/state',{status,...extra})
  const completed=new Set()
  async function sale({type,i},actor){
    const onlineOrder=type==='online'
    const drop=onlineOrder&&i<riderDeliveries
    // Both channels draw from the same product ranges during peak.
    const items=Array.from({length:6},(_,offset)=>({id:'load-'+String((i*3+offset)%4984+1).padStart(4,'0'),steps:1}))
    const slot=drop?delivery[i%delivery.length]:pickup[i%pickup.length]
    const method=onlineOrder&&i%3===0?'online':'cash'
    const payload={fulfillment:onlineOrder?(drop?'delivery':'pickup'):'counter',method,items,
      ...(onlineOrder?{slot:slot.start,...(drop?{addressId:actor.addressId}:{})}:{})}
    const client=onlineOrder?actor.customer:owner
    if(onlineOrder){
      for(let visit=0;visit<8;visit++){
        await Promise.all([
          guest('/api/catalog?category=pantry&limit=12'),
          guest('/api/catalog?q=benchmark+'+String((i+visit)%3000+1).padStart(4,'0')+'&limit=12'),
          guest('/api/store'),
        ])
      }
    }
    const quote=await action(client,'/quote',payload)
    const result=await action(client,onlineOrder?'/orders':'/pos',{...payload,key:crypto.randomUUID(),version:quote.version},201)
    if(onlineOrder){
      if(method==='online')await action(client,'/orders/'+result.id+'/test-payment',{result:'paid'})
      await move(owner,result.id,'accepted')
      if(drop)await action(owner,'/orders/'+result.id+'/assign')
      await move(owner,result.id,'packing')
      await move(owner,result.id,'ready')
      if(drop)await move(rider,result.id,'out_for_delivery')
      await move(drop?rider:owner,result.id,'completed',method==='cash'?{cash:quote.total}:{})
    }
    assert.ok(!completed.has(result.id))
    completed.add(result.id)
  }
  function interleave(onlineStart,onlineEnd,walkStart,walkEnd){
    const tasks=[]
    const slots=Math.max(onlineEnd-onlineStart,walkEnd-walkStart)
    for(let n=0;n<slots;n++){
      if(onlineStart+n<onlineEnd)tasks.push({type:'online',i:onlineStart+n})
      const position=Math.floor((n+1)*(walkEnd-walkStart)/slots)
      const previous=Math.floor(n*(walkEnd-walkStart)/slots)
      if(position>previous)tasks.push({type:'counter',i:walkStart+position-1})
    }
    return tasks
  }
  async function phase(tasks,width){
    let next=0
    await Promise.all(Array.from({length:width},async(_,i)=>{
      while(next<tasks.length)await sale(tasks[next++],clients[i])
    }))
  }
  const peakOnline=Math.floor(online/4)
  await phase(interleave(0,peakOnline,0,75),peakConcurrency)
  const peakMetricCount=data.length
  await phase(interleave(peakOnline,online,75,counter),16)
  assert.equal(completed.size,online+counter)
  const {metrics}=await owner('/api/admin/summary?days=2')
  assert.equal(metrics.online_orders,online)
  assert.equal(metrics.walk_in,counter)
  assert.equal(metrics.completed,online+counter)
  const page=await guest('/api/catalog?category=pantry&limit=60')
  assert.equal(page.products.length,60)
  assert.ok(page.next)
  const finalCpu=sample()?.cpu_seconds
  const finalDb=await instance.databaseSize()
  const percentiles=rows=>{
    const latency=rows.map(row=>row.ms).sort((a,b)=>a-b)
    const p=x=>Number(latency[Math.min(latency.length-1,Math.ceil(latency.length*x)-1)].toFixed(2))
    return {p50_ms:p(.5),p95_ms:p(.95),p99_ms:p(.99),max_ms:p(1)}
  }
  const byRoute={}
  const counts=data.reduce((sum,row)=>{
    if(row.d1){
      sum.reads+=row.d1.reads;sum.writes+=row.d1.writes;sum.statements+=row.d1.statements;sum.metered++
      const [path]=row.path.split('?')
      const key=row.method+' '+path.replace(/(\/orders\/)[^/]+/,'$1:id')
      const entry=byRoute[key]??={requests:0,reads:0,writes:0}
      entry.requests++;entry.reads+=row.d1.reads;entry.writes+=row.d1.writes
    }
    if(row.status>=400||row.status===0)sum.errors++
    return sum
  },{reads:0,writes:0,statements:0,metered:0,errors:0})
  assert.equal(counts.metered,data.length,'Every measured request must report local D1 metadata.')
  assert.ok(counts.reads>0&&counts.writes>0)
  console.log(JSON.stringify({
    catalog_skus:5000,online_completed:online,counter_completed:counter,home_deliveries:riderDeliveries,
    seconds:Number(((performance.now()-start)/1000).toFixed(2)),requests:data.length,...percentiles(data),
    error_rate:counts.errors/data.length,errors:counts.errors,
    peak:{shoppers:peakConcurrency,online_orders:peakOnline,counter_orders:75,requests:peakMetricCount,...percentiles(data.slice(0,peakMetricCount))},
    d1:{rows_read:counts.reads,rows_written:counts.writes,statements:counts.statements,by_route:byRoute},
    resources:{workerd_cpu_seconds:initialCpu===undefined||finalCpu===undefined?null:Number((finalCpu-initialCpu).toFixed(2)),peak_workerd_rss_mib:peakRss?Number((peakRss/1024).toFixed(1)):null,database_before:initialDb,database_after:finalDb},
  }))
}catch(e){console.error(instance.logs());throw e}finally{clearInterval(monitor);await instance.stop()}
