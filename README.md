# dsh-external-instruct

让**任意外部应用或模型**通过本机 HTTP 给正在运行的 DeepSeek Harness（dsh）Web GUI 下达指令；
指令由 GUI **自己**创建成会话，所以会出现在左侧栏的工作区树下，和手工开的会话没有区别。

```
┌──────────────┐  POST /dsh-instruct/ask   ┌─────────────────────────────┐
│ 外部软件/AI   │ ────────────────────────► │ dsh Web GUI（同一进程）      │
│ 任何语言      │ ◄──────────────────────── │  external-instruct 插件      │
└──────────────┘  最终回答 / 事件 / 状态     │  → ctx.agents.create(...)    │
                                            │  → workspace.attachSession() │
                                            │  → 左侧栏出现一条会话         │
                                            └─────────────────────────────┘
```

## 为什么需要它

外部进程另起一个 dsh（`dsh --profile headless`、SDK、ACP）也能跑 agent，但那些会话属于**另一个进程**：
它们不会出现在你正在用的 GUI 左侧栏里（侧栏的 Workspace 树只认 GUI 自己的会话登记表）。
本插件把入口做进 GUI 进程内部，于是会话天生属于 GUI：有标题、进工作区、可续接、可搜索。

## 快速开始

### 1. 安装

把 `external-instruct.mjs` 放进你的 dsh profile 目录，然后在同一个目录的 `cordis.patch.yml`
（这是 profile 的用户覆盖层，一个 YAML 数组）末尾追加一项：

```yaml
- insert:
    - id: external-instruct
      name: 'C:\Users\You\.dsh\profiles\desktop\external-instruct.mjs'
```

要点：

- `name:` 是**相对 patch 文件所在目录**解析的路径（不是相对 profile 目录）；写成绝对路径最稳。
- `desktop` profile 由 Electron 应用独占，不能用 `dsh desktop` 从命令行启动；
  直接**重启应用**即可生效（profile 的 patch 是 `patchReload: startup`）。
- 也可以用 `dsh --profile web --patch <patch.yml>` 单次加载来验证。

### 2. 发一条指令

```powershell
curl.exe -s -X POST http://127.0.0.1:19387/dsh-instruct/ask `
  -H "content-type: application/json" `
  -d '{"text":"用一句话说明什么是 KV cache","workspacePath":"D:\\work\\my-project"}'
```

响应（默认阻塞到整轮结束）：

```json
{"ok":true,"sessionId":"ext-1f0c…","created":true,"software":null,
 "workspacePath":"D:\\work\\my-project","workspaceTitle":"my-project",
 "title":"外部指令 2026/10/14 03:20:11","finalResponse":"……","finishReason":"completed"}
```

## HTTP 契约

所有路由**仅接受回路请求**：socket 地址（127/8、::1、IPv4-mapped）+ `Host` 头 + 浏览器同源标记
三重围栏，非回路一律 `403`。（这套围栏与官方 `dsh-webhook`、`@linxin666/dsh-pet` 同源。）

### `GET /dsh-instruct/health`

```json
{"ok":true,"instance":"external-instruct","routes":["/dsh-instruct/ask","/dsh-instruct/session","/dsh-instruct/sessions"],
 "distinguishes":{"titleTag":"[<software>] <title>","sessionIdPrefix":"<software-slug>-<uuid>", "...":"..."},
 "continuation":{"how":"POST /ask 带上已有 sessionId 即续发到该会话","discover":"GET /dsh-instruct/sessions"}}
```

### `POST /dsh-instruct/ask`

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | ✅ | 提示词正文 |
| `workspacePath` | ✅ | 绝对路径；**不存在时会自动创建目录**并登记为工作区 |
| `sessionId` | | 带上则**续发**到该会话；命中不到则用它作为新会话的 id |
| `software` | | 调用方标识：进 sessionId 前缀（slug）、标题标签 `[GPT]`、消息 `source.software` |
| `title` | | 会话标题；省略则 `外部指令 <本地时间>` |
| `agentPreset` | | 默认 `standard`（仅新建时生效） |
| `permissionPreset` | | 默认 `workspace-write`（仅新建时生效） |
| `provider` / `model` | | 默认沿用 GUI 当前的模型选择 |
| `wait` | | 默认 `true`（等整轮结束）；`false` 立即返回 `202` |
| `timeoutMs` | | `wait:true` 时的等待上限，默认 30 分钟 |

响应字段：`sessionId`、**`created`**（`true` 新建 / `false` 续发）、`software`、`workspacePath`、
`workspaceTitle`、`title`、`finalResponse`、`finishReason`。

### `GET /dsh-instruct/session?sessionId=…`

