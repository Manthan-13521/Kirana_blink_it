import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const folder = mkdtempSync(join(tmpdir(), 'kirana-growth-'))
const business = new DatabaseSync(join(folder, 'orders.sqlite'))
const media = new DatabaseSync(join(folder, 'media.sqlite'))
const latestDay = Math.floor((Date.now() / 1000 + 19800) / 86400) * 86400 - 19800
const initialDay = latestDay - 89 * 86400
const reportSQL = `SELECT date(created_at+19800,'unixepoch') day,channel,fulfillment,payment_method,
  COUNT(*) order_count,SUM(total) gross FROM orders
  WHERE status='completed' AND created_at>=? GROUP BY day,channel,fulfillment,payment_method ORDER BY day DESC`

function migrate(db, directory) {
  db.exec('PRAGMA foreign_keys=ON')
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort())
    db.exec(readFileSync(join(directory, name), 'utf8'))
}
function allocated(db) {
  return db.prepare('PRAGMA page_size').get().page_size * db.prepare('PRAGMA page_count').get().page_count
}
function integrity(db) {
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
}

try {
  migrate(business, 'migrations')
  migrate(media, 'media-migrations')
  const sample = readdirSync('public/catalog').filter(name => /^\d+\.webp$/.test(name))
    .map(name => readFileSync(join('public/catalog', name)))
  const catalogCount = business.prepare('SELECT COUNT(*) count FROM products').get().count
  const insertProduct = business.prepare(`INSERT INTO products(id,sku,name,category,unit,step,price,mrp,stock,image,updated_at)
    VALUES(?,?,?,'fresh','pc',1,1000,1000,140000,?,?)`)
  const insertMedia = media.prepare('INSERT INTO media(id,payload,size,created_at) VALUES(?,?,?,?)')
  business.exec('BEGIN')
  media.exec('BEGIN')
  for (let index = catalogCount; index < 5000; index++) {
    const id = 'growth-product-' + index
    const image = sample[index % sample.length]
    insertMedia.run(id, image, image.length, initialDay - Math.floor(index / 250) * 86400)
    insertProduct.run(id, id, 'Fixture grocery ' + index, '/media/' + id, initialDay)
  }
  business.exec('COMMIT')
  media.exec('COMMIT')

  const customer = business.prepare("INSERT INTO accounts(id,role,name) VALUES(?,'customer','Historical fixture') ON CONFLICT(id) DO NOTHING")
  const order = business.prepare(`INSERT INTO orders
    (id,account_id,request_key,request_fingerprint,channel,fulfillment,status,payment_method,payment_status,
     subtotal,fees,total,tax,slot_start,slot_end,slot_retained,billing_json,reconciled,created_at,updated_at,config_revision)
    VALUES(?,?,?,'retention-fixture',?,?,'completed',?, ?,3000,0,3000,0,?,?,0,
      '{"name":"Fixture Kirana","buyer":"Synthetic"}',1,?,?,(SELECT revision FROM settings WHERE id=1))`)
  const item = business.prepare(`INSERT INTO order_items
    (order_id,product_id,sku,name,unit,step,quantity,price,line_total,tax,tax_bps,hsn)
    VALUES(?,?,?,'Fixture grocery','pc',1,1,1000,1000,0,0,'')`)
  const event = business.prepare('INSERT INTO order_events(order_id,status,created_at) VALUES(?,?,?)')
  const audit = business.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES(?,?,?,?)')
  const payment = business.prepare(`INSERT INTO order_checkout_payments
    (order_id,provider_order_id,payment_id,mode,expires_at,captured_at) VALUES(?,?,?,'test',?,?)`)
  const summary = business.prepare(reportSQL)
  for (let day = 0; day < 90; day++) {
    const dayStart = initialDay + day * 86400
    business.exec('BEGIN')
    for (let index = 0; index < 1100; index++) {
      const number = day * 1100 + index
      const orderId = 'historical-' + number
      const online = index < 800
      const paid = online && index % 3 === 0
      const account = online ? 'historical-shopper-' + (number % 6000) : 'demo-owner'
      if (online) customer.run(account)
      const time = dayStart + 9 * 3600 + index * 30
      order.run(orderId, account, orderId, online ? 'online' : 'pos', online ? (index < 60 ? 'delivery' : 'pickup') : 'counter',
        paid ? 'online' : 'cash', paid ? 'paid' : 'cash_collected',
        online ? time + 3600 : null, online ? time + 7200 : null, time, time + 300)
      for (let line = 0; line < 3; line++) {
        const product = 'growth-product-' + (catalogCount + (number * 3 + line) % (5000 - catalogCount))
        item.run(orderId, product, product)
      }
      for (const status of online ? ['placed', 'accepted', 'packing', 'ready', 'completed'] : ['completed'])
        event.run(orderId, status, time + 300)
      audit.run(account, online ? 'order.create' : 'counter.sale', orderId, time)
      if (paid) payment.run(orderId, 'order_fixture_' + number, 'pay_fixture_' + number, time + 900, time)
    }
    business.exec('COMMIT')
    if ([29, 59, 89].includes(day)) {
      const samples = Array.from({ length: 15 }, () => {
        const start = performance.now()
        const rows = summary.all(dayStart - 29 * 86400)
        assert.equal(rows.reduce((total, row) => total + row.order_count, 0), 33000)
        return performance.now() - start
      }).sort((a, b) => a - b)
      console.log(JSON.stringify({ days: day + 1, orders: (day + 1) * 1100, skus: 5000,
        businessBytes: allocated(business), separateMediaBytes: allocated(media),
        reportSqliteP50Ms: +samples[7].toFixed(2), reportSqliteP95Ms: +samples[14].toFixed(2) }))
    }
  }
  assert.equal(business.prepare('SELECT count(*) count FROM stock_events').get().count, 297000)
  assert.equal(business.prepare('SELECT MIN(stock) stock FROM products').get().stock >= 0, true)
  integrity(business)
  integrity(media)
  if(process.argv.includes('--rollover-rehearsal'))rehearseRollover()
} finally {
  business.close()
  media.close()
  rmSync(folder, { recursive: true, force: true })
}

