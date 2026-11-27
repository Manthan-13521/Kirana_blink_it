import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertTargetHeadroom, readQuota } from './benchmark-quota.mjs'

const [policyPath, mode] = process.argv.slice(2)
assert.ok(policyPath && (mode === undefined || mode === '--preflight'),
  'Usage: node testing/run-hosted-target.mjs PRIVATE_POLICY_JSON [--preflight]')
const load = path => JSON.parse(readFileSync(path, 'utf8'))
const policy = load(policyPath)
const previous = load(policy.previousClient)
assert.match(previous.account, /^[a-f0-9]{32}$/)
assert.match(previous.url, /^https:\/\/kirana-benchmark-staging-api\.[a-z0-9-]+\.workers\.dev$/)
const start = Date.parse(policy.startAt), end = Date.parse(policy.endAt)
assert.ok(Number.isFinite(start) && end > start && end - start <= 4 * 3600000)
assert.equal(policy.startAt.slice(0, 10), policy.endAt.slice(0, 10), 'Use a single UTC quota day.')
assert.ok(Date.parse(previous.expiresAt) < start, 'Wait for the existing endurance credential to expire.')

const quota = readQuota(previous.account)
let headroom = true, refusal
try { assertTargetHeadroom(quota) } catch (error) { headroom = false; refusal = error.message }
const inWindow = Date.now() >= start && Date.now() < end
const admission = { inWindow, headroom, ...(refusal ? { refusal } : {}), quota }
console.log(JSON.stringify({ event: 'preflight', ...admission }))
if (mode === '--preflight') process.exit(0)
assert.ok(inWindow, 'Outside the authorized benchmark window.')
assert.ok(headroom, refusal)

// Exclusive directory admission prevents a second run after any partial financial fixture writes.
const root = resolve(policy.evidenceDirectory)
mkdirSync(root, { mode: 0o700 })
const events = join(root, 'schedule.jsonl')
const record = (event, fields = {}) => appendFileSync(events,
  JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 })
record('admitted', admission)
const worker = join(root, 'worker.json'), client = join(root, 'client.json'), quotaPath = join(root, 'quota.json')
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_ACCOUNT_ID: previous.account }
function run(label, args, timeout, stdoutPath = join(root, label + '.log')) {
  const out = openSync(stdoutPath, 'wx', 0o600)
  let err
  try {
    err = openSync(join(root, label + '.stderr.log'), 'wx', 0o600)
    const child = spawnSync(process.execPath, args, { env, stdio: ['ignore', out, err], timeout })
    if (child.error) throw child.error
    assert.equal(child.status, 0, label + ' failed. See the private logs.')
  } finally {
    closeSync(out)
    if (err !== undefined) closeSync(err)
  }
}
try {
  // Existing populated fixture only. prepare-benchmark independently validates resource isolation.
  run('credential', ['testing/prepare-benchmark.mjs', policy.workerConfig, policy.merchantManifest,
    policy.previousClient, worker, client, previous.account, '0'], 180000)
  const fresh = readQuota(previous.account)
  assert.equal(fresh.utcDay, quota.utcDay)
  assertTargetHeadroom(quota, fresh)
  writeFileSync(quotaPath, JSON.stringify(fresh), { mode: 0o600, flag: 'wx' })
  record('workload-started', { quota: fresh })
  const temporaryResult = join(root, 'result.partial')
  run('target', ['tests/hosted-benchmark.mjs', client, 'target', quotaPath, join(root, 'workload.jsonl')],
    60 * 60000, temporaryResult)
  const outcome = load(temporaryResult)
  assert.equal(outcome.catalog, 5000)
  assert.equal(outcome.finalIntegrity.online - outcome.startingIntegrity.online, 800)
  assert.equal(outcome.finalIntegrity.counter - outcome.startingIntegrity.counter, 300)
  assert.equal(outcome.errors, 0)
  renameSync(temporaryResult, join(root, 'result.json'))
  record('complete', { requests: outcome.requests, errors: outcome.errors, d1: outcome.d1 })
  console.log(JSON.stringify({ event: 'complete', requests: outcome.requests, errors: outcome.errors }))
} catch (error) {
  record('failed', { reason: error.message })
  throw error
}
