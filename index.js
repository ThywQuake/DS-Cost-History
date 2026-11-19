/**
 * DeepSeek platform consumption export: ask for the browser HAR and Bearer
 * token, verify the login state, then download the requested date range and
 * write Paid / Granted detail tables.
 */

import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  AuthError,
  addDays,
  dayStart,
  fetchInvoice,
  fetchKeys,
  formatDay,
  maskToken,
  parseDay,
} from './lib/api.js'
import { readHar, parseCredentialText } from './lib/har.js'
import { collectRange } from './lib/fetch.js'
import { normalizeCost, normalizeUsage, writeOutputs } from './lib/report.js'
import { clearToken, readToken, saveToken } from './lib/store.js'
import { SETUP_GUIDE, TOKEN_STEPS } from './lib/guide.js'
import {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_WHEN_TO_USE,
} from './lib/skill.js'

const TZ_OFFSET = 28_800
const OUTPUT_DIR_NAME = 'deepseek-usage-export'

export const name = 'deepseek-usage'
export const inject = ['tools']

function text(value) {
  return [{ type: 'text', text: value }]
}

function nowStamp() {
  // 导出时间按平台时区显示，避免 UTC 与本地时间混淆
  const shifted = new Date(Date.now() + TZ_OFFSET * 1000)
  return shifted.toISOString().replace('T', ' ').slice(0, 19)
}

function todayUtc() {
  const shifted = new Date(Date.now() + TZ_OFFSET * 1000)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()))
}

function earliestHint(apiKeys, orders) {
  const stamps = []
  for (const key of apiKeys) {
    const value = Number(key?.created_at)
    if (Number.isFinite(value) && value > 0) stamps.push(value * 1000)
  }
  for (const order of orders.paymentOrders ?? []) {
    const value = Date.parse(order?.paid_at ?? '')
    if (Number.isFinite(value)) stamps.push(value)
  }
  for (const order of orders.bonusOrders ?? []) {
    const value = Date.parse(order?.inserted_at ?? '')
    if (Number.isFinite(value)) stamps.push(value)
  }
  if (stamps.length === 0) return null
  const shifted = new Date(Math.min(...stamps) + TZ_OFFSET * 1000)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()))
}

async function defaultOutputDir(ctx, exec) {
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory?.ensure && exec.agent) {
      return join(await workingDirectory.ensure(exec.agent, exec.signal), OUTPUT_DIR_NAME)
    }
  } catch {
    // fall back to the host process directory
  }
  return join(process.cwd(), OUTPUT_DIR_NAME)
}

function renderStatus(value) {
  if (value.cleared) return '已清除保存的 DeepSeek 登录态。'
  if (!value.configured) {
    const reason = value.stale ? `保存的 token 已失效（${value.tokenMasked}）。` : ''
    return `${reason}\n${value.guidance ?? '尚未配置登录态。'}`
  }
  return `登录态可用（${value.tokenMasked}，来源：${value.source}）。账号下 ${value.apiKeys} 个 API Key。`
}

function renderSetup(value) {
  if (!value.configured) {
    const reason = value.authFailed ? 'token 验证失败（401/40003）。\n' : ''
    return `${reason}${value.guidance}`
  }
  const har = value.har
    ? `\nHAR：${value.har.requestCount} 条平台请求${value.har.hasExport ? '，含用量导出接口' : ''}。`
    : ''
  const warning = value.warning ? `\n注意：${value.warning}` : ''
  return `登录态已保存到 ${value.savedTo}（${value.tokenMasked}）。账号下 ${value.apiKeys} 个 API Key。${har}${warning}\n下一步：调用 ds_usage_export 指定时间范围。`
}

function renderExport(value) {
  return [
    `范围 ${value.range[0]} ~ ${value.range[1]}（${value.windows} 个 31 天窗口）`,
    `消费合计 ${value.total} CNY`,
    `  Paid（充值余额） ${value.paid} CNY`,
    `  Granted（赠金） ${value.granted} CNY`,
    `请求 ${value.requests} 次`,
    `输出目录 ${value.outputDir}`,
    `文件 ${value.files.join('、')}`,
  ].join('\n')
}

