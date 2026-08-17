# dsh-plugin-desktop

DSH-desktop-for-Linux 的伴生插件。运行在 dsh 服务进程内，把桌面端需要的内部状态以稳定 HTTP 端点暴露出来，替代桌面端过去的两个 hack：

| 桌面端旧做法 | 插件做法 |
|---|---|
| 嗅探 `webRequest` 的 `/api/session.*` POST body 判断当前会话 | `GET /api/state` 直接给出 |
| 解压 `~/.dsh/sessions/**/session.jsonl.zstd` 估算用量 | `GET /api/usage` 给出事件流实时聚合 |

## 端点

- `GET /api/state` → `{ plugin, since, currentSessionId, turn: 'working'|'idle', lastTurnEndSeq, lastSummary }`
- `GET /api/usage` → `{ plugin, since, complete: false, byModel, sessions: [{ id, byModel, userMsgByModel, lastTurnEndSeq, lastSummary, updatedAt }] }`
  - `complete: false`：仅覆盖插件加载后的事件（dsh 重启后归零）。桌面端用它做当前会话的实时数据，历史总量仍走本地文件扫描（有 mtime+size 缓存，增量代价很小）。
- `POST /api/prompt` `{ sessionId?, text }` → 全局快捷输入的发送通道；`sessionId` 缺省用当前会话。

事件语义与桌面端 `src/usage-parse.js` 完全一致（`request/header` 记模型、`user/message` 开新一轮、`turn/end` 收尾、用量只取 `assistant/chunk`），保证两条路径数字一致。

## 安装

桌面端已内置安装入口（托盘菜单 / 设置页「安装伴生插件」）：把本目录拷贝到
`$DSH_HOME/profiles/web/node_modules/dsh-plugin-desktop/`，并在
`$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-plugin-desktop
      name: dsh-plugin-desktop
      inject:
        - webServer
        - apiProxy
```

然后重启 dsh 服务。手动验证：`curl http://127.0.0.1:3080/api/state`。

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
