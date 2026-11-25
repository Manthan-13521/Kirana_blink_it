import assert from 'node:assert/strict'

const [account,script]=process.argv.slice(2)
assert.match(account??'',/^[a-f0-9]{32}$/)
if(script)assert.match(script,/^[a-z][a-z0-9-]{1,62}$/)
const token=process.env.CLOUDFLARE_API_TOKEN
assert.ok(token,'Set CLOUDFLARE_API_TOKEN to a scoped Account Analytics Read token.')
const now=new Date(),from=now.toISOString().slice(0,10),start=from+'T00:00:00Z'
const base='https://api.cloudflare.com/client/v4/graphql'
const query=`{viewer {accounts(filter:{accountTag:"${account}"}) {
  d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:"${from}",date_leq:"${from}"}) {
    sum { rowsRead rowsWritten }
  }
  workersInvocationsAdaptive(limit:100,filter:{datetime_geq:"${start}",datetime_leq:"${now.toISOString()}"}) {
    sum { requests errors }
  }
  ${script?`selected: workersInvocationsAdaptive(limit:100,filter:{datetime_geq:"${start}",
    datetime_leq:"${now.toISOString()}",scriptName:"${script}"}) {sum {requests errors} quantiles {cpuTimeP50 cpuTimeP99}}`:''}
}}}`
const response=await fetch(base,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query})})
assert.equal(response.status,200,'Cloudflare Analytics request failed.')
const result=await response.json()
assert.ok(!result.errors?.length,result.errors?.map(e=>e.message).join('; ')||'Cloudflare Analytics query failed.')
const entry=result.data.viewer.accounts[0]
assert.ok(entry,'Cloudflare returned no account data.')
const sum=(rows,key)=>rows.reduce((total,row)=>total+Number(row.sum?.[key]??0),0)
const usage=(value,limit)=>({value,limit,warning:value>=limit*.8})
const selected=entry.selected?.[0]
console.log(JSON.stringify({
  utcDay:from,asOf:now.toISOString(),sampling:'Cloudflare analytics may lag or be sampled.',
  d1RowsRead:usage(sum(entry.d1AnalyticsAdaptiveGroups,'rowsRead'),5_000_000),
  d1RowsWritten:usage(sum(entry.d1AnalyticsAdaptiveGroups,'rowsWritten'),100_000),
  workerRequests:usage(sum(entry.workersInvocationsAdaptive,'requests'),100_000),
  ...(selected?{worker:{name:script,requests:selected.sum.requests,errors:selected.sum.errors,
    cpuP50Us:selected.quantiles.cpuTimeP50,cpuP99Us:selected.quantiles.cpuTimeP99}}:{}),
}))
