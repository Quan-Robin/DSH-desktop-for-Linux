# dsh-plugin-desktop

DSH-desktop-for-Linux 的**官方伴生插件**（独立发布，`dsh-plugin` 话题）。

**定位：大部分桌面端功能 + 小部分插件功能。** 原版桌面端保持极简；安装此插件才解锁增强功能。运行在 dsh 服务进程内，一方面把桌面端需要的内部状态以稳定 HTTP 端点暴露出来（替代桌面端过去的 hack），另一方面往 Web UI 注入增强的页内右键菜单与「置顶会话」扩展。

| 桌面端旧做法 | 插件做法 |
|---|---|
| 嗅探 `webRequest` 的 `/api/session.*` POST body 判断当前会话 | `GET /api/state` 直接给出 |
| 解压 `~/.dsh/sessions/**/session.jsonl.zstd` 估算用量 | `GET /api/usage` 给出事件流实时聚合 |
| （无） | 页内完整右键菜单（会话/工作区/正文/链接/输入框）+「置顶会话」扩展（client 注入） |

## 端点

- `GET /api/state` → `{ plugin, since, currentSessionId, turn: 'working'|'idle', lastTurnEndSeq, lastSummary }`
- `GET /api/usage` → `{ plugin, since, complete: false, byModel, sessions: [{ id, byModel, userMsgByModel, lastTurnEndSeq, lastSummary, updatedAt }] }`
  - `complete: false`：仅覆盖插件加载后的事件（dsh 重启后归零）。桌面端用它做当前会话的实时数据，历史总量仍走本地文件扫描（有 mtime+size 缓存，增量代价很小）。
- `POST /api/prompt` `{ sessionId?, text }` → 全局快捷输入的发送通道；`sessionId` 缺省用当前会话。
- `POST /api/set-session` `{ sessionId }` → 桌面壳在用户在 Web UI 中切换会话时调用，让 `/api/state` 的 `currentSessionId` 始终跟随用户实际查看的会话（DS-pet 依赖此接口）。

## 实机验证（2026-08-17）

在真实 dsh + 桌面 Electron 环境中验证了 `POST /api/set-session` 的端到端链路：

1. 创建两个会话，`/api/state` 因 `session/created` 事件暂时指向新会话；
2. 在主页面（webContents 内）发起 `fetch('/api/session.history', { method: 'POST', body: JSON.stringify({ payload: { sessionId } }) })`，模拟用户在 Web UI 中打开某个会话；
3. 桌面壳的 `webRequest` 嗅探捕获该请求并调用 `POST /api/set-session`；
4. 随后 `GET /api/state` 的 `currentSessionId` 双向切换正确（`session-f30a986a-…` ↔ `session-611cc60e-…`）。

该链路证明：即使插件可用（`pluginAvailable=true`），桌面端也会持续嗅探 `/api/session.*` 并同步 UI 导航导致的当前会话变化，DS-pet 轮询到的 `currentSessionId` 与实际查看的会话一致。

事件语义与桌面端 `src/usage-parse.js` 完全一致（`request/header` 记模型、`user/message` 开新一轮、`turn/end` 收尾、用量只取 `assistant/chunk`），保证两条路径数字一致。

## 安装

**方式一（推荐，独立发布）**：

```bash
dsh plugin add github:Quan-Robin/dsh-plugin-desktop
```

**方式二（桌面端内置）**：DSH-desktop-for-Linux 托盘/设置页「安装伴生插件」一键安装（从应用内拷贝 + patch 注册）。

手动亦可：把本目录拷贝到 `$DSH_HOME/profiles/web/node_modules/dsh-plugin-desktop/`，并在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-plugin-desktop
      name: dsh-plugin-desktop
      inject:
        - webServer
        - apiProxy
```

然后重启 dsh 服务。手动验证：`curl http://127.0.0.1:3080/api/state`。

## 页内增强（client 注入，随插件加载）

安装后 dsh Web UI 自动获得：

- **完整右键菜单**：会话 / 工作区 / 正文编辑 / 链接 / 输入框，各场景对应操作；检测到社区 @baihejiangnan/dsh-session-context-menu 已装时自动让位，仅注册「置顶会话」为其扩展
- **置顶会话**：会话行右键「置顶会话」→ 侧边栏独立「📌 置顶」分区（状态由桌面端保管）；右键会话菜单显示「置顶/取消置顶」随状态切换

## 适配真实 dsh（重要）

dsh 的插件 API 尚未文档化，本插件的宿主交互集中在 `lib/index.js` 的三个
ADAPTER 函数里，全部是"尝试多种可能形态、逐个降级"的写法：

1. **`EVENT_BUS_SHAPES`** — 事件挂接：`ctx.on('dsh/event')` / `ctx.on('session/event')` / `ctx.events.on(...)`
2. **`ROUTER_SHAPES`** — HTTP 注册：`ctx.server.get/post` / `ctx.router.get/post`
3. **`PROMPT_SHAPES`** — 发消息 RPC：`ctx.server.call('session.prompt')` 等

接真实 dsh 时只需要改这三个列表；聚合逻辑（`Tracker`）不依赖任何宿主 API。
`GET /api/state` 不暴露适配诊断（保持响应精简），可用插件 apply 返回的
`report()` 在进程内查询哪个形态挂接成功。

零 npm 依赖是有意为之：桌面端直接拷贝目录安装，无需 npm/网络。

## 测试

```bash
node test/run.mjs
```

用 mock ctx（假事件总线 + 路由表）验证事件聚合、三个端点的响应与降级行为，
不依赖真实 dsh。
