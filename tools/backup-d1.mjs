import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import { chmodSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync } from 'node:fs'
import { basename,join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const [mode,source,destination,orderId]=process.argv.slice(2)
assert.ok(['backup','verify','invoice'].includes(mode)&&source&&destination&&
  (mode!=='invoice'||typeof orderId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(orderId)),
  'Usage: node tools/backup-d1.mjs backup WRANGLER_CONFIG BACKUP_DIR OR verify ENCRYPTED_BACKUP RESTORE_DIR OR invoice ENCRYPTED_ARCHIVE NEW_JSON ORDER_ID. Passphrase via stdin.')
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
  return result.stdout
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
  const receipt={order:null,items:[],refunds:[]}
  for await(const line of lines){
    if(previous){
      hash.update(previous+'\n')
      const data=JSON.parse(previous)
      if(!header)header=data
      else if(data.table==='orders'){
        orders++
        if(orderId&&data.row.id===orderId){
          const {id,status,fulfillment,payment_method,payment_status,fees,subtotal,total,tax,billing_json,created_at}=data.row
          receipt.order={id,status,fulfillment,payment_method,payment_status,fees,subtotal,total,tax,invoice:JSON.parse(billing_json),created_at}
        }
      }else if(orderId&&data.row?.order_id===orderId){
        if(data.table==='order_items')receipt.items.push(data.row)
        if(data.table==='refunds')receipt.refunds.push({amount:data.row.amount,created_at:data.row.created_at})
      }
    }
    previous=line
  }
  assert.equal(header?.format,'kirana-local-archive-v1')
  assert.equal(header.orders,orders)
  assert.equal(JSON.parse(previous).sha256,hash.digest('hex'))
  return {orders,receipt}
}
try{
  if(mode==='invoice'){
    const dump=join(temp,'verified.ndjson')
    run(tool('merchant-backup.mjs'),['decrypt',resolve(source),dump],passphrase)
    const {receipt}=await verifyArchive(dump)
    assert.ok(receipt.order,'Order is absent from this verified archive.')
    writeFileSync(root,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600})
    console.log('Verified historical invoice exported.')
  }else if(mode==='verify'){
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
          const cutoff=Math.floor(Date.now()/1000)-90*86400
          const archive=join(temp,'settled.ndjson'),checked=join(temp,'settled-verified.ndjson')
          const archives=[]
          let cursor=[],sum=0
          do{
            const index=archives.length+1
            const name=index===1?'settled.ndjson.enc':`settled-${String(index).padStart(3,'0')}.ndjson.enc`
            const exported=JSON.parse(run(tool('archive-local.mjs'),[sqlite,archive,String(cutoff),'10000',...cursor.map(String)]))
            const encryptedArchive=join(pending,name)
            run(tool('merchant-backup.mjs'),['encrypt',archive,encryptedArchive],passphrase)
            run(tool('merchant-backup.mjs'),['decrypt',encryptedArchive,checked],passphrase)
            const {orders}=await verifyArchive(checked)
            assert.equal(orders,exported.orders)
            sum+=orders
            archives.push({file:name,orders})
            rmSync(archive)
            rmSync(checked)
            cursor=exported.next
          }while(cursor)
          result.settledOrders=sum
          result.archives=archives
        }
      }
      writeFileSync(join(pending,'verified.json'),JSON.stringify({date,verified:['DB','MEDIA','settled'],method:'authenticated decrypt and SQLite integrity check',archives:result.archives},null,2),{mode:0o600})
      const published=join(root,date)
      renameSync(pending,published)
      console.log(JSON.stringify({backup:basename(published),results:result}))
    }finally{rmSync(pending,{recursive:true,force:true})}
  }
}finally{
  passphrase.fill(0)
  rmSync(temp,{recursive:true,force:true})
}
