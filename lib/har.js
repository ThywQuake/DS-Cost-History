/** Read a browser HAR and recover the platform login token plus the endpoints used. */

import { readFile } from 'node:fs/promises'

const PLATFORM = /^https:\/\/platform\.deepseek\.com\//i

/** Extract a Bearer token from an Authorization header value. */
export function normalizeToken(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.replace(/^bearer\s+/i, '').trim()
}

/** Pull `userToken=` out of a Cookie header value. */
export function tokenFromCookie(cookie) {
  for (const part of String(cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (name === 'userToken' || name === 'token') {
      const value = part.slice(index + 1).trim()
      if (value) return value
    }
  }
  return ''
}

/** Accept a raw token, an `Authorization: ...` line, or a Cookie header. */
export function parseCredentialText(text) {
  const value = String(text ?? '').trim()
  if (!value) return { token: '', cookie: '' }
  const authLine = value.match(/^authorization\s*:\s*(.+)$/im)
  if (authLine) return { token: normalizeToken(authLine[1]), cookie: '' }
  const cookieLine = value.match(/^cookie\s*:\s*(.+)$/im)
  if (cookieLine) {
    const cookie = cookieLine[1].trim()
    return { token: tokenFromCookie(cookie), cookie }
  }
  if (value.includes('=') && value.includes(';')) {
    return { token: tokenFromCookie(value), cookie: value }
  }
  return { token: normalizeToken(value), cookie: '' }
}

/**
 * Read a HAR file and describe the DeepSeek platform traffic it contains.
 * @param {string} harPath
 */
export async function readHar(harPath) {
  const text = await readFile(harPath, 'utf8')
  let har
  try {
    har = JSON.parse(text)
  } catch {
    throw new Error('HAR 文件不是有效 JSON，请从浏览器「Export HAR」重新导出')
  }
  const entries = har?.log?.entries
  if (!Array.isArray(entries)) throw new Error('HAR 缺少 log.entries，不是浏览器导出的 HAR')

  const platform = []
  for (const entry of entries) {
    const url = entry?.request?.url ?? ''
    if (!PLATFORM.test(url)) continue
    const headers = {}
    for (const header of entry.request.headers ?? []) {
      headers[String(header.name).toLowerCase()] = header.value
    }
    let path = ''
    try {
      path = new URL(url).pathname
    } catch {
      path = url
    }
    platform.push({ url, path, method: entry?.request?.method ?? 'GET', headers })
  }

  if (platform.length === 0) {
    throw new Error(
      '这个 HAR 里没有 platform.deepseek.com 的请求。请按顺序重来：打开 platform.deepseek.com/usage → 开发者工具 Network → 勾选 Preserve log → 点一次页面上的「导出」按钮 → 右键出现的 usage/export 请求 → Copy all as HAR。',
    )
  }

  // 优先用导出 / 用量请求上的凭据，它们和本插件要调的接口最接近
  const preferred = platform.filter((e) => /\/usage\/(export|by_api_key)/.test(e.path))
  let token = ''
  let cookie = ''
  for (const entry of [...preferred, ...platform]) {
    if (!token && entry.headers.authorization) token = normalizeToken(entry.headers.authorization)
    if (!cookie && entry.headers.cookie) cookie = entry.headers.cookie
    if (token && cookie) break
  }
  if (!token && cookie) token = tokenFromCookie(cookie)

  const paths = [...new Set(platform.map((e) => e.path))].sort()
  return {
    token,
    cookie,
    paths,
    hasExport: platform.some((e) => e.path.startsWith('/api/v0/usage/export')),
    hasUsage: platform.some((e) => e.path.startsWith('/api/v0/usage/')),
    requestCount: platform.length,
  }
}
