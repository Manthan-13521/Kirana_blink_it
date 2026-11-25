import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'

const [workerPath,quotaPath,requested]=process.argv.slice(2)
assert.ok(workerPath&&quotaPath&&requested,'Usage: node tools/seed-hosted-benchmark.mjs BENCH_CONFIG FRESH_QUOTA_JSON COUNT')
const worker=JSON.parse(readFileSync(workerPath,'utf8'))
assert.equal(worker.name,'kirana-benchmark-staging-api')
assert.equal(worker.vars.APP_MODE,'benchmark')
assert.equal(worker.d1_databases.find(d=>d.binding==='DB')?.database_name,'kirana-benchmark-staging-orders')
const quota=JSON.parse(readFileSync(quotaPath,'utf8')),today=new Date().toISOString().slice(0,10)
assert.equal(quota.utcDay,today)
assert.ok(Math.abs(Date.now()-Date.parse(quota.asOf))<10*60*1000,'Refresh account quota analytics first.')
const count=Number(requested),alreadyUsed=quota.d1RowsWritten?.value
assert.ok(Number.isSafeInteger(count)&&count>0&&count<=1500)
assert.ok(Number.isSafeInteger(alreadyUsed)&&alreadyUsed>=0&&40*count+alreadyUsed<=85000,
  'The index fixture and current usage would leave less than 15,000 D1 write rows of headroom.')
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js')
function sql(...args){
  const result=spawnSync(process.execPath,[wrangler,'d1','execute','DB','--config',resolve(workerPath),'--remote','--json',...args],{encoding:'utf8'})
  if(result.error)throw result.error
  assert.equal(result.status,0,result.stderr?.trim()||result.stdout)
  const start=result.stdout.search(/^\s*\[/m)
  assert.ok(start>=0,'Wrangler returned no JSON result. Check the fixture count before retrying.')
  return JSON.parse(result.stdout.slice(start))[0]
}
const previous=sql('--command',"SELECT COALESCE(MAX(CAST(substr(id,6) AS INTEGER)),0) last FROM products WHERE id GLOB 'load-*'").results[0].last
const end=Math.min(previous+count,4984)
assert.ok(end>previous,'All synthetic SKUs are already present.')
const path=mkdtempSync(join(tmpdir(),'kirana-benchmark-seed-'))
try{
  const fixture=readFileSync('tests/workload-seed.sql','utf8').split('INSERT INTO search_terms')[0]
    .replace('VALUES(1)',`VALUES(${previous+1})`).replace('i<4984',`i<${end}`)
  const match=`id BETWEEN 'load-${String(previous+1).padStart(4,'0')}' AND 'load-${String(end).padStart(4,'0')}'`
  const file=join(path,'seed.sql')
  writeFileSync(file,fixture+`
INSERT INTO search_terms SELECT 'benchmark',id FROM products WHERE ${match}
  UNION ALL SELECT substr(id,6),id FROM products WHERE ${match};
`)
  const result=sql('--file',file)
  console.log(JSON.stringify({added:end-previous,catalogWithBase:end+16,meta:result.meta}))
}finally{rmSync(path,{recursive:true,force:true})}
