# Technical details

## Running from source

```bash
git clone https://github.com/yourui233/best_lan-share.git && cd best_lan-share
node share-server.js ./shared 8080
```

Node >= 18.15 and no `npm install`: the server imports only built-ins
(`http fs path os net crypto child_process`).

| Argument | Default | Meaning |
|---|---|---|
| `share-dir` | `.` | the folder that gets served and written to |
| `port` | `8080` (or `$PORT`) | listen port, always bound to `0.0.0.0` |
| `data-dir` | `<share-dir>-data` | bookkeeping only, outside the shared folder |

Environment: `SHARE_MAX_UPLOAD` (default 4 GiB), `SHARE_HOSTS` (extra `Host` names, comma
separated), `SHARE_READONLY` (`1`/`true`/`yes`/`on`), `PORT`. `--read-only` does the same thing from
the command line.

The startup banner prints every LAN address:

```
[share] content = /path/to/shared
[share] data    = /path/to/shared-data
[share] 本机    http://127.0.0.1:8080/
[share] 局域网  http://192.168.1.9:8080/
```

To autostart with Node instead of the exe, `start.vbs` launches it in a hidden window — shortcut it
into <kbd>Win</kbd>+<kbd>R</kbd> → `shell:startup`.

## HTTP routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | the app shell, file list rendered server-side (`X-Rev` header) |
| `GET` | `/rev` | one integer: bumped whenever anything changes (the page polls this) |
| `PUT` | `/u/<name>` | stream an upload into `文件/<today>/` (never overwrites); `?dir=<sub>` keeps the folder structure |
| `GET` / `HEAD` / `DELETE` | `/f/<rel>` | download a file (forced attachment, supports `Range`) / delete it — uploader only |
| `GET` / `HEAD` | `/i/<rel>` | inline image (no SVG, sandboxed CSP, supports `Range`) |
| `GET` / `HEAD` | `/m/<rel>` | inline video/audio, the only types allowed to render in place |
| `GET` | `/zip?f=<rel>&f=<rel>` | stream a zip of the selected files — a folder is expanded recursively |
| `GET` | `/qr?u=<url>` | QR code as SVG; only this server's own LAN addresses are accepted |
| `GET` | `/t/list` | notes from the last 24 h (`?older=1` for the rest) |
| `POST` / `DELETE` | `/t`, `/t/<id>` | add a note / delete a note and its `.txt` |
| `GET` | `/t/raw/<id>` | a note as plain text |
| `*` | `/setup`, `/setup/api/*` | the first-run wizard — loopback only, gone once configured |

## Live refresh, read-only mode, QR

- **Live refresh.** `LIST_REV` is an in-memory counter, bumped when an upload finishes, when a file
  or note is deleted and when read-only is toggled. `GET /rev` returns it (and `X-Rev` comes back on
  `/` and `/t/list`). The page polls `/rev` every 3 s *while it is visible* and only re-fetches the
  list when the number changed, so a second device sees new files without reloading and without
  losing the search box, sort order or selection. The baseline is the value baked into the page, so a
  change that lands right after load is not missed.
- **Read-only mode.** `readOnly: true` in `lan-share.json`, `--read-only`, or `SHARE_READONLY=1`
  (command line and environment win over the config file). Enforced in one place in the dispatcher:
  every write request — `PUT /u/*`, `POST /t`, `DELETE /f/*`, `DELETE /t/*` — gets `403
  {"error":"read-only"}`, and the page is rendered without the upload zone, the compose box and the
  delete buttons. Downloads, the zip builder, the QR panel and the live refresh keep working.
- **QR panel.** `GET /qr?u=<url>` renders the code as an SVG (byte mode, EC level M, versions 1–10,
  implemented from ISO/IEC 18004 — no dependency). It only encodes the server's own LAN addresses,
  which also keeps it from becoming an open QR generator. The address list ranks virtual adapters
  (Hyper-V/WSL/VMware/VPN) last and marks them, gateway-looking addresses (`.1`/`.254`) after that,
  and a client that already reached the server over the LAN gets its own address preselected.
- **Uploads.** `PUT /u/<file>?dir=a/b` writes into `文件/<today>/a/b/`; every segment is validated
  (no `..`, no reserved device names, no Windows-illegal characters, at most 8 levels). Dropping a
  folder uses `webkitGetAsEntry` to walk it, and *pick a whole folder* uses `webkitdirectory`.

## Files on disk

```
shared/                          the served content — all /f/ and /i/ can reach
  文件/2026-09-25/…               uploads, one folder per day
  快捷文本/2026-09-27_101500.txt   one .txt per note
shared-data/                     bookkeeping, deliberately outside the shared folder
  files.json                     rel → { id, ip, t }
  notes.jsonl                    one JSON object per line
lan-share.json                   wizard config (exe only; falls back to %APPDATA%\lan-share)
```

Identity is a `lan_id` cookie (16 random bytes, `HttpOnly`, `SameSite=Lax`) rather than the IP; the
uploader's id is stored in `files.json` next to each file. Requests from `127.0.0.1` count as the
host and may delete anything.

## How the exe is built

One file, ~2900 lines, no framework: `share-server.js` renders the page server-side and serves
everything itself. The exe is your own `node.exe` with `share-server.js` embedded as a
[Node SEA](https://nodejs.org/api/single-executable-applications.html) blob:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1        # version from package.json
powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1 -Version 0.1.0-beta
```

The script copies `node.exe`, strips its Authenticode signature (`tools/strip-signature.js`) and
injects the blob with `npx postject`. `sea-config.json` sets `useCodeCache: false` on purpose: the
same source then always produces the same bytes, so the published `sha256` is reproducible.

At runtime the exe writes `lan-share.json` next to itself, falling back to `%APPDATA%\lan-share`
when that folder is not writable, and — only if you tick autostart — one registry value
`HKCU\...\Run\LanShare` pointing at a hidden `wscript.exe` launcher. `--setup` re-runs the wizard,
`--uninstall` removes the autostart entry, the shortcut and that config.

## Known limitations

- **No authentication and no HTTPS** — anyone who can reach the port can read and write
  everything. Never expose it to the internet without a reverse proxy (or VPN) in front.
- **`DELETE /t/<id>` has no ownership check**: any LAN client can delete any note (file deletion
  *is* checked against the uploader).
- **Zipping is capped at ~3.9 GB** per request (no ZIP64), and a streamed zip cannot be resumed —
  the archive is generated while it is sent, so `Range` does not apply to `/zip`. Single files
  (`/f/`, `/i/`, `/m/`) do resume.
- **The file list is walked on every page load** (up to 12 levels deep) — fine for hundreds of
  files, not hundreds of thousands.
- **The interface is Chinese only.** The language plumbing is in place (`?lang=en`, a `lan_lang`
  cookie, `L(zh, en)` for newer strings) but the existing copy has not been moved into the string
  table yet, so `AUTO_LANG` is off on purpose: an English-locale browser still gets the consistent
  Chinese page instead of a half-translated one.
- **The prebuilt exe is unsigned and Windows x64 only.**
