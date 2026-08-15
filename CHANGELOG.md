# Changelog

本项目的版本更新说明。发布 GitHub Release 时同步引用本文件对应条目。

## 0.1.35 (2026-08-15)

- **新增：Linux 便携版**（`npm run dist:portable`）——捆绑 node + pnpm + dsh 运行时，**开箱即用**（无需系统安装 Node/pnpm/dsh）
  - 数据完全隔离：`config.dshHome` 可配置（便携版指向应用旁 `data/` 或任意目录），不污染 `~/.dsh`
  - 启动模式：`dshCommand: "bundled"`（内置 node 运行内置 dsh；`PATH` 自动注入内置 bin）
  - 内置 dsh 固定版本（当前 0.1.0-rc.6），无 npm 侧更新提示（更新 = 重新下载便携版）
  - 构建脚本 `scripts/download-bundled.sh`（可换 node/pnpm/dsh 版本）；产物 `dist-portable/DeepSeek-Harness-x64.zip`（解压即用目录，含可执行 `deepseek-harness-desktop` + resources/bundled）
  - 内置 dsh 的已知插件 bug（dsh-plugin-vetting 正则）在 bundled 模式启动时自动修复
- **设置面板新增「应用版本」**：显示桌面端自身版本（如 v0.1.35）；`dshCommand: "bundled"` 时「当前版本」显示内置 dsh 版本
- **配置按实例隔离**：便携版应用数据全部独立于应用旁 `data/app/`（关闭行为等设置不与普通版/其他便携副本共用；多实例可同时运行、各自独立窗口与数据）
- **普通版自动降级**：显式 `dshCommand: "bundled"` 但本机无内置运行时（如普通版 config 遗留）→ 自动回退 npx 并提示
- **便携版开箱即用**：无需任何配置（无 `dshCommand` 时自动检测内置运行时并启用 bundled 模式；配置端口被外部服务占用时自动顺延，绝不显示宿主机自己的 `~/.dsh` 会话）
- **便携版入口改为启动器** `./deepseek-harness`（zip 解压会丢失 chrome-sandbox 的 SUID 权限导致直接运行报 FATAL，启动器自动检测并加 `--no-sandbox`）
- **普通版体积不变**（`npm run dist` 不含捆绑运行时）

## 0.1.13 (2026-08-14)

- **修复**：0.1.12 的检查更新修复不彻底——`bash -lc` 依赖 `~/.profile` 的 PATH 配置，而你的 npm 全局目录（`~/.npm-global/bin`）配置在别处，纯净 GUI 环境下仍然找不到 `dsh`。现改为**直接探测常见安装位置**（`~/.npm-global/bin`、`~/.local/bin`、`/usr/bin`）并用**绝对路径执行**，完全不依赖 shell 配置
- **改进**：检查更新失败时提示**具体失败项**（`dsh --version` 失败 / `npm view` 失败及原因），便于定位

## 0.1.12 (2026-08-14)

- **修复**：检查更新在桌面快捷方式（GUI 启动）下报「npm view / dsh --version failed」——原因是 GUI 环境的 PATH 不含 `~/.npm-global/bin`，`dsh` 命令找不到；现改为通过 login shell 执行，与终端环境一致
- **新增**：关闭行为设置（设置面板 →「关闭窗口时」）：保留后台（托盘）/ 完全退出 / 每次询问
- **新增**：首次关闭窗口时弹窗提示选择默认行为（选一次后记住，可在设置中更改）
- **变更**：点击窗口关闭键（✕）在设置默认行为后按所选执行（默认倾向保留后台）
- **兼容**：旧配置 `onClose` 字段自动迁移为 `closeBehavior`

## 0.1.11 (2026-08-14)

- **新增**：设置面板模态效果——打开设置时主窗口变灰暗并拦截点击，明确上下层关系

## 0.1.10 (2026-08-14)

- **修复**：设置面板改为内嵌浮层（WebContentsView），首次点击即显示、精确居中于主窗口（Wayland 下独立窗口位置不受应用控制）
- **修复**：「从源码构建并安装」前自动清理旧构建产物

## 0.1.9 (2026-08-14)

- **修复**：设置窗口居中于主窗口（modal + parent）
- **变更**：菜单栏「帮助」暂未实现，已禁用
- **清理**：删除 0.1.1~0.1.8 旧构建产物

## 0.1.8 (2026-08-14)

- **新增**：设置窗口（菜单栏「文件 → 设置」/ 托盘菜单）：dsh npm 版本检测与一键更新、界面语言切换（中文/English）
- **新增**：菜单栏中文化（语言可在设置中切换，即时生效）
- **新增**：启动时自动检测 dsh npm 新版本（非侵入通知）

## 0.1.7 (2026-08-14)

