import { createHash,randomUUID } from 'node:crypto'
import { closeSync,fsyncSync,linkSync,openSync,rmSync,writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const [source,destination,cutoffValue,limitValue='1000']=process.argv.slice(2)
const cutoff=Number(cutoffValue),limit=Number(limitValue)
if(!source||!destination||!Number.isSafeInteger(cutoff)||cutoff<=0||cutoff>=Date.now()/1000||
  !Number.isInteger(limit)||limit<1||limit>10000){
  throw new Error('Usage: node tools/archive-local.mjs LOCAL_SQLITE NEW_ARCHIVE CUTOFF_UNIX_SECONDS [LIMIT_1_TO_10000]')
}

const db=new DatabaseSync(source,{readOnly:true})
const temporary=destination+'.'+randomUUID()+'.tmp'
let file
try {
  const provider=Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='order_provider_refunds'").get())
  const checkout=Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='order_checkout_payments'").get())
  db.exec('CREATE TEMP TABLE selected(id TEXT PRIMARY KEY) WITHOUT ROWID; BEGIN')
  db.prepare(`INSERT INTO selected
    SELECT o.id FROM orders o WHERE o.updated_at<?
      AND o.status IN('completed','failed','cancelled','rejected')
      AND (o.payment_status IN('void','refunded') OR
        (o.payment_status IN('paid','cash_collected') AND o.reconciled=1))
      AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.order_id=o.id AND c.status='open')
      ${provider?"AND NOT EXISTS(SELECT 1 FROM order_provider_refunds r WHERE r.order_id=o.id AND r.status<>'processed')":''}
    ORDER BY o.updated_at,o.id LIMIT ?`).run(cutoff,limit)
  const count=db.prepare('SELECT COUNT(*) count FROM selected').get().count
  const digest=createHash('sha256')
  file=openSync(temporary,'wx',0o600)
  const record=(data)=>{
    const line=JSON.stringify(data)+'\n'
    writeFileSync(file,line)
    digest.update(line)
  }
  record({format:'kirana-local-archive-v1',cutoff,orders:count})
  for(const table of ['orders','order_items','order_events','stock_events','cases','refunds',...(provider?['order_payment_links','order_provider_refunds']:[]),...(checkout?['order_checkout_payments']:[])]){
    const key=table==='orders'?'id':'order_id'
    const rows=db.prepare(`SELECT data.* FROM ${table} AS data JOIN selected ON selected.id=data.${key}`).iterate()
    for(const row of rows)record({table,row})
  }
  const audits=db.prepare(`SELECT a.* FROM audit a WHERE a.subject IN(SELECT id FROM selected)
    OR a.subject IN(SELECT c.id FROM cases c JOIN selected s ON s.id=c.order_id)`).iterate()
  for(const row of audits)record({table:'audit',row})
  writeFileSync(file,JSON.stringify({sha256:digest.digest('hex')})+'\n')
  fsyncSync(file)
  closeSync(file);file=undefined
  db.exec('COMMIT')
  // Publish only a complete file, and refuse to replace an existing archive.
  linkSync(temporary,destination)
  console.log(JSON.stringify({orders:count,cutoff}))
} finally {
  if(file!==undefined)closeSync(file)
  db.close()
  rmSync(temporary,{force:true})
}