```json
{"ok":true,"sessionId":"ext-…","live":true,"settled":true,"software":"GPT",
 "workspacePath":"…","workspaceTitle":"…","finalResponse":"…","finishReason":"completed"}
```

`live` 表示该会话仍在进程内、可以续发。**只跟踪插件进程内见过的会话**（重启后清空）；权威列表永远是 GUI 左侧栏。

### `GET /dsh-instruct/sessions`

列出进程内跟踪过的会话（`software` / 工作区归属 / `live` / `settled` / 最后回复片段），
供外部程序发现"哪条可以续发"。

## 新会话 vs 续发已有会话

| 意图 | 请求 | 判据 |
|---|---|---|
| 开新会话 | **不带** `sessionId` | 响应 `"created": true` |
| 继续同一话题 | **带上**那个 `sessionId` | 响应 `"created": false` |

```powershell
$base = "http://127.0.0.1:19387/dsh-instruct/ask"
function Ask($body) {
  Invoke-RestMethod -Uri $base -Method Post -ContentType "application/json; charset=utf-8" `
    -Body ([System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json)))
}

$a = Ask @{ software="GPT"; workspacePath="D:\deepseek\gpt-sessions"
            text="记住代号 XK-7788，只回复：收到" }
$b = Ask @{ software="GPT"; workspacePath="D:\deepseek\gpt-sessions"
            sessionId=$a.sessionId; text="刚才的代号是什么？只回复代号" }
$b.finalResponse   # → XK-7788（上下文延续）
```

外部 AI 的决策逻辑就一句：**接着上一个话题且手里有 `sessionId` → 带上续发，否则不带、开新会话。**

## 让不同软件/模型互相可区分

| 层 | 机制 | 效果 |
|---|---|---|
| 1 | `software` → sessionId 前缀（slug 化） | 会话目录名可辨 |
| 2 | `software` → 标题标签 `[GPT] …` | 左侧栏一眼可辨 |
| 3 | `software` + `workspacePath` → 消息 `source` | 会话日志永久留痕、可检索 |
| 4 | **每个软件一个 `workspacePath`** | 侧栏按工作区分组，天然隔离（最强） |

建议每个软件一个目录：`D:\deepseek\gpt-sessions`、`D:\deepseek\<software>-sessions`。

> ⚠️ `workspacePath` 不存在时会被自动创建——拼错路径不会报错，只会静默多出一个空工作区。

## 关于卡片外观

外部指令在对话里显示为「通知卡」（标题、说明、用时），这些**文案是 dsh 内建**的，
由消息 `source.kind` 决定：官方 UI 只认识 `goal / agent-message / team-message / subagent-settled /
webhook / schedule / tool-jobs / cordis-host-runner`，其余一律落到默认标题「收到执行请求」。
本插件有意使用自定义 `kind: external-instruct`，以便在会话日志里和 GitHub webhook 等来源区分开。

## 安全模型

- **仅回路**：非 127/8、::1、IPv4-mapped 的 socket 一律拒绝；`Host` 头必须回路；
  `Sec-Fetch-Site: cross-site` 拒绝；带 `Origin` 时必须与 `Host` 完全同源。不信任 `X-Forwarded-For`。
- **请求体上限 64 KiB**。
- 能访问回环端口的本机进程即可下达指令——因此**任何本机程序都等价于一个能驱动 agent 的用户**。
  这是设计取舍：入口与 GUI 同权限，不做额外鉴权。需要跨机访问请自行加反向代理与认证，
  并注意插件本身只监听 GUI 已有的回环端口。
- 指令以**普通用户消息**投递，因此仍受会话的权限预设、沙箱与审批策略约束。

## 兼容性

在 dsh `0.2.0-rc.2`（Windows 桌面版）上开发与实测。插件只通过 `ctx` 使用宿主服务，
**不 import 任何 `@deepseek-ai/*` 运行时包**，只依赖两个 Node 内置模块，因此没有 npm 依赖树。

用到的宿主服务（全部通过 `inject` 声明，缺失即加载失败、不会半挂载）：
`webServer`、`agents`、`agentDefaultModel`、`agentPresets`、`permissionPresets`、
`sessionTitle`、`workspaceRegistry`、`sessions`。

## 已知限制

- 会话**只能新建或续发**，没有"删除会话"等管理能力。
- 本插件的 `/session`、`/sessions` 只反映**进程内**记忆，重启即清空。
- 非回路（跨机）访问不支持；没有内置鉴权与 TLS。
- 续发面向**活会话**；已不在进程内的冷会话不会被本插件恢复（那是 session controller 的职责）。

## License

MIT
