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

## Phase 4 交付结论（P0 安全加固、日志可见性、文档）

### P4-1：接管热键 + 用户输入即暂停（任务 1）

**状态机归属：sidecar 是唯一事实源。** 暂停判定依赖桌面物理输入
（`GetAsyncKeyState` 轮询），只能在 Python 侧实现；Node 侧只保存镜像。
`core/pause.py` 的 `PauseState` 是与平台无关的纯状态机（可单测），
监控线程 `start_monitor` 是 Windows-only 纯 ctypes（无新依赖）。

关键决策：

1. **暂停态推送走自定义 MCP 通知** `notifications/dsh-cu/pause-state`。
   Node 侧在自己实现的 `SidecarTransport` 解析循环里按方法前缀拦截，
   不进 MCP SDK——避免为 SDK 的 zod 通知 schema 注册引入依赖；线缆仍是
   标准 JSON-RPC notification。stdout 写出在 sidecar 内加锁（通知来自
   监控线程，响应来自 stdin 循环）。
2. **"在途"窗口 = 动作工具分发开始→结束**，用 `begin_action`/`end_action`
   计数包住物理执行；`userInputGraceMs`（默认 250ms）是动作结束后的检测
   宽限，吸收 sidecar 自身合成输入的迟到事件。未匹配的 `end_action` 是
   no-op（不会把计数打成负数，也不会凭空启动宽限）。
3. **首次轮询冲刷** `GetAsyncKeyState` 低位的"自上次调用以来按下"锁存，
   否则进程启动前的按键会被误判为用户输入。
4. **崩溃不得静默解除暂停**：Node 镜像在重连后调用新增的 `pause_actions`
   内部工具重新挂起；失败即拆掉新 sidecar（fail closed）。`resume_actions`
   是模型可见工具，`pause_actions` 仅 Node 内部使用。
5. **接管组合本身升级为高危**（`isSameHotkey` 复用 `normalizeHotkey`）：
   模型不得在无交互确认的情况下切换暂停态。
6. 监控线程在按住接管组合期间跳过用户输入检测——否则"按热键恢复"的
   同一轮询里组合键本身会被当作用户输入立即重新暂停。

**新记录的设计张力（只记录不修）**：高危动作的审批等待不属于在途窗口，
用户移动鼠标去点"允许"即触发暂停，批准后的动作会以暂停错误被拒——
恢复路径是再按热键或 `resume_actions`。已写入 README Known Limitations。

### P4-2：敏感场景不截屏（任务 2）

**标题检查先于一切像素操作**：`screen_shot` 分发第一步取前台窗口标题
（`GetForegroundWindow` + `GetWindowTextW`），命中即抛
`SensitiveWindowError`，不落盘、不 persist、不发模型。错误消息 = 标记
`[dsh-cu-sensitive-window]` + JSON 事实载荷（`windowTitle`/`pattern`），
Node 侧 `parseSensitiveWindowFacts` 解析成类型化错误
`SensitiveWindowRefusal`，`screen_shot` 工具据此写
`danger/sensitive-window` 审计行（可记录标题，绝不记录屏内容）。

- 允许名单 `sensitiveWindowAllowlist` 优先于封禁名单（显式豁免语义）。
- Node 侧 `SensitiveWindowPolicy` 是参考语义 + 挂载期校验器：非法正则在
  `apply` 即抛（自包含配置在加载时 fail loud），运行期强制执行在 sidecar。
- **macOS 无纯 ctypes 的窗口标题 API**：`foreground_window_title()` 返回
  None，检查整体跳过（fail-open）——已写入 Known Limitations；不为此引入
  pyobjc（违反"不引入新依赖"约束）。
- OCR 级密码框检测为未来工作，写入 Known Limitations。

### P4-3：lifecycle 审计事件（任务 3）

`Auditor` 接口新增 `recordLifecycle`/`recordSensitiveWindow`，
`lifecycle/*` 行与既有 `action/*`、`danger/*` 同文件同格式。七种事件：
`mounted`（platform + 路由）、`routes-missing`（激活拒绝时，先审计后抛）、
`sidecar-starting`（mode + 描述）、`sidecar-connected`（版本）、
`sidecar-exited`（exitCode/signal/触发方）、`paused`/`resumed`（触发方）。

实现要点：

- **退出归因**：`exitTrigger` 字段（`shutdown`/`restart`/`crash`，默认
  crash 读数），dispose 与健康重启在 terminate 前置位；`apply` 内
  `createAuditor` 提前到路由检查之前，使 `routes-missing` 可审计。
- **dispose 重排**：原实现在 `waitForExit` 前清掉 `this.handle`，done
  处理器的归属检查（`this.handle === handle`）永远失配；现在保留到退出
  被记录后才清。
- `ctx.logger` 调用全部保留（双写）；未引入 console exporter。

### P4-4：工程契约补充

- **`ctx.plugin` 只转发单个 config 实参**（cordis `GetPluginConfig` 取
  构造器第一参数），带第三参的调用类型检查不过。Provider 改为在 `apply`
  内直接构造（`new McpComputerUseProvider(ctx, config, auditor)`）——
  Service 构造器自注册并随属主 fiber 卸载，与 Phase 2 记录的
  `ApprovalService(ctx, config)` 先例同形。
