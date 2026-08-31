# dsh-computer-use 开发日志

本文件记录提示词「零、前置自查任务」的三项自查结论。所有结论均基于
`D:\code\Ai\fork\deepseek-harness` 源码（版本 0.1.2-alpha.1，2026 年 8 月同步基线），
引用格式为 `文件:行号`。写任何业务代码之前必须先读本文件。

## 自查 1：插件内调用大模型的标准 API

**结论：DSH 提供统一的模型调用服务 `ctx.llm`（`LlmRuntime`），支持多模态；
插件通过它调用用户已配置的模型路由，不需要也不允许自己管理 API Key。**

### 1.1 统一接口

- `ctx.llm` 是 `LlmRuntime`：adapter 注册表 + 可被 `llm/stream` waterfall 拦截的流式调用
  （`packages/llm/llm/src/index.ts:326`、`:1050`）。
- 插件侧调用入口：
  - `ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`（`index.ts:1050`）
  - `ctx.llm.prepareCall(config: LlmCallConfig, signal?): Promise<PreparedLlmCall>`
    （`index.ts:889`）——把「路由解析 + 能力校验」与「分派」绑定到同一个 adapter 代，
    是 session-title-llm 之外需要能力预检时的推荐入口。
- `GenerateOptions`（`packages/llm/llm/src/types.ts:393`）：
  `{ provider, model, messages, system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }`。
  `purpose` 是封闭集合 `'compaction' | 'session-title'`（`types.ts:428`），
  本插件的视觉辅助调用**不设置** `purpose`。

### 1.2 多模态（图片 + 文本）

- 消息内容块 `ContentBlockMap` 含 `image`（`packages/llm/llm/src/types.ts:99`）：
  `ImageBlock { type: 'image', attachment: ImageAttachmentRef }`（`types.ts:71`）。
- **图片是持久化附件引用，不是内联 base64**：必须先把字节存入附件服务
  `ctx.attachments.saveImage({ data: Uint8Array, mediaType, name? })`
  （`packages/attachment/attachment/src/index.ts:100`），拿到 `ImageAttachmentRef`
  后放进 user message 的 content。
- 目标路由不接受图片时，`LlmRuntime` 自动把图片投影为占位文本
  （`projectImagesForTextModel`，`index.ts:995-1001`）；路由的模态能力来自 adapter
  `resolveModel` 返回的 `inputModalities`。

### 1.3 现成的辅助调用先例

`packages/session/session-title-llm/src/index.ts:229-294` 是官方「旁路模型调用」模板：

1. `createUserMessage({ content, source: { kind: 'plugin', plugin: '<name>' } })` 构造消息；
2. `deadline(signal, timeoutMs, CODE)` 生成带超时的信号（`@deepseek-ai/dsh-timeout`）；
3. `for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`
   用 `BlockAssembler` 汇聚；
4. 检查 `assembler.finish`（`stop | error | aborted | max-tokens | tool-calls`）
   后读取 `assembler.blocks()` 的 text 块。

### 1.4 路由解析与用户已配置模型

- `GenerateOptions.provider` 是 **provider 路由名**。本机部署的路由来自
  `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers` 段：段名即路由名
  （`packages/bundle/base/cordis.patch.yml:100-108` 注释说明 settings 段驱动
  pi-ai adapter 的路由注册；`agent-default-model` 行使用 `provider: tokenrhythm`
  证实路由名 = settings 键，`packages/bundle/base/cordis.patch.yml:75-79`）。
- 本机实测（`C:\Users\luoguangyu\.dsh\settings.yaml`）：
  - `tokenrhythm/qwen3.8-max` 声明 `input: [text, image]` ——可作主力视觉模型；
  - `tokenrhythm/glm-5.3-flash` 声明 `input: [text, image]` ——可作变化检测模型；
  - `agent-default-model: { provider: tokenrhythm, model: qwen3.8-max }`。
- 因此 Config 必须同时携带 **provider + model** 两个字段（成对出现，
  session-title-llm 同样要求「provider and model must be supplied together」，
  `packages/session/session-title-llm/src/index.ts:127-131`）。

### 1.5 API Key

插件**禁止**自管 API Key、禁止直接发 HTTP 请求。Key 由拥有该路由的 adapter
在每次请求时从 credentials/settings 解析（`packages/bundle/base/cordis.patch.yml:93-98`
credentials 行、`:496-501` llm-deepseek 行注释）。插件只需调用 `ctx.llm`。

### 1.6 本插件的视觉调用代码形态（Phase 2 实现依据）

