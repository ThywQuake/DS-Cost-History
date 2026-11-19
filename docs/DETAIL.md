# DeepSeek 消费记录导出

把「从浏览器 HAR 拿到登录态 → 拉取平台消费记录 → 生成明细表」这套流程固化成三个工具，并附带一个 skill 负责先问清凭据和时间范围。

## 功能

- **ds_usage_status**：查看是否已保存登录态、token 是否还有效；`clear: true` 删除已保存的 token。
- **ds_usage_setup**：从 HAR 文件里提取 `Authorization: Bearer …`（或 `userToken` Cookie），也可以直接传 token；验证后保存为 DSH 凭据记录（没有凭据服务时写到 `~/.config/dsh-deepseek-usage/token.json`，权限 600）。
- **ds_usage_export**：按用户给的 `since` / `until` 拉取数据。内部按 **31 天**一切片调用 `/api/v0/usage/export`，把 `cost`（含 `wallet_type`）和 `amount`（含 Key、单价、token 类别）聚合后写到工作区的 `deepseek-usage-export/`。

## 使用

1. 用户说要导出 DeepSeek 消费记录时，skill 先教用户取数（见下），再让用户给 **HAR 文件** 和 **Bearer token**（HAR 里带 Authorization 时 token 可省）。
2. `ds_usage_setup({ harPath, token })` 验证并保存；HAR 里没有 Authorization 时，返回里会带上从请求头 / Cookie 取 token 的步骤。
3. 问清时间范围后 `ds_usage_export({ since, until, wallet })`；`wallet` 默认 `paid`，可传 `granted` 或 `all`。

## 教用户取 HAR 与 token

**HAR**：登录 <https://platform.deepseek.com/usage> → 开发者工具 Network → 勾 Preserve log → 过滤 `export` → 回页面点一次「导出」→ 右键出现的 `/api/v0/usage/export` 请求 → Copy all as HAR（Safari 用 Network 面板的导出按钮）。

**token**：

- 同一条请求 Headers → Request Headers → `Authorization: Bearer …`；
- 或右键 Copy as cURL，整段交给插件；
- HAR 里没有时，从 Application/Storage → Cookies → `platform.deepseek.com` → `userToken` 取值，或 Console 执行 `document.cookie` 查找。

插件在 `ds_usage_setup` 返回、`ds_usage_status` 未配置提示和 skill 正文里都内置了这套步骤。

## 产出

- `DeepSeek消费记录.xlsx`：概览、按日、按月、按模型、按用量类型、按APIKey、费用明细、用量明细、充值订单
- `Paid费用明细.csv`（`wallet=granted` 时为 Granted，`all` 时为全量）
- `按日汇总.csv`、`用量明细.csv`、`summary.json`、`raw/`（窗口缓存，可断点续跑）

## 已知边界

- 导出接口单次区间上限 31 天，超限会 `INVALID_PARAM`；工具自动切片。
- `wallet_type` 只到「账号 × 模型 × 天」，**按 API Key 的金额是单价 × 用量折合**，无法拆 Paid/Granted。
- 只发 GET 请求，不上传 token；工具返回里只有掩码。token 过期（40003）需要用户重新提供。
