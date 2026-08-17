# DeepSeek Harness Desktop

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[**English**](README.en.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的桌面壳应用：用 Electron 窗口内嵌 dsh 的 Web UI，自动管理 dsh 服务进程，并提供系统托盘。

> 本项目完全由 DeepSeek 系列模型创建并维护。
>
> 这是社区非官方桌面端（第三方项目，与 DeepSeek 官方无关）。

## 功能

- **自动启动 dsh**：通过 `npx -y @deepseek-ai/dsh web` 拉起服务（官方安装方式）；若目标端口已有 dsh 服务在跑则直接复用，不重复启动
- **内嵌 Web UI**：窗口加载 `http://127.0.0.1:3080`（端口可配置），支持完整的 dsh 功能（会话、模型、插件、工作区等）
- **系统托盘**：显示/隐藏窗口、在系统浏览器中打开、重启服务、退出（退出时自动终止 dsh 子进程）
- **设置面板**（菜单栏「文件 → 设置」或托盘菜单，内嵌浮层、居中于主窗口）：检查并更新 dsh（npm）、切换界面语言（中文/English）；菜单栏「帮助」暂未实现（已禁用）
- **dsh 更新检测**：启动时自动检查 npm 上的 @deepseek-ai/dsh 新版本（非侵入通知）；也可在设置中手动检查并一键更新
- **关闭行为**：默认关闭窗口 = 隐藏到托盘（可在配置中关闭）
- **伴生插件**（`plugin/dsh-plugin-desktop/`，推荐安装）：运行在 dsh 进程内，提供当前会话感知（替代请求嗅探）、实时轮次状态与快捷输入发送通道；托盘/设置页一键安装
- **页内右键菜单 + 置顶会话（免插件）**：会话/工作区/输入框/链接的完整右键菜单（适配自社区 dsh-session-context-menu，MIT；检测到原版插件时自动让位并把「置顶」注册进其扩展菜单）；「📌 置顶」独立分区显示在会话列表上方——不动原列表、不影响按时间排序，置顶状态由桌面端保管，托盘也可直达
- **右侧文件面板（Ctrl+Shift+E，免插件）**：当前工作区文件树（懒加载、噪声目录过滤），单击插入 `[file: 路径]` 引用、双击预览、📂 打开工作区目录（复刻社区 dsh-workspace-explorer，MIT）；「搜索」标签全文找文件、「变更」标签看 git 状态与 diff；统计条显示当前会话 tokens（官方接口）与会话/本轮花费（复用余额估算链路）
- **会话调色板**：`Ctrl+Shift+P` 模糊切换会话（带 ● 未读标记）、`Ctrl+Shift+F` 跨会话全文搜索——结果点击直达
- **审批直达**：DSH 等待工具审批时弹原生通知 + 小弹窗（批准/拒绝/详情，需伴生插件）；DS-pet 桌宠同步提醒并可直接批准/拒绝
- **路径直达**：Ctrl+点击对话中的文件路径 → 文件管理器定位
- **全局快捷输入**：`Ctrl+Shift+D` 任意位置唤出迷你输入条，Enter 发送到当前会话（需伴生插件；快捷键在 config.json 的 `quickInputShortcut` 修改）；拖到窗口、页面未处理的文件会以路径填入输入条
- **窗口记忆 / deep link / 多 profile**：窗口位置大小跨重启保留（拔屏自动回退）；`dsh://session/<id>` 从外部定位会话；多套 DSH_HOME+端口配置一键切换（托盘「配置」），账号/项目互不串数据
- **日志**：dsh 子进程输出写入 `userData/dsh.log`，便于排查问题

## 运行

需要 Node.js（dsh 要求 `^22.19.0 || >=24.0.0`）。首次运行会通过 npx 下载 dsh 包，可能需要几分钟。

```bash
npm install
npm start
```

## 安装为 Linux 应用（deb / AppImage）

```bash
npm install
npm run dist
```

产物在 `dist/`：

- **deb**（推荐）：`sudo dpkg -i dist/deepseek-harness-desktop_0.1.11_amd64.deb`，安装到 `/opt/DeepSeek Harness/`，应用菜单出现 **DeepSeek Harness** 入口（图标为你提供的图片）。postinst 会自动配置 chrome-sandbox 权限（支持 user namespaces 的现代内核用 0755，否则 SUID 4755），安装后即可全沙箱运行。
- **AppImage**：`chmod +x "dist/DeepSeek Harness-0.1.11.AppImage"` 后直接运行，无需安装。

两种方式启动后行为一致：自动复用/启动 dsh 服务、托盘、窗口图标均为你的图片。

### 更新机制（双路径）

**AppImage 自更新**（electron-updater）：

1. 构建新版并发布：把 `dist/DeepSeek Harness-x.y.z.AppImage` 和 `dist/latest-linux.yml` 上传到你自己的 HTTP(S) 服务器（或 GitHub Releases）
2. 在用户机器配置 `updateUrl` 指向该目录（例如 `"updateUrl": "https://example.com/dsh-desktop/"`）
3. 应用启动时静默检查更新，发现新版本自动下载，完成后弹窗提示重启安装

`latest-linux.yml` 在每次 `npm run dist` 时自动生成（含 sha512 校验与差分更新信息）；`example.invalid` 占位地址不会被请求。

**deb 本机自打包安装**（推荐，适合本机开发/自用）：

配置 `sourceDir` 指向本机源码目录后，托盘菜单出现「从源码构建并安装」：

1. 本机执行 `npm run dist` 打包全新 deb
2. 通过 pkexec 弹系统授权框（polkit，密码由系统收取，不经过应用）
3. `dpkg -i` 安装后自动重启应用

适合「改完代码 → 一键重装系统版本」的迭代流程。注意：升级前先退出正在运行的旧实例（`pkill -f "opt/DeepSeek Harness/deepseek-harness-desktop"`），避免单实例锁冲突。

**dsh 自身的更新**（与桌面端版本无关）：

dsh 通过 npm 发布，桌面端在启动时自动检测（也可在设置中手动检查）：

1. 比较本机 `dsh --version` 与 npm 上的最新版本
2. 发现新版本 → 设置窗口点「立即更新」→ 执行 `npm install -g @deepseek-ai/dsh`（npm prefix 为用户目录时无需管理员权限）
3. 更新完成后选择重启服务即生效（Web UI 由 dsh 进程提供，新版本即新界面）

> 注意：npm 更新后，正在运行的旧 dsh 进程不会自动升级——完全退出再启动、或托盘「重启服务」后生效。


## 配置

配置文件位于用户数据目录（Linux 为 `~/.config/deepseek-harness-desktop/config.json`，macOS 为 `~/Library/Application Support/deepseek-harness-desktop/config.json`，Windows 为 `%APPDATA%\deepseek-harness-desktop\config.json`）。不创建该文件即使用默认值：

```json
{
  "port": 3080,
  "dshCommand": "npx",
  "onClose": "ask",
  "language": "zh"
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `3080` | dsh 服务端口 |
| `dshCommand` | `"npx"` | 启动方式：`"npx"`（官方推荐，自动下载）；`"global"`（使用 PATH 上的 `dsh`）；`"bundled"`（便携版，使用内置 node 运行内置 dsh——见下文「Linux 便携版」）；或自定义可执行文件的绝对路径 |
| `dshHome` | `""` | dsh 数据目录（会话/凭据/profile）。留空 = `~/.dsh`；**便携版（bundled）留空 = 应用旁 `data/`**，完全隔离 |
| `closeBehavior` | `""` | 关闭窗口时的行为：`""`（未设置——首次关闭时询问并记住）；`"tray"`（隐藏到托盘继续运行，dsh 不中断）；`"quit"`（完全退出并停止 dsh）；`"ask"`（每次都询问）。可在设置面板中更改 |
| `updateUrl` | `""` | 自动更新源（仅 AppImage 生效）：generic HTTP(S) 服务器或 GitHub Releases 地址。留空 = 禁用自动更新 |
| `sourceDir` | `""` | 本机源码目录：设置后托盘菜单出现「从源码构建并安装」，一键在本机打包 deb 并用系统授权安装（留空 = 隐藏该功能） |
| `stopExternalDsh` | `true` | 完全退出时，若端口上还有终端启动的外部 `dsh web` 服务，一并终止（仅杀命令行匹配 `dsh web` 的进程，不误伤其他服务；保留后台到托盘时不受影响） |
| `language` | `"zh"` | 界面语言：`"zh"`（中文）或 `"en"`（English）。可在设置窗口中切换，立即生效 |

## Linux 便携版

不依赖系统 Node/pnpm/dsh 的独立版本：

```bash
npm run bundle          # 下载 node + pnpm + dsh（固定版本）到 bundled/
npm run dist:portable   # 构建目录 + 打包 zip（dist-portable/DeepSeek-Harness-x64.zip）
```

产物为**解压即用目录**（类似 Antigravity-x64 形态）：

```
DeepSeek-Harness-x64/
├── deepseek-harness          # 启动器（入口，自动处理 sandbox）
├── deepseek-harness-desktop   # 实际可执行
└── resources/
    ├── app.asar
    └── bundled/               # 内置 node + pnpm + dsh 运行时
```

运行：`./DeepSeek-Harness-x64/deepseek-harness`（解压后直接双击/执行；sandbox 不可用时自动加 `--no-sandbox`）

**开箱即用**：无需任何配置——自动检测内置运行时并启用 bundled 模式，默认数据目录 = 应用旁 `data/`（不碰 `~/.dsh`）；配置端口被外部服务占用时自动顺延（绝不显示宿主机自己的会话）。

**配置完全隔离**：便携版的全部应用数据（config、余额状态、日志、缓存）都在应用旁 `data/app/`——普通版与便携版、或多个便携副本的关闭行为等设置互不影响，可同时运行（各自独立窗口、独立 dsh 服务、独立数据）。

- 内置 dsh 版本固定（`scripts/download-bundled.sh` 中可改），更新 = 重新 `npm run bundle` + `dist:portable`
- bundled 模式自动修复内置 dsh 的已知插件 bug（dsh-plugin-vetting 正则）

## 开发说明

- `src/main.js`：Electron 主进程（窗口、菜单栏、设置窗口、托盘、dsh 子进程管理、配置、npm 更新检测），无渲染进程代码——界面就是 dsh 的 Web UI
- `src/preload.js` + `src/settings.html`：设置窗口（contextBridge 暴露最小 IPC 面：状态/检查更新/更新 dsh/切换语言）
- `src/sni.js`：自实现 StatusNotifierItem（GNOME Wayland 托盘）
- 托盘/窗口图标为代码内联生成的 PNG（data URL），无二进制资源文件
- 窗口安全设置：主窗口 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`（加载的是远程 dsh Web UI）；设置窗口使用最小 preload（contextBridge 暴露状态/更新/语言 IPC）；外部链接一律交给系统浏览器打开

## 已知限制

- dsh 仍处于 developer preview，接口与行为可能随版本变化
- 若 `port` 端口被非 dsh 的 HTTP 服务占用，应用会误判为已有服务并直接连接
