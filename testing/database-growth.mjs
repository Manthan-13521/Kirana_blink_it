import assert from 'node:assert/strict'
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
} finally {
  business.close()
  media.close()
  rmSync(folder, { recursive: true, force: true })
}
