import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'

const [fixturePath, probePath] = process.argv.slice(2)
assert.ok(fixturePath && probePath, 'Usage: node testing/hosted-latency.mjs PRIVATE_BENCHMARK_CLIENT PRIVATE_PAGES_PROBE')
const { url: direct, token } = JSON.parse(readFileSync(fixturePath, 'utf8'))
const { url: pages } = JSON.parse(readFileSync(probePath, 'utf8'))
assert.match(direct, /^https:\/\/kirana-benchmark-staging-api\.[a-z0-9-]+\.workers\.dev$/)
assert.match(pages, /^https:\/\/kirana-latency-[a-f0-9]{10}\.pages\.dev$/)
assert.match(token, /^[a-f0-9]{64}$/)

const recordSeparator = '\x1e'
const writeOut = '%{json}\\t%{header_json}' + recordSeparator
const paths = {
  health: '/api/health',
  search: '/api/catalog?q=benchmark+1207&limit=12',
  details: '/api/catalog/load-1207',
  d1Control: '/probe/single-d1',
}
const ms = seconds => +(1000 * seconds).toFixed(2)
function collect(origin, path, count = 1, parallel = 1) {
  return new Promise((resolve, reject) => {
    const input = [
      'header = "Authorization: Bearer ' + token + '"',
      ...Array.from({ length: count }, () => `url = "${origin + path}"\noutput = "/dev/null"`),
    ].join('\n') + '\n'
    // Pass the credential over stdin. No credential, raw address or URL is recorded in evidence.
    const args = ['-q', '--silent', '--http2', '--compressed', '--max-time', '15', '--write-out', writeOut]
    if (parallel > 1) args.push('--parallel', '--parallel-max', String(parallel))
    const child = spawn('curl', [...args, '--config', '-'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('close', code => {
      try {
        assert.equal(code, 0, 'curl diagnostic failed')
        const rows = stdout.split(recordSeparator).filter(Boolean).map(record => {
          const separator = record.indexOf('\t')
          const transfer = record.slice(0, separator), responseHeaders = record.slice(separator + 1)
          const info = JSON.parse(transfer)
          const headers = JSON.parse(responseHeaders)
          const timing = headers['server-timing']?.join(',') ?? ''
          const ray = headers['cf-ray']?.[0] ?? ''
          const first = headers['x-probe-first']?.[0]
          const d1 = headers['x-kirana-d1']?.[0]
          assert.equal(info.response_code, 200, 'Unexpected probe HTTP status')
          assert.equal(info.exitcode, 0)
          if (d1) assert.equal(JSON.parse(d1).writes, 0)
          const durations = Object.fromEntries([...timing.matchAll(/\b([a-z][a-z0-9_]*);dur=([\d.]+)/g)]
            .map(([, key, val]) => [key, Number(val)]))
          if (path === paths.d1Control) assert.ok(Number.isFinite(durations.single_d1))
          else {
            assert.ok(Number.isFinite(durations.qa_d1))
            if (origin === pages) assert.ok(Number.isFinite(durations.pages_binding))
          }
          const connected = info.num_connects > 0
          const wait = ms(info.time_starttransfer - info.time_pretransfer)
          const observedWall = durations.pages_binding ?? durations.qa_worker
          return {
            transfer: info.urlnum,
            connection: connected ? 'new' : 'reused', protocol: info.http_version,
            colo: /-([A-Z]{3})$/.exec(ray)?.[1] ?? null,
            firstInProbeIsolate: first ? first === 'true' : null,
            dnsMs: connected ? ms(info.time_namelookup) : null,
            tcpMs: connected ? ms(info.time_connect - info.time_namelookup) : null,
            tlsMs: connected ? ms(info.time_appconnect - info.time_connect) : null,
            readyMs: ms(info.time_pretransfer), waitMs: wait,
            ttfbMs: ms(info.time_starttransfer), downloadMs: ms(info.time_total - info.time_starttransfer),
            totalMs: ms(info.time_total), bytes: info.size_download,
            // This residual still includes transport, scheduling and uninstrumented app work.
            outsideHandlerMs: observedWall === undefined ? null : +(wait - observedWall).toFixed(2),
            ...durations,
          }
        })
        assert.equal(rows.length, count)
        resolve(rows)
      } catch (error) { reject(error) }
    })
    child.stdin.end(input)
  })
}

const startedAt = new Date().toISOString(), groups = []
for (const [endpoint, origin] of [['direct', direct], ['pages', pages]]) {
  for (const kind of ['health', 'search', 'details', ...(endpoint === 'pages' ? ['d1Control'] : [])]) {
    const path = paths[kind]
    const serial = await collect(origin, path, 16)
    const fresh = []
    for (let trial = 0; trial < 8; trial++) fresh.push(...await collect(origin, path))
    groups.push({ endpoint, kind, mode: 'serial-persistent', rows: serial }, { endpoint, kind, mode: 'serial-fresh', rows: fresh })
    if (kind !== 'health' && kind !== 'search') continue
    for (let wave = 0; wave < 2; wave++) {
      const persistent = () => collect(origin, path, 32, 32)
      const freshParallel = async () => (await Promise.all(Array.from({ length: 32 }, () => collect(origin, path)))).flat()
      // Alternate run order so one mode does not always get the initial idle wave.
      const order = wave ? [['fresh-32', freshParallel], ['persistent-32', persistent]] : [['persistent-32', persistent], ['fresh-32', freshParallel]]
      for (const [mode, execute] of order) {
        await wait(750)
        groups.push({ endpoint, kind, wave, mode, rows: await execute() })
      }
    }
  }
}
console.log(JSON.stringify({ startedAt, completedAt: new Date().toISOString(), groups }))
