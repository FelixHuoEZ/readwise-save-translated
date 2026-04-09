# Readwise Save Translated 需求文档

## 1. 项目目标

构建一个 Chrome 扩展，将“浏览器当前页面中已经被翻译后的状态”保存到 Readwise Reader。

这个项目的核心目标不是重新实现一套网页阅读模式或站点解析器，而是尽量复用：

- 浏览器当前已经渲染出来的页面
- 浏览器翻译插件已经写入 DOM 的翻译结果
- Readwise 自己的 `should_clean_html` 清洗与解析能力

最终产物应当是一份适合在 Reader 中继续阅读的“双语增强版”文档。

## 2. 已确定的产品原则

- 不为单独网站编写自定义 parser。
- 不做站点专用规则、页面专用抽取、手工 block 过滤体系。
- 优先把“当前页面的 HTML 快照”交给 Readwise 自己清洗。
- 扩展只允许使用非常轻量的通用范围收缩策略，例如直接复用页面现成的 `article` 元素。
- 默认路径优先保留 Readwise 的原生 source-link 行为。
- synthetic URL 方案是 fallback，只在默认路径把内容清洗回英文时使用。
- 整个产品方向是“保存翻译后的页面状态”，不是“重新抓取原始 URL 并重新翻译”。
- 如果翻译插件没有把中文写入真实 DOM，而只是视觉覆盖，那么本项目的保存效果不保证可用。

## 3. 目标用户流程

### 3.1 主流程

用户在网页上完成翻译后：

1. 左键点击扩展图标
2. 扩展立即使用原始页面 URL 执行默认保存
3. 保存结果通过扩展图标状态反馈
4. 用户需要更多信息时，再通过详情页查看结果、fallback 和调试信息

### 3.2 次级流程

当默认保存结果不理想时：

1. 用户右键扩展图标
2. 直接选择 synthetic URL fallback，或者打开详情页
3. 需要时手动触发 synthetic URL fallback
4. 查看 Reader 链接、existing doc 信息和调试信息

## 4. 功能需求

### 4.1 扩展形态

- 必须是一个 Chrome 扩展。
- 左键点击扩展 action 时，直接触发默认保存，不弹出 popup。
- 右键扩展 action 时，应至少提供：
  - 打开详情页
  - Save with original URL (default)
  - synthetic URL fallback
- 详情页用于 fallback、结果查看和调试，不应成为主流程入口。

### 4.2 保存策略

- 默认保存策略使用原始页面 URL 作为 Reader source URL。
- fallback 保存策略使用 synthetic URL 作为 Reader source URL。
- 两条保存路径都必须使用 `should_clean_html: true`。
- 扩展必须将当前页面在翻译完成后的 HTML 快照提交给 Readwise Reader Save API。
- 扩展必须保留回到原始文章 URL 的路径。

### 4.3 范围策略

- `whole-page` 模式使用完整页面 HTML。
- synthetic fallback 路径允许使用当前页面现成的 `article` 节点，作为更轻的正文范围。
- synthetic fallback 不能把 `article` 裸包进一个极简 HTML 壳子里。
- synthetic fallback 必须尽量保留原页面 `head` 上下文，只把 `body` 收窄到当前 `article` 节点。
- 不允许为了提高命中率而引入站点专用 DOM 规则。
- 不允许把“通用轻量 scope”逐步演化成“隐形 parser 系统”。

### 4.4 URL 策略

- 首次保存时，优先使用原始页面 URL 作为 Reader source URL。
- 如果默认路径效果不理想，fallback 路径应直接使用 synthetic URL，而不是继续依赖原始 URL。
- synthetic URL 应足够唯一，避免被 Reader 识别为原始文章 URL。
- 使用 synthetic URL 时，不能再依赖 Reader 自带 source link 回到原网页。
- 因此 fallback 文档正文中必须插入一个明确的原文链接。

### 4.5 标题策略

- 默认不添加任何标题前缀。
- 如果页面同时存在：
  - 原始可见英文标题
  - 与主标题邻近的可见中文翻译标题
  则应生成双语标题。
- 双语标题格式使用普通空格连接，而不是斜杠或其他分隔符。
- 例如：
  `A visual guide to getting out of a creative slump 摆脱创意低谷的视觉指南`
- 如果只能抓到其中一个标题，则退回为单标题。
- 保存时需要区分“解析输入标题”和“最终展示标题”。
- 提交给 Readwise save API 的 ingest title，应优先使用更偏翻译后的标题，而不是强制使用双语标题。
- 文档创建成功后，如果 ingest title 与最终展示标题不同，应再把 Reader 文档标题更新成用户想要的双语标题。
- 最终展示标题可以是双语标题。
- 保存时仍需要同步改写上传 HTML 中的：
  - `<title>`
  - `og:title`
  - `twitter:title`

### 4.6 元数据策略

- 作者信息应尽量从页面通用元数据中提取，而不是退回成域名。
- 发布时间应尽量从页面通用元数据中提取。
- 元数据提取允许使用通用来源，例如：
  - meta tags
  - JSON-LD
  - `time[datetime]`
