/** Step-by-step instructions shown to users when they need to obtain a HAR file or token. */

export const HAR_STEPS = `## 抓 HAR：必须先在页面上点一次「导出」

1. 用浏览器登录 <https://platform.deepseek.com/usage>，停在「用量」页。
2. 打开开发者工具：Chrome / Edge 按 \`F12\` 或 \`⌥⌘I\`；Safari 需先在「设置 → 高级」勾选“显示网页开发者功能”，再按 \`⌥⌘I\`。
3. 切到 **Network（网络）** 面板，勾上 **Preserve log / 保留日志**，在过滤框输入 \`export\`。
4. 回到页面，点一次用量表格旁边的 **「导出」** 按钮（会下载一个 zip，不用管它）。
5. 此时 Network 里会出现 \`/api/v0/usage/export?start=…&end=…&tz=…\` 请求：
   - Chrome / Edge：右键该请求 → **Copy → Copy all as HAR**（或 **Save all as HAR with content**），粘贴/保存成 \`deepseek-usage.har\`；
   - Safari：Network 面板右下角的导出按钮（向下箭头）→ 导出 HAR，保存成 \`.har\`。
6. 把这个 \`.har\` 文件路径交给 Agent。

> 为什么一定要点「导出」：只有这条请求带 \`/api/v0/usage/export\`，插件就是按它定位平台接口和登录态；没点导出时 HAR 里可能一条 platform 请求都没有。

HAR 里通常**不含** \`Authorization\`（Safari 会主动删掉 Cookie 和 Authorization），所以还需要下面的 token。`

export const TOKEN_STEPS = `## 拿 Authorization token

**方法 A：从同一条 export 请求的请求头里看（最快）**

1. 在 Network 面板点开那条 \`usage/export\` 请求。
2. 切到 **Headers → Request Headers**，找到 \`Authorization: Bearer xxxxx\`。
3. 复制 \`Bearer \` 后面那一段（不要带 "Bearer" 字样也行，插件会自动去掉）。

**方法 B：Copy as cURL**

右键那条请求 → **Copy → Copy as cURL**，把整段命令原样保存成文本文件（或直接粘贴给 Agent），里面有一行 \`-H 'authorization: Bearer …'\`，插件会自动提取。

**方法 C：HAR 里没有 Authorization 时**

- Chrome / Edge：**Application（应用）→ Storage → Cookies → https://platform.deepseek.com**，找到 \`userToken\`，复制它的值；
- 或在 **Console** 里执行 \`document.cookie.split('; ').find(c => c.startsWith('userToken='))\`，复制等号后面的值；
- Safari：**Storage → Cookies** 里找 \`userToken\`，或在 Console 执行同样的语句。
- 把 \`userToken\` 的值（或整行 \`userToken=…\`）当 token 传给插件即可。

> token 会过期，通常几天到几周。报 40003 时回到这里重新复制一次。不要把 token 截图或粘贴到公开渠道。`

export const SETUP_GUIDE = `${HAR_STEPS}

${TOKEN_STEPS}

## 交给插件

- 已拿到 HAR：\`ds_usage_setup({ harPath: "/绝对路径/deepseek-usage.har", token: "可选" })\`
- 只有 token：\`ds_usage_setup({ token: "…" })\`
- HAR 里已经带了 Authorization：只传 \`harPath\` 即可。
`
