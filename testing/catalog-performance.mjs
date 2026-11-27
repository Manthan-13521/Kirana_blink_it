import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'

const [configPath, label] = process.argv.slice(2)
assert.ok(configPath && ['baseline', 'candidate'].includes(label),
  'Usage: node testing/catalog-performance.mjs PRIVATE_BENCHMARK_CONFIG baseline|candidate')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const url = new URL(config.url)
assert.match(url.hostname, /^kirana-benchmark-staging-api\.[a-z0-9-]+\.workers\.dev$/)
assert.equal(url.origin, config.url)
assert.equal(url.protocol, 'https:')
assert.match(config.token, /^[a-f0-9]{64}$/)

const results = []
const headers = { Authorization: 'Bearer ' + config.token }
const sku = index => String(1 + (index * 37 % 4984)).padStart(4, '0')
const paths = [
  () => ['browse', '/api/catalog?category=pantry&limit=12'],
  i => ['search', '/api/catalog?q=benchmark+' + sku(i) + '&limit=12'],
  i => ['details', '/api/catalog/load-' + sku(i)],
]
const size = await fetch(url.origin + '/api/__benchmark/catalog-size', { headers, signal: AbortSignal.timeout(12000) })
assert.equal(size.status, 200)
assert.equal((await size.json()).total, 5000)
const metric = (value, key) => {
  const entry = value?.split(',').find(part => part.trim().startsWith(key + ';dur='))
  return entry ? Number(entry.split('=')[1]) : null
}

async function burst(width, sample) {
  await Promise.all(Array.from({ length: width }, async (_, index) => {
    const [kind, path] = paths[(index + sample) % paths.length](sample * 100 + index)
    const start = performance.now()
    const r = await fetch(url.origin + path, { headers, signal: AbortSignal.timeout(12000) })
    const firstByte = performance.now() - start
    assert.equal(r.status, 200)
    const counts = JSON.parse(r.headers.get('x-kirana-d1'))
    assert.equal(counts.writes, 0)
    const body = await r.text()
    assert.ok(JSON.parse(body))
    const timing = r.headers.get('server-timing')
    results.push({ width, kind, ms: performance.now() - start, firstByte,
      bytes: Buffer.byteLength(body), reads: counts.reads, statements: counts.statements,
      d1Wall: metric(timing, 'qa_d1'), sql: metric(timing, 'qa_sql'), workerWall: metric(timing, 'qa_worker') })
  }))
}
for (const width of [32, 100]) {
  for (let sample = 0; sample < 6; sample++) {
    await burst(width, sample)
    await wait(750)
  }
}

function summary(rows) {
  const percentile = (key, p) => {
    const values = rows.map(row => row[key]).filter(value => value !== null).sort((a,b) => a-b)
    return values.length ? +values[Math.ceil(values.length * p) - 1].toFixed(2) : null
  }
  return { count: rows.length, p50: percentile('ms', .5), p95: percentile('ms', .95), p99: percentile('ms', .99),
    firstByteP95: percentile('firstByte', .95), d1WallP95: percentile('d1Wall', .95),
    sqlP95: percentile('sql', .95), workerWallP95: percentile('workerWall', .95), bytesP95: percentile('bytes', .95),
    reads: rows.reduce((sum,row)=>sum+row.reads,0), statements: rows.reduce((sum,row)=>sum+row.statements,0) }
}
const groups = [32, 100].flatMap(width => ['browse', 'search', 'details'].map(kind =>
  [width + '-' + kind, summary(results.filter(row => row.width === width && row.kind === kind))]))
console.log(JSON.stringify({ completedAt: new Date().toISOString(), label, commit: config.commit,
  total: summary(results), groups: Object.fromEntries(groups), writes: 0, errors: 0 }))
