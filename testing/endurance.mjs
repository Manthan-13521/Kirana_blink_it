import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { setTimeout as wait } from 'node:timers/promises'

const [configPath, evidencePath] = process.argv.slice(2)
assert.ok(configPath && evidencePath, 'Usage: node testing/endurance.mjs PRIVATE_CONFIG NEW_EVIDENCE_JSONL')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const origin = new URL(config.url)
assert.equal(origin.origin, config.url)
assert.equal(origin.protocol, 'https:')
assert.match(origin.hostname, /^kirana-benchmark-staging-api\.[a-z0-9-]+\.workers\.dev$/)
assert.match(config.token, /^[a-f0-9]{64}$/)
assert.match(config.account, /^[a-f0-9]{32}$/)
assert.ok(process.env.CLOUDFLARE_API_TOKEN || process.env.KIRANA_WRANGLER_OAUTH_CONFIG,
  'Set the account analytics token or the local Wrangler OAuth config path.')
assert.ok(Number.isInteger(config.unseededWrites) && config.unseededWrites >= 0,
  'Set unseededWrites to any synthetic seed writes that may still be absent from analytics.')

const execute = promisify(execFile)
const samples = new Map()
const usage = { requests: 0, reads: 0, writes: 0, statements: 0, maxStatements: 0, unexpected: 0 }
const completed = { online: 0, counter: 0, delivery: 0, simulatedOnlinePayments: 0, expectedFailures: 0 }
const runLimits = { requests: 12000, reads: 400000, writes: 26000 }
const accountLimits = { requests: 70000, reads: 3500000, writes: 70000 }
const phases = [
  { name: 'baseline', minutes: 30, width: 6, salesEvery: 4 },
  { name: 'sustained', minutes: 60, width: 12, salesEvery: 2 },
  { name: 'peak', minutes: 45, width: 16, salesEvery: 2 },
  { name: 'endurance', minutes: 60, width: 10, salesEvery: 3 },
  { name: 'recovery', minutes: 30, width: 6, salesEvery: 5 },
  { name: 'verification', minutes: 15, width: 6, salesEvery: 5 },
]
const minute = 60000
const timestamp = () => new Date().toISOString()
await writeFile(evidencePath, '', { flag: 'wx', mode: 0o600 })
const record = (event, fields = {}) => appendFile(evidencePath, JSON.stringify({ time: timestamp(), event, ...fields }) + '\n')
let account, initialAccount
let aborting = false
process.on('SIGINT', () => { aborting = true })
process.on('SIGTERM', () => { aborting = true })

async function quota() {
  const env = { ...process.env }
  if (!env.CLOUDFLARE_API_TOKEN) {
    await execute(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'whoami'], { timeout: 20000 })
    const oauth = await readFile(env.KIRANA_WRANGLER_OAUTH_CONFIG, 'utf8')
    env.CLOUDFLARE_API_TOKEN = oauth.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1]
    assert.ok(env.CLOUDFLARE_API_TOKEN, 'Wrangler OAuth token is unavailable.')
  }
  const { stdout } = await execute(process.execPath,
    ['tools/quota-report.mjs', config.account, 'kirana-benchmark-staging-api'], { env, timeout: 20000 })
  account = JSON.parse(stdout)
  assert.equal(account.utcDay, timestamp().slice(0, 10), 'Benchmark requires a current UTC quota snapshot.')
  if (!initialAccount) initialAccount = account
  assert.equal(account.utcDay, initialAccount.utcDay, 'UTC quota reset occurred during this run.')
  await record('cloudflare-analytics', { usage: account })
}

function checkBudget() {
  assert.equal(aborting, false, 'Benchmark stopped by operator.')
  assert.ok(account && Date.now() - Date.parse(account.asOf) < 10 * minute, 'Cloudflare quota telemetry is stale.')
  const observed = { requests: account.workerRequests.value, reads: account.d1RowsRead.value, writes: account.d1RowsWritten.value }
  const baseline = { requests: initialAccount.workerRequests.value, reads: initialAccount.d1RowsRead.value,
    writes: initialAccount.d1RowsWritten.value + config.unseededWrites }
  for (const [key, limit] of Object.entries(runLimits)) {
    const reserve = key === 'requests' ? 120 : key === 'reads' ? 4000 : 500
    assert.ok(usage[key] + reserve < limit, 'Benchmark ' + key + ' budget reached.')
    assert.ok(Math.max(observed[key], baseline[key] + usage[key]) + reserve < accountLimits[key],
      'Account-wide ' + key + ' safety budget reached.')
  }
}

