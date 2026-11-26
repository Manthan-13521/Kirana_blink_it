import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'

const [storePath,workerConfig]=process.argv.slice(2)
assert.ok(storePath&&workerConfig,
  'Usage: node tools/publish-media-static.mjs STORE_JSON GENERATED_WORKER_CONFIG')
const store=JSON.parse(readFileSync(storePath,'utf8'))
const config=resolve(workerConfig),worker=JSON.parse(readFileSync(config,'utf8'))
const storefront=new URL(store.googleOrigin??'https://'+store.frontendProject+'.pages.dev')
assert.equal(storefront.protocol,'https:')
assert.match(store.mediaProject,/^[a-z][a-z0-9-]{2,35}$/)
assert.notEqual(store.frontendProject,store.mediaProject)
assert.ok(worker.d1_databases.some(binding=>binding.binding==='DB'&&binding.database_id===store.databaseId))
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js')
function cloudflare(args,quiet=false){
  const job=spawnSync(process.execPath,[wrangler,...args],quiet?{encoding:'utf8',maxBuffer:8*1024*1024}:{stdio:'inherit'})
  if(job.error)throw job.error
  assert.equal(job.status,0,job.stderr?.trim()||'Wrangler failed.')
  return job.stdout
}
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const imagePath=new RegExp('^/media/'+uuid+'(?:[.]jpg)?$')
const work=mkdtempSync(join(tmpdir(),'kirana-static-media-'))
try{
  const result=JSON.parse(cloudflare(['d1','execute','DB','--remote','--config',config,'--json','--command',
    "SELECT image FROM products WHERE image GLOB '/media/*' UNION SELECT logo AS image FROM settings WHERE logo GLOB '/media/*' ORDER BY image LIMIT 5002"],true))
  const images=result[0].results.map(row=>row.image)
  assert.ok(images.length<=5001&&images.every(path=>imagePath.test(path)),'The media manifest exceeds its allowed scope.')
  const dir=join(work,'media')
  mkdirSync(dir)
  // An incomplete asset set must never replace the previous Pages deployment.
  let next=0
  await Promise.all(Array.from({length:4},async()=>{
    while(next<images.length){
      const path=images[next++]
      const response=await fetch(new URL(path,storefront),{signal:AbortSignal.timeout(10000),redirect:'error'})
      assert.equal(response.status,200,path)
      const isJpeg=path.endsWith('.jpg')
      assert.equal(response.headers.get('content-type'),isJpeg?'image/jpeg':'image/webp',path)
      const image=Buffer.from(await response.arrayBuffer())
      assert.ok(image.length>=24&&image.length<=32768,path)
      writeFileSync(join(dir,path.slice(7)+(isJpeg?'':'.webp')),image)
    }
  }))
  writeFileSync(join(work,'_headers'),'/media/*\n  Cache-Control: public, max-age=86400, immutable\n  X-Content-Type-Options: nosniff\n')
  writeFileSync(join(work,'manifest.json'),JSON.stringify({images:images.length}))
  cloudflare(['pages','deploy',work,'--project-name',store.mediaProject,'--branch','main'])
  console.log(JSON.stringify({mediaProject:store.mediaProject,images:images.length}))
}finally{rmSync(work,{recursive:true,force:true})}
