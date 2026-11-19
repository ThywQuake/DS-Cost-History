/** Persist the platform token: credential record when available, else a 600 file. */

import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const RECORD_KEY = 'dsh-deepseek-usage/session'
const FALLBACK_FILE = join(homedir(), '.config', 'dsh-deepseek-usage', 'token.json')

function credentialsService(ctx) {
  try {
    return ctx.get('credentials')
  } catch {
    return undefined
  }
}

export async function readToken(ctx) {
  const service = credentialsService(ctx)
  if (service?.readRecord) {
    try {
      const record = await service.readRecord(RECORD_KEY)
      if (record?.kind === 'api-key' && record.key) return { token: record.key, source: 'credentials' }
    } catch {
      // fall through to file / env
    }
  }
  try {
    const raw = JSON.parse(await readFile(FALLBACK_FILE, 'utf8'))
    if (typeof raw?.token === 'string' && raw.token) return { token: raw.token, source: FALLBACK_FILE }
  } catch {
    // not stored as a file
  }
  const env = (process.env.DEEPSEEK_USAGE_TOKEN ?? '').trim()
  if (env) return { token: env, source: 'DEEPSEEK_USAGE_TOKEN' }
  return { token: '', source: '' }
}

export async function saveToken(ctx, token) {
  const service = credentialsService(ctx)
  if (service?.modifyRecord) {
    try {
      await service.modifyRecord(RECORD_KEY, async () => ({ kind: 'api-key', key: token }))
      return 'DSH 凭据记录'
    } catch {
      // fall back to the file when the credential store rejects the write
    }
  }
  await mkdir(dirname(FALLBACK_FILE), { recursive: true })
  await writeFile(FALLBACK_FILE, `${JSON.stringify({ token })}\n`, 'utf8')
  await chmod(FALLBACK_FILE, 0o600)
  return FALLBACK_FILE
}

export async function clearToken(ctx) {
  const service = credentialsService(ctx)
  if (service?.deleteRecord) {
    try {
      await service.deleteRecord(RECORD_KEY)
    } catch {
      // ignore: the file fallback may still exist
    }
  }
  try {
    await unlink(FALLBACK_FILE)
  } catch {
    // already absent
  }
}