function client() {
  let cookie = ''
  return async (path, { method = 'GET', body, expected = 200, unsigned = false } = {}) => {
    checkBudget()
    const started = performance.now()
    usage.requests++
    // Only the private benchmark Worker is ever addressed.
    const headers = {
      ...(unsigned ? {} : { Authorization: 'Bearer ' + config.token }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'GET' ? {} : { Origin: origin.origin, 'Content-Type': 'application/json' }),
    }
    let response
    try {
      response = await fetch(origin.origin + '/api' + path, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(12000),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      usage.unexpected++
      throw new Error(method + ' ' + path.split('?')[0] + ' failed before an HTTP response.')
    }
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';', 1)[0]
    const metric = response.headers.get('x-kirana-d1')
    if (metric) {
      const { reads, writes, statements } = JSON.parse(metric)
      usage.reads += reads
      usage.writes += writes
      usage.statements += statements
      usage.maxStatements = Math.max(usage.maxStatements, statements)
    }
    const result = await response.json().catch(() => null)
    const route = method + ' ' + path.split('?')[0].replace(/[a-f0-9-]{36}/g, ':id').replace(/load-\d+$/, ':sku')
    if (!samples.has(route)) samples.set(route, [])
    samples.get(route).push(performance.now() - started)
    if (response.status !== expected || (!metric && !unsigned)) {
      usage.unexpected++
      throw new Error(route + ' returned HTTP ' + response.status + ' instead of ' + expected)
    }
    return result
  }
}

const guest = client(), owner = client(), rider = client()
const write = (actor, path, body = {}, expected = 200) => actor(path, { method: 'POST', body, expected })
const status = (actor, id, next, extra = {}) => write(actor, '/orders/' + id + '/state', { status: next, ...extra })
const skuFor = (n) => 'load-' + String(n % 4984 + 1).padStart(4, '0')
const buyers = []
let counter = 0, buyerIndex = 0, peakWidth = 0

async function sale(channel, { replay = false, fail = false } = {}) {
  const buyer = buyers[buyerIndex++ % buyers.length]
  const n = counter++
  const online = channel === 'online'
  const delivery = online && n % 13 === 0
  const fulfillment = online ? (delivery ? 'delivery' : 'pickup') : 'counter'
  const actor = online ? buyer.call : owner
  const method = online && (fail || n % 4 === 0) ? 'online' : 'cash'
  const data = { fulfillment, method, items: Array.from({ length: 6 }, (_, index) => ({ id: skuFor(n * 13 + index), steps: 1 })) }
  if (online) {
    const windows = await guest('/slots?mode=' + fulfillment)
    assert.ok(windows?.length, 'No available synthetic fulfillment window.')
    data.slot = windows[n % windows.length].start
    if (delivery) data.addressId = buyer.address
  }
  const quote = await write(actor, '/quote', data)
  const body = { ...data, version: quote.version, key: crypto.randomUUID() }
  const path = online ? '/orders' : '/pos'
  const { id } = await write(actor, path, body, 201)
  if (replay) assert.deepEqual(await write(actor, path, body), { id, replayed: true })
  if (!online) { completed.counter++; return }
  if (method === 'online') {
    await write(actor, '/orders/' + id + '/test-payment', { result: fail ? 'failed' : 'paid' })
    await write(actor, '/orders/' + id + '/test-payment', { result: fail ? 'failed' : 'paid' })
    if (fail) {
      const order = await actor('/orders/' + id)
      assert.equal(order.status, 'cancelled')
      assert.equal(order.payment_status, 'void')
      completed.expectedFailures++
      return
    }
    completed.simulatedOnlinePayments++
  }
  await status(owner, id, 'accepted')
  if (delivery) await write(owner, '/orders/' + id + '/assign')
  await status(owner, id, 'packing')
  await status(owner, id, 'ready')
  if (delivery) await status(rider, id, 'out_for_delivery')
  await status(delivery ? rider : owner, id, 'completed', method === 'cash' ? { cash: quote.total } : {})
  if (delivery && method === 'cash') await write(owner, '/orders/' + id + '/reconcile')
  completed.online++
  if (delivery) completed.delivery++
}

