# lan-share

> Share files and text between the devices on your LAN — one Node.js file, no dependencies.

[中文说明 →](README.zh-CN.md)

<p align="center">
  <img src="docs/screenshots/mobile-files.png" width="230" alt="file list on a phone">
  <img src="docs/screenshots/mobile-select.png" width="230" alt="selecting files for download">
  <img src="docs/screenshots/mobile-notes.png" width="230" alt="text notes">
  <img src="docs/screenshots/desktop-grid.png" width="480" alt="grid view on the desktop">
</p>

## ⚠️ No authentication

Only for *trusted LANs*: anyone who can reach the port can browse, download and upload everything.
Never expose it to the internet without a reverse proxy (or VPN) in front.

## Windows: no Node.js needed

[Download `best_lan-share-0.2.0-beta-win-x64.exe`](https://github.com/yourui233/best_lan-share/releases) (89 MB)
· [faster download](https://v4.gh-proxy.org/https://github.com/yourui233/best_lan-share/releases/download/v0.2.0-beta/best_lan-share-0.2.0-beta-win-x64.exe)
if GitHub is slow. Double-click it: the first run opens a setup wizard in your browser — shared
folder, port, options — on `127.0.0.1` only. After that a double-click just serves.

`SHA256 4035fd07bf769163273e7fd64435fdcb01f00ee173beeaa26868d5d1a23e93b5` — check it with
`certutil -hashfile best_lan-share-0.2.0-beta-win-x64.exe SHA256`.

<p align="center">
  <img src="docs/screenshots/wizard-1-folder.png" width="400" alt="step 1: the shared folder">
  <img src="docs/screenshots/wizard-3-options.png" width="400" alt="step 3: options">
</p>

| Command | What it does |
|---|---|
| `lan-share.exe` | start — wizard on the first run, then it just serves |
| `lan-share.exe --setup` | run the wizard again |
| `lan-share.exe --read-only` | serve, but nobody can upload, post text or delete |
| `lan-share.exe --uninstall` | remove autostart, shortcut and config |
| `lan-share.exe <dir> [port] [data-dir]` | skip the wizard, like the Node version |

Not code-signed, so SmartScreen asks once (*More info → Run anyway*) and the firewall asks for
**private** networks. No installer, no admin rights, at most one registry value.

## Quick start

```bash
git clone https://github.com/yourui233/best_lan-share.git && cd best_lan-share
node share-server.js ./shared 8080        # Node >= 18.15; no npm install
```

Then open `http://<this-machine-ip>:8080/` from any device on the same network.

## What it does

- **Files** — drag & drop or multi-select upload into `文件/<YYYY-MM-DD>/`; drop a folder (or use
  *pick a whole folder*) and the sub-folders are recreated. Thumbnails and lightbox, search,
  list/grid view, sort by time/size/name.
- **Downloads that survive a flaky connection** — merge the selection, or a whole folder, into one
  streamed `.zip`, or take each file separately. Downloads support HTTP `Range`, so an interrupted
  transfer resumes instead of starting over, and video/audio play right on the page.
- **Live list** — when another device uploads or deletes something, the list refreshes on its own
  (a tiny revision counter is polled; nothing reloads while you are typing in the search box).
- **Scan to open** — the page shows a QR code plus every LAN address (virtual adapters are labelled),
  so a phone gets in without anyone typing an IP.
- **Read-only mode** — one switch in the wizard, `--read-only`, or `SHARE_READONLY=1`: everyone can
  browse and download, nobody can upload, post text or delete.
- **Text notes** — paste text or a link and every device sees it; also written to `快捷文本/*.txt`.
- **Delete protection** — only the device that uploaded a file (or the host) can delete it.
- **LAN protection** — Host/Origin checks against DNS rebinding, path traversal and Windows reserved
  names, upload cap, free-space guard, `nosniff`, forced attachment downloads, SVG never inlined.

<p align="center">
  <img src="docs/screenshots/connect-qr.png" width="300" alt="QR code and LAN addresses to open the share from a phone">
  <img src="docs/screenshots/readonly.png" width="360" alt="read-only mode: downloads only">
</p>

Other technical details: **[docs/technical.md](docs/technical.md)**.

## License

MIT
