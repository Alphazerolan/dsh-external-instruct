# dsh-external-instruct

Let **any external app or model** hand instructions to a running DeepSeek Harness (dsh) Web GUI over
loopback HTTP. The instruction is turned into a session **by the GUI process itself**, so it shows up
in the left sidebar's workspace tree exactly like a session you opened by hand.

```
┌──────────────┐  POST /dsh-instruct/ask   ┌─────────────────────────────┐
│ external app │ ────────────────────────► │ dsh Web GUI (same process)  │
│ any language │ ◄──────────────────────── │  external-instruct plugin    │
└──────────────┘  answer / events / state  │  → ctx.agents.create(...)    │
                                           │  → workspace.attachSession() │
                                           │  → appears in the sidebar     │
                                           └─────────────────────────────┘
```

## Why this exists

Spawning a separate dsh (`--profile headless`, the SDK, ACP) also runs an agent, but those sessions
belong to *another process*: they do **not** appear in the sidebar of the GUI you are using, because
the sidebar's workspace tree is rendered from the GUI's own session registry.

This plugin puts the entry point *inside* the GUI process, so sessions are native to the GUI:
they get a title, join a workspace, can be continued, and are searchable.

## Quick start

### 1. Install

Drop `external-instruct.mjs` into your dsh profile directory and append one entry to that directory's
`cordis.patch.yml` (the profile's user layer — a YAML array):

```yaml
- insert:
    - id: external-instruct
      name: 'C:\Users\You\.dsh\profiles\desktop\external-instruct.mjs'
```

- `name:` resolves **relative to the patch file's own directory** (not the profile directory);
  an absolute path is the safest form.
- The `desktop` profile is owned by the Electron app and cannot be started from the CLI;
  **restart the app** to load the change (profile patches are `patchReload: startup`).
- To try it without touching your profile: `dsh --profile web --patch <patch.yml>`.

### 2. Send an instruction

```bash
curl -s -X POST http://127.0.0.1:19387/dsh-instruct/ask \
  -H "content-type: application/json" \
  -d '{"text":"Explain KV cache in one sentence","workspacePath":"/home/you/project"}'
```

```json
{"ok":true,"sessionId":"ext-1f0c…","created":true,"software":null,
 "workspacePath":"/home/you/project","workspaceTitle":"project",
 "title":"外部指令 2026/10/14 03:20:11","finalResponse":"…","finishReason":"completed"}
```

## HTTP contract

Every route is **loopback-only**: socket address (127/8, ::1, IPv4-mapped) + `Host` header +
browser same-origin markers, else `403`. (Same fence semantics as the official `dsh-webhook`
and `@linxin666/dsh-pet`.)

| Route | Purpose |
|---|---|
| `GET /dsh-instruct/health` | Liveness + capability/continuation hints |
| `POST /dsh-instruct/ask` | Submit an instruction (new session, or continue an existing one) |
| `GET /dsh-instruct/session?sessionId=…` | Inspect one tracked session (`live`, `settled`, answer) |
| `GET /dsh-instruct/sessions` | List tracked sessions, to discover what can be continued |

### `POST /dsh-instruct/ask`

| Field | Required | Meaning |
|---|---|---|
| `text` | ✅ | Prompt body |
| `workspacePath` | ✅ | Absolute path; **created if missing** and registered as a workspace |
| `sessionId` | | Continue that session; if not live, it becomes the new session's id |
| `software` | | Caller identity: sessionId prefix (slug), title tag `[GPT]`, message `source.software` |
| `title` | | Session title; defaults to `外部指令 <local time>` |
| `agentPreset` | | Default `standard` (new sessions only) |
| `permissionPreset` | | Default `workspace-write` (new sessions only) |
| `provider` / `model` | | Default to the GUI's current model selection |
| `wait` | | `true` (default) waits for the whole turn; `false` returns `202` immediately |
| `timeoutMs` | | Wait bound when `wait:true`; default 30 minutes |

Response: `sessionId`, **`created`** (`true` new / `false` continued), `software`, `workspacePath`,
`workspaceTitle`, `title`, `finalResponse`, `finishReason`.

## New session vs. continuing one

| Intent | Request | Signal |
|---|---|---|
| Start a new session | **omit** `sessionId` | `"created": true` |
| Continue the same topic | **pass** that `sessionId` | `"created": false` |

An external AI's decision rule is one line: *continuing the previous topic and I hold a `sessionId`
→ pass it; otherwise omit it and remember the returned id.*

## Distinguishing callers

| Layer | Mechanism | Effect |
|---|---|---|
| 1 | `software` → sessionId prefix (slugged) | Session directory is self-describing |
| 2 | `software` → title tag `[GPT] …` | Visible at a glance in the sidebar |
| 3 | `software` + `workspacePath` → message `source` | Permanent, searchable in the session log |
| 4 | **one `workspacePath` per software** | Grouped per workspace in the sidebar (strongest) |

> ⚠️ A missing `workspacePath` is auto-created: a typo silently produces an extra empty workspace.

## About the notice card

External instructions render as a "notice card" (title, explanation, elapsed time). Those strings are
**built into dsh** and chosen by the message's `source.kind`: the official UI recognizes
`goal / agent-message / team-message / subagent-settled / webhook / schedule / tool-jobs /
cordis-host-runner`, and anything else falls back to the default title ("收到执行请求"). This plugin
deliberately uses its own `kind: external-instruct` so that external calls stay distinguishable from
GitHub webhook events and the like in session logs.

## Security model

- **Loopback only** — non-loopback sockets are refused; `Host` must be loopback;
  `Sec-Fetch-Site: cross-site` is refused; when `Origin` is present it must match `Host` exactly.
  `X-Forwarded-For` is never trusted.
- Request bodies are capped at 64 KiB.
- Any local process that can reach the loopback port can drive the agent — that is the design
  trade-off: the endpoint shares the GUI's trust level and adds no authentication of its own.
  For cross-machine access, put a reverse proxy with authentication in front; the plugin itself
  only listens on the GUI's existing loopback port.
- Instructions are delivered as ordinary user messages, so session permission presets, sandboxing,
  and approval policies still apply.

## Compatibility

Developed and verified against dsh `0.2.0-rc.2` (Windows desktop). The plugin reaches host services
only through `ctx` and imports **no `@deepseek-ai/*` runtime package** — just two Node built-ins —
so it has no npm dependency tree.

Injected host services (declared in `inject`, so a missing one fails the load rather than
half-mounting): `webServer`, `agents`, `agentDefaultModel`, `agentPresets`, `permissionPresets`,
`sessionTitle`, `workspaceRegistry`, `sessions`.

## Known limitations

- Sessions can only be created or continued; no session management (delete/rename) here.
- `/session` and `/sessions` reflect **in-process** memory only and reset on restart.
- No cross-machine access, no built-in auth or TLS.
- Continuation targets live sessions; cold sessions from a previous process are not resumed
  (that is the session controller's job).

## License

MIT
