import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('overnight maintenance uses the shop day before UTC midnight and runs once', () => {
  const root = mkdtempSync(join(tmpdir(), 'kirana-maintenance-date-'))
  try {
    mkdirSync(join(root, 'tools'))
    mkdirSync(join(root, 'backups'))
    writeFileSync(join(root, 'store.json'), JSON.stringify({ slug: 'local', databaseId: 'orders', mediaDatabaseId: 'media' }))
    writeFileSync(join(root, 'worker.json'), JSON.stringify({ name: 'local-api', d1_databases: [
      { binding: 'DB', database_id: 'orders' }, { binding: 'MEDIA', database_id: 'media' },
    ] }))
    writeFileSync(join(root, 'backups', '2026-11-27-backup.done'), 'already ran on 27 November\n')
    writeFileSync(join(root, 'tools', 'backup-d1.mjs'),
      'import { appendFileSync } from "node:fs"; appendFileSync("calls", "backup\\n")')
    const clock = encodeURIComponent(`const Original=Date; globalThis.Date=class extends Original {
      constructor(...args){super(...(args.length?args:['2026-11-27T21:45:00.000Z']))}
    }`)
    const args = ['--import', 'data:text/javascript,'+clock, resolve('tools/maintenance.mjs'),
      'store.json', 'worker.json', 'backups', '--backup-only']
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, args, { cwd: root, input: 'test-passphrase', encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    assert.equal(readFileSync(join(root, 'calls'), 'utf8'), 'backup\n')
    assert.equal(readFileSync(join(root, 'backups', '2026-11-28-backup.done'), 'utf8'), '2026-11-27T21:45:00.000Z\n')
  } finally { rmSync(root,{recursive:true,force:true}) }
})
