import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const [configPath,mode='smoke',quotaPath]=process.argv.slice(2)
assert.ok(configPath&&['smoke','target','browse'].includes(mode),'Usage: node tests/hosted-benchmark.mjs PRIVATE_CONFIG [smoke|browse|target FRESH_QUOTA_JSON]')
const config=JSON.parse(readFileSync(configPath,'utf8'))
const url=new URL(config.url)
assert.match(url.hostname,/^kirana-benchmark-staging-api\.[a-z0-9-]+\.workers\.dev$/)
assert.equal(url.protocol,'https:')
assert.equal(url.origin,config.url)
assert.match(config.token,/^[a-f0-9]{64}$/)
const target=mode==='target',browseOnly=mode==='browse',counts=target?{online:800,pos:300,sku:5000,width:32,visits:8}:browseOnly?{online:0,pos:0,sku:180,width:32,visits:8}:{online:30,pos:12,sku:180,width:6,visits:3}
const maxWrites=target?76000:5000
let quota, initialQuota
function validateQuota(value) {
  assert.equal(value.utcDay,new Date().toISOString().slice(0,10),'Use the measured account quota for the current UTC day.')
  assert.ok(Math.abs(Date.now()-Date.parse(value.asOf))<60000,'Refresh account quota analytics first.')
  for(const key of ['d1RowsWritten','d1RowsRead','workerRequests'])
    assert.ok(Number.isSafeInteger(value[key]?.value)&&value[key].value>=0,'Invalid quota metric '+key)
  return value
}
function readQuota() {
  const env={...process.env}
  if(!env.CLOUDFLARE_API_TOKEN&&env.KIRANA_WRANGLER_OAUTH_CONFIG){
    execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','whoami'],{encoding:'utf8',timeout:20000})
    const oauth=readFileSync(env.KIRANA_WRANGLER_OAUTH_CONFIG,'utf8')
    env.CLOUDFLARE_API_TOKEN=oauth.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1]
  }
  assert.ok(env.CLOUDFLARE_API_TOKEN,'Set the account analytics token or local Wrangler OAuth config path.')
  return validateQuota(JSON.parse(execFileSync(process.execPath,['tools/quota-report.mjs',config.account,'kirana-benchmark-staging-api'],
    {encoding:'utf8',env,timeout:20000})))
}
if(target){
  assert.ok(quotaPath,'Provide a fresh account quota report.')
  const submitted=validateQuota(JSON.parse(readFileSync(quotaPath,'utf8')))
  assert.match(config.account??'',/^[a-f0-9]{32}$/)
  assert.ok(Date.parse(config.expiresAt)-Date.now()>15*60000,'Refresh the isolated benchmark credential.')
  assert.equal(config.unseededWrites,0,'Wait for seed writes to settle in the account analytics.')
  initialQuota=quota=readQuota()
  for(const [key,reserve,limit] of [['d1RowsWritten',maxWrites,90000],['d1RowsRead',1000000,3500000],['workerRequests',30000,70000]])
    assert.ok(Math.max(quota[key].value,submitted[key].value)+reserve<limit,'Insufficient account headroom for '+key)
}

let writes=0,reads=0,statements=0,requests=0,errors=0
const times=[],byEndpoint=new Map()
let halted=false
function checkBudget(){
  assert.ok(!halted,'Benchmark has stopped admitting requests.')
  assert.ok(writes+(target?512:0)<maxWrites,'Synthetic D1 write budget reached.')
  if(!target)return
  if(Date.now()-Date.parse(quota.asOf)>=60000)quota=readQuota()
  assert.equal(quota.utcDay,initialQuota.utcDay,'Quota day changed.')
  for(const [key,used,reserve,limit] of [
    ['d1RowsWritten',writes,1024,90000],['d1RowsRead',reads,16000,3500000],['workerRequests',requests,128,70000],
  ])assert.ok(Math.max(quota[key].value,initialQuota[key].value+used)+reserve<limit,'Account safety budget reached for '+key)
}
function client(){
  let cookie=''
  return async(path,{method='GET',data,type,expected=200}={})=>{
    try{checkBudget()}catch(error){halted=true;throw error}
    const headers={Authorization:'Bearer '+config.token, ...(cookie?{Cookie:cookie}:{}),
      ...(method==='GET'?{}:{Origin:config.url}),...(data===undefined?{}:{'Content-Type':type??'application/json'})}
    const start=performance.now()
    const response=await fetch(url.origin+path,{method,headers,signal:AbortSignal.timeout(15000),
      body:type?data:data===undefined?undefined:JSON.stringify(data)})
    const set=response.headers.get('set-cookie')
    if(set)cookie=set.split(';',1)[0]
    const metric=response.headers.get('x-kirana-d1')
    if(metric){
      const counts=JSON.parse(metric)
      reads+=counts.reads;writes+=counts.writes;statements+=counts.statements
    }
    requests++
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
async function sales(){
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
  const pickup=await guest('/api/slots?mode=pickup'),delivery=await guest('/api/slots?mode=delivery')
  assert.ok(pickup.length&&delivery.length)
  let task=0
  async function sale(position,shopper){
    const online=position%3!==0||position/3>=counts.pos
    const pickupIndex=position%pickup.length,drops=online&&position%13===1
    const fixtureSkus=counts.sku-16
    const items=Array.from({length:6},(_,i)=>({id:'load-'+String((position*13+i)%fixtureSkus+1).padStart(4,'0'),steps:1}))
    const method=online&&position%4===1?'online':'cash'
    const checkout={fulfillment:online?(drops?'delivery':'pickup'):'counter',method,items,
      ...(online?{slot:drops?delivery[position%delivery.length].start:pickup[pickupIndex].start}:{})}
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
      if(method==='online')await post(call,'/orders/'+id+'/test-payment',{result:'paid'})
      await move(owner,'accepted')
      if(drops)await post(owner,'/orders/'+id+'/assign')
      await move(owner,'packing')
      await move(owner,'ready')
      if(drops)await move(rider,'out_for_delivery')
      await move(drops?rider:owner,'completed',method==='cash'?{cash:quote.total}:{})
    }
  }
  await Promise.all(shoppers.map(async shopper=>{while(task<counts.online+counts.pos)await sale(task++,shopper)}))
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
  for(const field of ['badTotals','duplicateCompletions','paymentMismatch'])
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
console.log(JSON.stringify({...counts,catalog,requests,errors,...percentiles(times),elapsed_ms:Math.round(elapsed),
  endpoints,d1:{reads,writes,statements},...(target?{startingIntegrity,finalIntegrity,initialQuota,finalQuota:readQuota()}: {})}))
