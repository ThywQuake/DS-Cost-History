/** Fetch a whole date range through the 31-day export API, with an on-disk window cache. */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCsvObjects } from './csv.js'
import { readZip } from './zip.js'
import { fetchExport, ParamError } from './api.js'

const MAX_WINDOW_DAYS = 31
const MAX_WINDOWS = 120

async function readCached(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (Array.isArray(parsed?.cost) && Array.isArray(parsed?.amount)) return parsed
  } catch {
    // no usable cache for this window
  }
  return null
}

async function cacheAgeSeconds(path) {
  try {
    return (Date.now() - (await stat(path)).mtimeMs) / 1000
  } catch {
    return null
  }
}

/**
 * Fetch every 31-day window covering `[since, untilExclusive)`.
 * @returns {Promise<{cost: object[], amount: object[], windows: number}>}
 */
export async function collectRange(token, {
  since,
  untilExclusive,
  tzOffset = 28800,
  signal,
  cacheDir,
  refresh = false,
  onWindow,
}) {
  const span = Math.round((untilExclusive - since) / 86_400)
  const windows = []
  for (let cursor = since; cursor < untilExclusive; cursor += MAX_WINDOW_DAYS * 86_400) {
    windows.push([cursor, Math.min(untilExclusive, cursor + MAX_WINDOW_DAYS * 86_400)])
  }
  if (windows.length > MAX_WINDOWS) {
    throw new Error(`时间范围过大（${span} 天，需要 ${windows.length} 个窗口）；请缩小范围`)
  }
  if (cacheDir) await mkdir(cacheDir, { recursive: true })

  const cost = []
  const amount = []
  for (const [index, [start, end]] of windows.entries()) {
    const cachePath = cacheDir ? join(cacheDir, `export_${start}_${end}.json`) : ''
    // 覆盖最近两天的窗口会继续产生消费，缓存只信任 5 分钟内的结果
    const live = end > Math.floor(Date.now() / 1000) - 2 * 86_400
    let parsed = null
    if (!refresh && cachePath) {
      if (live) {
        const age = await cacheAgeSeconds(cachePath)
        if (age !== null && age <= 300) parsed = await readCached(cachePath)
      } else {
        parsed = await readCached(cachePath)
      }
    }

    if (!parsed) {
      try {
        parsed = await fetchExport(token, start, end, { tzOffset, signal })
        if (cachePath) {
          // the raw zip is not kept by fetchExport, so cache the parsed rows as JSON instead
        }
      } catch (error) {
        if (error instanceof ParamError && end - start > 86_400) {
          // split an over-long window and fetch both halves
          const mid = start + Math.floor((end - start) / 2 / 86_400) * 86_400
          const left = await fetchExport(token, start, mid, { tzOffset, signal })
          const right = await fetchExport(token, mid, end, { tzOffset, signal })
          parsed = { cost: [...left.cost, ...right.cost], amount: [...left.amount, ...right.amount] }
        } else {
          throw error
        }
      }
      if (cachePath) await writeFile(cachePath, JSON.stringify(parsed), 'utf8')
    }

    cost.push(...parsed.cost)
    amount.push(...parsed.amount)
    onWindow?.({ index: index + 1, total: windows.length, start, end, cost: parsed.cost.length, amount: parsed.amount.length })
  }
  return { cost, amount, windows: windows.length }
}
