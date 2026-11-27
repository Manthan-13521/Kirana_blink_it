import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [existingConfig, merchantManifest, oldClient, preparedConfig, newClient, account, seedWrites] = process.argv.slice(2)
assert.ok(newClient && account && seedWrites !== undefined,
  'Usage: node testing/prepare-benchmark.mjs BENCH_WRANGLER STORE_MANIFEST BENCH_CLIENT NEW_WRANGLER NEW_CLIENT ACCOUNT_ID RECENT_SEED_WRITES')
const json = async (file) => JSON.parse(await readFile(file, 'utf8'))
const worker = await json(existingConfig)
const store = await json(merchantManifest)
const previous = await json(oldClient)
const url = new URL(previous.url)
assert.equal(url.protocol, 'https:')
assert.equal(url.origin, previous.url)
assert.match(url.hostname, /^kirana-benchmark-staging-api\.[a-z0-9-]+\.workers\.dev$/)
assert.equal(worker.name, 'kirana-benchmark-staging-api')
assert.equal(worker.vars.APP_MODE, 'benchmark')
assert.match(account, /^[a-f0-9]{32}$/)
const unseededWrites = Number(seedWrites)
assert.ok(Number.isInteger(unseededWrites) && unseededWrites >= 0 && unseededWrites <= 40000)
const merchantIds = new Set([store.databaseId, store.mediaDatabaseId, ...store.archiveDatabaseIds])
const expectedNames = { DB: 'kirana-benchmark-staging-orders', MEDIA: 'kirana-benchmark-staging-media' }
assert.equal(worker.d1_databases.length, 2)
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js')
function call(args, input) {
  const job = spawnSync(process.execPath, [wrangler, ...args], {
    input, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_SEND_METRICS: 'false' },
  })
  if (job.error) throw job.error
  assert.equal(job.status, 0, 'Wrangler failed during ' + args.slice(0, 3).join(' ') + ': ' + job.stderr?.trim())
  return job.stdout
}
const known = JSON.parse(call(['d1', 'list', '--json']))
for (const binding of worker.d1_databases) {
  assert.equal(binding.database_name, expectedNames[binding.binding])
  assert.ok(!merchantIds.has(binding.database_id), 'Benchmark cannot bind a merchant database.')
  assert.ok(known.some(db => db.name === binding.database_name && db.uuid === binding.database_id),
    'Benchmark database identity was not verified.')
  binding.migrations_dir = resolve(binding.binding === 'DB' ? 'migrations' : 'media-migrations')
}
assert.notEqual(worker.d1_databases[0].database_id, worker.d1_databases[1].database_id)
const token = randomBytes(32).toString('hex')
const until = Math.floor(Date.now() / 1000) + 5 * 3600 - 30
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
assert.match(commit, /^[a-f0-9]{40}$/)
assert.equal(spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'worker', 'migrations', 'media-migrations']).status, 0,
  'Commit the exact benchmark application source before deploying.')
const prepared = {
  name: worker.name, main: resolve('worker/benchmark.ts'), compatibility_date: worker.compatibility_date,
  vars: { APP_MODE: 'benchmark', BENCHMARK_UNTIL: String(until) },
  d1_databases: worker.d1_databases, workers_dev: true, preview_urls: false,
}
await writeFile(preparedConfig, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const base = ['--config', resolve(preparedConfig)]
for (const binding of ['DB', 'MEDIA']) {
  process.stdout.write(call(['d1', 'migrations', 'apply', binding, '--remote', ...base]))
}
call(['secret', 'bulk', ...base], JSON.stringify({ BENCHMARK_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') }))
process.stdout.write(call(['deploy', ...base]))
await writeFile(newClient, JSON.stringify({
  token, url: url.origin, account, expiresAt: new Date(until * 1000).toISOString(), unseededWrites, commit,
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