- **新增**：完全退出时自动终止终端启动的外部 `dsh web`（仅杀命令行匹配 `dsh web` 的进程，不误伤其他服务）

## 0.1.1 ~ 0.1.6 (2026-08-13)

- 0.1.1：初版（dsh 服务管理、内嵌 Web UI、托盘）
- 0.1.2：deb/AppImage 打包与安装、托盘三选退出（ask/tray/quit）
- 0.1.3：回滚 Wayland 原生模式（强制 x11 导致 GPU 崩溃）
- 0.1.4：deb 本机自打包安装（「从源码构建并安装」）
- 0.1.5：自实现 StatusNotifierItem 托盘（GNOME Wayland 图标正常显示）
- 0.1.6：托盘菜单完整实现（左右键、dbusmenu）

## 0.1.14 (2026-08-14)

- **新增**：余额显示与用量估算（菜单栏最右侧「余额」菜单 + 托盘菜单 + 设置面板）
  - 官方余额：读取 dsh 凭据（~/.dsh/.credentials.yaml）调 DeepSeek 官方 GET /user/balance，实时显示
  - 估算余额：校准机制——「校准」记录当前官方余额为基准，之后按本地 token 用量（扫描 ~/.dsh/sessions 的 usage 事件，含 input/cacheRead/output/reasoning tokens）实时估算，不受官方余额更新延迟影响
  - 价格按 config.json 的 pricing 可调（默认 DeepSeek 官方价）
- 依赖：fzstd（zstd 解压会话记录，纯 JS 无系统依赖）

## 0.1.21 (2026-08-14)

- **修复**：估算余额首次启动时不变——校准后若本地没有新消耗（或消耗来自其他客户端，本地统计不到），估算余额会停在校准基准不动；现改为：校准后本地有新消耗时按「基准 − 消耗增长」实时递减，无本地新消耗时跟随官方实时余额
- **改进**：估算余额与官方余额偏差超过 0.5 元时自动重新校准（防止本地统计不全导致的长期漂移）

## 0.1.20 (2026-08-14)

- **修复**：首次查询余额必现无响应——首次全量扫描会话文件（zstd 解压约 2 秒）原本同步阻塞主进程，现移入 **worker 线程**（src/balance-worker.js），主进程永不阻塞；worker 失败自动降级为同步解析并记录日志；缓存命中后扫描 <1ms

## 0.1.19 (2026-08-14)

- **重构**：余额独立页面（余额详情…）——浮层通用化（openOverlay 支持 settings/balance 两页）
- **变更**：设置面板移除余额区块（余额只在菜单栏/托盘/独立余额页）；余额菜单移除「设置」项
- **变更**：菜单栏/托盘「本会话消耗」改「当前会话消耗」——跟随 Web UI 切换的会话（切换到某会话后继续对话，10s 内更新）
- **修复**：余额查询偶发无响应——fetch 官方接口超时 15s→8s、refreshBalance 防重入（定时刷新与手动点击共享一次请求）、余额页刷新按钮 loading 反馈
- **修复**：设置/余额页关闭按钮滚动时常驻右上角（absolute→fixed）

## 0.1.16 (2026-08-14)

- **新增**：会话消耗明细（设置面板 + 菜单栏/托盘余额区）
  - 本会话消耗（预估）：最新 dsh 会话（mtime）的 token 用量；本次对话消耗：该会话最近一次对话（最大 turn）；**每个历史会话单独列出**（ID/时间/消耗，按时间倒序）
  - **按模型分价**：模型从 request/header 事件提取（顺序配对 usage）；内置官方定价（deepseek-v4-flash / v4-pro / chat / reasoner），config.json 的 pricing 可覆盖
  - **峰谷定价**：官方 2026-08-17 00:00（北京时间）起生效（高峰 9-12、14-18 为峰值价，其余半价），代码按日期自动切换
  - **每 10 秒自动刷新**；会话未更新不重复估算（mtime+size 增量缓存）；菜单仅在数值变化时重建（无对话时零开销）

## 0.1.22
- 本次对话消耗：按 `user/message` 事件界定——每次新发消息自动从 ¥0.00 计（旧逻辑按 turn，但 dsh 的 turn 不随消息增长，导致不变化）
- 对话完成提醒：检测 `turn/end` 事件（整轮完成信号，不受推理模型步骤间长停顿影响）；窗口不在前台时系统通知（含该轮回复摘要），点击通知回到前台；设置面板可开关（`notifyOnTurnEnd`）

