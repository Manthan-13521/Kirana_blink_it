import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { assertTargetHeadroom, readQuota, targetLimits, targetWriteBudget, validateQuota } from '../testing/benchmark-quota.mjs'

const [configPath,mode='smoke',quotaPath,progressPath]=process.argv.slice(2)
assert.ok(configPath&&['smoke','target','browse'].includes(mode),'Usage: node tests/hosted-benchmark.mjs PRIVATE_CONFIG [smoke|browse|target FRESH_QUOTA_JSON [NEW_PROGRESS_JSONL]]')
const config=JSON.parse(readFileSync(configPath,'utf8'))
const url=new URL(config.url)
assert.match(url.hostname,/^kirana-benchmark-staging-api\.[a-z0-9-]+\.workers\.dev$/)
assert.equal(url.protocol,'https:')
assert.equal(url.origin,config.url)
assert.match(config.token,/^[a-f0-9]{64}$/)
const target=mode==='target',browseOnly=mode==='browse',counts=target?{online:800,pos:300,sku:5000,width:32,visits:8}:browseOnly?{online:0,pos:0,sku:180,width:32,visits:8}:{online:30,pos:12,sku:180,width:6,visits:3}
const maxWrites=target?targetWriteBudget:5000
let quota, initialQuota
if(progressPath)writeFileSync(progressPath,'',{flag:'wx',mode:0o600})
const record=(event,data={})=>{
  if(progressPath)appendFileSync(progressPath,JSON.stringify({at:new Date().toISOString(),event,...data})+'\n')
}
if(target){
  assert.ok(quotaPath,'Provide a fresh account quota report.')
  const submitted=validateQuota(JSON.parse(readFileSync(quotaPath,'utf8')))
  assert.match(config.account??'',/^[a-f0-9]{32}$/)
  assert.ok(Date.parse(config.expiresAt)-Date.now()>15*60000,'Refresh the isolated benchmark credential.')
  assert.equal(config.unseededWrites,0,'Wait for seed writes to settle in the account analytics.')
  initialQuota=quota=readQuota(config.account)
  assertTargetHeadroom(quota,submitted)
  record('admitted',{quota,revision:config.commit})
}

