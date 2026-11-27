import { closeSync,existsSync,mkdirSync,openSync,readFileSync,writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join,resolve } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const [storePath,workerPath,backupDir,mode]=process.argv.slice(2)
assert.ok(storePath&&workerPath&&backupDir&&(mode===undefined||mode==='--backup-only'),
  'Usage: node tools/maintenance.mjs STORE_JSON GENERATED_WORKER_CONFIG PRIVATE_BACKUP_DIR [--backup-only]. Passphrase via stdin.')
const config=JSON.parse(readFileSync(storePath,'utf8'))
const worker=JSON.parse(readFileSync(workerPath,'utf8'))
assert.equal(worker.name,config.slug+'-api')
for(const [name,id] of [['DB',config.databaseId],['MEDIA',config.mediaDatabaseId]]){
  assert.ok(worker.d1_databases.some(database=>database.binding===name&&database.database_id===id))
}
const root=resolve(backupDir)
mkdirSync(root,{recursive:true,mode:0o700})
assert.ok(!existsSync(join(root,'.maintenance.lock')),'Check for a running legacy maintenance job before clearing its lock.')
const path=join(root,'.maintenance.sqlite')
closeSync(openSync(path,'a',0o600))
const lock=new DatabaseSync(path)
const passphrase=readFileSync(0)
// India's overnight backup runs before UTC midnight. Deduplicate by the store's calendar day.
const stamp=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Kolkata'})
function once(name,script,args,input){
  const done=join(root,stamp+'-'+name+'.done')
  if(existsSync(done))return
  const result=spawnSync(process.execPath,[script,...args],{input,encoding:'utf8'})
  if(result.error)throw result.error
  assert.equal(result.status,0,result.stderr?.trim()||name+' failed.')
  writeFileSync(done,new Date().toISOString()+'\n',{flag:'wx',mode:0o600})
  console.log(name+' completed.')
}
try{
  // SQLite releases the lease when an interrupted runner exits. Keep this directory on local disk.
  lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
  once('backup','tools/backup-d1.mjs',['backup',workerPath,backupDir],passphrase)
  if(!mode)once('static-images','tools/publish-media-static.mjs',[storePath,workerPath])
}finally{
  passphrase.fill(0)
  lock.close()
}
