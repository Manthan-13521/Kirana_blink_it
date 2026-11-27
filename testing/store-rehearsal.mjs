import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const temporary = mkdtempSync(join(tmpdir(), 'kirana-two-stores-'))
const template = JSON.parse(readFileSync('deployment/store.example.json', 'utf8'))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const slugs = ['kirana-fixture-north', 'kirana-fixture-south']
const bundles = []
const start = performance.now()
try {
  for (const slug of slugs) {
    const frontendProject = slug + '-shop'
    const mediaProject = slug + '-media'
    const fixture = {
      ...template, slug, frontendProject, mediaProject,
      databaseId: randomUUID(), mediaDatabaseId: randomUUID(), archiveDatabaseIds: [randomUUID()],
      googleOrigin: 'https://' + frontendProject + '.pages.dev',
      staticMediaOrigin: 'https://' + mediaProject + '.pages.dev',
      store: { ...template.store, name: slug, address: slug + ' fixture address' },
    }
    const config = join(temporary, slug + '.json')
    const output = join(temporary, slug)
    writeFileSync(config, JSON.stringify(fixture))
    execFileSync(process.execPath, ['tools/prepare-release.mjs', config, output])
    const worker = readJson(join(output, 'worker', 'wrangler.json'))
    const pages = readJson(join(output, 'pages', 'wrangler.json'))
    const release = readJson(join(output, 'release-manifest.json'))
    assert.equal(pages.name, frontendProject)
    assert.deepEqual(pages.services, [{ binding: 'KIRANA_API', service: worker.name }])
    assert.equal(worker.vars.APP_MODE, 'production')
    assert.equal(worker.vars.GOOGLE_ORIGIN, fixture.googleOrigin)
    assert.equal(worker.vars.MEDIA_STATIC_ORIGIN, fixture.staticMediaOrigin)
    for (const flag of ['PUBLIC_CHECKOUT', 'RAZORPAY_LIVE_CHECKOUT', 'RAZORPAY_LIVE_REFUNDS'])
      assert.equal(worker.vars[flag], 'disabled')
    assert.ok(!('secrets' in worker))
    assert.equal(worker.workers_dev, false)
    const shipped = readdirSync(join(output, 'worker', 'worker'))
    for (const file of ['index.ts', 'qa.ts', 'benchmark.ts', 'local-integrations.ts'])
      assert.ok(!shipped.includes(file), file)
    const migrations = join(output, 'worker', 'migrations')
    assert.ok(!readdirSync(migrations).some(file => file.includes('local_catalog')))
    const db = new DatabaseSync(join(temporary, slug + '.sqlite'))
    try {
      for (const migration of readdirSync(migrations).sort())
        db.exec(readFileSync(join(migrations, migration), 'utf8'))
      db.exec(readFileSync(join(output, 'worker', 'initialize-store.sql'), 'utf8'))
      const store = db.prepare('SELECT name, address, accepting, enable_online FROM settings WHERE id=1').get()
      assert.deepEqual({ ...store }, { name: slug, address: fixture.store.address, accepting: 0, enable_online: 0 })
      for (const table of ['products', 'accounts', 'orders'])
        assert.equal(db.prepare('SELECT COUNT(*) count FROM ' + table).get().count, 0)
      assert.ok(db.prepare('PRAGMA foreign_key_check').all().length === 0)
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally {
      db.close()
    }
    bundles.push({
      projectNames: [pages.name, worker.name, release.mediaProject],
      databases: [...worker.d1_databases.map(binding => binding.database_id), ...release.archiveD1],
    })
  }
  const names = bundles.flatMap(bundle => bundle.projectNames)
  const databases = bundles.flatMap(bundle => bundle.databases)
  assert.equal(new Set(names).size, names.length)
  assert.equal(new Set(databases).size, databases.length)
  console.log(JSON.stringify({ stores: bundles.length, separateDatabaseIds: databases.length,
    separateProjectNames: names.length, acceptedOrdersOnSetup: 0, localSeconds: +(performance.now() - start).toFixed(0) / 1000 }))
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
