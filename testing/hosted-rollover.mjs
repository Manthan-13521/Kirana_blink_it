import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [directory] = process.argv.slice(2)
assert.ok(directory, 'Usage: node testing/hosted-rollover.mjs NEW_PRIVATE_EVIDENCE_DIR')
const evidence = resolve(directory)
mkdirSync(evidence, { mode: 0o700 })
const wrangler = args => execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args],
  { encoding: 'utf8', timeout: 90000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
const source = 'kirana-rollover-qa-source', candidate = 'kirana-rollover-qa-candidate'
const databases = JSON.parse(wrangler(['d1', 'list', '--json']))
const id = name => databases.find(db => db.name === name)?.uuid
assert.ok(id(source) && id(candidate) && id(source) !== id(candidate), 'Set up the dedicated QA pair first.')
const migrations = join(evidence, 'migrations')
mkdirSync(migrations)
for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql') && !name.includes('local_catalog')))
  copyFileSync(join('migrations', name), join(migrations, name))
const config = join(evidence, 'wrangler.json')
writeFileSync(config, JSON.stringify({
  name: 'kirana-rollover-qa', compatibility_date: '2026-10-01',
  d1_databases: [source, candidate].map((name, index) => ({
    binding: index ? 'CANDIDATE' : 'SOURCE', database_name: name, database_id: id(name), migrations_dir: 'migrations',
  })),
}), { mode: 0o600 })
const remote = (operation, binding, args) => wrangler(['d1', operation, binding, '--config', config, ...args])
const query = (binding, sql) => JSON.parse(remote('execute', binding, ['--remote', '--json', '--command', sql]))[0]
const empty = binding => query(binding, "SELECT COUNT(*) AS existing FROM sqlite_schema WHERE name='settings'").results[0].existing === 0
assert.ok(empty('SOURCE') && empty('CANDIDATE'), 'Both QA databases must start empty.')
wrangler(['d1', 'migrations', 'apply', 'SOURCE', '--config', config, '--remote'])
remote('execute', 'SOURCE', ['--remote', '--file', resolve('testing/hosted-rollover-fixture.sql'), '--yes'])

const snapshot = binding => {
  assert.deepEqual(query(binding, 'PRAGMA foreign_key_check').results, [])
  return query(binding, `SELECT o.id,o.status,o.payment_status,o.total,o.billing_json,o.request_key,
    p.provider_order_id,p.payment_id,i.line_total,products.stock,
    (SELECT count(*) FROM stock_events s WHERE s.order_id=o.id) AS inventoryEvents,
    (SELECT count(*) FROM order_events e WHERE e.order_id=o.id) AS historyEvents,
    (SELECT accepting FROM settings WHERE id=1) AS accepting
    FROM orders o JOIN order_items i ON i.order_id=o.id JOIN products ON i.product_id=products.id
    LEFT JOIN order_checkout_payments p ON p.order_id=o.id ORDER BY o.id`).results
}
const before = snapshot('SOURCE')
assert.equal(before.length, 2)
assert.equal(before[0].status, 'placed')
assert.equal(before[1].payment_status, 'paid')
assert.ok(before[1].payment_id)
assert.ok(before.every(row => row.stock === 18 && row.line_total === 1000 && row.inventoryEvents === 1 &&
  row.historyEvents >= 1 && row.accepting === 0))
const bookmark = JSON.parse(wrangler(['d1', 'time-travel', 'info', 'SOURCE', '--config', config, '--json']))
assert.ok(Object.keys(bookmark).some(key => /bookmark/i.test(key) && typeof bookmark[key] === 'string'),
  'Cloudflare did not return a source recovery bookmark.')
const dump = join(evidence, 'synthetic-source.sql')
remote('export', 'SOURCE', ['--remote', '--skip-confirmation', '--output', dump])
remote('execute', 'CANDIDATE', ['--remote', '--file', dump, '--yes'])
assert.deepEqual(snapshot('CANDIDATE'), before)
assert.deepEqual(snapshot('SOURCE'), before)
const result = { completedAt: new Date().toISOString(), hosted: true, isolatedDatabases: 2, orders: 2,
  preserved: ['active order', 'paid order', 'invoice lines', 'payment identifiers', 'checkout keys', 'history', 'inventory'],
  sourceBookmarkRecorded: true, sourceUnchanged: true, candidateForeignKeysClean: true }
writeFileSync(join(evidence, 'verified.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify(result))