```ts
import { createUserMessage, BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm'

const prepared = await ctx.llm.prepareCall(
  { provider: config.visionProvider, model: config.visionModel },
  signal,
)
const [ref] = await ctx.attachments.saveImages([{
  data: jpegBytes, mediaType: 'image/jpeg', name: `cu-shot-${seq}.jpg`,
}])
const messages = [createUserMessage({
  content: [
    { type: 'text', text: analysisPrompt },
    { type: 'image', attachment: ref },
  ],
  source: { kind: 'plugin', plugin: 'dsh-computer-use' },
})]
const assembler = new BlockAssembler()
for await (const chunk of prepared.stream(deepFreeze({
  provider: prepared.config.provider,
  model: prepared.config.model,
  messages,
  system: visionSystemPrompt,
  maxTokens: config.visionMaxOutputTokens,
  signal,
}))) assembler.push(chunk)
// 检查 assembler.finish 后解析 blocks() 中的 JSON 指令
```

## 自查 2：DSH 对 MCP 协议的原生支持

**结论：DSH 内置 MCP Client（`@deepseek-ai/dsh-mcp-client`），可在
cordis.patch.yml 中原生挂载 stdio MCP Server；但原生挂载不满足本插件的安全
架构，因此本插件自建 MCP Client——线缆协议仍是标准 MCP JSON-RPC 2.0。**

### 2.1 内置能力（若选择原生挂载的写法）

`packages/mcp/mcp-client/README.md:34-53` 给出原生挂载形态：

```yaml
- id: mcp-cu
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: cu
    transport: stdio
    command: dsh-cu-server
    args: []
```

工具以 `mcp__cu__<tool>` 名注册进 `ctx.tools`；stdio 子进程环境经
`scrubbedParentEnv()` 清洗（`packages/mcp/mcp-client/src/transport.ts:21-23`）；
自带重连、工具代同步、超时配置（README:55-66）。

### 2.2 为什么不采用原生挂载

1. **安全层被绕过**：原生挂载把 Python Server 的工具直接暴露给模型，
   本插件的分级授权（ctx.approval）、审计日志、熔断、危险内容拦截、
   ObservationId 新鲜度校验都无从介入。
2. **进程生命周期不归 ctx.subprocess**：`dsh-mcp-client` 的 stdio 传输用
   MCP SDK 的 `StdioClientTransport` 自行 spawn
   （`packages/mcp/mcp-client/src/transport.ts:31-40`，README:133
   「The MCP SDK owns the actual spawn」），与提示词第七节
   「禁止直接/间接使用 child_process，必须使用 ctx.subprocess」冲突。
3. **工具形态不符**：提示词第九节要求自定义工具名、`basedOnObservationId`
   参数与 UI render intent，原生桥接的 `mcp__*` 工具无法定制。

### 2.3 采纳方案：自建 Client + 标准 MCP 线缆协议

- 复用官方 `@modelcontextprotocol/sdk`（harness 钉住 `^1.12.0`，
  `packages/mcp/mcp-client/package.json:45`）的 `Client` 与协议类型，
  避免手写 JSON-RPC 分帧/校验（符合仓库「优先维护中的依赖」纪律）。
- 传输层自实现 `Transport` 接口：写入 `ctx.subprocess.spawn()` 句柄的
  `stdin`、读取其 `stdout`（换行分隔 JSON）。进程生命周期（spawn/terminate/
  waitForExit/健康检查/清理）全部归 `ctx.subprocess`。
- 每次 `tools/call` 前在 Node 侧编织安全层；Python 端保持「标准 MCP Server」
  身份（initialize 响应携带版本号用于握手校验）。

## 自查 3：cordis.patch.yml 的编写规范

**结论：外部插件与内置 bundle 的 patch 在 schema 上无差别；外部包的行以
npm 包名引用自身模块。完整模板见本仓库根目录 `cordis.patch.yml`。**

### 3.1 Schema（实证自 `packages/bundle/base/cordis.patch.yml` 与
`packages/bundle/web-app/cordis.patch.yml`）

顶层是 YAML 数组，条目三种形态：

1. `- insert:` + 行列表——新增行。行字段：`id`（稳定标识）、`name`
   （包名或 `包名/子路径`）、可选 `inject: [services]`、可选 `config: {}`、
   可选 `disabled`。
2. `- id: <已存在行的 id>` + `config:` ——覆盖既有行；**config 整体替换，
   不是深合并**，必须重述该行需要的全部键（`docs/user/develop/basic/publish.md:123-127`）。