export function apply(ctx) {
  const statusTool = defineTool({
    name: 'ds_usage_status',
    description:
      'Check whether a DeepSeek platform token is stored and still valid, or clear it. Call before asking the user for credentials.',
    parameters: {
      clear: { type: 'boolean', description: '删除已保存的 token' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(renderStatus(value)) },
    async execute(args, exec) {
      if (args.clear) {
        await clearToken(ctx)
        return { configured: false, cleared: true }
      }
      const { token, source } = await readToken(ctx)
      if (!token) {
        return {
          configured: false,
          guidance:
            '还没有保存登录态。先向用户讲清 HAR 与 token 的获取步骤（skill 或 ds_usage_setup 的返回里有完整说明），再调用 ds_usage_setup。',
        }
      }
      try {
        const { apiKeys } = await fetchKeys(token, { signal: exec.signal })
        return {
          configured: true,
          source,
          tokenMasked: maskToken(token),
          apiKeys: apiKeys.length,
        }
      } catch (error) {
        if (error instanceof AuthError) {
          return {
            configured: false,
            stale: true,
            tokenMasked: maskToken(token),
            source,
            guidance: '保存的 token 已过期，请用户重新复制 Authorization 后再调用 ds_usage_setup。',
          }
        }
        throw error
      }
    },
  })

  const setupTool = defineTool({
    name: 'ds_usage_setup',
    description:
      'Validate and store the DeepSeek platform login state from a browser HAR file and/or a Bearer token (or Cookie). When the HAR has no Authorization header or no token is given, the result contains the step-by-step instructions for obtaining them. Never echoes the token.',
    parameters: {
      harPath: {
        type: 'string',
        description: 'Absolute path of a HAR exported from platform.deepseek.com/usage; its Authorization header is used when token is omitted.',
      },
      token: {
        type: 'string',
        description: 'Authorization Bearer token, an "Authorization: ..." line, or a Cookie string containing userToken.',
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(renderSetup(value)) },
    async execute(args, exec) {
      let har = null
      if (args.harPath) har = await readHar(args.harPath)
      const parsed = parseCredentialText(args.token)
      const token = parsed.token || har?.token || ''

      const harSummary = har
        ? {
            requestCount: har.requestCount,
            hasExport: har.hasExport,
            hasUsage: har.hasUsage,
            paths: har.paths.slice(0, 6),
          }
        : null

      if (!token) {
        return {
          configured: false,
          needsToken: true,
          har: harSummary,
          guidance: `HAR 里没有找到 Authorization / userToken。\n\n${TOKEN_STEPS}`,
        }
      }

      try {
        const { apiKeys } = await fetchKeys(token, { signal: exec.signal })
        const savedTo = await saveToken(ctx, token)
        return {
          configured: true,
          savedTo,
          tokenMasked: maskToken(token),
          apiKeys: apiKeys.length,
          har: harSummary,
          warning:
            harSummary && !harSummary.hasExport
              ? 'HAR 里没有 /usage/export 请求：建议按步骤在页面上点一次「导出」再重新抓，否则下次缺 token 时不好定位。'
              : '',
        }
      } catch (error) {
        if (error instanceof AuthError) {
          return {
            configured: false,
            authFailed: true,
            tokenMasked: maskToken(token),
            har: harSummary,
            guidance:
              'token 无效或已过期。让用户回到 platform.deepseek.com 的 Network 面板，重新复制 export 请求的 Authorization，或从 Cookie 里取 userToken。',
          }
        }
        throw error
      }
    },
  })

  const exportTool = defineTool({
    name: 'ds_usage_export',
    description:
      'Download DeepSeek consumption records for a date range and write CSV/Excel tables split by wallet (Paid = top-up balance, Granted = bonus credit). Requires ds_usage_setup first.',
    parameters: {
      since: {
        type: 'string',
        description: 'Start date YYYY-MM-DD (inclusive). Omit to start from the account\'s earliest record.',
      },
      until: {
        type: 'string',
        description: 'End date YYYY-MM-DD (inclusive). Defaults to today.',
      },
      wallet: {
        type: 'string',
        description: 'Wallet filter for the detail tables: paid (default), granted, or all.',
      },
      outputDir: {
        type: 'string',
        description: 'Directory for the generated files. Defaults to <session workspace>/deepseek-usage-export.',
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(renderExport(value)) },
    async execute(args, exec) {
      const { token } = await readToken(ctx)
      if (!token) {
        throw new Error('还没有保存登录态：先调用 ds_usage_setup 保存 HAR 或 Bearer token')
      }

      const wallet = ['paid', 'granted', 'all'].includes(args.wallet) ? args.wallet : 'paid'
      const untilDay = parseDay(args.until, TZ_OFFSET, todayUtc())
      const untilExclusive = dayStart(addDays(untilDay, 1), TZ_OFFSET)

      const { apiKeys } = await fetchKeys(token, { signal: exec.signal })
      const orders = await fetchInvoice(token, { signal: exec.signal })

      let sinceDay
      if (args.since) {
        sinceDay = parseDay(args.since, TZ_OFFSET)
      } else {
        const hint = earliestHint(apiKeys, orders) ?? addDays(untilDay, -365)
        sinceDay = addDays(hint, -31)
      }
      const since = dayStart(sinceDay, TZ_OFFSET)
      if (since >= untilExclusive) throw new Error('起始日期必须早于结束日期')

      const outputDir = args.outputDir
        ? resolve(args.outputDir)
        : await defaultOutputDir(ctx, exec)

      const { cost, amount, windows } = await collectRange(token, {
        since,
        untilExclusive,
        tzOffset: TZ_OFFSET,
        signal: exec.signal,
        cacheDir: join(outputDir, 'raw'),
      })

      const summary = await writeOutputs({
        outputDir,
        cost: normalizeCost(cost),
        usage: normalizeUsage(amount),
        orders,
        wallet,
        generatedAt: nowStamp(),
      })

      return {
        ok: true,
        range: [formatDay(sinceDay), formatDay(untilDay)],
        wallet,
        windows,
        paid: summary.paid,
        granted: summary.granted,
        total: summary.total,
        requests: summary.requests,
        outputDir,
        files: summary.files,
      }
    },
  })

  ctx.tools.register(statusTool)
  ctx.tools.register(setupTool)
  ctx.tools.register(exportTool)

  let skills
  try {
    skills = ctx.get('skills')
  } catch {
    skills = undefined
  }
  if (skills && typeof skills.register === 'function') {
    ctx.effect(() =>
      skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        content: SKILL_CONTENT,
        invocation: { modelInvocable: true, userInvocable: true },
      }),
    )
  }
}
