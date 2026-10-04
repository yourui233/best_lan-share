# best_lan-share

> Share files and text between the devices on your LAN — one Node.js file, zero dependencies.

English | [中文](README.md)

> **The web interface is Chinese only for now.** An English translation has been started but is far
> from finished, so expect Chinese labels even with `?lang=en`. Everything below describes the
> current state honestly, including what the tool does *not* do.

<p align="center">
  <img src="docs/screenshots/mobile-files.png" width="230" alt="the file list on a phone">
  <img src="docs/screenshots/mobile-select.png" width="230" alt="selecting files to download">
  <img src="docs/screenshots/mobile-notes.png" width="230" alt="text notes on a phone">
  <img src="docs/screenshots/desktop-grid.png" width="480" alt="grid view in a desktop browser">
</p>

Install it on the machine that serves. **Every other device needs nothing at all** — a phone, a
tablet, a colleague's laptop opens one URL in a browser and can drop files in or pull them out.
No account, no app, no cable, and no server in between.

## ⚠️ No authentication

**Only for trusted LANs.** There is no account, password or token: anyone who can reach the port
can browse, download, upload and delete. Never expose it to the internet as-is. If you really need
that, put an authenticating reverse proxy or a VPN in front — and you **must** set `SHARE_HOSTS`
(see [Security model](#security-model)), otherwise the Host check rejects everything arriving
through the proxy.

## Quick start

### Windows: one exe, no Node.js

Grab the latest `best_lan-share-<version>-win-x64.exe` from the
[**Releases**](https://github.com/yourui233/best_lan-share/releases) page and double-click it. The
first run opens a setup wizard in your browser (shared folder, port, startup options) listening on
`127.0.0.1` only; after that, a double-click just serves.

Download links, file size, SHA256 and mirrors live on that release page — check there, it is the
authority.

<p align="center">
  <img src="docs/screenshots/wizard-1-folder.png" width="330" alt="wizard step 1: which folder to share">
  <img src="docs/screenshots/wizard-2-port.png" width="330" alt="wizard step 2: which port to use">
  <img src="docs/screenshots/wizard-3-options.png" width="330" alt="wizard step 3: autostart and other options">
  <img src="docs/screenshots/wizard-4-confirm.png" width="330" alt="wizard step 4: confirm">
</p>

Release file names carry the version; below they are shortened to `best_lan-share.exe` — rename it,
or just use the full name, whichever you prefer.

|Command|What it does|
|-|-|
|`best_lan-share.exe`|start — wizard on the first run, then it just serves|
|`best_lan-share.exe --setup`|run the wizard again|
|`best_lan-share.exe --read-only`|serve, but nobody can upload, post text or delete|
|`best_lan-share.exe --no-open`|start without opening a browser|
|`best_lan-share.exe --uninstall`|remove autostart, shortcut and config (your shared files are untouched)|
|`best_lan-share.exe <dir> [port] [data-dir]`|skip the wizard, exactly like the Node version|

Not code-signed, so SmartScreen asks once (*More info → Run anyway*) and the firewall asks for
**private** networks. No installer, no admin rights: at most one per-user startup entry, one desktop
shortcut, and one small `.vbs` in `%APPDATA%\lan-share` (only if you tick the hidden-window option).

### From source

```bash
git clone https://github.com/yourui233/best_lan-share.git && cd best_lan-share
node share-server.js ./shared 8080        # Node >= 18.15; no npm install
```

Then open `http://<this-machine-ip>:8080/` from any device on the same network. The console prints
the loopback URL and every LAN address it can find.

The wizard is packaged-exe only: it binds to loopback and drives native Windows dialogs. From
source you get the plain command line, so `--setup` does nothing there.

## What it does

* **Files** — drag & drop or multi-select upload into `文件/<YYYY-MM-DD>/`; drop a folder (or use
*pick a whole folder*) and the sub-folders are recreated, 8 levels deep. Per-file progress and
speed, duplicates renamed to `name (2).ext`, 4 GiB per-file cap, free-space guard, and file names
sanitised for Windows (reserved names, illegal characters, trailing dots).
* **Downloads that survive a flaky connection** — merge the selection, or a whole folder, into one
streamed `.zip` built on the fly (no temp file), or take each file separately. Downloads support
HTTP `Range`, so an interrupted transfer resumes instead of starting over, video/audio play right
on the page, and images get thumbnails plus a lightbox.
* **Live list** — when another device uploads or deletes something, the list refreshes on its own
(a tiny revision counter is polled; nothing reloads while you are typing in the search box). Your
tab, view, sort and expanded folders are remembered per browser.
* **Scan to open** — the page shows a QR code plus every LAN address, with the adapter name, so a
phone gets in without anyone typing an IP. Virtual adapters are labelled as usually unreachable.
* **Read-only mode** — one switch in the wizard, `--read-only`, or `SHARE_READONLY=1`: everyone can
browse and download, nobody can upload, post text or delete.
* **Text notes** — paste text or a link and every device sees it; it is also written to
`快捷文本/*.txt`. Up to 20,000 characters each, with anything older than 24 hours one click away.
* **Find things** — one search box covers file names and note text; list or grid view; sort by
time/size/name.
* **Settings before uploading** — picking files no longer uploads them straight away: they land in a
staging list where each one can be renamed, set to *everyone* or *only me*, or encrypted, and then
uploaded in one go.
* **Browser-side (end-to-end) encryption** — tick encrypt and the file is encrypted in your browser
with a password (ChaCha20-Poly1305 + PBKDF2-SHA256); **the password is never sent to the server**.
What lands on disk is ciphertext under a random name, and only someone with the password can
decrypt it. Works over plain HTTP on a phone — no HTTPS, no WebCrypto needed.
* **Visibility and extract codes** — a file set to *only me* does not exist for anyone else (absent
from the list, direct links 404); the uploader's browser and the host machine always see it, and the
generated 6-character extract code lets anyone you give it to see and download that one file.
* **File settings (⚙)** — every file you uploaded gets a gear icon: rename it, change its visibility,
view and rotate its extract code, or **encrypt a file that is already on the server** (encrypt in the
browser → upload the ciphertext → delete the original).
* **Delete protection** — uploads are remembered per browser, and only the browser that uploaded a
**file** (or the host machine) can delete it.
* **Dark mode** — follows `prefers-color-scheme` automatically.

<p align="center">
  <img src="docs/screenshots/connect-qr.png" width="300" alt="QR code and LAN addresses to open the share from a phone">
  <img src="docs/screenshots/readonly.png" width="360" alt="read-only mode: downloads only">
</p>

## Where things are stored

```
<shared folder>/
├── 文件/
│   └── 2026-10-03/
│       ├── report.pdf
│       ├── a3f9c1e07b52d8a4c6e19f30.bin ← encrypted: random name + ciphertext, nothing to recognise
│       └── photos/                     ← sub-folders you dropped are recreated
└── 快捷文本/
    └── 2026-10-03_195644.txt           ← one file per text note

<shared folder>-data/                   ← kept OUTSIDE the share, on purpose
├── files.json                          who uploaded what (plus real names, visibility, extract codes)
└── notes.jsonl                         the index behind the text tab
```

* Everything inside the shared folder is visible to everyone — including files you put there
yourself, without using the page.
* The `-data` folder sits *next to* the share, so nobody browsing the share ever sees it.
* Deleting `-data` costs you the note history (the `.txt` files stay) and the uploader records;
afterwards only the host machine can delete files. It also holds the real names of encrypted
uploads — losing it does not stop decryption (the password and the file header are enough), but
the names are gone.
* An encrypted file's **password exists nowhere**: no recovery, no backdoor. Forget it and that
ciphertext is unreadable forever.

## Environment variables

|Variable|Default|Effect|
|-|-|-|
|`PORT`|`8080`|port to listen on when no port argument or config value is given|
|`SHARE_READONLY`|—|`1`/`true`/`yes`/`on` = read-only; overrides the config file|
|`SHARE_MAX_UPLOAD`|`4294967296`|per-file upload cap in bytes (4 GiB)|
|`SHARE_HOSTS`|—|extra comma-separated host names to accept in the `Host` header — **required behind a reverse proxy**|
|`SHARE_CONFIG`|next to the exe|path to the JSON config file|
|`SHARE_NO_BROWSER`|—|`1` = never open a browser|

Settings live in `lan-share.json` next to the exe (the name is a leftover from before the project
was renamed — that is expected, not a typo), or in `%APPDATA%\lan-share\lan-share.json` when that
location is not writable. Plain JSON (`root`, `port`, `data`, `open`, `readOnly`, `autostart`,
`hidden`, `shortcut`), and hand-editing works — the wizard just writes it for you.

## Security model

**What it does protect**

* **DNS rebinding and cross-site requests** — every request must arrive with a `Host` that is one of
this machine's names or addresses, and an `Origin` that matches. Requests with an opaque origin
are rejected.
* **Path traversal** — every path is rebuilt from sanitised segments and must resolve inside the
shared folder. Windows reserved names (`con`, `lpt1`, …), trailing dots and spaces, and control
characters are rewritten.
* **XSS through uploads** — file names are HTML-escaped, note text is rendered as text, SVG is never
inlined, inline media carries `Content-Security-Policy: default-src 'none'; sandbox`, every
response carries `X-Content-Type-Options: nosniff`, and downloads are always `attachment`.
* **Disk exhaustion** — a per-file cap plus a free-space floor checked before and during an upload.
* **The QR endpoint** — encodes this server's own LAN addresses only, so it is not a free QR
generator for anyone who finds it.
* **Files nobody else should see** — *only me* files are filtered out on the server: absent from
other people's lists, 404 on direct links. Only the uploader's browser, the host machine, or a
device that redeemed the extract code can get them.
* **What lands on disk** — the bytes of an encrypted upload are ciphertext and the server holds no
key, so browsing the shared folder only reveals random file names.

**What it does not**

* **Authenticate anyone.** Anyone on the network can upload. If you need a boundary between people,
this is the wrong tool.
* **Encrypt anything unless you tick the option.** It is plain HTTP: unencrypted file contents and
note text are readable by anyone who can sniff the LAN. Encrypt it, or use something else.
* **Hide the existence of an encrypted file.** With visibility *everyone*, an encrypted file's name,
size and uploader IP stay visible; pick *only me* to hide the name as well.
* **Treat an extract code as an account.** Whoever holds the code (or that device's cookie) holds the
access; there is no revoke list, only *new code*, which invalidates the old one.
* **Give you audited crypto.** The pure-JS implementation is compared against OpenSSL and the
RFC 8439 vector, but it is not a cryptography library.
* **Hide your clients from each other.** One device cannot delete another's file, but it can read
it, and every entry shows the uploader's IP address.
* **Follow links safely.** Symbolic links and directory junctions that already exist inside the
shared folder are followed, so a link pointing outside it exposes that target too. Do not put
such a link in a folder you share.

## Troubleshooting

**The port is already taken** — the exe moves on to the next port, up to 10 times, and prints the one
it actually used. From source, pass a different port yourself.

**My phone cannot open it** — check that both devices are on the same network (guest and "isolated"
Wi-Fi networks block device-to-device traffic), and allow the app through the firewall on **private**
networks. Open the 🔗 panel and use an address that is not marked as a virtual adapter.

**Files I copy in by hand do not show up elsewhere** — the live refresh only tracks changes made
through the page. Copy files in from Explorer and the other devices need a manual refresh.

**I cannot delete a file** — only the browser that uploaded it, or the host machine, can. Uploader
identity lives in a cookie, so a different browser, or a cleared cookie store, counts as a different
device.

## See also

* Architecture, on-disk format, and the zero-dependency zip/QR implementations:
[**docs/technical.md**](docs/technical.md)
* Windows single-file downloads: [Releases](https://github.com/yourui233/best_lan-share/releases)
* 中文说明: [README.md](README.md)

## License

MIT

