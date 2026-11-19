/** DeepSeek platform web API client used by the plugin tools. */

import { readZip } from './zip.js'
import { parseCsvObjects } from './csv.js'

export const BASE = 'https://platform.deepseek.com'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

/** Authentication was rejected: the token expired or never belonged to this account. */
export class AuthError extends Error {}

/** The API rejected the date window; callers split it and retry. */
export class ParamError extends Error {}

export function maskToken(token) {
  const text = String(token ?? '')
  if (text.length <= 10) return '***'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

export function dayStart(day, tzOffset) {
  return Math.floor(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 1000) - tzOffset
}

export function parseDay(value, tzOffset, fallback) {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  if (text === 'today' || text === 'now') {
    const now = new Date(Date.now() + tzOffset * 1000)
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) throw new Error(`日期格式应为 YYYY-MM-DD：${text}`)
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

export function addDays(day, days) {
  return new Date(day.getTime() + days * 86_400_000)
}

export function formatDay(day) {
  return day.toISOString().slice(0, 10)
}

function headers(token, tzOffset) {
  return {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: `${BASE}/usage`,
    'user-agent': USER_AGENT,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-timezone-offset': String(tzOffset),
    'x-client-version': '1.0.1',
    'x-device-id': 'dsh-deepseek-usage',
    'x-device-model': '',
    authorization: `Bearer ${token}`,
  }
}

function timeoutSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function request(path, { token, tzOffset, signal, retries = 4, timeoutMs = 60_000 }) {
  const url = `${BASE}${path}`
  let lastError
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: headers(token, tzOffset),
        signal: timeoutSignal(signal, timeoutMs),
      })
      if (response.status === 401 || response.status === 403) {
        throw new AuthError('HTTP 401/403：登录态已失效，需要重新获取 Bearer token')
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`)
        await sleep(600 * attempt)
        continue
      }
      return response
    } catch (error) {
      if (error instanceof AuthError) throw error
      if (signal?.aborted) throw error
      lastError = error
      await sleep(600 * attempt)
    }
  }
  throw new Error(`请求失败：${url}（${lastError?.message ?? '未知错误'}）`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestJson(path, options) {
  const response = await request(path, options)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`)
  }
  if (body.code === 40002) throw new AuthError('缺少 Token：请重新提供 Bearer token')
  if (body.code === 40003) throw new AuthError('Token 无效：请重新从浏览器复制 Authorization')
  if (body.code !== 0 && body.code !== undefined) {
    throw new Error(`接口返回 code=${body.code} msg=${body.msg ?? ''}`)
  }
  return body.data ?? {}
}

/** List API keys plus their key quota. */
export async function fetchKeys(token, { tzOffset = 28800, signal } = {}) {
  const data = await requestJson('/api/v0/users/get_api_keys', { token, tzOffset, signal })
  const biz = data.biz_data ?? {}
  return { apiKeys: biz.api_keys ?? [], quota: biz.key_quota ?? {} }
}

/** Payment orders and bonus grants. */
export async function fetchInvoice(token, { tzOffset = 28800, signal } = {}) {
  const data = await requestJson('/auth-api/v0/users/get_all_invoice', { token, tzOffset, signal })
  const invoices = data.biz_data?.invoices ?? {}
  return {
    paymentOrders: invoices.payment_orders ?? [],
    bonusOrders: invoices.bonus_orders ?? [],
  }
}

/**
 * Download one usage export window and parse both CSVs.
 * `[start, end)` are epoch seconds; the service rejects spans over 31 days.
 */
export async function fetchExport(token, start, end, { tzOffset = 28800, signal } = {}) {
  const path = `/api/v0/usage/export?start=${start}&end=${end}&tz=${tzOffset}`
  const response = await request(path, { token, tzOffset, signal, timeoutMs: 120_000 })
  const type = (response.headers.get('content-type') ?? '').toLowerCase()

  if (type.includes('application/json')) {
    const body = await response.json().catch(() => ({}))
    if (body?.data?.biz_msg === 'INVALID_PARAM') throw new ParamError('导出区间超过上限')
    throw new Error(`导出接口返回异常：${JSON.stringify(body).slice(0, 200)}`)
  }
  if (!type.includes('zip') && !type.includes('octet-stream')) {
    throw new Error(`导出接口返回了意外的内容类型：${type || '空'}`)
  }

  const archive = readZip(Buffer.from(await response.arrayBuffer()))
  const result = { cost: [], amount: [] }
  for (const [name, data] of archive) {
    const lower = name.toLowerCase()
    if (!lower.endsWith('.csv')) continue
    const rows = parseCsvObjects(data.toString('utf8'))
    if (lower.startsWith('cost')) result.cost = rows
    else if (lower.startsWith('amount')) result.amount = rows
  }
  return result
}
