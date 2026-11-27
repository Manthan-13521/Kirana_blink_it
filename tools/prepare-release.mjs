import { cp,mkdir,readFile,readdir,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import assert from 'node:assert/strict'

// Creates reviewable files locally. It never talks to a hosting provider.
const [source, destination,mode='production'] = process.argv.slice(2)
assert.ok(['production','staging'].includes(mode),'Use production or staging for the release mode.')
assert.ok(source&&destination,'Usage: node tools/prepare-release.mjs STORE.json EMPTY_OUTPUT_DIRECTORY')
const config=JSON.parse(await readFile(source,'utf8'))
const template=JSON.parse(await readFile('deployment/store.example.json','utf8'))
const identifier=/^[a-z][a-z0-9-]{2,35}$/
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
for(const key of ['slug','frontendProject','mediaProject'])assert.match(config[key],identifier,key)
assert.notEqual(config.frontendProject,config.mediaProject,'Use independent storefront and media projects.')
assert.ok(Array.isArray(config.archiveDatabaseIds)&&config.archiveDatabaseIds.length<=8)
const ids=[config.databaseId,config.mediaDatabaseId,...config.archiveDatabaseIds].map(id=>{assert.match(id,uuid);return id.toLowerCase()})
assert.equal(new Set(ids).size,ids.length,'Store resources must have distinct database IDs.')
const googleOrigin=config.googleOrigin
if(googleOrigin!==undefined){
  const url=new URL(googleOrigin)
  assert.equal(url.protocol,'https:')
  assert.equal(url.origin,googleOrigin,'Google origin must be an HTTPS origin without a trailing slash.')
}
const razorpayMode=config.razorpayMode??'test'
assert.ok(['test','live'].includes(razorpayMode),'Use test or live Razorpay mode.')
for(const flag of ['publicCheckout','razorpayLiveCheckout','razorpayLiveRefunds']){
  assert.ok(config[flag]===undefined||typeof config[flag]==='boolean',flag+' must be a boolean.')
}
assert.ok(!config.publicCheckout||mode==='production','Staging never enables public checkout.')
assert.ok(razorpayMode==='live'||!config.razorpayLiveCheckout&&!config.razorpayLiveRefunds,'Live controls require live Razorpay mode.')
const paymentVars={
  RAZORPAY_MODE:razorpayMode,
  PUBLIC_CHECKOUT:config.publicCheckout?'enabled':'disabled',
  RAZORPAY_LIVE_CHECKOUT:config.razorpayLiveCheckout?'enabled':'disabled',
  RAZORPAY_LIVE_REFUNDS:config.razorpayLiveRefunds?'enabled':'disabled',
}
const staticMediaOrigin=config.staticMediaOrigin
if(staticMediaOrigin!==undefined)assert.equal(staticMediaOrigin,'https://'+config.mediaProject+'.pages.dev',
  'Use the dedicated Pages media hostname for static image delivery.')
assert.ok(config.store&&typeof config.store==='object')
const data={enable_delivery:1,enable_pickup:1,...config.store}
const fields=Object.keys(template.store)
assert.deepEqual(Object.keys(data).sort(),[...fields].sort(),'The store settings must match the declared fields.')
for(const key of fields){
  const value=data[key], sample=template.store[key]
  assert.equal(typeof value,typeof sample,key)
  if(typeof value==='number')assert.ok(Number.isFinite(value),key)
  if(typeof value==='string')assert.ok(value.length<=1000&&!value.includes('\0'),key)
}
assert.equal(data.accepting,0,'Provision new installations with order acceptance disabled.')
assert.equal(data.enable_online,0,'Provision new installations with online payment disabled.')
for(const key of ['enable_delivery','enable_pickup'])assert.ok([0,1].includes(data[key]),key+' must be 0 or 1.')
const root=resolve(destination)
await mkdir(root,{recursive:true})
assert.deepEqual(await readdir(root),[],'The release directory must be empty.')
await Promise.all([
  cp('dist',join(root,'pages','dist'),{recursive:true}),
  cp('deployment/pages/functions',join(root,'pages','functions'),{recursive:true}),
  cp('worker',join(root,'worker','worker'),{recursive:true,filter:file=>!['index.ts','local-integrations.ts','qa.ts','benchmark.ts'].includes(file.split(/[\\/]/).at(-1))}),
  cp('package.json',join(root,'worker','package.json')),
  cp('package-lock.json',join(root,'worker','package-lock.json')),
  cp('media-migrations',join(root,'worker','media-migrations'),{recursive:true}),
  mkdir(join(root,'worker','migrations'),{recursive:true}),
])
for(const file of (await readdir('migrations')).filter(file=>file.endsWith('.sql')&&!file.includes('local_catalog'))){
  await cp(join('migrations',file),join(root,'worker','migrations',file))
}
const sql=value=>typeof value==='number'?String(value):"'"+value.replaceAll("'","''")+"'"
const fieldsSql=fields.join(',')
const seed="INSERT INTO settings(id,"+fieldsSql+") VALUES(1,"+fields.map(k=>sql(data[k])).join(',')+") ON CONFLICT(id) DO NOTHING;\n"
const workerName=config.slug+'-api'
const configWriter=(file,value)=>writeFile(join(root,file),JSON.stringify(value,null,2)+'\n')
await Promise.all([
  writeFile(join(root,'worker','initialize-store.sql'),seed),
  configWriter('worker/wrangler.json',{name:workerName,main:'worker/production.ts',compatibility_date:'2026-10-01',workers_dev:false,
    observability:{enabled:true,logs:{enabled:true,invocation_logs:false}},
    vars:{APP_MODE:mode,...paymentVars,...(googleOrigin?{GOOGLE_ORIGIN:googleOrigin}:{}),...(staticMediaOrigin?{MEDIA_STATIC_ORIGIN:staticMediaOrigin}:{})},preview_urls:false,
    d1_databases:[{binding:'DB',database_id:ids[0],database_name:config.slug+'-orders',migrations_dir:'migrations'},{binding:'MEDIA',database_id:ids[1],database_name:config.slug+'-media',migrations_dir:'media-migrations'}],
    triggers:{crons:['*/10 * * * *']}}),
  configWriter('pages/wrangler.json',{name:config.frontendProject,pages_build_output_dir:'dist',compatibility_date:'2026-10-01',services:[{binding:'KIRANA_API',service:workerName}]}),
  configWriter('pages/dist/_routes.json',{version:1,include:['/api/*','/media/*'],exclude:[]}),
  configWriter('release-manifest.json',{mode,store:config.slug,mediaProject:config.mediaProject,archiveD1:config.archiveDatabaseIds,requiredIntegrations:['Google authentication','Razorpay Standard Checkout and webhook verification','Pages image publishing','permitted routing','Web Push','archive and hosted load checks']}),
])
console.log('Prepared local review files with demo seed and mock mode excluded.')
