# Cloudflare Redirect 接入过程记录

## 1. 背景

这个项目最开始的 fallback 方案使用的是 synthetic URL，例如：

- `https://translated.local/...`

这样可以避免 Readwise 把保存结果重新识别成原始文章 URL，从而把内容清洗回英文，但也带来一个明显问题：

- Reader 里的 source link 不能直接跳回原始文章

为了解决这个问题，后续接入了一个可选的个人 redirect 服务。

目标是：

- fallback 保存时仍然避免使用原始文章 URL
- Reader 里的 source link 仍然可以点击回到原始页面
- 不把 redirect signing secret 硬编码进公开扩展包

## 2. 最终方案

最终采用的方案是：

- 域名：`go.example.com`
- 基础设施：Cloudflare Workers
- redirect 形态：
  - `https://go.example.com/open?u=...&n=...&s=...&v=v1`

其中：

- `u` 是原始 URL 的 `base64url`
- `n` 是随机 nonce
- `s` 是基于 HMAC-SHA256 的签名
- `v` 是协议版本号

扩展在 fallback 保存时：

1. 使用本地配置的 `redirectBaseUrl`
2. 使用本地配置的 `redirectSigningSecret`
3. 生成签名后的 redirect URL
4. 把这个 redirect URL 作为 Readwise 的 fallback source URL

Worker 在收到请求后：

1. 校验参数格式
2. 校验签名
3. 解码原始 URL
4. 拒绝不安全目标
5. `302` 跳转到原始页面

## 3. 为什么不用 OAuth 登录 Wrangler

一开始尝试使用：

- `npx wrangler login`

但实际遇到了 Cloudflare OAuth scope 错误，表现为：

- `invalid_scope`
- `The OAuth 2.0 Client is not allowed to request scope "pages:write%"`

授权失败后，本地回调地址：

- `http://localhost:8976/oauth/callback`

也会出现：

- `ERR_CONNECTION_REFUSED`

因此最后没有继续使用 Wrangler OAuth，而是切换到了 API token 方案。

## 4. 最终采用的 Cloudflare 接入方式

### 4.1 本地凭据文件

新增了本地忽略文件：

- `.cloudflare.env.local`

格式如下：

```bash
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
REDIRECT_SIGNING_SECRET=...
REDIRECT_BASE_URL=https://go.example.com
```

同时新增模板文件：

- `.cloudflare.env.local.example`

并将这些本地文件加入 `.gitignore`。

### 4.2 Token 模板选择

Cloudflare 后台创建 token 时，使用：

- `Edit Cloudflare Workers`

这是为了让 Wrangler 可以直接部署 Worker 和 custom domain。

### 4.3 Account ID 获取

使用 API token 调用：

- `GET https://api.cloudflare.com/client/v4/accounts`

自动读取当前 account id。

### 4.4 Worker secret 写入

使用：

```bash
npx wrangler secret put REDIRECT_SIGNING_SECRET --config cloudflare/redirect-worker/wrangler.jsonc
```

把签名 secret 写入 Cloudflare Worker。

### 4.5 Worker 部署

使用：

```bash
npx wrangler deploy --config cloudflare/redirect-worker/wrangler.jsonc
```

成功部署到了：

- `go.example.com (custom domain)`

## 5. 本地扩展配置

在本地 `config.local.json` 中加入：

```json
{
  "redirectBaseUrl": "https://go.example.com",
  "redirectSigningSecret": "..."
}
```

这样 fallback 保存时，扩展会优先生成：

- `go.example.com/open?...`

而不是继续使用 `translated.local/...`

## 6. 真实验证结果

后续做了真实 fallback 保存测试，关键结果如下：

- `usedRedirectUrl: true`
- `readerSourceUrl` 已经变成 `https://go.example.com/open?...`
- Reader 文档创建成功
- 测试文档验证后已删除

这说明：

- fallback redirect 集成生效
- Reader 中的 source link 已经可以通过 `go.example.com` 跳回原始页面

## 7. 过程中的一个真实 bug

在真实端到端测试里，顺手发现了一个无关 redirect 的 bug：

- `BADGE_RESET_DELAY_MS is not defined`

原因是背景脚本里还保留了一段旧的 badge 延迟清理逻辑，但相关常量已经被删除。

修复方式是：

- 不再依赖旧常量
- 在保存流程结束时直接清掉临时 badge

## 8. 当前行为

现在扩展的行为是：

- 左键扩展图标：用原始 URL 保存
- 右键扩展图标：可选 fallback source URL

fallback source URL 的优先级：

1. 如果已配置 redirect 服务，则使用 `go.example.com/open?...`
2. 如果未配置 redirect 服务，则退回 synthetic URL

同时：

- fallback 文档正文顶部仍然会插入 `Open original article`
- fallback note 只保留 `Original URL: ...`

## 9. 当前结论

这次 redirect 接入已经可以视为可用状态：

- 技术方案成立
- 线上域名已部署
- 扩展本地已接好
- 真实保存链路已验证

后续如果要继续优化，方向是：

- 把 `go.example.com/open?...` 升级成更短的 `go.example.com/r/<id>`
- 但这已经属于体验优化，不是当前功能可用性的阻塞项
