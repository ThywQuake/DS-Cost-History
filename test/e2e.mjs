/**
 * Live end-to-end check against the real export API.
 * Requires DEEPSEEK_USAGE_TOKEN (Bearer token) in the environment.
 *   DEEPSEEK_USAGE_TOKEN=... node test/e2e.mjs 2026-10-01 2026-10-31
 */

import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { dayStart, fetchInvoice, fetchKeys, parseDay } from '../lib/api.js'
import { collectRange } from '../lib/fetch.js'
import { normalizeCost, normalizeUsage, summarize, writeOutputs } from '../lib/report.js'

const token = (process.env.DEEPSEEK_USAGE_TOKEN ?? '').trim()
if (!token) {
  console.log('skip: 需要 DEEPSEEK_USAGE_TOKEN 才能跑真实接口测试')
  process.exit(0)
}
const TZ = 28800
const sinceText = process.argv[2] ?? '2026-10-01'
const untilText = process.argv[3] ?? '2026-10-31'
const outDir = process.env.E2E_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/ds-plugin-e2e`

await mkdir(outDir, { recursive: true })
const since = dayStart(parseDay(sinceText, TZ), TZ)
const untilExclusive = dayStart(new Date(parseDay(untilText, TZ).getTime() + 86_400_000), TZ)

const { apiKeys } = await fetchKeys(token)
const orders = await fetchInvoice(token)
const { cost, amount, windows } = await collectRange(token, {
  since,
  untilExclusive,
  tzOffset: TZ,
  cacheDir: `${outDir}/raw`,
})
const normalizedCost = normalizeCost(cost)
const normalizedUsage = normalizeUsage(amount)
const stats = summarize(normalizedCost, normalizedUsage)
const summary = await writeOutputs({
  outputDir: outDir,
  cost: normalizedCost,
  usage: normalizedUsage,
  orders,
  wallet: 'paid',
  generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
})

console.log(
  JSON.stringify(
    {
      keys: apiKeys.length,
      windows,
      costRows: cost.length,
      amountRows: amount.length,
      paid: summary.paid,
      granted: summary.granted,
      total: summary.total,
      requests: summary.requests,
      files: summary.files,
    },
    null,
    2,
  ),
)

if (process.env.E2E_EXPECT_PAID) {
  assert.equal(summary.paid, process.env.E2E_EXPECT_PAID, 'Paid 与已知值不一致')
}
await writeFile(`${outDir}/.ok`, 'ok\n')
