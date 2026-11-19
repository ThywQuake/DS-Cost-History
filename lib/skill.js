/** Runtime skill: the ask-first workflow for exporting DeepSeek consumption records. */

import { SETUP_GUIDE } from './guide.js'

export const SKILL_NAME = 'deepseek-usage-export'

export const SKILL_DESCRIPTION =
  '拉取 DeepSeek 开放平台（platform.deepseek.com）账号的消费记录并导出 CSV/Excel，按钱包区分 Paid（充值余额）与 Granted（赠金）。用户要查消费、账单、用量、token 消耗、付费明细时使用。'

export const SKILL_WHEN_TO_USE =
  '用户说“导出我的 DeepSeek 消费记录”“看看这个月花了多少”“只要付费的那部分”“按 Key/模型看用量”等；需要先拿到浏览器 HAR 或 Bearer token。'

export const SKILL_CONTENT = `# DeepSeek 消费记录导出

## 何时使用

用户要查 / 导出 DeepSeek 开放平台的消费、账单、用量、token 消耗，或要求区分 Paid（充值余额）与 Granted（赠金）时使用。加载本 skill 不代表已授权访问账号：先确认用户愿意提供登录态。

## 第一步：先要凭据，不要先问时间范围

1. 先调 \`ds_usage_status\`。返回 \`configured: true\` 就直接进第二步。
2. 未配置时，把下面的步骤**原样讲给用户**（一次讲清，别分多轮）：先让用户在 platform 页面上点一次「导出」，再抓 HAR；HAR 里没有 Authorization 时，教用户从请求头或 Cookie 里取 token。
3. 用户给出 HAR / token 后调 \`ds_usage_setup({ harPath, token })\` 保存并验证。返回 \`authFailed: true\` 说明 token 过期，让用户按同样的方法重新复制一次。
4. 安全：\`ds_usage_setup\` 只回掩码；任何时候都不要把 token 原文复述到回复里。

### 给用户的取数步骤

${SETUP_GUIDE}

## 第二步：确认时间范围

问用户要查哪一段，然后调 \`ds_usage_export\`：

- 「全部」→ 不传 \`since\`，默认从账号最早记录（Key/充值/赠金时间）往前推一个月开始；
- 「最近 N 天 / 这个月 / 某两个日期之间」→ 换算成 \`YYYY-MM-DD\` 传 \`since\` / \`until\`；
- \`wallet\` 默认 \`paid\`；用户要连赠金一起看时传 \`all\`，只看赠金传 \`granted\`。

## 第三步：汇报结果

- 报 Paid / Granted / 平台总用量、请求数、Token 数，以及文件写到哪个目录。
- 说明口径：Paid = 充值余额实际扣款，Granted = 赠金抵扣；钱包拆分粒度只到「账号 × 模型 × 天」，按 API Key 的金额是单价 × 用量折合。
- 产出：\`DeepSeek消费记录.xlsx\`（概览/按日/按月/按模型/按用量类型/按APIKey/费用明细/用量明细/充值订单）、\`Paid费用明细.csv\`、\`按日汇总.csv\`、\`用量明细.csv\`、\`summary.json\`。

## 限制与安全

- 导出接口单次区间上限 31 天，工具会自动切片；范围太大时先缩小，别一次拉几年。
- token 会过期（通常几天到几周）；重跑报 40003 就让用户重新提供。
- 工具只发 GET 请求，不上传 token；不要把 token 写进命令、文件或回复。
- 需要清除已保存的 token 时调 \`ds_usage_status({ clear: true })\`。
`