let writes=0,reads=0,statements=0,requests=0,errors=0
const completed={online:0,counter:0,delivery:0,simulatedPayments:0,cashReconciled:0,trackingChecks:0}
const times=[],byEndpoint=new Map()
let halted=false
function checkBudget(){
  assert.ok(!halted,'Benchmark has stopped admitting requests.')
  assert.ok(writes+(target?512:0)<maxWrites,'Synthetic D1 write budget reached.')
  if(!target)return
  if(Date.now()-Date.parse(quota.asOf)>=60000){
    quota=readQuota(config.account)
    record('checkpoint',{quota,completed,requests,reads,writes,statements,errors})
  }
  assert.equal(quota.utcDay,initialQuota.utcDay,'Quota day changed.')
  for(const [key,used,reserve] of [
    ['d1RowsWritten',writes,1024],['d1RowsRead',reads,16000],['workerRequests',requests,128],
  ])assert.ok(Math.max(quota[key].value,initialQuota[key].value+used)+reserve<targetLimits[key],'Account safety budget reached for '+key)
}
function client(){
  let cookie=''
  return async(path,{method='GET',data,type,expected=200}={})=>{
    try{checkBudget()}catch(error){halted=true;throw error}
    const headers={Authorization:'Bearer '+config.token, ...(cookie?{Cookie:cookie}:{}),
      ...(method==='GET'?{}:{Origin:config.url}),...(data===undefined?{}:{'Content-Type':type??'application/json'})}
    const start=performance.now()
    requests++
    const response=await fetch(url.origin+path,{method,headers,redirect:'error',signal:AbortSignal.timeout(15000),
      body:type?data:data===undefined?undefined:JSON.stringify(data)}).catch(error=>{errors++;throw error})
    const set=response.headers.get('set-cookie')
    if(set)cookie=set.split(';',1)[0]
    const metric=response.headers.get('x-kirana-d1')
    if(metric){
      const counts=JSON.parse(metric)
      reads+=counts.reads;writes+=counts.writes;statements+=counts.statements
    }
    const value=response.headers.get('content-type')?.includes('application/json')?await response.json():new Uint8Array(await response.arrayBuffer())
    const elapsed=performance.now()-start
    times.push(elapsed)
    const endpoint=method+' '+path.split('?')[0].replace(/(\/orders\/)[a-f0-9-]{36}/,'$1:id')
    const results=byEndpoint.get(endpoint)??[]
    results.push(elapsed)
    byEndpoint.set(endpoint,results)
    if(response.status!==expected)errors++
    assert.equal(response.status,expected,`${method} ${path} ${JSON.stringify(value).slice(0,200)}`)
    if(path.startsWith('/api/'))assert.ok(metric,'Every synthetic API response must include D1 counters.')
    return value
  }
}
const post=(who,path,data={},expected)=>who('/api'+path,{method:'POST',data,expected})
const owner=client(),rider=client(),guest=client()
const catalog=(await guest('/api/__benchmark/catalog-size')).total
assert.ok(catalog>=counts.sku&&(!target||catalog===5000),'The hosted catalog is smaller than the selected workload.')
const startingIntegrity=target?await guest('/api/__benchmark/integrity'):null
if(startingIntegrity)assert.equal(startingIntegrity.pending,0,'Resolve pending synthetic orders first.')
const browse=async index=>{
  const sku=String(index%(catalog-16)+1).padStart(4,'0')
  await guest('/api/catalog?category=pantry&limit=12')
  await guest('/api/catalog?q=benchmark+'+sku+'&limit=12')
}
function reserveWindows(windows,count){
  assert.ok(windows.reduce((total,window)=>total+window.remaining,0)>=count,
    'The isolated store has insufficient available fulfillment slots.')
  const available=windows.map(window=>({...window}))
  let next=0
  return Array.from({length:count},()=>{
    while(!available[next].remaining)next=(next+1)%available.length
    const slot=available[next]
    slot.remaining--
    next=(next+1)%available.length
    return slot.start
  })
}
async function sales(){
  const pickup=await guest('/api/slots?mode=pickup'),delivery=await guest('/api/slots?mode=delivery')
  const mix=Array.from({length:counts.online+counts.pos},(_,position)=>{
    if(position%3===0&&position/3<counts.pos)return 'counter'
    return position%13===1?'delivery':'pickup'
  })
  const pickupSlots=reserveWindows(pickup,mix.filter(mode=>mode==='pickup').length)
  const deliverySlots=reserveWindows(delivery,mix.filter(mode=>mode==='delivery').length)
  await post(owner,'/auth/demo',{role:'owner'})
  await post(rider,'/auth/demo',{role:'rider'})
  const before=(await owner('/api/admin/summary?days=2')).metrics
  const shoppers=await Promise.all(Array.from({length:counts.width},async(_,index)=>{
    const call=client()
    const name='Synthetic shopper '+index
    await post(call,'/auth/register-local',{name})
    const address=await post(call,'/addresses',{label:'Test',recipient:name,phone:'9000000099',
      line1:'Synthetic lane',locality:'Hyderabad fixture',landmark:'',pin:'500034',latitude:17.413,longitude:78.421},201)
    return {call,addressId:address.id}
  }))
  let nextPickup=0,nextDelivery=0
  let task=0
  async function sale(position,shopper){
    const fulfillment=mix[position]
    const online=fulfillment!=='counter',drops=fulfillment==='delivery'
    const fixtureSkus=counts.sku-16
    const items=Array.from({length:6},(_,i)=>({id:'load-'+String((position*13+i)%fixtureSkus+1).padStart(4,'0'),steps:1}))
    const method=online&&position%4===1?'online':'cash'
    const checkout={fulfillment,method,items,
      ...(online?{slot:drops?deliverySlots[nextDelivery++]:pickupSlots[nextPickup++]}:{})}
    if(drops)checkout.addressId=shopper.addressId
    const call=online?shopper.call:owner
    if(online)for(let i=0;i<counts.visits;i++)await Promise.all([
      guest('/api/catalog?category=pantry&limit=12'),
      guest('/api/catalog?q=benchmark+'+String((position+i)%fixtureSkus+1).padStart(4,'0')+'&limit=12'),
      guest('/api/store'),
    ])
    const quote=await post(call,'/quote',checkout)
    const {id}=await post(call,online?'/orders':'/pos',{...checkout,key:crypto.randomUUID(),version:quote.version},201)
    if(online){
      const move=(actor,status,more={})=>post(actor,'/orders/'+id+'/state',{status,...more})
      if(method==='online'){
        await post(call,'/orders/'+id+'/test-payment',{result:'paid'})
        completed.simulatedPayments++
      }
      await move(owner,'accepted')
      if(drops)await post(owner,'/orders/'+id+'/assign')
      await move(owner,'packing')
      await move(owner,'ready')
      if(drops)await move(rider,'out_for_delivery')
      await move(drops?rider:owner,'completed',method==='cash'?{cash:quote.total}:{})
      if(drops){
        completed.delivery++
        if(method==='cash'){
          await post(owner,'/orders/'+id+'/reconcile')
          completed.cashReconciled++
        }
      }
      if(target&&position%8===0){
        const tracked=await call('/api/orders/'+id)
        assert.equal(tracked.status,'completed')
        assert.equal((await call('/api/orders/'+id+'?tracking='+encodeURIComponent(tracked.trackingVersion))).unchanged,true)
        completed.trackingChecks++
      }
    }
    completed[online?'online':'counter']++
    if((completed.online+completed.counter)%50===0)record('sales',{completed,requests,reads,writes,statements,errors})
  }
  const outcomes=await Promise.allSettled(shoppers.map(async shopper=>{
    try{while(!halted&&task<counts.online+counts.pos)await sale(task++,shopper)}
    catch(error){halted=true;throw error}
  }))
  const failure=outcomes.find(outcome=>outcome.status==='rejected')
  if(failure){
    record('stopped',{completed,requests,reads,writes,statements,errors})
    throw failure.reason
  }
  const after=(await owner('/api/admin/summary?days=2')).metrics
  assert.equal(after.online_orders-before.online_orders,counts.online)
  assert.equal(after.walk_in-before.walk_in,counts.pos)
  assert.equal(after.completed-before.completed,counts.online+counts.pos)
}
const start=performance.now()
if(browseOnly||target){
  await Promise.all(Array.from({length:32},async(_,index)=>{
    await guest('/api/store')
    for(let visit=0;visit<8;visit++)await browse(index*8+visit)
  }))
}
if(!browseOnly)await sales()
const finalIntegrity=target?await guest('/api/__benchmark/integrity'):null
if(finalIntegrity){
  assert.equal(finalIntegrity.online-startingIntegrity.online,counts.online)
  assert.equal(finalIntegrity.counter-startingIntegrity.counter,counts.pos)
  assert.equal(finalIntegrity.pending,0)
  assert.ok(finalIntegrity.minStock>=0)
  assert.equal(startingIntegrity.stockUnits-finalIntegrity.stockUnits,6*(counts.online+counts.pos))
  for(const field of ['badTotals','duplicateCompletions','paymentMismatch','cashUnreconciled'])
    assert.equal(finalIntegrity[field],startingIntegrity[field])
}
const elapsed=performance.now()-start
const percentiles=samples=>{
  samples.sort((a,b)=>a-b)
  const p=q=>Math.round(samples[Math.ceil(q*samples.length)-1])
  return {p50_ms:p(.5),p95_ms:p(.95),p99_ms:p(.99)}
}
const endpoints=Object.fromEntries([...byEndpoint].map(([endpoint,samples])=>
  [endpoint,{requests:samples.length,...percentiles(samples)}]))
const result={...counts,catalog,requests,errors,completed,...percentiles(times),elapsed_ms:Math.round(elapsed),
  endpoints,d1:{reads,writes,statements},...(target?{startingIntegrity,finalIntegrity,initialQuota,finalQuota:readQuota(config.account)}: {})}
record('complete',result)
console.log(JSON.stringify(result))
