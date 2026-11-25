import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import { chmodSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync } from 'node:fs'
import { basename,join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const [mode,source,destination]=process.argv.slice(2)
assert.ok(['backup','verify'].includes(mode)&&source&&destination,
  'Usage: node tools/backup-d1.mjs backup WRANGLER_CONFIG BACKUP_DIR OR verify ENCRYPTED_BACKUP RESTORE_DIR. Passphrase via stdin.')
const passphrase=readFileSync(0)
assert.ok(passphrase.toString().trimEnd().length>=16,'Use a merchant-held passphrase of at least 16 characters.')
const temp=mkdtempSync(join(tmpdir(),'kirana-d1-backup-'))
const root=resolve(destination)
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js')
const tool=name=>resolve('tools',name)
const run=(script,args,input)=>{
  const result=spawnSync(process.execPath,[script,...args],{input,encoding:'utf8'})
  if(result.error)throw result.error
  assert.equal(result.status,0,result.stderr?.trim()||'Backup command failed.')
}
function restore(dump,output){
  const sql=readFileSync(dump,'utf8')
  const db=new DatabaseSync(output)
  try{
    db.exec('PRAGMA foreign_keys=OFF;'+sql)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='orders'").get()){
      return {
        orders:db.prepare('SELECT COUNT(*) count,COALESCE(SUM(total),0) gross FROM orders').get(),
        refunds:db.prepare('SELECT COUNT(*) count,COALESCE(SUM(amount),0) total FROM refunds').get(),
      }
    }
    const media=db.prepare('SELECT COUNT(*) count,COALESCE(SUM(size),0) bytes FROM media').get()
    assert.equal(db.prepare('SELECT COUNT(*) count FROM media WHERE size<>length(payload)').get().count,0)
    return {media}
  }finally{db.close()}
}
async function verifyArchive(file){
  const hash=createHash('sha256'),lines=createInterface({input:createReadStream(file),crlfDelay:Infinity})
  let previous='',header,orders=0
  for await(const line of lines){
    if(previous){
      hash.update(previous+'\n')
      const data=JSON.parse(previous)
      if(!header)header=data
      else if(data.table==='orders')orders++
    }
    previous=line
  }
  assert.equal(header?.format,'kirana-local-archive-v1')
  assert.equal(header.orders,orders)
  assert.equal(JSON.parse(previous).sha256,hash.digest('hex'))
  return orders
}
try{
  if(mode==='verify'){
    mkdirSync(root,{mode:0o700})
    const dump=join(temp,'verified.sql'),sqlite=join(root,'recovered.sqlite')
    try{
      run(tool('merchant-backup.mjs'),['decrypt',resolve(source),dump],passphrase)
      const totals=restore(dump,sqlite)
      chmodSync(sqlite,0o600)
      console.log(JSON.stringify(totals))
    }catch(error){rmSync(root,{recursive:true,force:true});throw error}
  }else{
    const config=resolve(source)
    mkdirSync(root,{recursive:true,mode:0o700})
    const date=new Date().toISOString().replaceAll(':','-')
    const pending=mkdtempSync(join(root,'.pending-'))
    try{
      const result={}
      for(const binding of ['DB','MEDIA']){
        const dump=join(temp,binding+'.sql'),sqlite=join(temp,binding+'.sqlite')
        run(wrangler,['d1','export',binding,'--config',config,'--remote','--skip-confirmation','--output',dump])
        const encrypted=join(pending,binding+'.sql.enc')
        run(tool('merchant-backup.mjs'),['encrypt',dump,encrypted],passphrase)
        const authenticated=join(temp,binding+'-verified.sql')
        run(tool('merchant-backup.mjs'),['decrypt',encrypted,authenticated],passphrase)
        result[binding]=restore(authenticated,sqlite)
        if(binding==='DB'){
          const archive=join(temp,'settled.ndjson')
          const cutoff=Math.floor(Date.now()/1000)-90*86400
          run(tool('archive-local.mjs'),[sqlite,archive,String(cutoff),'10000'])
          const encryptedArchive=join(pending,'settled.ndjson.enc'),checkedArchive=join(temp,'settled-verified.ndjson')
          run(tool('merchant-backup.mjs'),['encrypt',archive,encryptedArchive],passphrase)
          run(tool('merchant-backup.mjs'),['decrypt',encryptedArchive,checkedArchive],passphrase)
          result.settledOrders=await verifyArchive(checkedArchive)
        }
      }
      writeFileSync(join(pending,'verified.json'),JSON.stringify({date,verified:['DB','MEDIA','settled'],method:'authenticated decrypt and SQLite integrity check'},null,2),{mode:0o600})
      const published=join(root,date)
      renameSync(pending,published)
      console.log(JSON.stringify({backup:basename(published),results:result}))
    }finally{rmSync(pending,{recursive:true,force:true})}
  }
}finally{
  passphrase.fill(0)
  rmSync(temp,{recursive:true,force:true})
}
