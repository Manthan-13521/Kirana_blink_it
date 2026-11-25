import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync,readFileSync,writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [slug,target,mode]=process.argv.slice(2)
assert.ok(/^[a-z][a-z0-9-]{2,18}-staging$/.test(slug??'')&&target&&['--dry-run','--create'].includes(mode),
  'Usage: npm run setup:staging -- STORE-staging PRIVATE_STORE_JSON --dry-run|--create')
assert.ok(!existsSync(target),'Choose a new private configuration path.')
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js')
function cf(args){
  const result=spawnSync(process.execPath,[wrangler,...args],{encoding:'utf8'})
  if(result.error)throw result.error
  assert.equal(result.status,0,result.stderr?.trim()||result.stdout?.trim()||'Wrangler command failed.')
  return result.stdout
}
const databaseNames=[slug+'-orders',slug+'-media'],pagesNames=[slug,slug+'-images']
if(mode==='--dry-run'){
  console.log(JSON.stringify({databases:databaseNames,pages:pagesNames}))
}else{
  const databases=()=>JSON.parse(cf(['d1','list','--json']))
  const existing=databases()
  const missing=databaseNames.filter(name=>!existing.some(db=>db.name===name))
  assert.ok(existing.length+missing.length<=10,'The account does not have enough D1 Free database slots.')
  for(const name of missing)cf(['d1','create',name])
  const pages=cf(['pages','project','list'])
  for(const name of pagesNames){
    if(!pages.split('\n').some(line=>line.split('│')[1]?.trim()===name)){
      cf(['pages','project','create',name,'--production-branch','main','--force'])
    }
  }
  const ready=databases()
  const [databaseId,mediaDatabaseId]=databaseNames.map(name=>ready.find(db=>db.name===name)?.uuid)
  assert.ok(databaseId&&mediaDatabaseId)
  const template=JSON.parse(readFileSync('deployment/store.example.json','utf8'))
  Object.assign(template,{slug,frontendProject:pagesNames[0],mediaProject:pagesNames[1],databaseId,mediaDatabaseId,
    googleOrigin:'https://'+pagesNames[0]+'.pages.dev',staticMediaOrigin:'https://'+pagesNames[1]+'.pages.dev'})
  writeFileSync(target,JSON.stringify(template,null,2)+'\n',{flag:'wx',mode:0o600})
  console.log('Wrote the private configuration. Enter store details before deploying.')
}
