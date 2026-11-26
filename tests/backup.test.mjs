import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

test('settled archive and authenticated database recovery preserve financial records',()=>{
  const root=mkdtempSync(join(tmpdir(),'kirana-archive-'))
  const path=name=>join(root,name)
  const database=path('source.sqlite'),snapshot=path('snapshot.sqlite'), restored=path('restored.sqlite')
  const archive=path('financial.ndjson'),encrypted=path('backup.enc')
  const old=1700000000, cutoff=1700010000
  const passphrase='local-qa-only-synthetic-test-passphrase'
  const command=(tool,args,input=passphrase)=>spawnSync(process.execPath,[tool,...args],{input,encoding:'utf8'})
  const backup=(...args)=>command('tools/merchant-backup.mjs',args)
  let db
  try{
    db=new DatabaseSync(database)
    db.exec('PRAGMA foreign_keys=ON')
    for(const migration of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort()){
      db.exec(readFileSync(join('migrations',migration),'utf8'))
    }
    const insert=db.prepare(`INSERT INTO orders(id,account_id,request_key,request_fingerprint,channel,fulfillment,status,
      payment_method,payment_status,subtotal,fees,total,tax,billing_json,created_at,updated_at,reconciled)
      VALUES (?,'demo-owner',?,'fixture','pos','counter',?,'cash',?,5000,0,5000,125,'{"invoice":"placeholder"}',?,?,?)`)
    db.exec('BEGIN')
    for(let i=0;i<1100;i++)insert.run('order-'+i,'key-'+i,'completed','cash_collected',old,old,1)
    insert.run('open-case','key-open','completed','cash_collected',old,old,1)
    insert.run('unreconciled','key-pending','completed','cash_collected',old,old,0)
    insert.run('unresolved','key-unresolved','placed','cash_due',old,old,0)
    insert.run('recent','key-recent','completed','cash_collected',cutoff+1,cutoff+1,1)
    db.exec("INSERT INTO cases(id,order_id,kind,reason,created_at,updated_at) VALUES ('open','open-case','support','Incomplete request',1700000000,1700000000)")
    db.exec("INSERT INTO refunds(id,order_id,amount,actor,created_at) VALUES ('refund-fixture','order-0',5000,'demo-owner',1700000000)")
    db.exec('COMMIT')
    db.prepare('VACUUM INTO ?').run(snapshot)

    const result=command('tools/archive-local.mjs',[snapshot,archive,String(cutoff),'2000'])
    assert.equal(result.status,0,result.stderr)
    assert.equal(JSON.parse(result.stdout).orders,1100)
    const lines=readFileSync(archive,'utf8').trimEnd().split('\n')
    const {sha256}=JSON.parse(lines.pop())
    assert.equal(createHash('sha256').update(lines.join('\n')+'\n').digest('hex'),sha256)
    const records=lines.slice(1).map(JSON.parse)
    assert.equal(records.filter(value=>value.table==='orders').length,1100)
    assert.ok(records.some(value=>value.table==='refunds'&&value.row.amount===5000))
    assert.ok(!records.some(value=>['unreconciled','unresolved','open-case','recent'].includes(value.row.id)))
    assert.equal(db.prepare('SELECT COUNT(*) count FROM orders').get().count,1104)

    assert.equal(backup('encrypt',snapshot,encrypted).status,0)
    assert.equal(backup('decrypt',encrypted,restored).status,0)
    assert.deepEqual(readFileSync(restored),readFileSync(snapshot))
    const recovered=new DatabaseSync(restored,{readOnly:true})
    try {
      assert.equal(recovered.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
      assert.deepEqual(recovered.prepare('PRAGMA foreign_key_check').all(),[])
      assert.equal(recovered.prepare('SELECT SUM(total) total FROM orders').get().total,5520000)
      assert.equal(recovered.prepare('SELECT SUM(amount) total FROM refunds').get().total,5000)
    } finally {recovered.close()}
    const encryptedArchive=path('archive.enc'),invoice=path('invoice.json')
    assert.equal(backup('encrypt',archive,encryptedArchive).status,0)
    const exported=command('tools/backup-d1.mjs',['invoice',encryptedArchive,invoice,'order-0'])
    assert.equal(exported.status,0,exported.stderr)
    const receipt=JSON.parse(readFileSync(invoice,'utf8'))
    assert.equal(receipt.order.total,5000)
    assert.equal(receipt.order.payment_status,'refunded')
    assert.equal(receipt.refunds[0].amount,5000)
    assert.notEqual(command('tools/backup-d1.mjs',['invoice',encryptedArchive,invoice,'order-0']).status,0)
    assert.notEqual(command('tools/backup-d1.mjs',['invoice',encryptedArchive,path('invalid-invoice.json'),'unresolved']).status,0)
    const bytes=readFileSync(encrypted);bytes[40]^=1
    writeFileSync(path('tampered.enc'),bytes)
    assert.notEqual(backup('decrypt',path('tampered.enc'),path('tampered.sqlite')).status,0)
    assert.ok(!existsSync(path('tampered.sqlite')))
    assert.notEqual(command('tools/merchant-backup.mjs',['decrypt',encrypted,path('wrong.sqlite')],'wrong-synthetic-passphrase').status,0)
    assert.ok(!existsSync(path('wrong.sqlite')))
  }finally{
    db?.close()
    rmSync(root,{recursive:true,force:true})
  }
})
