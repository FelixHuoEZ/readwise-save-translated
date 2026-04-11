# 公共插件可用的服务端签名版 Redirect 设计

## 1. 背景

当前项目已经支持两种 fallback source URL：

- `synthetic URL`：完全本地生成，不依赖服务端
- `redirect URL`：使用个人域名 + 本地 `redirectSigningSecret`

第二种方案适合高级用户，但不适合作为公共插件默认能力，因为：

- secret 不能随公开插件一起分发
- 一旦 secret 进入公开扩展包，就失去防滥用意义
- 其他用户即使看见默认域名，也无法直接使用它做 redirect

因此未来如果要做公共方案，可以考虑：

- 插件可以接入项目托管的 redirect 服务
- 用户不需要额外填写 secret
- secret 只留在服务端
- redirect 仍然能够跳回原始页面

## 2. 设计目标

- 公开发布的插件默认可用
- 不在客户端暴露签名 secret
- 默认 fallback 链接可由项目托管服务签发
- 继续支持现有高级模式：
  - 用户自定义 redirect 域名
  - 用户本地配置 secret
- 服务端实现尽量轻量，优先使用 Cloudflare Workers 体系

## 3. 非目标

- 不在第一阶段解决“链接完全不暴露原始 URL”
- 不在第一阶段做用户账号系统
- 不在第一阶段做统计面板
- 不在第一阶段做复杂权限体系

## 4. 推荐架构

推荐拆成两条路径：

### 4.1 未来公共默认路径

- 插件内置公共服务入口
- 插件不持有 secret
- 插件在 fallback 保存前，请求服务端签发 redirect URL
- 服务端返回已经签好名的 `https://go.example.com/open?...`
- 插件把这个 URL 作为 Readwise `source_url`

### 4.2 高级自定义路径

- 用户自己填写 `redirectBaseUrl`
- 用户自己填写 `redirectSigningSecret`
- 扩展本地签名
- 用户自己的 Worker 验签

也就是说，未来正式产品可以同时保留两种模式：

- 公共默认模式：服务端签名
- 高级用户模式：本地签名

## 5. 服务端签名模式

### 5.1 请求流程

1. 用户触发 fallback 保存
2. 扩展收集 `originalUrl`
3. 扩展向服务端发起签发请求
4. 服务端验证 URL 安全性与请求约束
5. 服务端生成签名后的 redirect URL
6. 扩展用这个 URL 继续调用 Readwise save API

### 5.2 推荐接口

#### `POST /api/mint-redirect`

请求体：

```json
{
  "originalUrl": "https://www.example.com/article",
  "version": "v1",
  "client": {
    "extensionVersion": "0.1.4",
    "mode": "fallback"
  }
}
```

响应体：

```json
{
  "ok": true,
  "redirectUrl": "https://go.example.com/open?u=...&n=...&s=...&v=v1"
}
```

失败响应：

```json
{
  "ok": false,
  "error": "unsafe_destination"
}
```

### 5.3 Worker 路由划分

建议统一在一个 Worker 里放两个入口：

- `POST /api/mint-redirect`
  - 负责签发 redirect URL
- `GET /open?u=...&n=...&s=...&v=v1`
  - 负责验签并跳转

这样不需要额外的后端，只要一个 Worker 即可。

## 6. 签名逻辑

服务端继续沿用当前签名结构：

- `u`：原始 URL 的 `base64url`
- `n`：随机 nonce
- `v`：协议版本
- `s`：HMAC-SHA256 签名

签名 payload：

```text
v1.<nonce>.<encodedDestination>
```

这与当前本地签名版兼容，优点是：

- 可以复用现有 `/open` 验签逻辑
- 客户端和服务端行为更容易统一
- 迁移成本低

## 7. 安全约束

这是这条方案里最关键的部分。

### 7.1 secret 只在服务端

- `REDIRECT_SIGNING_SECRET` 只能保存在 Worker secret
- 绝不能打包进公开扩展
- 绝不能写进仓库

### 7.2 URL 安全检查

签发前和跳转前都做检查：

- 只允许 `http` / `https`
- 禁止 `localhost`
- 禁止 `.local`
- 禁止内网 IP
- 禁止回环地址

这部分当前 Worker 已经具备基础逻辑，可以直接复用。

### 7.3 请求来源约束

第一阶段建议至少做：

- 严格 CORS，只允许：
  - 发布版扩展 ID
  - 开发时的本地调试来源
- 校验 `content-type: application/json`
- 只接受 `POST`

注意：

- 这不能彻底防止服务端被脚本调用
- 但可以先降低普通浏览器侧滥用

### 7.4 频率限制

公共服务必须加 rate limit。

建议：

- 每 IP 每分钟限制签发次数
- 对异常峰值直接返回 `429`
- 结合 Cloudflare 原生 rate limiting 或 Durable Object 计数

### 7.5 失效与轮换

建议把签名 URL 设计成可轮换：

- secret 可以轮换
- 未来如需加时间戳，可升级到 `v2`
- `v1` 和 `v2` 可并行一段时间

## 8. 插件侧行为

### 8.1 未来默认发布版行为

发布版推荐这样处理：

- 默认不暴露 signing secret
- 不要求用户填写 secret
- fallback 时优先调用服务端签发接口
- 如果接口成功，使用服务端返回的 redirect URL
- 如果接口失败，退回 synthetic URL

### 8.2 高级模式保留

当用户明确填写了：

- 自定义 `redirectBaseUrl`
- 自定义 `redirectSigningSecret`

则继续走当前本地签名模式，不调用公共签发接口。

这样可以把两种模式明确区分开：

- 公共默认模式：用户无感
- 高级模式：用户自管

### 8.3 推荐优先级

建议最终逻辑是：

1. 如果用户明确配置了 `redirectBaseUrl + redirectSigningSecret`
   - 使用本地签名 redirect
2. 否则如果存在公共签发服务
   - 请求服务端签发 redirect
3. 否则
   - 退回 synthetic URL

## 9. 推荐实现阶段

### Phase 1

最小可用版：

- Worker 增加 `POST /api/mint-redirect`
- 继续复用现有 `GET /open`
- 插件新增“请求公共 redirect”逻辑
- 失败自动退回 synthetic

### Phase 2

稳态增强：

- 加 IP rate limit
- 加更清晰的错误码
- 加服务可用性监控
- 在详情页显示：
  - `redirect minted by service`
  - `fell back to synthetic`

### Phase 3

更优雅的终态：

- 由 `open?u=...&s=...` 升级为短链
- 例如：
  - `https://go.example.com/r/abc123`
- 优点：
  - 链接更短
  - 不直接暴露原始 URL
  - 可以撤销和统计
- 成本：
  - 需要 KV / D1 / Durable Object 存储映射

## 10. 为什么不直接把 secret 发给所有用户

因为那样等于没有 secret。

公开插件里的任何静态值都可以被反编译拿到。  
如果所有用户共享同一个 secret，那么任何人都能伪造你域名下的跳转链接，服务端签名这层保护就失效了。

所以公共插件想要默认可用，正确方向一定是：

- secret 留在服务端
- 客户端只请求服务端签发结果

## 11. 对当前项目的建议结论

推荐正式路线：

- 保留现在的 `synthetic fallback`
- 保留现在的“高级用户自定义 redirect”模式
- 新增“公共默认服务端签发 redirect”模式

也就是三层兜底：

1. 用户自定义 redirect + secret
2. 官方公共签发 redirect
3. synthetic URL

这样：

- 公开插件可以开箱即用
- 高级用户仍然可以完全自托管
- 服务不可用时也不会失去 fallback 能力
