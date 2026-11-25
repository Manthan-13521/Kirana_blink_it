import { closeSync,existsSync,mkdirSync,openSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join,resolve } from 'node:path'
import assert from 'node:assert/strict'

const [storePath,workerPath,backupDir]=process.argv.slice(2)
assert.ok(storePath&&workerPath&&backupDir,
  'Usage: node tools/maintenance.mjs STORE_JSON GENERATED_WORKER_CONFIG PRIVATE_BACKUP_DIR. Passphrase via stdin.')
const config=JSON.parse(readFileSync(storePath,'utf8'))
const worker=JSON.parse(readFileSync(workerPath,'utf8'))
assert.equal(worker.name,config.slug+'-api')
for(const [name,id] of [['DB',config.databaseId],['MEDIA',config.mediaDatabaseId]]){
  assert.ok(worker.d1_databases.some(database=>database.binding===name&&database.database_id===id))
}
const root=resolve(backupDir)
mkdirSync(root,{recursive:true,mode:0o700})
const lock=join(root,'.maintenance.lock')
const fd=openSync(lock,'wx',0o600)
const passphrase=readFileSync(0)
const stamp=new Date().toISOString().slice(0,10)
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
  once('backup','tools/backup-d1.mjs',['backup',workerPath,backupDir],passphrase)
  once('static-images','tools/publish-media-static.mjs',[storePath,workerPath])
}finally{
  passphrase.fill(0)
  closeSync(fd)
  rmSync(lock,{force:true})
}