function browse(width, offset) {
  peakWidth = Math.max(width, peakWidth)
  return Promise.all(Array.from({ length: width }, (_, index) => {
    const serial = offset + index
    if (serial % 3 === 0) return guest('/catalog?category=pantry&limit=12')
    if (serial % 3 === 1) return guest('/catalog?q=benchmark+' + skuFor(serial).slice(5) + '&limit=12')
    return guest('/catalog/' + skuFor(serial))
  }))
}

function distribution(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const q = (rank) => Math.round(sorted[Math.ceil(sorted.length * rank) - 1])
  return { count: sorted.length, p50Ms: q(.5), p95Ms: q(.95), p99Ms: q(.99) }
}

try {
  assert.ok(Date.parse(config.expiresAt) - Date.now() >= 4.2 * 3600000, 'Renew the isolated benchmark token before the four-hour run.')
  await quota()
  await guest('/health', { expected: 404, unsigned: true })
  const before = await guest('/__benchmark/integrity')
  assert.equal(before.skus, 5000)
  assert.equal(before.pending, 0)
  await write(owner, '/auth/demo', { role: 'owner' })
  await write(rider, '/auth/demo', { role: 'rider' })
  for (let index = 0; index < 8; index++) {
    const customer = client()
    const name = 'Endurance shopper ' + index
    await write(customer, '/auth/register-local', { name })
    const address = await write(customer, '/addresses', {
      label: 'Fixture', recipient: name, phone: '9000000099', line1: 'Synthetic lane',
      locality: 'Hyderabad fixture', pin: '500034', latitude: 17.413, longitude: 78.421,
    }, 201)
    buyers.push({ call: customer, address: address.id })
  }
  const started = Date.now()
  let deadline = started
  await record('start', { expectedMinutes: 240, applicationCommit: config.commit, before, phases, runLimits, accountLimits })
  for (const phase of phases) {
    deadline += phase.minutes * minute
    await record('phase-start', { phase: phase.name })
    let tick = 0
    while (Date.now() < deadline) {
      const cycleStart = Date.now()
      if (Date.now() - Date.parse(account.asOf) >= 5 * minute) await quota()
      const width = phase.name === 'peak' && tick % 12 === 0
        ? [10, 25, 32, 50, 100][Math.floor(tick / 12) % 5] : phase.width
      await browse(width, counter * 31 + tick)
      if (tick % phase.salesEvery === 0) {
        await sale('online', { replay: phase.name === 'peak', fail: phase.name === 'recovery' && tick % 10 === 0 })
        if (tick % (phase.salesEvery * 3) === 0) await sale('pos')
      }
      if (tick % 8 === 0) await Promise.all([owner('/admin/summary'), rider('/rider/route'), buyers[0].call('/me')])
      if (phase.name === 'recovery' && tick % 12 === 0) {
        await guest('/health', { expected: 404, unsigned: true })
        await guest('/admin/settings', { expected: 401 })
        await write(buyers[0].call, '/quote', { fulfillment: 'pickup', method: 'cash', items: [] }, 400)
        completed.expectedFailures += 3
      }
      await record('checkpoint', { phase: phase.name, tick, concurrency: width, completed, usage, elapsedSeconds: Math.floor((Date.now() - started) / 1000) })
      tick++
      // Wait only until the next cycle or phase boundary.
      const delay = Math.max(0, Math.min(deadline - Date.now(), 30000 - (Date.now() - cycleStart)))
      if (delay) await wait(delay)
    }
  }
  const after = await guest('/__benchmark/integrity')
  await quota()
  assert.equal(after.pending, 0)
  assert.equal(after.skus, before.skus)
  assert.ok(after.minStock >= 0)
  assert.equal(after.badTotals, before.badTotals)
  assert.equal(after.paymentMismatch, before.paymentMismatch)
  assert.equal(after.duplicateCompletions, before.duplicateCompletions)
  assert.equal(after.online - before.online, completed.online)
  assert.equal(after.counter - before.counter, completed.counter)
  const elapsedSeconds = Math.floor((Date.now() - started) / 1000)
  assert.ok(elapsedSeconds >= 14400, 'Evidence is shorter than four hours.')
  await record('complete', { elapsedSeconds, after, usage, completed, peakWidth,
    latency: distribution([...samples.values()].flat()),
    endpoints: Object.fromEntries([...samples].map(([route, values]) => [route, distribution(values)])),
  })
} catch (error) {
  await record('stopped', { error: error.message, usage, completed })
  process.exitCode = 1
}