- sidecar 版本升至 0.1.1（新增 `resume_actions`/`pause_actions` 工具面 +
  暂停通知）；兼容前缀仍是 `0.1.*`。

### P4-5：验证结果（2026-08-31）

- `npx tsc --noEmit` 零错误；`vitest run --coverage` 114/114 全绿：
  definition 100% / security 97.1% lines / vision 89.0% lines，
  总体 lines 93.61%（均 >80%）。
- `python -m unittest discover -s tests/python` 19/19（暂停状态机
  pause/resume/in-flight/宽限、热键 VK 解析、敏感窗口匹配与标记载荷）。
- `tests/dev-mcp-smoke.py`（源码模式，交互会话）：暂停回路（拒绝带
  `[dsh-cu-paused]` 标记）、暂停期间截图可用、恢复、通知推送
  `[paused=True, paused=False]`、中心点击映射全部通过。
- PyInstaller 产物重建：89.5 MiB，SHA256
  `effd0cd77d71fd283ab2b7be5d247347fbbaf97cd92db13ad62d641ad61619f2`；
  对产物复跑协议冒烟（版本 0.1.1、九工具面、暂停回路、通知）通过。

## Phase 4.1 交付结论（真实环境缺陷修复，2026-08-31）

真实环境验证（步骤 1-5）发现三处缺陷，证据均在
`C:\Users\luoguangyu\.dsh\logs\dsh-cu-audit.log`：`lifecycle/mounted` 全日志
0 条（D1），`sidecar-connected` 后 319ms 即误报 `paused(user-input)` 且当时
无任何用户输入（D2），Node/Python 版本不齐（D3）。单一提交修复
D1+D2+D3；D4 只记录。

### P4.1-1：审计 sweep 串行化（D1）

**根因**：`createAuditor` 的启动保留期清扫独立于 `AuditLog` 串行追加队列
异步执行（readFile→filter→writeFile）；`apply()` 在清扫读取文件之后追加的
`mounted` 行被清扫的 `writeFile` 整体覆盖。

**修复**：`AuditLog` 新增 `compact(keep)`——把整文件重写排进同一条串行队列
（返回 Promise，调用方可等待落盘）；清扫更名 `runRetentionSweep` 并经
`log.compact` 执行；`Auditor` 接口新增 `sweepRetention(): Promise<void>`
（可触发并等待的操作入口，回归测试也用它）。不变式：**sweep 之前入队的追加
进入重写后的内容，之后入队的原样落盘**——两种时序下挂载期行都不可能丢。

回归测试（确定性、无 sleep）：预置一条过期行 → mount → 立即追加新行 →
`await auditor.sweepRetention()` → 断言仅剩新行、过期行被清理。

### P4.1-2：暂停监控启动误报（D2，阻断级）

**根因**：监控线程启动后立即开始检测；`GetAsyncKeyState`「自上次调用以来
按下」的低位锁存与启动最初几帧的光标位移可能被启动前输入污染（例如提交
任务的那次按键），单次全量冲刷不足以防御，实测启动 319ms 即误报
`paused(user-input)`，阻断全部四个动作工具。

**修复**：

1. 检测判定抽成纯可测单元 `MonitorState`（`arm(cursor)` / `feed(...)`），
   ctypes 只留在轮询循环里；决策逻辑注入假时钟全确定性单测（无 sleep）。
2. arming 前对每个被监控键（热键 VK ∪ 键盘扫描区 0x08..0xFE）各调一次
   `GetAsyncKeyState` 清除低位锁存；光标基线在 `arm` 之前建立。
3. **启动 grace 窗口**：Config 新增 `monitorStartupGraceMs`（默认 500），
   经 `DSH_CU_MONITOR_STARTUP_GRACE_MS` 传到 sidecar；窗口内丢弃一切检测
   （含热键切换），但边缘状态（组合键按住、光标位置）持续更新——跨窗口
   持续的状态不会在窗口结束瞬间误触发。

既有语义保持：在途窗口与动作后宽限豁免、grace 后用户输入即暂停、热键切换
暂停/恢复。新增 12 个 `MonitorState` 测试：陈旧锁存不暂停、grace 内不暂停、
grace 后移动/按键暂停、在途豁免、热键边缘触发等。

### P4.1-3：版本对齐（D3）

Node 侧 `package.json` 0.1.0→0.1.1；provider 的 MCP 客户端身份版本提为
常量 `PLUGIN_VERSION = '0.1.1'`，注释标明与 `package.json` 及
`src-python/main.py` `VERSION` 的两处同步点；Python 侧 `VERSION` 加同向注释。

### P4.1-4：只记录（D4）

- 接管热键为 50ms 轮询检测，合成按键需按住 ≥100ms 才能可靠命中
  （README Known Limitations 新增）。
- 设计说明：pause-on-user-input 视任何真实 OS 输入（含自动化输入）为用户
  输入；自动化验证须提交后零输入被动观察（README Known Limitations 新增）。
