import { spawnSync } from 'node:child_process'
import { mkdtempSync,readFileSync,rmSync,symlinkSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const [storePath, option] = process.argv.slice(2)
assert.ok(storePath && (option === undefined || option === '--dry-run'),
  'Usage: npm run deploy:staging -- STORE_JSON [--dry-run]')
const source = resolve(storePath)
const {slug,frontendProject} = JSON.parse(readFileSync(source,'utf8'))
assert.ok(slug?.endsWith('-staging') && frontendProject?.endsWith('-staging'),
  'This command only deploys dedicated resources whose store and Pages names end in -staging.')
const dryRun = option === '--dry-run'
const wrangler = resolve('node_modules','wrangler','bin','wrangler.js')
const root = mkdtempSync(join(tmpdir(),'kirana-staging-'))
const release = join(root,'release')
const worker = join(release,'worker')
const pages = join(release,'pages')
const run = (command,args,cwd=process.cwd()) => {
  const result = spawnSync(command,args,{cwd,stdio:'inherit'})
  if(result.error)throw result.error
  assert.equal(result.status,0,`Command failed: ${command} ${args[0]}`)
}
try {
  run(process.execPath,['node_modules/vite/bin/vite.js','build'])
  run(process.execPath,['tools/prepare-release.mjs',source,release,'staging'])
  symlinkSync(resolve('node_modules'),join(worker,'node_modules'),process.platform==='win32'?'junction':'dir')
  const config = JSON.parse(readFileSync(join(worker,'wrangler.json'),'utf8'))
  assert.equal(config.vars.APP_MODE,'staging')
  assert.equal(config.workers_dev,false)
  const cf=(args,directory=worker)=>run(process.execPath,[wrangler,...args],directory)
  if(dryRun){
    cf(['deploy','--dry-run','--outdir',join(root,'dry-run')])
  } else {
    const list=spawnSync(process.execPath,[wrangler,'d1','list','--json'],{cwd:worker,encoding:'utf8'})
    if(list.error)throw list.error
    assert.equal(list.status,0,list.stderr||'Could not verify the staging databases.')
    const databases=JSON.parse(list.stdout)
    for(const binding of config.d1_databases){
      assert.ok(databases.some(db=>db.name===binding.database_name && db.uuid===binding.database_id),
        `The configured ID does not match the dedicated database ${binding.database_name}.`)
    }
    for(const binding of config.d1_databases)cf(['d1','migrations','apply',binding.binding,'--remote'])
    cf(['d1','execute','DB','--remote','--file','initialize-store.sql'])
    cf(['deploy'])
    cf(['pages','deploy','dist','--project-name',frontendProject,'--branch','main'],pages)
  }
} finally {rmSync(root,{recursive:true,force:true})}
