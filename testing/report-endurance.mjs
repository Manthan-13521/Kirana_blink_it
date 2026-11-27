import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const [path] = process.argv.slice(2)
assert.ok(path, 'Usage: node testing/report-endurance.mjs EVIDENCE.jsonl')
const lines = readFileSync(path, 'utf8').split('\n')
// Omit an incomplete final line if the benchmark is writing its next checkpoint.
lines.pop()
const records = lines.filter(Boolean).map(line => JSON.parse(line))
const start = records.find(record => record.event === 'start')
const checkpoint = records.findLast(record => record.event === 'checkpoint')
const terminal = records.findLast(record => record.event === 'complete' || record.event === 'stopped')
const analytics = records.filter(record => record.event === 'cloudflare-analytics')
assert.ok(start, 'The runner has yet to record a start.')
if (terminal?.event === 'complete') {
  assert.ok(terminal.elapsedSeconds >= 14400)
  assert.ok(Date.parse(terminal.time) - Date.parse(start.time) >= 14400 * 1000)
  assert.equal(terminal.usage.unexpected, 0)
  assert.equal(terminal.after.pending, 0)
  assert.equal(terminal.after.skus, 5000)
  assert.ok(terminal.after.minStock >= 0)
  for (const key of ['paymentMismatch', 'badTotals', 'duplicateCompletions'])
    assert.equal(terminal.after[key], start.before[key])
  assert.equal(terminal.after.online - start.before.online, terminal.completed.online)
  assert.equal(terminal.after.counter - start.before.counter, terminal.completed.counter)
}
console.log(JSON.stringify({
  status: terminal?.event ?? 'in progress',
  start: start.time,
  end: terminal?.time ?? null,
  elapsedSeconds: terminal?.elapsedSeconds ?? checkpoint?.elapsedSeconds ?? null,
  phase: checkpoint?.phase ?? null,
  metered: terminal?.usage ?? checkpoint?.usage ?? null,
  completed: terminal?.completed ?? checkpoint?.completed ?? null,
  latestCloudflare: analytics.at(-1)?.usage ?? null,
  startingCloudflare: analytics[0]?.usage ?? null,
  latency: terminal?.latency ?? null,
  endpointLatency: terminal?.endpoints ?? null,
  peakWidth: terminal?.peakWidth ?? null,
  finalIntegrity: terminal?.after ?? null,
  stopReason: terminal?.error ?? null,
}, null, 2))