function rehearseRollover() {
  // This branch can only open the databases generated by this synthetic run.
  const path = name => join(folder, name)
  const command = (script, ...args) => execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8', input: 'synthetic-rollover-test-passphrase',
  })
  business.prepare('VACUUM INTO ?').run(path('rollover.sqlite'))
  const candidate = new DatabaseSync(path('rollover.sqlite'))
  const cutoff = initialDay + 30 * 86400
  const totalsSQL = 'SELECT COUNT(*) count, SUM(total) gross FROM orders'
  const stockSQL = 'SELECT id,stock FROM products ORDER BY id'
  const original = business.prepare(totalsSQL).get()
  const archived = { count: 0, gross: 0 }
  let cursor = [], sampleInvoice, pages = 0
  try {
    candidate.exec('PRAGMA foreign_keys=ON; CREATE TEMP TABLE archived_orders(id TEXT PRIMARY KEY) WITHOUT ROWID; BEGIN')
    const add = candidate.prepare('INSERT INTO archived_orders(id) VALUES (?)')
    do {
      pages++
      const plain = path('rollover-' + pages + '.ndjson')
      const encrypted = plain + '.enc'
      const exported = JSON.parse(command('tools/archive-local.mjs', path('orders.sqlite'), plain, String(cutoff), '5000', ...cursor.map(String)))
      command('tools/merchant-backup.mjs', 'encrypt', plain, encrypted)
      command('tools/merchant-backup.mjs', 'decrypt', encrypted, plain + '.verified')
      const authenticated = readFileSync(plain + '.verified')
      assert.deepEqual(authenticated, readFileSync(plain))
      const rows = authenticated.toString().trimEnd().split('\n').map(JSON.parse)
        .filter(record => record.table === 'orders').map(record => record.row)
      assert.equal(rows.length, exported.orders)
      for (const order of rows) {
        add.run(order.id)
        archived.count++
        archived.gross += order.total
      }
      if (!sampleInvoice && rows.length) {
        const order = rows.find(row => row.payment_method === 'online')
        assert.ok(order)
        command('tools/backup-d1.mjs', 'invoice', encrypted, path('rollover-invoice.json'), order.id)
        const invoice = JSON.parse(readFileSync(path('rollover-invoice.json'), 'utf8'))
        assert.equal(invoice.order.total, order.total)
        assert.equal(invoice.order.payment_status, 'paid')
        assert.equal(invoice.items.length, 3)
        sampleInvoice = order.id
      }
      rmSync(plain)
      rmSync(plain + '.verified')
      cursor = exported.next
    } while (cursor)
    assert.equal(archived.count, 33000)
    assert.ok(sampleInvoice)

    const references = candidate.prepare(`SELECT m.name, f."from" AS field FROM sqlite_schema m
      JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f."table"='orders'`).all()
    // Fail on an unexpected relationship so an application schema change cannot silently lose records.
    const expected = ['cases','notices','order_checkout_payments','order_events','order_items',
      'order_payment_links','order_provider_refunds','refunds','stock_events']
    assert.deepEqual(references.map(row => row.name).sort(), expected)
    assert.ok(references.every(row => row.field === 'order_id'))
    candidate.exec(`DELETE FROM audit WHERE subject IN (SELECT id FROM archived_orders)
      OR subject IN (SELECT id FROM cases WHERE order_id IN (SELECT id FROM archived_orders))`)
    for (const table of expected) {
      candidate.exec('CREATE INDEX rollover_fk_' + table + ' ON ' + table + '(order_id)')
      candidate.exec('DELETE FROM ' + table + ' WHERE order_id IN (SELECT id FROM archived_orders)')
    }
    candidate.exec('DELETE FROM orders WHERE id IN (SELECT id FROM archived_orders)')
    for (const table of expected)candidate.exec('DROP INDEX rollover_fk_' + table)
    candidate.exec('COMMIT; VACUUM')
    const remaining = candidate.prepare(totalsSQL).get()
    assert.equal(remaining.count + archived.count, original.count)
    assert.equal(remaining.gross + archived.gross, original.gross)
    assert.deepEqual(candidate.prepare(stockSQL).all(), business.prepare(stockSQL).all())
    assert.equal(candidate.prepare('SELECT 1 FROM orders WHERE id=?').get(sampleInvoice), undefined)
    assert.deepEqual(business.prepare(totalsSQL).get(), original)
    integrity(candidate)
    const sourceBytes = allocated(business), candidateBytes = allocated(candidate)
    assert.ok(candidateBytes < sourceBytes)
    console.log(JSON.stringify({ type: 'synthetic rollover rehearsal', sourceOrders: original.count,
      candidateOrders: remaining.count, archivedOrders: archived.count, archivedPages: pages,
      sourceBytes, candidateBytes, bytesReclaimed: sourceBytes - candidateBytes,
      stockUnchanged: true, totalsMatch: true, archiveInvoiceRecovered: true, sourceUnchanged: true }))
  } finally {
    candidate.close()
  }
}
