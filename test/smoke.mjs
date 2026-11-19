/**
 * Offline smoke test. Uses the synthetic fixture in test/fixtures (a real
 * deflate-compressed zip written by Python, not by this package's writer).
 *   node test/smoke.mjs
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { readZip } from '../lib/zip.js'
import { parseCsvObjects } from '../lib/csv.js'
import { readHar, parseCredentialText } from '../lib/har.js'
import { buildXlsx } from '../lib/xlsx.js'
import { normalizeCost, normalizeUsage, summarize, writeOutputs } from '../lib/report.js'

const dir = await mkdtemp(join(tmpdir(), 'ds-usage-smoke-'))

// 1) zip + csv parsing
const archive = readZip(await readFile(new URL('./fixtures/usage-sample.zip', import.meta.url)))
const costRows = parseCsvObjects(archive.get('cost-2026-10-01_2026-10-02.csv').toString('utf8'))
const amountRows = parseCsvObjects(archive.get('amount-2026-10-01_2026-10-02.csv').toString('utf8'))
assert.equal(costRows.length, 3, 'cost 行数')
assert.equal(amountRows.length, 4, 'amount 行数')

// 2) aggregation
const cost = normalizeCost(costRows)
const usage = normalizeUsage(amountRows)
const stats = summarize(cost, usage)
const round = (value) => Number(value.toFixed(8))
assert.equal(round(stats.totals.Paid), 0.83246172, 'Paid 合计')
assert.equal(round(stats.totals.Granted), 0.10375136, 'Granted 合计')
assert.equal(stats.byType.get('request_count').amount, 53, '请求数')
assert.equal(round(stats.byType.get('input_cache_hit_tokens').cost), 0.024, '缓存命中折合金额')

// 3) HAR parsing: a token-bearing HAR and one without
const withToken = {
  log: {
    entries: [
      {
        request: {
          url: 'https://platform.deepseek.com/api/v0/usage/export?start=1&end=2&tz=28800',
          method: 'GET',
          headers: [{ name: 'Authorization', value: 'Bearer test-token-1234567890' }],
        },
      },
    ],
  },
}
const withoutToken = {
  log: {
    entries: [
      {
        request: {
          url: 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost',
          method: 'GET',
          headers: [{ name: 'Cookie', value: 'userToken=cookie-token-123' }],
        },
      },
    ],
  },
}
await writeFile(join(dir, 'with-token.har'), JSON.stringify(withToken))
await writeFile(join(dir, 'cookie.har'), JSON.stringify(withoutToken))

const parsed = await readHar(join(dir, 'with-token.har'))
assert.equal(parsed.token, 'test-token-1234567890')
assert.equal(parsed.hasExport, true)
const cookieHar = await readHar(join(dir, 'cookie.har'))
assert.equal(cookieHar.token, 'cookie-token-123')
assert.equal(cookieHar.hasExport, false)
assert.equal(parseCredentialText('Authorization: Bearer abc').token, 'abc')
assert.equal(parseCredentialText('userToken=xyz; other=1').token, 'xyz')

// 4) xlsx writer
const workbook = buildXlsx([
  { name: '概览', rows: [['项目', '值'], ['Paid', 13.165045]] },
  { name: '明细', rows: [['日期', '模型', '费用'], ['2026-10-01', 'deepseek-flash', 0.59624864]] },
])
await writeFile(join(dir, 'sample.xlsx'), workbook)
assert.equal(workbook.subarray(0, 2).toString(), 'PK')

// 5) full write-out
const summary = await writeOutputs({
  outputDir: join(dir, 'out'),
  cost,
  usage,
  orders: { paymentOrders: [{ amount: '100', currency: 'CNY', payment_order_status: 'SUCCESS' }], bonusOrders: [] },
  wallet: 'paid',
  generatedAt: '2026-11-19 13:00:00',
})
assert.equal(summary.paid, '0.83246172')
assert.ok(summary.files.includes('Paid费用明细.csv'))
assert.ok(summary.files.includes('summary.json'))

console.log(
  JSON.stringify(
    {
      costRows: costRows.length,
      amountRows: amountRows.length,
      paid: summary.paid,
      granted: summary.granted,
      range: summary.range,
      harToken: `${parsed.token.slice(0, 4)}…`,
      files: summary.files,
      tmp: dir,
    },
    null,
    2,
  ),
)
console.log('smoke ok')
