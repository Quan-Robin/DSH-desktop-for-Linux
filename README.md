# DeepSeek Harness Desktop

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的桌面壳应用：用 Electron 窗口内嵌 dsh 的 Web UI，自动管理 dsh 服务进程，并提供系统托盘。

> 这是社区非官方桌面端（第三方项目，与 DeepSeek 官方无关）。

## 功能

- **自动启动 dsh**：通过 `npx -y @deepseek-ai/dsh web` 拉起服务（官方安装方式）；若目标端口已有 dsh 服务在跑则直接复用，不重复启动
- **内嵌 Web UI**：窗口加载 `http://127.0.0.1:3080`（端口可配置），支持完整的 dsh 功能（会话、模型、插件、工作区等）
- **系统托盘**：显示/隐藏窗口、在系统浏览器中打开、重启服务、退出（退出时自动终止 dsh 子进程）
- **设置面板**（菜单栏「文件 → 设置」或托盘菜单，内嵌浮层、居中于主窗口）：检查并更新 dsh（npm）、切换界面语言（中文/English）；菜单栏「帮助」暂未实现（已禁用）
- **dsh 更新检测**：启动时自动检查 npm 上的 @deepseek-ai/dsh 新版本（非侵入通知）；也可在设置中手动检查并一键更新
- **关闭行为**：默认关闭窗口 = 隐藏到托盘（可在配置中关闭）
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

- **deb**（推荐）：`sudo dpkg -i dist/deepseek-harness-desktop_0.1.8_amd64.deb`，安装到 `/opt/DeepSeek Harness/`，应用菜单出现 **DeepSeek Harness** 入口（图标为你提供的图片）。postinst 会自动配置 chrome-sandbox 权限（支持 user namespaces 的现代内核用 0755，否则 SUID 4755），安装后即可全沙箱运行。
- **AppImage**：`chmod +x "dist/DeepSeek Harness-0.1.8.AppImage"` 后直接运行，无需安装。

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
  "closeToTray": true,
  "language": "zh"
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `3080` | dsh 服务端口 |
| `dshCommand` | `"npx"` | 启动方式：`"npx"`（官方推荐，自动下载）；`"global"`（使用 PATH 上的 `dsh`）；或自定义可执行文件的绝对路径 |
| `onClose` | `"ask"` | 关闭窗口时的行为：`"ask"`（弹窗询问：保留后台到托盘 / 完全退出 / 取消）；`"tray"`（直接隐藏到托盘继续运行）；`"quit"`（直接退出并停止 dsh） |
| `updateUrl` | `""` | 自动更新源（仅 AppImage 生效）：generic HTTP(S) 服务器或 GitHub Releases 地址。留空 = 禁用自动更新 |
| `sourceDir` | `""` | 本机源码目录：设置后托盘菜单出现「从源码构建并安装」，一键在本机打包 deb 并用系统授权安装（留空 = 隐藏该功能） |
| `stopExternalDsh` | `true` | 完全退出时，若端口上还有终端启动的外部 `dsh web` 服务，一并终止（仅杀命令行匹配 `dsh web` 的进程，不误伤其他服务；保留后台到托盘时不受影响） |
| `language` | `"zh"` | 界面语言：`"zh"`（中文）或 `"en"`（English）。可在设置窗口中切换，立即生效 |

## 开发说明

- `src/main.js`：Electron 主进程（窗口、菜单栏、设置窗口、托盘、dsh 子进程管理、配置、npm 更新检测），无渲染进程代码——界面就是 dsh 的 Web UI
- `src/preload.js` + `src/settings.html`：设置窗口（contextBridge 暴露最小 IPC 面：状态/检查更新/更新 dsh/切换语言）
- `src/sni.js`：自实现 StatusNotifierItem（GNOME Wayland 托盘）
- 托盘/窗口图标为代码内联生成的 PNG（data URL），无二进制资源文件
- 窗口安全设置：主窗口 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`（加载的是远程 dsh Web UI）；设置窗口使用最小 preload（contextBridge 暴露状态/更新/语言 IPC）；外部链接一律交给系统浏览器打开

## 已知限制

- dsh 仍处于 developer preview，接口与行为可能随版本变化
- 若 `port` 端口被非 dsh 的 HTTP 服务占用，应用会误判为已有服务并直接连接