3. `- id: <行 id>` + `disabled: true|false` ——启停既有行。

config 值支持 `!!js` 表达式，在 Loader 注入上下文中求值：可用 `process.env.*`、
`ctx.<已注入服务>.*`、`dshHomePath('...')`（`packages/boot/app-boot/src/index.ts:785`
在 boot 根提供 `dshHomePath`；base 用例行：`packages/bundle/base/cordis.patch.yml:113`）。

### 3.2 层叠顺序与外部插件解析

- 层序：profile 的 `dsh.profile.bundles` 逐个（`@deepseek-ai/dsh-base` 最先，
  其后按安装顺序），然后 profile 自身 `cordis.patch.yml`，再 `$DSH_HOME/cordis.patch.yml`，
  最后 `--patch` 覆盖层（`docs/user/develop/basic/publish.md:114-122`）。
- 本插件安装在 `dsh-web-app` 之后，因此可以按 id 覆盖 base/web-app 的行；
  用户也可以在其 profile 层覆盖本插件的行——所以把「用户大概率保留的取值」
  写进 patch，其余放 schema 默认值（`publish.md:126`）。
- 模块解析：in-box 包名从 dsh 安装自身解析；外部包由 `dsh plugin add`
  经 pnpm 安装进 profile 目录（`publish.md:128`、`:77-101`）。
  dsh 启动时修复模块回退（module fallback），把 dsh 安装依赖闭包
  （**含 peerDependencies**）镜像进 `$DSH_HOME/profiles/node_modules` 与
  profile 目录（`packages/boot/app-boot/src/profile.ts:497-592`，
  `:508-511` 注释明确 Service Definition 包作为 peer 也会被镜像，
  供外部插件直接 import）。

### 3.3 依赖声明策略（重要工程结论）

- `@deepseek-ai/*` 一律声明为 **peerDependencies**（harness 自身包的惯例：
  「@deepseek-ai/cordis 是每个 harness 包的 peerDependency(+dev)」），
  运行时经模块回退解析到当前 dsh 安装的副本，保证与宿主同版本、
  服务实例单一（`instanceof`/注册表共享正确）。
- 注意：**这些包的 npm 已发布版本（0.0.1-rc.1）远旧于本 fork（0.1.2-alpha.1）**，
  实测 `npm view @deepseek-ai/dsh-llm version` = `0.0.1-rc.1`。
  因此本机开发安装不能从 npm 拉取，`package.json` 携带 `pnpm.overrides`
  把 peer/dev 依赖 `link:` 到 `../deepseek-harness` 的源码目录（仅在本仓库
  作为根项目安装时生效，不影响消费者）。
- **// TODO: 需确认**——`link:` 安装形态下，插件入口经 Loader 以 profile 为
  parent URL 载入后，Node 对裸包名的解析基址是插件源码目录的 realpath；
  若 profile 的 `node_modules` 不在其解析路径上，则须在本仓库本地
  `pnpm install`（overrides 已备好）提供解析。Phase 3 安装验证时实测钉死。
- 第三方依赖 `@modelcontextprotocol/sdk` 声明为普通 `dependencies`，
  由 `dsh plugin add` 时 pnpm 安装（与 peer 不同，它不在 dsh 安装闭包中）。

### 3.4 本插件的 patch 模板

见根目录 `cordis.patch.yml`：单条 `insert`，行 id `computer-use`，
`name: dsh-computer-use`，config 携带视觉路由与全部部署可调参数
（与 `src/config.ts` 的 Schemastery schema 逐键对应）。

## 其他已核实的集成事实（供 Phase 2 直接引用）

- **ctx.subprocess**（`packages/subprocess/subprocess/src/index.ts:102-140`）：
  `spawn(spec)` 立即返回活句柄；spec 无默认值，必须显式给出
  `argv/cwd/stdio/graceMs`（`types.ts:75-104`）；句柄提供
  `stdin?: Writable`、`stdout?: Readable`、`done: Promise<SubprocessOutcome>`、
  `terminate()`（SIGTERM→grace→SIGKILL，Windows taskkill /T 树杀）、
  `waitForExit(signal?)`（`types.ts:159-194`）。`scrubbedParentEnv()`
  去掉 `KEY|PASSWORD|SECRET|TOKEN` 与 `DSH_*` 环境名（`index.ts:44-66`）。
