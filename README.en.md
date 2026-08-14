# DeepSeek Harness Desktop

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

English | [**中文**](README.md)

A desktop shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): an Electron window that embeds the dsh Web UI, manages the dsh service process, and provides a system tray.

> This project was created and is maintained entirely by DeepSeek models.
>
> This is a community, unofficial desktop client (a third-party project, not affiliated with DeepSeek).

## Features

- **Auto-starts dsh**: launches the service via `npx -y @deepseek-ai/dsh web` (official install method); if a dsh service is already running on the target port, it is reused instead of started again
- **Embedded Web UI**: the window loads `http://127.0.0.1:3080` (port configurable) with the full dsh feature set (sessions, models, plugins, workspace, etc.)
- **System tray**: show/hide window, open in the system browser, restart the service, quit (quitting stops the dsh child process)
- **Settings panel** (menu bar "File → Settings" or the tray menu; an in-window overlay, centered on the main window): check & update dsh (npm), switch UI language (中文/English); the "Help" menu is not implemented yet (disabled)
- **dsh update detection**: checks npm for a newer `@deepseek-ai/dsh` at startup (non-intrusive notification); you can also check manually in Settings and update with one click
- **Close behavior**: by default, closing the window hides to the tray (configurable)
- **Logs**: dsh child-process output is written to `userData/dsh.log` for troubleshooting

## Running

Requires Node.js (dsh requires `^22.19.0 || >=24.0.0`). The first run downloads the dsh package via npx, which may take a few minutes.

```bash
npm install
npm start
```

## Install as a Linux app (deb / AppImage)

```bash
npm install
npm run dist
```

Artifacts are written to `dist/`:

- **deb** (recommended): `sudo dpkg -i dist/deepseek-harness-desktop_0.1.11_amd64.deb` — installs to `/opt/DeepSeek Harness/` and adds a **DeepSeek Harness** entry to the application menu. The postinst script configures chrome-sandbox permissions automatically (0755 on kernels with user-namespace support, SUID 4755 otherwise), so the app runs fully sandboxed.
- **AppImage**: `chmod +x "dist/DeepSeek Harness-0.1.11.AppImage"` and run — no installation needed.

Both methods behave identically after launch: dsh service reuse/start, tray, and window icon.

### Update mechanisms (two paths)

**AppImage self-update** (electron-updater):

1. Build and publish a new version: upload `dist/DeepSeek Harness-x.y.z.AppImage` and `dist/latest-linux.yml` to your own HTTP(S) server (or GitHub Releases)
2. Point `updateUrl` at that directory on the user machine (e.g. `"updateUrl": "https://example.com/dsh-desktop/"`)
3. The app checks silently at startup, downloads the new version, and prompts to restart & install

`latest-linux.yml` is generated on every `npm run dist` (with sha512 checksums and differential-update info); the `example.invalid` placeholder URL is never requested.

**deb local self-packaging install** (recommended for local development/self-use):

Once `sourceDir` points at your local source tree, the tray menu shows "Build & Install":

1. Runs `npm run dist` locally to build a fresh deb
2. Shows the system authorization dialog via pkexec (polkit — the password is handled by the system, never by the app)
3. Installs with `dpkg -i` and restarts the app automatically

Great for "edit code → one-click reinstall the system version" iteration. Note: quit any running old instance first (`pkill -f "opt/DeepSeek Harness/deepseek-harness-desktop"`) to avoid the single-instance lock.

**Updating dsh itself** (independent of the desktop shell version):

dsh is published on npm; the desktop app detects updates at startup (or you can check manually in Settings):

1. Compares the local `dsh --version` with the latest version on npm
2. If a new version is found, click "Update Now" in Settings → runs `npm install -g @deepseek-ai/dsh` (no admin rights needed when the npm prefix is a user directory)
3. Choose to restart the service after the update — the Web UI is served by the dsh process, so a new version means a new UI

> Note: after an npm update, a running old dsh process does not upgrade itself — fully quit and restart, or use the tray's "Restart Service".

## Configuration

The config file lives in the user-data directory (Linux: `~/.config/deepseek-harness-desktop/config.json`, macOS: `~/Library/Application Support/deepseek-harness-desktop/config.json`, Windows: `%APPDATA%\deepseek-harness-desktop\config.json`). If the file does not exist, defaults are used:

```json
{
  "port": 3080,
  "dshCommand": "npx",
  "onClose": "ask",
  "language": "zh"
}
```

| Field | Default | Description |
|---|---|---|
| `port` | `3080` | dsh service port |
| `dshCommand` | `"npx"` | How to start dsh: `"npx"` (official, auto-downloads); `"global"` (uses `dsh` on PATH); or an absolute path to an executable |
| `closeBehavior` | `""` | What happens when the window is closed: `""` (unset — asked once on first close, then remembered); `"tray"` (hide to the tray, dsh keeps running); `"quit"` (fully quit and stop dsh); `"ask"` (ask every time). Changeable in the Settings panel |
| `updateUrl` | `""` | Auto-update feed (AppImage only): a generic HTTP(S) server or GitHub Releases URL. Empty = auto-update disabled |
| `sourceDir` | `""` | Local source directory: enables "Build & Install" in the tray menu, which packages a deb locally and installs it with system authorization (empty = feature hidden) |
| `stopExternalDsh` | `true` | On full quit, also stop an externally-started `dsh web` listening on the port (only kills processes whose command line matches `dsh web`; never touches other services; unaffected in tray/background mode) |
| `language` | `"zh"` | UI language: `"zh"` (Chinese) or `"en"` (English). Switchable in Settings, applies immediately |

## Development notes

- `src/main.js`: Electron main process (window, menu bar, settings overlay, tray, dsh child-process management, config, npm update detection) — no renderer code; the UI *is* the dsh Web UI
- `src/preload.js` + `src/settings.html`: the settings panel (contextBridge exposes a minimal IPC surface: state / check update / update dsh / switch language)
- `src/sni.js`: self-implemented StatusNotifierItem (GNOME Wayland tray)
- Tray/window icons are PNGs generated inline (see `assets/`)
- Window security: main window `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (it loads the remote dsh Web UI); the settings panel uses a minimal preload; external links always open in the system browser

## Known limitations

- dsh is still a developer preview — its interface and behavior may change between versions
- If the configured `port` is occupied by a non-dsh HTTP service, the app may mistake it for an existing service and connect to it
