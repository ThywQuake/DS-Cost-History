/** Aggregate export rows and write CSV/XLSX deliverables. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toCsv } from './csv.js'
import { buildXlsx } from './xlsx.js'

export const TYPE_LABELS = {
  input_cache_hit_tokens: '输入·缓存命中',
  input_cache_miss_tokens: '输入·缓存未命中',
  output_tokens: '输出',
  request_count: '请求数',
  function_call: '工具调用',
}

const FUNCTION_MODEL = '工具调用(function_call)'

export function money(value) {
  const rounded = Math.round((Number(value) || 0) * 1e8) / 1e8
  return String(rounded)
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function normalizeCost(rows) {
  return rows.map((row) => ({
    date: String(row.start_time_iso ?? '').slice(0, 10),
    model: row.model || FUNCTION_MODEL,
    name: row.name || row.model || FUNCTION_MODEL,
    wallet: row.wallet_type || 'Paid',
    currency: row.currency || 'CNY',
    cost: num(row.cost),
  }))
}

export function normalizeUsage(rows) {
  return rows.map((row) => {
    const price = row.price === '' || row.price === undefined ? null : num(row.price)
    const amount = num(row.amount)
    return {
      date: String(row.start_time_iso ?? '').slice(0, 10),
      model: row.model || FUNCTION_MODEL,
      apiKey: row.api_key_name || '(未知)',
      type: row.type || '',
      price,
      amount,
      cost: price === null ? 0 : price * amount,
    }
  })
}

export function summarize(cost, usage) {
  const totals = { Paid: 0, Granted: 0 }
  const byDay = new Map()
  const byMonth = new Map()
  const byModel = new Map()
  const byType = new Map()
  const byKey = new Map()
  const requests = new Map()

  for (const row of cost) {
    const wallet = row.wallet === 'Granted' ? 'Granted' : 'Paid'
    totals[wallet] += row.cost
    const day = byDay.get(row.date) ?? { Paid: 0, Granted: 0 }
    day[wallet] += row.cost
    byDay.set(row.date, day)
    const month = row.date.slice(0, 7)
    const monthRow = byMonth.get(month) ?? { Paid: 0, Granted: 0 }
    monthRow[wallet] += row.cost
    byMonth.set(month, monthRow)
    const modelRow = byModel.get(row.model) ?? { Paid: 0, Granted: 0 }
    modelRow[wallet] += row.cost
    byModel.set(row.model, modelRow)
  }

  for (const row of usage) {
    const typeRow = byType.get(row.type) ?? { cost: 0, amount: 0 }
    typeRow.cost += row.cost
    typeRow.amount += row.amount
    byType.set(row.type, typeRow)

    const keyRow = byKey.get(row.apiKey) ?? { cost: 0, requests: 0, tokens: 0 }
    keyRow.cost += row.cost
    if (row.type === 'request_count') keyRow.requests += row.amount
    else keyRow.tokens += row.amount
    byKey.set(row.apiKey, keyRow)

    if (row.type === 'request_count') {
      requests.set(row.date, (requests.get(row.date) ?? 0) + row.amount)
    }
  }

  const dayKeys = [...byDay.keys()].sort()
  return {
    totals,
    byDay,
    byMonth,
    byModel,
    byType,
    byKey,
    requests,
    firstDay: dayKeys[0],
    lastDay: dayKeys.at(-1),
    requestTotal: [...requests.values()].reduce((a, b) => a + b, 0),
  }
}

function csvRows(header, rows) {
  return [header, ...rows]
}

/**
 * Write the deliverable set into `outputDir`.
 * @param {object} options
 */
