import assert from 'node:assert/strict'
import test from 'node:test'
import { assertTargetHeadroom, validateQuota } from '../testing/benchmark-quota.mjs'

const quota = (writes = 0, reads = 0, requests = 0) => ({
  utcDay: new Date().toISOString().slice(0, 10), asOf: new Date().toISOString(),
  d1RowsWritten: { value: writes }, d1RowsRead: { value: reads }, workerRequests: { value: requests },
})

test('hosted target rejects stale or malformed usage and preserves shared quota reserves', () => {
  assert.doesNotThrow(() => assertTargetHeadroom(validateQuota(quota(13999, 2499999, 39999))))
  assert.throws(() => assertTargetHeadroom(quota(), quota(14000)), /d1RowsWritten/)
  assert.throws(() => assertTargetHeadroom(quota(0, 2500000)), /d1RowsRead/)
  assert.throws(() => assertTargetHeadroom(quota(0, 0, 40000)), /workerRequests/)
  assert.throws(() => validateQuota({ ...quota(), asOf: new Date(Date.now() - 70000).toISOString() }), /Refresh/)
  assert.throws(() => validateQuota(quota(-1)), /Invalid/)
})
