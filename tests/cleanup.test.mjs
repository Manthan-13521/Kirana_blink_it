import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { harness } from './harness.mjs'

const fixture=fileURLToPath(new URL('./cleanup-fixture.sql',import.meta.url))
test('Cron prunes temporary rows and releases only expired mock reservations',async()=>{
  const local=await harness(fixture)
  try{
    const [initial]=await local.readBusiness("SELECT stock FROM products WHERE id='milk'")
    const response=await fetch(local.base+'/cdn-cgi/local/scheduled?cron='+encodeURIComponent('*/10 * * * *'))
    const dispatch=await response.text()
    assert.equal(response.status,200,dispatch)
    assert.doesNotMatch(dispatch,/<!doctype html>/i)
    const status=()=>local.readBusiness("SELECT id,status,payment_status FROM orders WHERE id IN('old-mock','open-cash') ORDER BY id")
    let rows=await status()
    const deadline=Date.now()+3500
    while(rows[0]?.status==='awaiting_payment'&&Date.now()<deadline){await delay(100);rows=await status()}
    assert.deepEqual(rows.map(row=>[row.status,row.payment_status]),[['cancelled','void'],['placed','cash_due']])
    const [final]=await local.readBusiness("SELECT stock FROM products WHERE id='milk'")
    assert.equal(final.stock,initial.stock+500)
    for(const table of ['sessions','invites','carts','notices']){
      const [row]=await local.readBusiness(`SELECT COUNT(*) count FROM ${table} WHERE ${table==='notices'?'created_at=1700000000':'1=1'}`)
      assert.equal(row.count,0,table)
    }
    const [orderItems]=await local.readBusiness("SELECT COUNT(*) count FROM order_items WHERE order_id='old-mock'")
    assert.equal(orderItems.count,1)
  }finally{await local.stop()}
})