export async function writeOutputs({ outputDir, cost, usage, orders, wallet, generatedAt }) {
  await mkdir(outputDir, { recursive: true })
  const stats = summarize(cost, usage)
  const total = stats.totals.Paid + stats.totals.Granted
  const paidTopup = (orders.paymentOrders ?? []).reduce((sum, order) => sum + num(order.amount), 0)
  const files = []

  const costRows = [...cost].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model))
  const selected = wallet === 'all' ? costRows : costRows.filter((row) => row.wallet === (wallet === 'granted' ? 'Granted' : 'Paid'))

  // 费用明细（按钱包筛选）与全量
  const detailCsv = toCsv(
    csvRows(
      ['日期', '模型', '钱包类型', '币种', '费用'],
      selected.map((row) => [row.date, row.model, row.wallet, row.currency, money(row.cost)]),
    ),
  )
  const detailName = wallet === 'granted' ? 'Granted费用明细.csv' : wallet === 'all' ? '费用明细.csv' : 'Paid费用明细.csv'
  await writeFile(join(outputDir, detailName), detailCsv, 'utf8')
  files.push(detailName)

  // 按日汇总
  const dailyRows = [...stats.byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, value]) => [
      day,
      Number(money(value.Paid)),
      Number(money(value.Granted)),
      Number(money(value.Paid + value.Granted)),
      stats.requests.get(day) ?? 0,
    ])
  const dailyCsv = toCsv(csvRows(['日期', 'Paid', 'Granted', '合计', '请求数'], dailyRows))
  await writeFile(join(outputDir, '按日汇总.csv'), dailyCsv, 'utf8')
  files.push('按日汇总.csv')

  // 用量明细
  const usageCsv = toCsv(
    csvRows(
      ['日期', '模型', 'API Key', '用量类别', '折合金额', '数量'],
      [...usage]
        .sort((a, b) => a.date.localeCompare(b.date) || a.apiKey.localeCompare(b.apiKey))
        .map((row) => [
          row.date,
          row.model,
          row.apiKey,
          TYPE_LABELS[row.type] ?? row.type,
          money(row.cost),
          row.amount,
        ]),
    ),
  )
  await writeFile(join(outputDir, '用量明细.csv'), usageCsv, 'utf8')
  files.push('用量明细.csv')

  // Excel
  const overview = [
    ['项目', '值'],
    ['导出时间', generatedAt],
    ['数据范围', stats.firstDay ? `${stats.firstDay} ~ ${stats.lastDay}` : '无数据'],
    ['统计口径', '按钱包拆分：Paid=充值余额，Granted=赠金'],
    ['消费合计', `${money(total)} CNY`],
    ['其中 Paid（充值余额）', `${money(stats.totals.Paid)} CNY`],
    ['其中 Granted（赠金）', `${money(stats.totals.Granted)} CNY`],
    ['Paid 占比', `${total ? ((stats.totals.Paid / total) * 100).toFixed(2) : '0.00'}%`],
    ['充值合计', `${money(paidTopup)} CNY`],
    ['推算充值余额', `${money(paidTopup - stats.totals.Paid)} CNY`],
    ['请求数合计', stats.requestTotal],
  ]
  const modelTotal = [...stats.byModel.values()].reduce((sum, value) => sum + value.Paid + value.Granted, 0)
  const monthRows = [
    ['月份', 'Paid', 'Granted', '合计', 'Paid 占比'],
    ...[...stats.byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, value]) => {
        const sum = value.Paid + value.Granted
        return [month, Number(money(value.Paid)), Number(money(value.Granted)), Number(money(sum)), sum ? value.Paid / sum : 0]
      }),
  ]
  const typeRows = [
    ['用量类别', '折合金额', '占比', '数量'],
    ...[...stats.byType.entries()]
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([type, value]) => [
        TYPE_LABELS[type] ?? type,
        Number(money(value.cost)),
        total ? value.cost / total : 0,
        value.amount,
      ]),
  ]
  const keyRows = [
    ['API Key', '折合金额', '占比', '请求数', 'Token 数'],
    ...[...stats.byKey.entries()]
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([key, value]) => [key, Number(money(value.cost)), total ? value.cost / total : 0, value.requests, value.tokens]),
  ]
  const workbook = buildXlsx([
    { name: '概览', rows: overview, widths: [24, 46] },
    { name: '按日', rows: dailyRows.length ? [['日期', 'Paid', 'Granted', '合计', '请求数'], ...dailyRows] : [['日期', 'Paid', 'Granted', '合计', '请求数']], widths: [12, 14, 14, 14, 10] },
    { name: '按月', rows: monthRows, widths: [12, 14, 14, 14, 12] },
    {
      name: '按模型',
      rows: [
        ['模型', 'Paid', 'Granted', '合计', '占比'],
        ...[...stats.byModel.entries()]
          .sort((a, b) => b[1].Paid + b[1].Granted - (a[1].Paid + a[1].Granted))
          .map(([model, value]) => [
            model,
            Number(money(value.Paid)),
            Number(money(value.Granted)),
            Number(money(value.Paid + value.Granted)),
            modelTotal ? (value.Paid + value.Granted) / modelTotal : 0,
          ]),
      ],
      widths: [34, 14, 14, 14, 10],
    },
    { name: '按用量类型', rows: typeRows, widths: [20, 16, 10, 16] },
    { name: '按APIKey', rows: keyRows, widths: [30, 16, 10, 12, 16] },
    {
      name: '费用明细',
      rows: [
        ['日期', '模型', '钱包类型', '币种', '费用'],
        ...selected.map((row) => [row.date, row.model, row.wallet, row.currency, Number(money(row.cost))]),
      ],
      widths: [12, 34, 12, 8, 16],
    },
    {
      name: '用量明细',
      rows: [
        ['日期', '模型', 'API Key', '用量类别', '折合金额', '数量'],
        ...usage.map((row) => [row.date, row.model, row.apiKey, TYPE_LABELS[row.type] ?? row.type, Number(money(row.cost)), row.amount]),
      ],
      widths: [12, 34, 30, 18, 17, 14],
    },
    {
      name: '充值订单',
      rows: [
        ['订单号', '支付时间', '金额', '币种', '状态', '渠道'],
        ...(orders.paymentOrders ?? []).map((order) => [
          order.payment_order_id ?? '',
          order.paid_at ?? '',
          num(order.amount),
          order.currency ?? '',
          order.payment_order_status ?? '',
          order.payment_channel ?? '',
        ]),
      ],
      widths: [44, 26, 12, 8, 12, 12],
    },
  ])
  await writeFile(join(outputDir, 'DeepSeek消费记录.xlsx'), workbook)
  files.push('DeepSeek消费记录.xlsx')

  files.push('summary.json')
  const summary = {
    generatedAt,
    range: [stats.firstDay, stats.lastDay],
    wallet,
    paid: money(stats.totals.Paid),
    granted: money(stats.totals.Granted),
    total: money(total),
    paidTopup: money(paidTopup),
    impliedPaidBalance: money(paidTopup - stats.totals.Paid),
    requests: stats.requestTotal,
    keys: stats.byKey.size,
    files,
  }
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return summary
}