- 热键轮询漏掉短暂合成按键的问题本身不在本次修复范围。

### P4.1-5：验证结果

- `npx tsc --noEmit` 零错误；`vitest run` 115/115（114 旧 + 1 D1 回归）；
  `python -m unittest discover -s tests/python` 31/31（19 旧 + 12 新）。
- PyInstaller 重建（构建前终止了两个占用二进制的在运行 sidecar 进程——
  部署的 `dsh web` 子进程，provider 会在下次调用时自动重拉）：
  89.5 MiB，SHA256
  `33a3bc1d6bcf83af9ec3b8171ae57ee62a0f96637010e3a8521b02db99fb377b`。
- 对产物冒烟：版本 0.1.1、九工具面、监控启动日志出现
  `startup grace 500ms`、干净退出（exit 0）。

## Phase 4.2 交付结论（审批接线真正生效，纯插件侧，2026-08-31）

背景：第三轮真实环境验证确认回归 4（click_at 链路）被三层预存缺陷阻断，均非
Phase 4 引入——

1. Web UI 新会话默认 Full access，会话 `approval/policy=never`；
2. 宿主 `user-approval` 的 `decide()` 在分发 `approval/request` waterfall
   **之前**对 never 确定性拒绝（返回 `'rejected'`，源码见上游
   `packages/interaction/user-approval/src/index.ts` 的 never 分支）；
3. ask 下宿主交互式 answerer 排在插件 answerer 之前，轮不到插件
   （第一轮 allowed-once 是真人点击的）。

结论：`ctx.on('approval/request')` 上的 `registerAnswerer` 是死代码，
无人值守下任何审批模式 click_at 都不通（never 秒拒、ask 等人）。修复必须
纯插件侧，绕开宿主 waterfall。

### P4.2-1：前置决策取代 waterfall 接线

把 answerer 状态机从 waterfall 监听抽成可直接调用的
`consultAnswerer(config, sessionId, tier) => 'auto' | 'delegate'`：
复用原窗口/配额逻辑（`autoApprovalWindowMs` / `autoApprovalMaxGrants`），
high 永远 `delegate`；配额耗尽后窗口内保持耗尽（不重置，防绕过上限）；
窗口过期重新武装；`RiskTier` 移入 answerer.ts，shared.ts 转为再导出。
`index.ts` 移除 `registerAnswerer` waterfall 接线（宿主结构上不会咨询到
它，注册即死代码）。

### P4.2-2：requestApproval 前置放行 + never 模式 fail-closed

`shared.ts requestApproval`（签名新增 `deps`，四个工具调用点同步更新）：

- `tier==='medium'` 且 `consultAnswerer` 返回 `'auto'` → 直接放行，不调
  `ctx.approval.request`；Auditor 新增 `recordAutoApproval` 写审计行
  `answer/auto-allowed`（timestamp/sessionId/toolName/tier），自动放行留痕。
- 其余（high、medium 配额耗尽）→ 照旧走 `ctx.approval.request`：ask 会话由
  宿主交互式审批；never 会话宿主确定性拒绝。`rejected` 与 `unavailable`
  统一抛出带指引的清晰错误（需交互审批 + 实际 tier + never-approval/
  Full access 成因 + 切 Workspace Write 重试），替代旧版误导性的
  "was rejected by the user"；`cancelled` 保持独立错误。
- 升级路径的 reason 仍带 `[dsh-computer-use tier=…]` 标记，宿主侧审批日志
  （`approval/asked` + `approval/decided`）继续留痕。

### P4.2-3：文档与描述对齐

README：Purpose / Configuration 注释 / Key facts 增补审批语义（前置决策、
`answer/auto-allowed` 审计行、Full access 下 high fail-closed 属设计使然）；
Known Limitations 移除已被本修复消灭的"waterfall 注册顺序可被远端审批桥
遮蔽"，新增 never 会话限制；审计清单补入自动放行行；Model Experience 同步。
hotkey 工具描述改为 "always require interactive confirmation and are refused
outright in never-approval sessions"（与 fail-closed 行为一致）。

### P4.2-4：只记录（D5）

pause-on-user-input 把 agent 带外自动化（模型不经 computer-use 工具、自调
PowerShell UIAutomation 之类驱动 UI）产生的真实 OS 输入误判为用户接管，
触发 `paused(user-input)`。检测面在 OS 输入事件层，原理上无法区分输入来源；
README Known Limitations 已补明该情形。本轮不修。

### P4.2-5：验证结果

- `npx tsc --noEmit` 零错误；`vitest run` 122/122（净增 7：旧
  registerAnswerer 瀑布测试 6 个改写为 consultAnswerer 5 个，新增
  requestApproval 7 个、auditor recordAutoApproval 1 个）。
- 覆盖率（definition/security/vision 分母）：语句 92.41%、行 93.4%、
  分支 80.76%，均 >80%。
- 真实环境验证（待执行）：重启后无人值守 Full access 会话提交截图 +
  click_at 计算器 3+5= 任务，预期审计出现 click_at action/before+after、
  无 rejected；再提交 high 操作（hotkey win+r），预期 never 模式清晰错误。
