# dsh-deepseek-usage

把「问用户要 HAR 与 Bearer token → 拉取 DeepSeek 开放平台消费记录 → 生成按钱包拆分的明细」固化成 DSH 插件。

这是 DeepSeek Harness（DSH）bundle。clone 后把本目录安装进 profile：DSH 的 **Plugins → Add plugin** 选择该目录（或用 `plugin_manager` 安装本地 bundle）。装好后 `deepseek-usage` 插件行生效，`ds_usage_status` / `ds_usage_setup` / `ds_usage_export` 与 skill `deepseek-usage-export` 出现。

依赖：DSH `0.2.2-rc.x`，Node 20+（Host 运行时自带）。本插件不引入第三方 npm 包，ZIP/CSV/XLSX 都是仓库内实现。

## 工具

| 工具 | 作用 |
| --- | --- |
| `ds_usage_status` | 检查已保存的登录态是否可用；`clear: true` 清除 |
| `ds_usage_setup` | 从 HAR 提取或直接接收 Bearer token，验证后保存 |
| `ds_usage_export` | 按 `since` / `until` 导出 CSV + Excel |

配套 skill `deepseek-usage-export` 规定流程：**先要 HAR 和 token**，再问时间范围，最后导出。

## 先抓 HAR：必须在页面上点一次「导出」

1. 登录 <https://platform.deepseek.com/usage>，停在用量页。
2. 打开开发者工具（Chrome/Edge `F12`；Safari 先在「设置 → 高级」勾选“显示网页开发者功能”，再 `⌥⌘I`）。
3. 切到 **Network**，勾上 **Preserve log**，过滤框输入 `export`。
4. 回页面点一次用量表格旁的 **「导出」** 按钮（会下载一个 zip，可忽略）。
5. Network 中出现 `/api/v0/usage/export?start=…` 请求后：
   - Chrome/Edge：右键 → **Copy → Copy all as HAR**（或 Save all as HAR with content），保存成 `deepseek-usage.har`；
   - Safari：Network 右下角导出按钮 → 导出 HAR。
6. 把 `.har` 路径交给 Agent。

> 只有点过「导出」，HAR 里才会有 `/api/v0/usage/export` 这条请求；插件靠它确认接口和登录态。

## 再拿 token（HAR 里通常没有 Authorization）

- **方法 A（请求头）**：点开那条 `usage/export` 请求 → **Headers → Request Headers** → `Authorization: Bearer …`，复制 Bearer 后面那段。
- **方法 B（cURL）**：右键请求 → **Copy as cURL**，整段保存/粘贴即可，插件会提取 `-H 'authorization: Bearer …'`。
- **方法 C（HAR 里没有时）**：Application/Storage → Cookies → `https://platform.deepseek.com` → `userToken` 的值；或 Console 执行 `document.cookie.split('; ').find(c => c.startsWith('userToken='))`。

> Safari 导出的 HAR 会主动删除 Cookie 和 Authorization，所以基本都要单独给 token。token 会过期（几天到几周），报 40003 时重新复制。

## 交给插件

对 Agent 说「导出我的 DeepSeek 消费记录」，把 HAR 路径和 token 给它；或直接要求：

- `ds_usage_setup({ harPath: '/绝对路径/deepseek-usage.har', token: '…' })`（HAR 带 Authorization 时 token 可省）
- `ds_usage_export({ since: '2025-01-01', until: '2026-11-18', wallet: 'paid' })`

## 产出（默认 `deepseek-usage-export/`）

- `DeepSeek消费记录.xlsx`：概览 / 按日 / 按月 / 按模型 / 按用量类型 / 按APIKey / 费用明细 / 用量明细 / 充值订单
- `Paid费用明细.csv`（`wallet=granted` 时为 `Granted费用明细.csv`，`all` 时为 `费用明细.csv`）
- `按日汇总.csv`、`用量明细.csv`、`summary.json`、`raw/`（窗口缓存）

## 边界

- 导出接口单区间上限 31 天，工具自动切片；超过 120 个窗口要求缩小范围。
- 钱包拆分只到「账号 × 模型 × 天」；按 Key 的金额是单价 × 用量折合。
- token 存为 DSH 凭据记录（无凭据服务时写 `~/.config/dsh-deepseek-usage/token.json`，600），只回显掩码。

## 目录结构

```
index.js            # 三个工具 + skill 注册
lib/guide.js        # 教用户抓 HAR / 取 token 的文案（skill 与工具共用）
lib/har.js          # HAR 解析与 token 提取
lib/api.js          # 平台接口客户端
lib/fetch.js        # 31 天窗口切片与缓存
lib/report.js       # 聚合与导出
lib/xlsx.js lib/zip.js lib/csv.js
lib/store.js        # 凭据存储
locale/{zh,en}.json icon.svg docs/DETAIL.md
test/               # 离线 smoke 测试 + 真实接口 e2e（需 token）
```

## 测试

```bash
node test/smoke.mjs                              # 离线，用 test/fixtures 里的合成导出包
DEEPSEEK_USAGE_TOKEN=... node test/e2e.mjs       # 真机抓一个窗口
```