- 不允许为某个具体网站单独写作者/时间提取规则。

### 4.7 标签与备注策略

- 默认不添加任何 tags。
- 只有用户显式配置时，才附带 tags。
- 默认原始 URL 保存路径不写 document note。
- synthetic fallback 路径的 document note 只保留原始 URL，不要写入大段诊断信息。
- fallback note 格式应尽量简单，例如：
  - `Original URL: https://...`

### 4.8 已存在文档检测

- 扩展必须检测“原始 URL 是否已经在 Reader 中存在”。
- 当前可用信号是：
  - 首次对原 URL 调用 Readwise save API 返回 `200`
- 如果出现该情况：
  - 扩展应继续用 fragment fallback 保存翻译版本
  - 同时把“原 URL 已存在于 Reader”记录到最近一次保存结果中
- 详情页必须展示这个状态。
- 详情页应尽量提供已有 Reader 文档链接，便于用户直接对比。

## 5. 状态反馈需求

### 5.1 主反馈方式

- 主反馈方式必须是扩展 action icon。
- 成功状态不能替换成一个完全不同的图标，而是要保留基础 `R` 图标，再叠加一个成功 badge。
- 失败状态同理，保留基础 `R` 图标，再叠加失败 badge。

### 5.2 icon 状态生命周期

- 保存成功后，当前 tab 的 icon 状态需要保留。
- 保存失败后，当前 tab 的失败状态也需要保留。
- icon 状态必须是按 tab 维度隔离的，而不是全局共享的。
- 在同一个浏览器会话内：
  - 切换到其他 tab
  - 切换到其他 Chrome 窗口
  - 切换到其他应用后再回来
  都不能清除这个 tab 的 icon 状态。
- 如果切换到一个没有保存状态的 tab，该 tab 必须显示默认 icon，而不是沿用上一个 tab 的对勾或叹号。
- 如果再次切回一个已经有保存状态的 tab，必须恢复显示该 tab 自己的对勾或叹号状态。
- 只有以下情况才应重置为默认图标：
  - 当前 tab 刷新
  - 当前 tab 导航到新的 URL
  - 当前 tab 被关闭
- 浏览器退出后，不要求保留之前的状态。

### 5.3 通知策略

- 不显示 macOS 系统通知。
- 不显示 Chrome 页内 toast。
- 所有主反馈都应收敛到：
  - action icon 状态
  - 详情页中的最近一次结果
  - action title 提示文本

## 6. 详情页需求

详情页用于查看保存结果、fallback 和调试信息。

详情页至少需要展示：

- 当前页面标题
- 当前页面 URL
- Token 是否已配置
- 当前 capture mode
- 最近一次保存结果
- 最近一次使用的 source 策略
- Reader 文档链接
- 原始 URL 是否已在 Reader 中存在
- 已存在文档链接（如果可用）
- 解析出的标题信息：
  - Resolved title
  - Parser title
  - Ingest title
  - Display title
  - Original title
  - Translated title
- 作者与发布时间
- 是否启用了 Readwise clean HTML
- 是否使用了 synthetic fallback
- 内容根节点、article 根节点、CJK 计数、preview 等轻量调试信息
- 一键复制 debug 信息

## 7. 配置需求

- Readwise access token 需要保存在扩展本地配置中。
- 支持通过扩展设置页配置：
  - token
  - title prefix
  - capture mode
  - default tags
- 同时支持通过本地 `config.local.json` 提供这些配置。
- unpacked extension 模式下，用户应能仅通过改本地配置文件完成初始化。

## 8. 测试与验收要求

- 使用真实 Readwise 账号做实验时，测试文档在验证完成后必须删除。
- 测试文档不能仅仅移动到 `archive`，而应该真正删除。
- 验收时至少关注：
  - 翻译后的中文是否真的进入保存结果
  - 标题是否为双语标题
  - 作者和发布时间是否正确
  - icon 成功/失败状态是否符合预期
  - 默认原始 URL 路径是否保留 Reader 原生 source link
  - synthetic fallback 是否能保住双语内容
  - synthetic fallback 文档中是否有可点击的原文链接

## 9. 已知边界与开放问题

- 并不是所有翻译插件都会把翻译写回真实 DOM；如果只是视觉覆盖，本项目可能拿不到中文内容。
- Readwise 对“直接上传 HTML”这条链路的 URL 去重行为，可能与其他保存路径不同。
- 当前 fragment fallback 已可用，但未来是否需要 `?query` 或 redirect URL 方案，仍可继续评估。
- 后续应评估并实现一个轻量 redirect 服务：
  - synthetic fallback 不再暴露 `translated.local` 之类的假地址
  - Reader 中保存的 source URL 改为该 redirect 服务地址
  - 用户点击或复制该链接时，可通过 302/307 跳转回原始页面
  - 该服务可作为 synthetic URL fallback 的正式替代方案
- 如果 Reader 中已存在原始英文文档，删除它之后是否会提升后续 raw HTML 清洗质量，仍然属于待观察问题。