- **ctx.approval**（`packages/interaction/user-approval/src/index.ts:222-241`）：
  `request(req)` 返回 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`；
  仅 `allowed-once` 是授权；无「记住授权」语义；**必须在开放 turn 内调用**
  （`index.ts:224-230`）；审计事件 `approval/asked`/`approval/decided` 自动入会话日志。
  自定义 Answerer = `ctx.on('approval/request', (req, next) => ...)` waterfall
  监听器（`packages/interaction/user-approval/src/types.ts:85-90`），
  返回结果认领请求，调用 `next()` 委托。
- **工具注册**（`docs/cookbook/adding-a-tool.md:9-38`、
  `packages/core/tools/src/index.ts:1036`）：`ctx.tools.register(defineTool({...}))`
  返回 disposer；注册即效果（fiber dispose 自动注销）；
  `execute(args, exec)` 中 `exec.signal` 必须尊重。
- **宿主平面工具对 web 会话可见**：`dsh-web-app` 把 agent 平面工具行在宿主层
  `disabled`，改由每个会话挂载的 agent preset 提供
  （`packages/bundle/web-app/cordis.patch.yml:364-494`）；宿主平面注册的工具
  进入全局层，对所有会话可见（本会话的 `cordis_*` 工具即宿主层先例）。
  本插件的 `computer-use` 行属于宿主平面（进程级能力，类似 shell）。
- **平台守卫**：Linux/无头环境在 `apply` 阶段显式抛错拒绝加载（提示词第十一节）。

## Phase 2 实现结论与实测发现（2026 年，第 2 阶段）

### P2-1：严格类型检查通过（真实链接，非猜测）

`pnpm install` 借 `pnpm.overrides` 的 `link:` 把 11 个 `@deepseek-ai/*`
peer 全部链到 `../deepseek-harness` 源码目录后，`npx tsc --noEmit`
（strict 全开）零错误。期间钉死的三个真实契约：

1. **工具 schema DSL 没有 `required: [...]` 数组形态**——必填性在每个属性上
   用 `required: true` 表达（`packages/core/tools/src/schema.ts:96-106` 的
   `ParameterPropertySpec`）；输出对象节点必须声明 `additionalProperties`。
2. **Cordis `Service` 子类构造器是 `constructor(ctx)`**——服务名在
   Definition 层 `super(ctx, 'computerUse')` 钉死，Provider 子类只
   `super(ctx)`；`ApprovalService(ctx, config)` 的形态是同型先例。
3. **MCP SDK `client.callTool` 不带 resultSchema 时返回内容是无类型的**——
   Provider 用结构化局部形状 `McpToolResultShape` 读取
   `structuredContent`/首个 text 块，下游再逐一校验。

### P2-2：实测发现——本部署运行在 Windows 会话 0（关键部署约束）

本机 `dsh web` 以**后台服务形态**运行（`query session` 实测：本进程在
session 0「services/Disc」，交互桌面在 session 1「console/Active」）。
会话 0 进程对交互桌面是结构性不可达的，实测三连证：

- `EnumDisplayMonitors` 只报告 1024×768 回退虚拟屏（名为 `WinDisc`）；
- `PIL.ImageGrab.grab()` 抛 `OSError: screen grab failed`（BitBlt 无权抓交互桌面）；
- `GetForegroundWindow` 返回空（会话 0 无前台窗口）。

处置（已实现）：

- Python sidecar 启动即做交互会话断言（`core/display.py`
  `assert_interactive_session`，kernel32 `ProcessIdToSessionId` 对比
  `WTSGetActiveConsoleSessionId`），不匹配即拒绝启动并给出补救指引；
- Node 侧 MCP 握手失败时把 sidecar stderr 尾部并入错误消息，
  该拒绝会原样浮到第一次工具调用；
- **验收推论**：真实屏幕控制的功能验证（截图/点击/150% 缩放映射）必须在
  **交互会话里启动的 dsh 实例**上执行——例如在桌面终端里
  `pnpm dsh --profile web`（换端口）或 headless 跑一条任务；本会话
  （服务会话）只能验证协议面。
- 不做 CreateProcessAsUser 之类跨会话注入：权限升级面，超出插件边界。

### P2-3：stdio 冒烟实测（tests/dev-mcp-smoke.py，本会话内跑通协议面）

在会话 0 内已验证通过：initialize 握手（协议版本回显 + `serverInfo`
版本号）、`tools/list` 七工具面、ObservationId 未知/过期拒绝的明确错误、
`get_foreground_window` 形状、`ping`、干净退出（exit 0）。
截图与点击两条在会话 0 内被交互会话守卫拦在启动前——这是预期行为，
真实链路待 Phase 3 在交互会话中复跑同一脚本钉死。

### P2-4：审批分层的标记约定（插件内部契约）

`ctx.approval` 的请求只携带 `toolName/callId/reason`，Answerer 无法看到
参数。本插件约定在 `reason` 前缀嵌标记：`[dsh-computer-use tier=medium]`
可被会话级窗口/计数器自动放行；`[dsh-computer-use tier=high]` 一律
`next()` 委托交互 Answerer（无交互 Answerer 时按 approval 缝语义
fail-closed 为 unavailable）。两端都在本插件内，契约文档化于
`src/answerer.ts`。

## Phase 3 交付结论（打包、文档、测试与真实环境验证）

### P3-1：PyInstaller 打包脚本与产物

`scripts/build-python.py`（`pnpm run build:python`）：检测 PyInstaller（未装打印
`pip install pyinstaller` 指引）→ 校验 sidecar 运行时依赖（pyautogui/PIL）→
清理 `bin/` 旧产物与 `build/pyinstaller/` → `--onefile --console` 打包
（stdio MCP 协议必须保留 stdin/stdout，不能 `--windowed`）→ 打印产物路径、
大小与 SHA256。产物命名与 Node 侧 `platformTag()` 解析对齐：
`bin/dsh-cu-server-win-x64.exe`（Windows）/ `bin/dsh-cu-server-macos-<arch>`。

实测（PyInstaller 6.22.2，Python 3.10.6）：打包成功，产物 89.5 MiB，
SHA256 `caf54a3d4035f1384cf841b2186aac4c5167b9e3e84b7eee9dd07391dc04815c`。
对产物做了 stdio 冒烟（initialize 握手 + tools/list 七工具面 + ping +
干净退出 exit 0）——当前会话已运行在交互桌面（Session 1），交互会话守卫
放行，与部署状态一致。

### P3-2：单元测试与覆盖率

新增 `vitest.config.ts` 与 10 个 spec 文件（91 用例全绿，`npx tsc --noEmit`
零错误）。覆盖率（v8，分母限定为 definition/security/vision 三个可单测的
核心模块；provider-mcp 与工具注册属集成层，由冒烟脚本覆盖）：

- definition 100% / security 96.1% lines / vision 89.0% lines，总体 92.54%。
- 关键逻辑均有断言：dHash 汉明距离（含 64 位满距、对称性）、熔断器
  触发/释放/复位、危险正则默认集全量拦截与误报放行、ObservationId TTL
  过期（fake timers）与过期事件、审计日志串行追加/保留期清扫（日志行与
  截图归档）、视觉决策 JSON 校验全拒绝路径、审批 answerer 窗口/配额。

### P3-3：Phase 2 遗留的两个安全缺陷（本阶段修复）

1. **高危快捷键升级失效**（`src/tools/shared.ts`）：`normalizeHotkey` 排序
   后拼接，但 `HIGH_RISK_HOTKEYS` 存的是书写顺序——`win+r` 排序成 `r+win`
   后查不到，6 个系统快捷键里只有 `alt+f4` 能升级，其余落入 medium 被
   answerer 自动放行。修复：集合改为由按键数组经 `normalizeHotkey` 派生，
   与查询侧同构。新增 `tests/tools/shared.spec.ts` 覆盖全部 6 组合的
   任意顺序/大小写升级与超集不升级。
2. **审批配额可重置绕过**（`src/answerer.ts`）：配额耗尽时
   `states.delete(sessionId)` 后 `next()`，下一个 medium 请求会新建窗口
   重新自动放行，`autoApprovalMaxGrants` 上限形同虚设。修复：保留耗尽态
   直至窗口过期分支重置。新增 `tests/answerer.spec.ts` 断言耗尽后同窗口
   持续委托、跨会话独立、窗口过期后重新武装。

### P3-4：文档

`README.md` 五章节齐备（Purpose / Installation / Configuration / Known
Limitations / Model Experience）；Known Limitations 钉死 Windows Session 0
限制（后台服务无截屏/输入权限，必须前台桌面终端运行，禁止跨会话注入）、
macOS 主屏限制、Linux 拒绝加载、正则拦截非安全边界、单实例执行器、
二进制体积。配置章节给出完整 `cordis.patch.yml` 覆盖模板并强调四个视觉
路由字段默认空、未配置即拒绝激活。

### P3-5：真实环境验证（待用户在桌面执行）

步骤 A–D（安装、`--dump-config` 层叠确认、重启加载、Web UI 发起
Computer Use 任务观察 sidecar 拉起/真实鼠标动作/审计日志）已输出给用户，
等待反馈。
