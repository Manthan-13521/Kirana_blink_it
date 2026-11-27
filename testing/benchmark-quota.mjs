import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const targetWriteBudget = 76000
export const targetLimits = { d1RowsWritten: 90000, d1RowsRead: 3500000, workerRequests: 70000 }
const reserves = { d1RowsWritten: targetWriteBudget, d1RowsRead: 1000000, workerRequests: 30000 }

export function validateQuota(value) {
  assert.equal(value.utcDay, new Date().toISOString().slice(0, 10), 'Use the measured account quota for the current UTC day.')
  assert.ok(Math.abs(Date.now() - Date.parse(value.asOf)) < 60000, 'Refresh account quota analytics first.')
  for (const key of Object.keys(targetLimits)) {
    assert.ok(Number.isSafeInteger(value[key]?.value) && value[key].value >= 0, 'Invalid quota metric ' + key)
  }
  return value
}

export function assertTargetHeadroom(quota, second = quota) {
  for (const [key, limit] of Object.entries(targetLimits)) {
    assert.ok(Math.max(quota[key].value, second[key].value) + reserves[key] < limit,
      'Insufficient account headroom for ' + key)
  }
}

export function readQuota(account) {
  const env = { ...process.env }
  if (!env.CLOUDFLARE_API_TOKEN && env.KIRANA_WRANGLER_OAUTH_CONFIG) {
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'whoami'], { encoding: 'utf8', timeout: 20000 })
    const oauth = readFileSync(env.KIRANA_WRANGLER_OAUTH_CONFIG, 'utf8')
    env.CLOUDFLARE_API_TOKEN = oauth.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1]
  }
  assert.ok(env.CLOUDFLARE_API_TOKEN, 'Set the account analytics token or local Wrangler OAuth config path.')
  const data = execFileSync(process.execPath, ['tools/quota-report.mjs', account, 'kirana-benchmark-staging-api'],
    { encoding: 'utf8', env, timeout: 20000 })
  return validateQuota(JSON.parse(data))
}