## 0.1.23
- 余额数据改用 dsh web 服务端权威 API（`POST /api/session.list`）：tokenUsage/updatedAt/running 由 dsh 统计，「当前会话」自动跟随 Web UI 中切换的会话（updatedAt 更新），数值口径统一
- API key 一致性校验：服务端会话必须都能在本地 ~/.dsh/sessions 找到，否则视为其他 DSH_HOME 的实例（其他 API key 的 DSH_HOME）→ 自动降级本地扫描，杜绝多 key 用量混算
- 余额详情页新增「各会话消耗」列表 + 「设为当前」：手动指定当前会话/本次对话统计对象（config.balanceSessionId）；不设置时自动跟随最近活跃

## 0.1.24
- 修复 0.1.23 回归：服务端 tokenUsage 无 model 字段，costOfTokens 误用 deepseek-chat 默认价（cacheHit 0.5/百万 vs v4-flash 0.02，差 25 倍）导致各会话消耗被放大
- 数值回归本地扫描口径（用户验证过的正确值，如「轻量级任务调度系统」¥0.664）；「当前会话」仍用服务端 session.list 判定（running/updatedAt 跟随 Web UI 活动会话 + 详情页手动「设为当前」）

## 0.1.25
- 托盘/菜单栏余额菜单新增「各会话消耗」子菜单：每个会话一行（标题 + 消耗，当前会话 ✓ 标记），点击即「设为当前」
- sni.js dbusmenu 支持子菜单（children 递归 id 分配 + GetLayout 展开 + Event 路由）
- （延续 0.1.24：数值本地口径、切换跟随=活动会话、key 一致性校验）

## 0.1.26
- 浏览切换自动跟随（窗口内）：监听主窗口 webRequest 的 POST /api/session.history（前端打开会话时必然发出，带 sessionId）→ 自动设为当前会话并立即刷新
- 监测确认：切换浏览时服务端 updatedAt/running/顺序与会话文件均无任何变化（dsh 无"当前会话"信号），源码确认 session.* 无 open/current 方法——webRequest 是唯一可行的自动跟随通道（限于桌面端窗口内操作；外部浏览器操作仍用托盘子菜单手动）

## 0.1.27
- 「本次对话消耗」跟随当前会话（之前固定用 mtime 最新文件）：语义 = 当前会话最后一条 user/message 之后的用量（估测该会话最后一条消息的消耗），切换会话后随「当前会话」一起更新

## 0.1.28
- 修复自动更新余额时主进程无响应/闪退：本次对话消耗原在主线程同步解析当前会话文件（对话中文件持续变化 → 每 10 秒 zstd 解压+解析阻塞主进程）；改为直接从 worker 线程的缓存解析结果取用（computeUsage 明细已含 userMsgByModel/lastTurnEndSeq/lastSummary），主进程零同步解析

## 0.1.29 / 0.1.30
- 修复「长会话加载完切换不更新」根因：缓存会话切换时前端只发 session.models（不发 session.history）——webRequest 监听扩展为所有 /api/session.*（带 sessionId 即捕获）；实测 models-only 切换被捕获并跟随
- 修复「首次加载长会话无响应」：官方余额先行显示（5s 内出数值，不再等全量扫描 12s）；fetchSessions 超时 6s→2.5s、fetchOfficialBalance 8s→5s；首次刷新错峰 8s
- 诊断日志：webRequest 捕获记录 + 慢刷新耗时写 userData/switch.log

## 0.1.31
- 修复托盘图标堆积：每次余额刷新曾销毁并重建 SNI 服务（GNOME 每次叠一个新托盘图标）；改为 dbusmenu 内容热更新（setMenu + LayoutUpdated 信号），图标唯一、菜单实时

## 0.1.32
- 修复 dsh 服务意外退出（code=1 MISSING_DSH_HOME）：spawn dsh 时显式设置 DSH_HOME（与本地扫描一致），新版 dsh 不再报错退出
- 代码审查修复（4 项）：worker 30s 超时降级（防 refreshBalance 永久卡死）；computeUsage 并发互斥（定时刷新与校准不交叉）；SNI 热更新失败时先销毁旧服务再重建；createTray 防重复创建（异步注册竞态）
- 托盘余额菜单精简：只显示官方余额（详情/各会话/刷新/校准入口移除，详情页代码保留）

## 0.1.33
- 修正 0.1.32 的托盘精简范围：托盘菜单余额只显示官方余额；应用菜单栏的「余额」菜单恢复完整（官方/估算/当前会话/本次对话/各会话/详情/刷新/校准）

## 0.1.34
- 插件失败自动修复：dsh 因插件加载失败退出（code≠0）时，解析 dsh.log 定位失败插件（错误链取最内层），弹窗询问「禁用该插件并重启」；确认后向 ~/.dsh/profiles/web/cordis.patch.yml 写入 `- id: <plugin>\n  disabled: true` 并自动重启；同一插件禁用后仍失败则停止自动处理（防循环）
- 修复过程实测：plugin-vetting 正则 bug 场景下自动禁用成功、服务恢复 200
