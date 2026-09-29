// 局域网共享：快捷文本 + 文件上传/下载
// 结构：共享根只放内容（文件/YYYY-MM-DD、快捷文本/*.txt）；内部数据在共享根之外的 <root>-data
// 注意：page() 与 setupPage() 里是模板字符串，客户端 JS 内不要出现反斜杠转义或 ${ }，否则会被服务端提前解释
// 用法：node share-server.js <共享目录> [端口] [数据目录]
//       lan-share.exe            双击直接跑（读同目录 lan-share.json；没有配置就先走安装向导）
//       lan-share.exe --setup    重新配置    --uninstall 清理开机启动与快捷方式
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

/* ---------- 单文件 exe（Node SEA）与配置 ---------- */
// SEA 下 argv 的布局和 node 运行不一样（有的版本会把 exe 路径塞进 argv[1]），
// 这里统一成和 node 一样的形状：[运行时, 脚本, 用户参数...]
const SEA = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
function userArgs() {
  const rest = process.argv.slice(1);
  while (rest.length && path.resolve(rest[0]) === path.resolve(process.execPath)) rest.shift();
  return rest;
}
const ARGV = SEA ? [process.execPath, '(sea)', ...userArgs()] : process.argv;
if (process.env.SHARE_DEBUG_ARGV === '1') {
  console.error('[dbg] raw argv = ' + JSON.stringify(process.argv));
  console.error('[dbg] normalized = ' + JSON.stringify(ARGV));
}
const SELF_DIR = SEA ? path.dirname(process.execPath) : __dirname;
const FLAGS = new Set(ARGV.slice(2).filter(a => a.slice(0, 2) === '--').map(a => a.toLowerCase()));
const POS = ARGV.slice(2).filter(a => a.slice(0, 2) !== '--');
const IS_WIN = process.platform === 'win32';
const CONFIG_NAME = 'lan-share.json';
const CONFIG_FILE = process.env.SHARE_CONFIG || path.join(SELF_DIR, CONFIG_NAME);

// exe 旁边写不进去（例如放在 Program Files）就退到 %APPDATA%\lan-share
function appDir() {
  const base = IS_WIN ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')) : path.join(os.homedir(), '.config');
  return path.join(base, 'lan-share');
}
function readConfig() {
  for (const p of [CONFIG_FILE, path.join(appDir(), CONFIG_NAME)]) {
    try { const o = JSON.parse(fs.readFileSync(p, 'utf8')); if (o && typeof o === 'object') return o; } catch {}
  }
  return {};
}
function writeConfig(obj) {
  const tries = [CONFIG_FILE, path.join(appDir(), CONFIG_NAME)];
  let last;
  for (const p of tries) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); return p; }
    catch (e) { last = e; }
  }
  throw last || new Error('无法写入配置');
}

const CFG = readConfig();
const HAS_CONFIG = Object.keys(CFG).length > 0;
// 向导：exe 首次运行（还没有配置）或显式 --setup；一旦给了目录参数就照旧跳过
const FORCE_SETUP = process.env.SHARE_SETUP === '1';          // 测试用：让 node 运行也进向导
const WANT_SETUP = (SEA || FORCE_SETUP) && !POS.length && !FLAGS.has('--uninstall');
let setupMode = WANT_SETUP && (!HAS_CONFIG || FLAGS.has('--setup'));

let ROOT = path.resolve(POS[0] || CFG.root || (SEA ? path.join(SELF_DIR, 'shared') : '.'));
let DATA = path.resolve(POS[2] || CFG.data || path.join(path.dirname(ROOT), path.basename(ROOT) + '-data'));
let PORT = Number(POS[1] || CFG.port || process.env.PORT || 8080);
// 不带参数的老用法（node share-server.js）保持原样：不自动开浏览器
const AUTO_OPEN = FLAGS.has('--no-open') ? false : (HAS_CONFIG ? CFG.open !== false : (SEA || FORCE_SETUP));
const SETUP_TOKEN = crypto.randomBytes(12).toString('hex');
let listenPort = PORT;                                        // 真正在听的端口（向导里可能改）

const MIN_FREE = 500 * 1024 * 1024;
const DIR_FILES = '文件';
const DIR_TEXT = '快捷文本';
// 向导里改完共享目录要就地生效，所以这两个路径跟着 DATA 重新算（见 applyConfig）
let NOTES = path.join(DATA, 'notes.jsonl');
let META = path.join(DATA, 'files.json');
const NOTE_MAX_CHARS = 20000;
const MAX_UPLOAD = Number(process.env.SHARE_MAX_UPLOAD || 4 * 1024 * 1024 * 1024); // 单文件上限 4 GiB
const MIN_FREE_MID = 200 * 1024 * 1024;  // 传输中途最低剩余空间
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/* —— Host / Origin 校验：挡 DNS rebinding 与跨站请求 —— */
function localHostNames() {
  const set = new Set(['localhost', '127.0.0.1', '::1']);
  try {
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) for (const a of (ifs[k] || [])) if (a && a.address) set.add(String(a.address).toLowerCase());
  } catch {}
  String(process.env.SHARE_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(x => set.add(x));
  return set;
}
const HOSTS = localHostNames();
function hostNameOf(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) { const i = s.indexOf(']'); return (i > 0 ? s.slice(1, i) : s).toLowerCase(); }
  const i = s.lastIndexOf(':');
  return ((i > 0 && s.indexOf(':') === i) ? s.slice(0, i) : s).toLowerCase();
}
function sameSite(req) {
  const h = hostNameOf(req.headers.host);
  if (!h || !HOSTS.has(h)) return false;
  const o = req.headers.origin;
  if (o === undefined) return true;          // 非浏览器发起的请求（curl / 本机脚本）
  if (!o || o === 'null') return false;      // 沙箱/不透明源：拒绝
  try { return HOSTS.has(hostNameOf(new URL(o).host)); } catch { return false; }
}

// 向导模式：只把默认的共享目录建出来（否则向导第 1 步一打开就是个打不开的路径），
// 数据目录等用户确认了再建（见 applyConfig）
if (!setupMode) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
} else {
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.amr': 'audio/amr',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.apk': 'application/vnd.android.package-archive'
};
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']); // 不含 svg：避免内联 SVG 脚本

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const extOf = n => { const i = String(n).lastIndexOf('.'); return i < 0 ? '' : String(n).slice(i).toLowerCase(); };
const isImg = n => IMG_EXT.has(extOf(n));

function human(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function freeBytes() { try { const s = fs.statfsSync(ROOT); return s.bavail * s.bsize; } catch { return undefined; } }
function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}
// 回环 = 服务器本机（等同于主人身份）
function isHostSelf(ip) { return ip === '127.0.0.1' || ip === '::1'; }

/* —— 身份：浏览器 cookie（不依赖 IP，IP 会变）—— */
const COOKIE = 'lan_id';
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
// 没带就跑下发一个（浏览器此后每次请求都会带上）
function ensureId(req, res) {
  const c = parseCookies(req);
  const id = String(c[COOKIE] || '').toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 32);
  if (id.length >= 16) return id;
  const fresh = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', COOKIE + '=' + fresh + '; Path=/; Max-Age=63072000; HttpOnly; SameSite=Lax');
  return fresh;
}
// 归属判定：优先 cookie 身份；没有 id 的旧数据退回按 IP 比
function ownerOk(m, meId, ip) {
  if (!m) return false;
  if (m.id) return m.id === meId;
  return !!m.ip && m.ip === ip;
}
function canDeleteFile(rel, meId, ip) {
  if (isHostSelf(ip)) return true;
  return ownerOk(readMeta()[rel], meId, ip);
}
function todayFolder() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function safeName(raw) {
  let n = path.basename(String(raw || '')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  n = n.replace(/[\\/:*?"<>|]/g, '_');
  if (!n || n === '.' || n === '..') n = 'unnamed';
  if (n[0] === '.') n = '_' + n;
  if (RESERVED_NAME.test(n)) n = '_' + n;
  if (n.length > 120) n = n.slice(0, 100) + path.extname(n).slice(0, 20);
  return n;
}
function uniqueIn(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name), base = path.basename(name, ext);
  for (let i = 2; i < 2000; i++) { const c = `${base} (${i})${ext}`; if (!fs.existsSync(path.join(dir, c))) return c; }
  return `${base}-${Date.now()}${ext}`;
}
function safeRel(rel) {
  const segs = String(rel || '').split('/').map(s => s.trim()).filter(s => s && s !== '.' && s !== '..')
    .map(s => { const t = s.replace(/[\\:*?"<>|\u0000-\u001f]/g, '_'); return RESERVED_NAME.test(t) ? '_' + t : t; });
  if (!segs.length) return null;
  const p = path.resolve(path.join(ROOT, ...segs));
  if (p !== path.resolve(ROOT) && !p.startsWith(path.resolve(ROOT) + path.sep)) return null;
  return { rel: segs.join('/'), full: p, segs };
}

/* ---------- 元数据 ---------- */
function readMeta() { try { return JSON.parse(fs.readFileSync(META, 'utf8')) || {}; } catch { return {}; } }
function writeMeta(m) { try { fs.writeFileSync(META, JSON.stringify(m)); } catch {} }
function setFileMeta(rel, ip, id) { const m = readMeta(); m[rel] = { id: id || '', ip, t: Date.now() }; writeMeta(m); }

/* ---------- 文本便签 ---------- */
function readNotes() {
  try {
    return fs.readFileSync(NOTES, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function writeNotes(list) { fs.writeFileSync(NOTES, list.map(n => JSON.stringify(n)).join('\n') + (list.length ? '\n' : '')); }
function noteFileName(t) {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function addNote(text, ip, meId) {
  const list = readNotes();
  const t = Date.now();
  const n = { id: t.toString(36) + Math.random().toString(36).slice(2, 7), t, text, ip };
  try {
    const dir = path.join(ROOT, DIR_TEXT);
    fs.mkdirSync(dir, { recursive: true });
    const name = uniqueIn(dir, noteFileName(t) + '.txt');
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
    n.file = DIR_TEXT + '/' + name;
    setFileMeta(n.file, ip, meId);
  } catch {}
  list.push(n);
  writeNotes(list);
  return n;
}
function removeNoteFile(n) {
  if (!n || !n.file) return;
  const t = safeRel(n.file);
  if (t) { try { fs.unlinkSync(t.full); } catch {} }
  const m = readMeta();
  if (m[n.file]) { delete m[n.file]; writeMeta(m); }
}
function readBody(req, limit) {
  return new Promise(resolve => {
    let d = '', over = false;
    req.on('data', c => { if (over) return; d += c; if (d.length > limit) over = true; });
    req.on('end', () => resolve(over ? null : d));
    req.on('error', () => resolve(null));
  });
}

/* ---------- 文件清单 ---------- */
function listFiles() {
  const meta = readMeta();
  const out = [];
  const walk = (dir, relDir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name[0] === '.') continue;
      const full = path.join(dir, e.name);
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(full, rel, depth + 1); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      out.push({ rel, folder: relDir, name: e.name, size: st.size, mtime: st.mtimeMs, ip: (meta[rel] || {}).ip || '', id: (meta[rel] || {}).id || '' });
    }
  };
  walk(ROOT, '', 1);
  // 分组顺序：快捷文本置顶；其余按日期倒序（最近的在上）；组内按修改时间倒序
  out.sort((a, b) => {
    const ra = a.folder === DIR_TEXT ? 0 : 1, rb = b.folder === DIR_TEXT ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.folder === b.folder) return b.mtime - a.mtime;
    return a.folder > b.folder ? -1 : 1;
  });
  const valid = new Set(out.map(x => x.rel));
  let changed = false;
  for (const k of Object.keys(meta)) if (!valid.has(k)) { delete meta[k]; changed = true; }
  if (changed) writeMeta(meta);
  return out;
}

/* 类型只用来选底色和文字标签：emoji 不受 CSS color 影响，所以不用 emoji */
const KIND_BY_EXT = {
  '.mp4': 'video', '.mkv': 'video', '.mov': 'video', '.avi': 'video', '.webm': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.amr': 'audio', '.flac': 'audio', '.ogg': 'audio',
  '.pdf': 'pdf',
  '.doc': 'doc', '.docx': 'doc',
  '.xls': 'sheet', '.xlsx': 'sheet', '.csv': 'sheet',
  '.ppt': 'slide', '.pptx': 'slide',
  '.zip': 'zip', '.rar': 'zip', '.7z': 'zip', '.tar': 'zip', '.gz': 'zip',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.log': 'text',
  '.apk': 'apk', '.exe': 'exe', '.msi': 'exe', '.bat': 'exe', '.ps1': 'exe'
};
const kindOf = n => KIND_BY_EXT[extOf(n)] || 'file';
function kindLabel(n) {
  const e = extOf(n).replace('.', '').toUpperCase();
  if (!e) return 'FILE';
  if (e === 'JPEG') return 'JPG';
  return e.slice(0, 4);
}

/* ---------- 页面 ---------- */
function fileGroupHtml(files, me, meIp) {
  if (!files.length) {
    return `<div class="empty"><div class="eicon">📭</div><div class="etitle">还没有文件</div>
      <div class="esub">点上面的「选择文件」，或把文件拖到页面任意位置</div></div>`;
  }
  const groups = [];
  const idx = new Map();
  for (const f of files) {
    const k = f.folder || '（根目录）';
    if (!idx.has(k)) { idx.set(k, groups.length); groups.push({ k, list: [] }); }
    groups[idx.get(k)].list.push(f);
  }
  const p2 = n => String(n).padStart(2, '0');
  // 默认展开：快捷文本（若有）+ 最新那个日期分组
  const openKeys = new Set();
  if (groups.length) openKeys.add(groups[0].k);
  const firstDate = groups.find(x => x.k !== DIR_TEXT);
  if (firstDate) openKeys.add(firstDate.k);
  return groups.map(g => {
    const rows = g.list.map(f => {
      const d = new Date(f.mtime);
      const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      const segs = f.folder.split('/').filter(Boolean).concat([f.name]);
      const rel = segs.join('/');
      const href = '/f/' + segs.map(encodeURIComponent).join('/');
      const imgUrl = '/i/' + segs.map(encodeURIComponent).join('/');
      const kind = kindOf(f.name);
      const thumb = isImg(f.name)
        ? `<img class="thumb" src="${imgUrl}" data-img="${imgUrl}" loading="lazy" alt="">`
        : `<span class="thumb ico">${kindLabel(f.name)}</span>`;
      const canDel = isHostSelf(meIp) || ownerOk(f, me, meIp);
      const act = canDel
        ? `<button class="btn ghost danger fdel" data-rel="${esc(rel)}" data-name="${esc(f.name)}" title="删除" aria-label="删除 ${esc(f.name)}">✕</button>`
        : `<span class="editlock" title="只有上传者能删除">🔒</span>`;
      return `<li class="frow" data-name="${esc(f.name.toLowerCase())}" data-rel="${esc(rel)}" data-kind="${kind}" data-size="${f.size}"><input type="checkbox" class="selbox" aria-label="选择 ${esc(f.name)}"><a class="row" href="${href}">
  ${thumb}
  <span class="mid"><span class="nm">${esc(f.name)}</span><span class="meta">${esc(f.ip || '未记录')} · ${ts}</span></span>
  <span class="sz">${human(f.size)}</span>
</a>${act}</li>`;
    }).join('');
    return `<details class="grp" data-folder="${esc(g.k)}"${openKeys.has(g.k) ? ' open' : ''}><summary class="folder"><span class="chev">▸</span><span class="fname">📂 ${esc(g.k)}</span><span class="cnt">${g.list.length}</span></summary><ul class="list">${rows}</ul></details>`;
  }).join('');
}

function page(files, me, meIp) {
  const free = freeBytes();

  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#2563eb">
<meta name="color-scheme" content="light dark">
<title>局域网共享</title>
<style>
 :root{
  --bg:#f2f4f8; --card:#fff; --line:rgba(17,24,39,.08); --fg:#111827; --muted:#6b7280;
  --accent:#2563eb; --accent-soft:#e8efff; --danger:#dc2626; --ok:#059669; --radius:14px;
  --shadow:0 1px 2px rgba(16,24,40,.04), 0 4px 14px rgba(16,24,40,.06);
 }
 @media (prefers-color-scheme:dark){
  :root{ --bg:#0e0f12; --card:#18191d; --line:rgba(255,255,255,.09); --fg:#e8eaed; --muted:#9aa0a6;
         --accent:#6ea8fe; --accent-soft:#1e2a3d; --danger:#f87171; --ok:#34d399;
         --shadow:0 1px 2px rgba(0,0,0,.4), 0 6px 18px rgba(0,0,0,.35); }
 }
 *{box-sizing:border-box}
 html,body{margin:0}
 body{
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  background:var(--bg); color:var(--fg); -webkit-font-smoothing:antialiased;
  padding-bottom:calc(32px + env(safe-area-inset-bottom));
 }
 .wrap{max-width:840px;margin:0 auto;padding:0 14px}
 header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;
   padding:16px 0 2px}
 .brand h1{font-size:19px;margin:0;letter-spacing:.2px}
 .sub{color:var(--muted);font-size:12.5px;margin-top:3px}
 .chips{display:flex;gap:6px;flex-wrap:wrap;margin:0}
 .chip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px 11px;
   font-size:12px;color:var(--muted);box-shadow:var(--shadow);white-space:nowrap}
 .chip b{color:var(--fg);font-weight:600}
 nav{position:sticky;top:0;z-index:20;background:var(--bg);
   background:color-mix(in srgb,var(--bg) 86%,transparent);
   backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
   border-bottom:1px solid var(--line);margin:8px -14px 0;padding:8px 14px;
   display:flex;align-items:center;gap:8px}
 .tabs{position:relative;display:flex;gap:5px;background:var(--card);border:1px solid var(--line);
   border-radius:12px;padding:4px;box-shadow:var(--shadow);flex:0 0 auto}
 .pill{position:absolute;top:4px;bottom:4px;left:0;width:0;border-radius:9px;background:var(--accent);
   box-shadow:0 2px 10px rgba(37,99,235,.32);z-index:0;
   transition:transform .15s cubic-bezier(.32,.72,0,1), width .15s cubic-bezier(.32,.72,0,1)}
 .tab{position:relative;z-index:1;text-align:center;padding:9px 13px;border-radius:9px;
   font:600 14px/1 inherit;color:var(--muted);cursor:pointer;border:0;background:transparent;
   transition:color .2s;white-space:nowrap}
 .tab.on{color:#fff}
 @media (prefers-color-scheme:dark){ .tab.on{color:#0b1220} }
 .navsearch{flex:1;min-width:0;display:flex}
 .search{width:100%;min-width:0;padding:9px 12px;border:1px solid var(--line);border-radius:10px;
   background:var(--card);color:inherit;font:14px inherit;outline:none}
 .search:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
 section{padding-top:18px}
 .pane{opacity:0;transform:translateY(10px);transition:opacity .16s ease, transform .16s cubic-bezier(.32,.72,0,1)}
 .pane.in{opacity:1;transform:none}
 .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
 .pad{padding:14px}
 textarea{width:100%;min-height:104px;padding:13px;border:1px solid var(--line);border-radius:11px;
   font:15px/1.65 inherit;resize:vertical;background:transparent;color:inherit;outline:none}
 textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
 .rowflex{display:flex;justify-content:space-between;align-items:center;margin-top:9px;gap:10px}
 .count{color:var(--muted);font-size:12px;flex:1;min-width:0}
 .btn{border:0;border-radius:11px;padding:11px 18px;font:600 15px/1 inherit;background:var(--accent);
   color:#fff;cursor:pointer;transition:transform .12s, box-shadow .15s, background .15s;
   box-shadow:0 2px 8px rgba(37,99,235,.28);white-space:nowrap}
 .btn:hover{filter:brightness(1.06)}
 .btn:active{transform:scale(.97)}
 .btn:disabled{opacity:.5;box-shadow:none;cursor:default}
 .btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line);box-shadow:none;
   font:500 13px/1 inherit;padding:7px 12px}
 .btn.ghost:hover{color:var(--fg);border-color:var(--muted)}
 .btn.ghost.danger:hover{color:var(--danger);border-color:var(--danger)}
 :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
 .drop{border:2px dashed var(--line);border-radius:var(--radius);padding:24px 16px;text-align:center;
   cursor:pointer;transition:.18s;background:var(--card)}
 .drop:hover{border-color:var(--accent);background:var(--accent-soft)}
 .drop .di{font-size:26px}
 .drop .dt{font-weight:600;margin-top:4px}
 .drop .ds{color:var(--muted);font-size:12.5px;margin-top:4px}
 .dragmask{position:fixed;inset:0;z-index:60;background:var(--accent-soft);
   background:color-mix(in srgb,var(--accent) 14%,var(--bg));border:3px dashed var(--accent);
   display:none;place-items:center;font-weight:700;font-size:18px;color:var(--accent)}
 .dragmask.on{display:grid}
 .toolbar{display:flex;gap:6px;align-items:center;margin:14px 0 2px;flex-wrap:nowrap}
 .tbinfo{color:var(--muted);font-size:12.5px;flex:1;min-width:0;overflow:hidden;
   text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
 .btn.mini{padding:7px 10px;font:500 12.5px/1 inherit}
 /* 选择模式的底部操作条 */
 .actbar{position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--card);
   border-top:1px solid var(--line);box-shadow:0 -4px 18px rgba(16,24,40,.10);
   padding:9px 14px calc(9px + env(safe-area-inset-bottom))}
 .actbar .ab{max-width:840px;margin:0 auto;display:flex;align-items:center;gap:8px}
 .abinfo{flex:1;min-width:0;font-size:13.5px;color:var(--muted);white-space:nowrap;overflow:hidden;
   text-overflow:ellipsis}
 .abinfo b{color:var(--fg);font-size:15px}
 body.picking{padding-bottom:calc(96px + env(safe-area-inset-bottom))}
 @media (max-width:430px){
   .actbar{padding:8px 10px calc(8px + env(safe-area-inset-bottom))}
   .actbar .ab{gap:6px}
   .abinfo{font-size:12px}
   .abinfo b{font-size:13.5px}
   .actbar .btn.mini{padding:7px 8px;font:500 12px/1 inherit}
   .actbar #zipBtn{padding:10px 12px;font:600 13.5px/1 inherit}
   body.picking{padding-bottom:calc(86px + env(safe-area-inset-bottom))}
 }
 .folder{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted);
   margin:14px 2px 8px;cursor:pointer;user-select:none;list-style:none;padding:7px 9px;
   border-radius:9px;transition:background .15s}
 .folder::-webkit-details-marker{display:none}
 .folder:hover{background:var(--card);color:var(--fg)}
 .chev{display:inline-block;font-size:10px;transition:transform .18s;color:var(--muted)}
 details.grp[open] .chev{transform:rotate(90deg)}
 .cnt{background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:1px 9px;font-size:12px}
 ul.list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
 li.frow{display:flex;align-items:center;gap:8px}
 .fdel{flex:0 0 auto;padding:9px 13px;border-radius:11px;font-size:14px;line-height:1}
 .editlock{flex:0 0 auto;padding:9px 10px;font-size:14px;opacity:.4;user-select:none}
 li.frow .row{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:11px 13px;
   text-decoration:none;color:inherit;background:var(--card);border:1px solid var(--line);
   border-radius:12px;box-shadow:var(--shadow);transition:.15s}
 li.frow .row:hover{border-color:var(--accent);transform:translateY(-1px)}
 .thumb{width:44px;height:44px;border-radius:10px;object-fit:cover;flex:0 0 auto;background:var(--bg);
   border:1px solid var(--line)}
 img.thumb{cursor:zoom-in}
 .thumb.ico{display:grid;place-items:center;border:1px solid transparent;
   font:800 10.5px/1 inherit;letter-spacing:.4px;color:var(--muted);background:rgba(100,116,139,.12)}
 .mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
 .nm{font-weight:600;font-size:14.5px;word-break:break-all;line-height:1.3}
 .meta{color:var(--muted);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .sz{color:var(--muted);font-size:12.5px;white-space:nowrap;flex:0 0 auto;
   font-variant-numeric:tabular-nums}
 /* 类型底色：emoji 上不了色，所以图标位改成文字标签 + 底色 */
 li[data-kind="video"] .thumb.ico{color:#e11d48;background:rgba(225,29,72,.12)}
 li[data-kind="audio"] .thumb.ico{color:#c026d3;background:rgba(192,38,211,.12)}
 li[data-kind="pdf"]   .thumb.ico{color:#dc2626;background:rgba(220,38,38,.12)}
 li[data-kind="doc"]   .thumb.ico{color:#2563eb;background:rgba(37,99,235,.12)}
 li[data-kind="sheet"] .thumb.ico{color:#059669;background:rgba(5,150,105,.12)}
 li[data-kind="slide"] .thumb.ico{color:#ea580c;background:rgba(234,88,12,.12)}
 li[data-kind="zip"]   .thumb.ico{color:#b45309;background:rgba(180,83,9,.14)}
 li[data-kind="apk"]   .thumb.ico{color:#16a34a;background:rgba(22,163,74,.12)}
 li[data-kind="exe"]   .thumb.ico{color:#475569;background:rgba(71,85,105,.14)}
 li[data-kind="text"]  .thumb.ico{color:#0f766e;background:rgba(15,118,110,.12)}
 /* 多选下载 */
 .selbox{display:none;flex:0 0 auto;width:20px;height:20px;margin:0;accent-color:var(--accent);cursor:pointer}
 #filelist.sel .selbox{display:block}
 #filelist.sel .fdel{display:none}
 li.frow.picked .row{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
 .btn.arm{background:var(--danger);color:#fff;border-color:transparent!important}
 /* 网格视图 */
 #filelist.grid ul.list{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px}
 #filelist.grid li.frow{position:relative;display:block}
 #filelist.grid .selbox{position:absolute;top:6px;left:6px;z-index:2}
 #filelist.grid li.frow .row{flex-direction:column;align-items:stretch;gap:6px;padding:7px}
 #filelist.grid .thumb{width:100%;height:auto;aspect-ratio:1/1;border-radius:9px}
 #filelist.grid .thumb.ico{font-size:15px}
 #filelist.grid .mid{gap:1px}
 #filelist.grid .meta{display:none}
 #filelist.grid .nm{font-size:12.5px;text-align:center;display:-webkit-box;-webkit-line-clamp:2;
   -webkit-box-orient:vertical;overflow:hidden}
 #filelist.grid .sz{font-size:11px;text-align:center}
 #filelist.grid .fdel{position:absolute;top:5px;right:5px;padding:4px 8px;font-size:12px;border:0;
   background:rgba(0,0,0,.5);color:#fff;backdrop-filter:blur(4px)}
 #filelist.grid .fdel.arm{background:var(--danger);color:#fff}
 .notebox{display:flex;flex-direction:column;gap:9px}
 .note{padding:13px 14px;background:var(--card);border:1px solid var(--line);border-radius:12px;
   box-shadow:var(--shadow);display:flex;flex-direction:column;gap:9px}
 .note .head{display:flex;align-items:center;justify-content:space-between;gap:10px}
 .note .time{color:var(--muted);font-size:11.5px}
 .note .body{white-space:pre-wrap;word-break:break-word;font-size:15px;max-height:320px;overflow:auto}
 .acts{display:flex;gap:6px;flex:0 0 auto}
 .morebox{display:flex;padding:2px 0 4px}
 .morebtn{width:100%;padding:10px 14px}
 .empty{text-align:center;padding:40px 20px;color:var(--muted)}
 .eicon{font-size:34px}
 .etitle{font-weight:600;color:var(--fg);margin-top:8px}
 .esub{font-size:13px;margin-top:4px}
 .prog{display:flex;flex-direction:column;gap:8px;margin-top:12px}
 .prow{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:10px 12px;font-size:13.5px}
 .prow .top{display:flex;justify-content:space-between;gap:10px;align-items:center}
 .prow .nmx{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .bar{height:5px;background:var(--bg);border-radius:99px;margin-top:8px;overflow:hidden}
 .bar i{display:block;height:100%;width:0;background:var(--accent);border-radius:99px;transition:width .18s}
 .ok{color:var(--ok)}.bad{color:var(--danger)}
 .sk{border-radius:12px;background:var(--card);border:1px solid var(--line);height:74px;
   animation:pulse 1.4s ease-in-out infinite}
 @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
 .lb{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.9);display:grid;place-items:center;
   opacity:0;transition:opacity .16s;padding:20px}
 .lb.in{opacity:1}
 .lb img{max-width:100%;max-height:100%;border-radius:8px;object-fit:contain}
 .lbclose{position:absolute;top:calc(14px + env(safe-area-inset-top));right:16px;border:0;
   background:rgba(255,255,255,.16);color:#fff;font:600 18px/1 inherit;padding:9px 13px;
   border-radius:11px;cursor:pointer}
 #toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,20px);z-index:90;
   background:#111827;color:#fff;padding:11px 18px;border-radius:11px;font-size:14px;
   opacity:0;pointer-events:none;transition:.22s;max-width:86vw;text-align:center}
 #toast.on{opacity:1;transform:translate(-50%,0)}
 @media (prefers-color-scheme:dark){ #toast{background:#e8eaed;color:#111827} }
 @media (prefers-color-scheme:dark){
   .btn.ghost{border-color:rgba(255,255,255,.16)}
   .btn.ghost:hover{color:var(--fg);border-color:rgba(255,255,255,.36)}
   .actbar{box-shadow:0 -4px 18px rgba(0,0,0,.45)}
   .thumb.ico{color:#9aa0a6;background:rgba(255,255,255,.06)}
   li[data-kind="video"] .thumb.ico{color:#fb7185;background:rgba(251,113,133,.14)}
   li[data-kind="audio"] .thumb.ico{color:#e879f9;background:rgba(232,121,249,.14)}
   li[data-kind="pdf"]   .thumb.ico{color:#f87171;background:rgba(248,113,113,.14)}
   li[data-kind="doc"]   .thumb.ico{color:#7dabff;background:rgba(125,171,255,.14)}
   li[data-kind="sheet"] .thumb.ico{color:#34d399;background:rgba(52,211,153,.14)}
   li[data-kind="slide"] .thumb.ico{color:#fb923c;background:rgba(251,146,60,.14)}
   li[data-kind="zip"]   .thumb.ico{color:#fbbf24;background:rgba(251,191,36,.14)}
   li[data-kind="apk"]   .thumb.ico{color:#4ade80;background:rgba(74,222,128,.14)}
   li[data-kind="exe"]   .thumb.ico{color:#cbd5e1;background:rgba(203,213,225,.12)}
   li[data-kind="text"]  .thumb.ico{color:#5eead4;background:rgba(94,234,212,.14)}
 }
 @media (prefers-reduced-motion:reduce){
  .sk{animation:none}
  .btn:active{transform:none}
  li.frow .row:hover{transform:none}
 }
 [hidden]{display:none!important}
</style></head><body>
<div class="wrap">
  <header>
    <div class="brand">
      <h1>局域网共享</h1>
      <div class="sub">同一 WiFi 下的设备都能用 · 上传 / 下载 / 传文本</div>
    </div>
    ${free === undefined ? '' : `<div class="chips"><span class="chip">💾 可用 <b>${human(free)}</b></span></div>`}
  </header>

  <nav>
    <div class="tabs" id="tabs">
      <span class="pill" id="pill"></span>
      <button class="tab on" id="tabText">📝 文本</button>
      <button class="tab" id="tabFile">📁 文件<span class="n" id="tabCount"> ${files.length}</span></button>
    </div>
    <div class="navsearch">
      <input id="q" class="search" type="search" placeholder="搜索文件名或文本…" aria-label="搜索文件名或文本内容">
    </div>
  </nav>

  <section class="pane" id="secText">
    <div class="card pad">
      <textarea id="ta" placeholder="粘贴或输入文字…（链接、号码、一小段笔记都行）"></textarea>
      <div class="rowflex">
        <span class="count"><b id="cc">0</b> / 20000 · 页面任意处粘贴也会填进来</span>
        <button class="btn" id="send">发送</button>
      </div>
    </div>
    <div id="notelist" class="notebox" style="margin-top:14px"></div>
    <div id="noNoteHit" class="empty" hidden><div class="eicon">🔍</div><div class="etitle">没有匹配的文本</div></div>
  </section>

  <section class="pane" id="secFile" hidden>
    <div class="drop" id="drop">
      <div class="di">📤</div>
      <div class="dt">点这里选择文件</div>
      <div class="ds">自动存入 文件/${todayFolder()}/ · 电脑上也可以直接拖进来</div>
      <input id="file" type="file" multiple hidden>
    </div>
    <div class="prog" id="prog"></div>

    <div class="toolbar">
      <span class="tbinfo" id="listInfo"></span>
      <button class="btn ghost mini" id="viewBtn" title="切换列表 / 网格视图">▦ 网格</button>
      <button class="btn ghost mini" id="sortBtn" title="切换排序：时间 / 大小 / 名称">⇅ 时间</button>
      <button class="btn ghost mini" id="expandBtn" title="展开或收起全部分组">展开</button>
      <button class="btn ghost mini" id="selBtn" title="选择要下载的文件">☑ 选择</button>
    </div>

    <div id="filelist">
      ${fileGroupHtml(files, me, meIp)}
    </div>
    <div id="noHit" class="empty" hidden><div class="eicon">🔍</div><div class="etitle">没有匹配的内容</div></div>
  </section>
</div>

<div class="dragmask" id="mask">松开即可上传</div>
<div class="lb" id="lb" hidden><img id="lbimg" alt=""><button class="lbclose" id="lbclose">关闭 ✕</button></div>
<div class="actbar" id="actbar" hidden>
  <div class="ab">
    <span class="abinfo"><b id="abCount">0</b> 已选</span>
    <button class="btn ghost mini" id="allBtn" title="全选当前显示的文件">全选</button>
    <button class="btn ghost mini" id="selOffBtn" title="退出选择并清空">取消</button>
    <button class="btn ghost mini" id="dlOneBtn" title="每个文件单独下载一个" disabled>分别下载</button>
    <button class="btn" id="zipBtn" title="打包成一个 zip 下载" disabled>⬇ 合并下载</button>
  </div>
</div>
<div id="toast" aria-live="polite"></div>

<script>
const $ = id => document.getElementById(id);
const ta = $('ta'), sendBtn = $('send'), notelist = $('notelist'), prog = $('prog'), cc = $('cc');
let toastTimer;

function toast(msg, bad){
  const t = $('toast'); t.textContent = msg;
  t.style.background = bad ? '#dc2626' : '';
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}
function fmtTime(ms){
  const d = new Date(ms), p = n => String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
function fmtSpeed(bps){
  if (!bps || bps < 1) return '';
  if (bps < 1048576) return (bps/1024).toFixed(0) + ' KB/s';
  return (bps/1048576).toFixed(1) + ' MB/s';
}

/* ---------- 页签 ---------- */
const tabsEl = $('tabs'), pill = $('pill');
const secText = $('secText'), secFile = $('secFile');
let curPane = null, tabGen = 0;

function movePill(btn, instant){
  const box = tabsEl.getBoundingClientRect(), b = btn.getBoundingClientRect();
  if (instant) pill.style.transition = 'none';
  pill.style.width = b.width + 'px';
  pill.style.transform = 'translateX(' + (b.left - box.left - tabsEl.clientLeft) + 'px)';
  if (instant) { void pill.offsetWidth; pill.style.transition = ''; }
}
function showTab(which, instant){
  const isFile = which === 'file';
  const next = isFile ? secFile : secText;
  const btn = isFile ? $('tabFile') : $('tabText');
  $('tabText').classList.toggle('on', !isFile);
  $('tabFile').classList.toggle('on', isFile);
  movePill(btn, instant || !curPane);
  try { localStorage.setItem('lanTab', which); } catch {}
  if (curPane === next) return;
  const g = ++tabGen, prev = curPane;
  curPane = next;
  // 关键：除 next 之外的面板一律隐藏，否则它会不可见却仍然占位（顶部出现大块空白）
  const hideOthers = () => {
    if (secText !== next) { secText.hidden = true; secText.classList.remove('in'); }
    if (secFile !== next) { secFile.hidden = true; secFile.classList.remove('in'); }
  };
  const swapIn = noAnim => {
    hideOthers();
    next.hidden = false;
    if (noAnim) { next.classList.add('in'); return; }
    next.classList.remove('in');
    requestAnimationFrame(() => requestAnimationFrame(() => { if (g === tabGen) next.classList.add('in'); }));
  };
  if (prev && !instant) {
    prev.classList.remove('in');
    setTimeout(() => { if (g !== tabGen) return; swapIn(false); }, 140);
  } else {
    swapIn(!!instant);
  }
}
$('tabText').onclick = () => { showTab('text'); loadNotes(); applyFilter(); };
$('tabFile').onclick = () => { showTab('file'); loadFiles(); applyFilter(); };
window.addEventListener('resize', () => movePill($('tabFile').classList.contains('on') ? $('tabFile') : $('tabText'), true));

/* ---------- 灯箱 ---------- */
const lb = $('lb'), lbimg = $('lbimg');
function openLb(src){ lbimg.src = src; lb.hidden = false; requestAnimationFrame(() => lb.classList.add('in')); }
function closeLb(){
  lb.classList.remove('in');
  setTimeout(() => { lb.hidden = true; lbimg.removeAttribute('src'); }, 160);
}
lb.addEventListener('click', closeLb);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) closeLb(); });
document.addEventListener('click', ev => {
  const im = ev.target && ev.target.closest ? ev.target.closest('[data-img]') : null;
  if (!im) return;
  ev.preventDefault();
  openLb(im.getAttribute('data-img'));
});

/* ---------- 文本 ---------- */
async function copyText(t){
  try { await navigator.clipboard.writeText(t); toast('已复制'); }
  catch (e) {
    const tmp = document.createElement('textarea');
    tmp.value = t; tmp.style.position='fixed'; tmp.style.opacity='0';
    document.body.appendChild(tmp); tmp.select();
    try { document.execCommand('copy'); toast('已复制'); }
    catch (_) { toast('请长按文字手动复制', true); }
    document.body.removeChild(tmp);
  }
}
function noteCard(n){
  const li = document.createElement('div'); li.className = 'note'; li.dataset.text = String(n.text || '').toLowerCase();
  const head = document.createElement('div'); head.className = 'head';
  const time = document.createElement('span'); time.className = 'time';
  time.textContent = (n.ip ? n.ip + ' · ' : '') + fmtTime(n.t);
  const acts = document.createElement('span'); acts.className = 'acts';
  const cp = document.createElement('button'); cp.className='btn ghost'; cp.textContent='复制'; cp.setAttribute('aria-label','复制这条文本');
  cp.onclick = () => copyText(n.text);
  const del = document.createElement('button'); del.className='btn ghost danger'; del.textContent='删除'; del.setAttribute('aria-label','删除这条文本');
  del.onclick = async () => {
    if (!del.classList.contains('arm')) {
      del.classList.add('arm');
      del.textContent = '确认删除?';
      setTimeout(() => { del.classList.remove('arm'); del.textContent = '删除'; }, 3000);
      return;
    }
    del.classList.remove('arm');
    try {
      const r = await fetch('/t/' + n.id, { method: 'DELETE' });
      if (r.ok) { toast('已删除'); loadNotes(); } else toast('删除失败', true);
    } catch (e) { toast('删除失败', true); }
  };
  acts.appendChild(cp); acts.appendChild(del);
  head.appendChild(time); head.appendChild(acts);
  const body = document.createElement('div'); body.className = 'body'; body.textContent = n.text;
  li.appendChild(head); li.appendChild(body);
  return li;
}
function skeleton(){
  notelist.textContent = '';
  for (let i = 0; i < 2; i++) { const d = document.createElement('div'); d.className = 'sk'; notelist.appendChild(d); }
}
let recentList = [], olderList = null, olderCount = 0, olderOpen = false;
function moreBox(n){
  const box = document.createElement('div'); box.className = 'morebox';
  const b = document.createElement('button'); b.className = 'btn ghost morebtn';
  b.textContent = olderOpen ? '收起更早的文本' : '查看更早信息（' + n + '）';
  b.setAttribute('aria-label', '查看更早的文本');
  b.onclick = async () => {
    olderOpen = !olderOpen;
    if (olderOpen && olderList === null) { b.textContent = '加载中…'; await loadOlder(); return; }
    renderNotes();
  };
  box.appendChild(b);
  return box;
}
function renderNotes(){
  notelist.textContent = '';
  if (!recentList.length && !olderCount) {
    const e = document.createElement('div'); e.className = 'empty';
    e.innerHTML = '<div class="eicon">📝</div><div class="etitle">还没有文本</div><div class="esub">在上面输入框发一条试试</div>';
    return notelist.appendChild(e);
  }
  recentList.forEach(n => notelist.appendChild(noteCard(n)));
  if (!recentList.length) {
    const h = document.createElement('div'); h.className = 'empty';
    h.innerHTML = '<div class="etitle">一天内没有新文本</div><div class="esub">更早的内容见下面的入口</div>';
    notelist.appendChild(h);
  }
  if (olderCount > 0) notelist.appendChild(moreBox(olderCount));
  if (olderOpen && olderList && olderList.length) {
    const box = document.createElement('div'); box.className = 'notebox';
    olderList.forEach(n => box.appendChild(noteCard(n)));
    notelist.appendChild(box);
  }
  applyFilter();
}
async function loadOlder(){
  try {
    const r = await fetch('/t/list?older=1', { cache: 'no-store' });
    olderList = r.ok ? await r.json() : [];
  } catch (e) { olderList = []; }
  renderNotes();
}
async function loadNotes(){
  try {
    const r = await fetch('/t/list', { cache: 'no-store' });
    if (!r.ok) return;
    recentList = await r.json();
    olderCount = Number(r.headers && r.headers.get ? r.headers.get('X-Older-Count') : 0) || 0;
    if (olderOpen && olderList !== null) {
      const r2 = await fetch('/t/list?older=1', { cache: 'no-store' });
      if (r2.ok) olderList = await r2.json();
    }
    renderNotes();
  } catch (e) { notelist.textContent = ''; }
}
// 局部刷新文件列表（不整页重载，保留搜索词/视图/展开状态）
async function loadFiles(){
  try {
    const r = await fetch('/', { cache: 'no-store' });
    if (!r.ok || typeof r.text !== 'function') return;
    const html = await r.text();
    if (typeof DOMParser === 'undefined') return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const fresh = doc.getElementById('filelist');
    if (!fresh) return;
    $('filelist').innerHTML = fresh.innerHTML;
    const fc = doc.getElementById('tabCount');
    if (fc) $('tabCount').textContent = fc.textContent;
    applyView();
    applyFilter();
    applySort();
    applyOpenState();
    applyPicked();
  } catch (e) {}
}
function updCount(){ cc.textContent = String(ta.value.length); }
ta.addEventListener('input', updCount);
sendBtn.onclick = async () => {
  const text = ta.value.trim();
  if (!text) return ta.focus();
  sendBtn.disabled = true; sendBtn.textContent = '发送中…';
  try {
    const r = await fetch('/t', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text })
    });
    if (r.ok) { ta.value = ''; updCount(); await loadNotes(); toast('已发送'); }
    else toast('发送失败：' + r.status, true);
  } catch (e) { toast('发送失败：' + e.message, true); }
  sendBtn.disabled = false; sendBtn.textContent = '发送';
};
ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendBtn.click(); });

/* 页面任意处粘贴 -> 填入输入框 */
window.addEventListener('paste', e => {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  const t = e.clipboardData && e.clipboardData.getData('text/plain');
  if (!t) return;
  if (secText.hidden) showTab('text');
  ta.value = t; updCount(); ta.focus();
  toast('已粘贴到输入框');
});

/* ---------- 上传 ---------- */
const drop = $('drop'), inp = $('file'), mask = $('mask');
drop.addEventListener('click', () => inp.click());
inp.addEventListener('change', () => { upload(Array.from(inp.files)); inp.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) mask.classList.add('on'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; mask.classList.remove('on'); } });
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; mask.classList.remove('on');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) upload(Array.from(e.dataTransfer.files));
});

function upload(files){
  if (!files.length) return;
  showTab('file');
  let done = 0, failed = 0;
  files.forEach(f => {
    const row = document.createElement('div'); row.className = 'prow';
    const top = document.createElement('div'); top.className = 'top';
    const nm = document.createElement('span'); nm.className = 'nmx'; nm.textContent = f.name;
    const pct = document.createElement('span'); pct.className = 'sz'; pct.textContent = '准备中…';
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    top.appendChild(nm); top.appendChild(pct);
    row.appendChild(top); row.appendChild(bar);
    prog.appendChild(row);

    const t0 = Date.now();
    const x = new XMLHttpRequest();
    x.open('PUT', '/u/' + encodeURIComponent(f.name));
    x.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const p = Math.round(e.loaded / e.total * 100);
      const dt = (Date.now() - t0) / 1000;
      const sp = dt > 0.3 ? fmtSpeed(e.loaded / dt) : '';
      pct.textContent = p + '%' + (sp ? ' · ' + sp : '');
      fill.style.width = p + '%';
    };
    const finish = (ok, msg) => {
      pct.textContent = msg;
      pct.className = 'sz ' + (ok ? 'ok' : 'bad');
      fill.style.width = '100%';
      if (!ok) { fill.style.background = 'var(--danger)'; failed++; }
      if (++done === files.length) {
        toast(failed ? failed + ' 个文件上传失败' : '上传完成', !!failed);
        setTimeout(async () => {
          try {
            await loadFiles();
            await loadNotes();
            prog.textContent = '';
            applySort();
            applyOpenState();
            applyPicked();
          } catch (e) {}
        }, 700);
      }
    };
    x.onload = () => finish(x.status < 300, x.status < 300 ? '✅ 完成' : '❌ ' + x.status);
    x.onerror = () => finish(false, '❌ 网络错误');
    x.send(f);
  });
}

/* ---------- 文件操作（删除改成二次点击确认，替掉原生 confirm） ---------- */
let armedBtn = null, armTimer = 0;
function disarm(){
  if (armedBtn) {
    armedBtn.classList.remove('arm');
    const t = armedBtn.getAttribute('data-x');
    if (t) armedBtn.textContent = t;
  }
  armedBtn = null;
  clearTimeout(armTimer);
}
document.addEventListener('click', ev => {
  const t = ev.target;
  if (armedBtn && (!t || !t.closest || !t.closest('.fdel'))) disarm();
}, true);
$('filelist').addEventListener('click', async ev => {
  const b = ev.target && ev.target.closest ? ev.target.closest('.fdel') : null;
  if (!b) return;
  ev.preventDefault();
  if (armedBtn !== b) {
    disarm();
    armedBtn = b;
    b.setAttribute('data-x', b.textContent);
    b.classList.add('arm');
    b.textContent = '确认?';
    armTimer = setTimeout(disarm, 3000);
    toast('再点一次就删除');
    return;
  }
  disarm();
  const rel = b.getAttribute('data-rel') || '';
  const name = b.getAttribute('data-name') || rel;
  b.disabled = true;
  try {
    const url = '/f/' + rel.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(url, { method: 'DELETE' });
    if (r.status === 403) { toast('只有上传者能删除这个文件', true); b.disabled = false; return; }
    if (!r.ok) { toast('删除失败：' + r.status, true); b.disabled = false; return; }
    const li = b.closest('li'), grp = b.closest('details'), ul = li && li.parentNode;
    const cnt = grp ? grp.querySelector('.cnt') : null;
    if (cnt) cnt.textContent = Math.max(0, (parseInt(cnt.textContent, 10) || 1) - 1);
    li.style.transition = 'opacity .18s ease, transform .18s ease';
    li.style.opacity = '0';
    li.style.transform = 'translateX(14px)';
    setTimeout(() => {
      if (li.parentNode) li.parentNode.removeChild(li);
      if (ul && ul.children.length === 0 && grp && grp.parentNode) grp.parentNode.removeChild(grp);
      const tb = $('tabCount');
      if (tb) tb.textContent = ' ' + Math.max(0, (parseInt(tb.textContent, 10) || 1) - 1);
      toast('已删除 ' + name);
      applyFilter();
    }, 190);
  } catch (e) { toast('删除失败：' + e.message, true); b.disabled = false; }
});

/* ---------- 工具栏：搜索 / 网格 / 展开 ---------- */
let suppressToggle = false;      // 搜索时自动展开分组，不写进记忆
function applyFilter(){
  const q = ($('q').value || '').trim().toLowerCase();
  let shown = 0, total = 0;
  const groups = document.querySelectorAll('#filelist details.grp');
  suppressToggle = true;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    let n = 0;
    const rows = g.querySelectorAll('li.frow');
    for (let j = 0; j < rows.length; j++) {
      total++;
      const hit = !q || (rows[j].getAttribute('data-name') || '').indexOf(q) >= 0;
      rows[j].hidden = !hit;
      if (hit) n++;
    }
    if (q) g.open = n > 0;             // 搜索时自动展开命中的分组
    g.hidden = n === 0;
    shown += n;
  }
  suppressToggle = false;
  const notes = document.querySelectorAll('#notelist .note');
  let nhit = 0;
  for (let i = 0; i < notes.length; i++) {
    const hit = !q || (notes[i].dataset.text || '').indexOf(q) >= 0;
    notes[i].hidden = !hit;
    if (hit) nhit++;
  }
  $('noHit').hidden = !(q && shown === 0);
  $('noNoteHit').hidden = !(q && notes.length > 0 && nhit === 0);
  $('listInfo').textContent = q ? ('命中 ' + shown + ' / ' + total) : (total + ' 个文件');
  if (typeof syncBtns === 'function') syncBtns();
}
$('q').addEventListener('input', applyFilter);

let gridMode = false;
try { gridMode = localStorage.getItem('lanGrid') === '1'; } catch {}
function applyView(){
  $('filelist').classList.toggle('grid', gridMode);
  $('viewBtn').textContent = gridMode ? '☰ 列表' : '▦ 网格';
  try { localStorage.setItem('lanGrid', gridMode ? '1' : '0'); } catch {}
}
$('viewBtn').onclick = () => { gridMode = !gridMode; applyView(); };

/* ---------- 排序（只排分组内部，分组本身仍按日期倒序） ---------- */
let sortMode = 'time';
try { sortMode = localStorage.getItem('lanSort') || 'time'; } catch {}
function sortLabel(){ return sortMode === 'size' ? '大小' : (sortMode === 'name' ? '名称' : '时间'); }
function applySort(){
  $('sortBtn').textContent = '⇅ ' + sortLabel();
  try { localStorage.setItem('lanSort', sortMode); } catch {}
  if (sortMode !== 'time') {
    const lists = filelistEl.querySelectorAll('ul.list');
    for (let i = 0; i < lists.length; i++) {
      const rows = Array.prototype.slice.call(lists[i].children);
      rows.sort((a, b) => {
        if (sortMode === 'name') {
          const x = a.getAttribute('data-name') || '', y = b.getAttribute('data-name') || '';
          return x < y ? -1 : (x > y ? 1 : 0);
        }
        return Number(b.getAttribute('data-size') || 0) - Number(a.getAttribute('data-size') || 0);
      });
      for (let k = 0; k < rows.length; k++) lists[i].appendChild(rows[k]);
    }
    applyPicked();
  }
}
$('sortBtn').onclick = () => {
  sortMode = sortMode === 'time' ? 'size' : (sortMode === 'size' ? 'name' : 'time');
  applySort();
  toast('按' + sortLabel() + '排序');
};

/* ---------- 分组展开状态记忆 ---------- */
const OPEN_KEY = 'lanOpen';
let openMap = {};
try { openMap = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') || {}; } catch { openMap = {}; }
function applyOpenState(){
  const gs = document.querySelectorAll('#filelist details.grp');
  for (let i = 0; i < gs.length; i++) {
    const k = gs[i].getAttribute('data-folder') || '';
    if (k && Object.prototype.hasOwnProperty.call(openMap, k)) gs[i].open = !!openMap[k];
    if (!gs[i].__bound) { gs[i].addEventListener('toggle', onGrpToggle); gs[i].__bound = 1; }
  }
  syncExpandBtn();
}
function onGrpToggle(ev){
  if (suppressToggle) return;
  const d = ev.target || ev.currentTarget;
  if (!d || !d.getAttribute) return;
  const k = d.getAttribute('data-folder') || '';
  if (!k) return;
  openMap[k] = d.open ? 1 : 0;
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(openMap)); } catch {}
  syncExpandBtn();
}
function syncExpandBtn(){
  const gs = document.querySelectorAll('#filelist details.grp');
  let closed = 0;
  for (let i = 0; i < gs.length; i++) if (!gs[i].open) closed++;
  $('expandBtn').textContent = (gs.length && closed === 0) ? '收起' : '展开';
}
$('expandBtn').onclick = () => {
  const all = document.querySelectorAll('#filelist details.grp');
  let anyClosed = false;
  for (let i = 0; i < all.length; i++) if (!all[i].open) anyClosed = true;
  suppressToggle = true;
  for (let i = 0; i < all.length; i++) {
    all[i].open = anyClosed;
    const k = all[i].getAttribute('data-folder') || '';
    if (k) openMap[k] = anyClosed ? 1 : 0;
  }
  suppressToggle = false;
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(openMap)); } catch {}
  syncExpandBtn();
};

/* ---------- 选择模式 + 底部操作条 ---------- */
const filelistEl = $('filelist'), selBtn = $('selBtn'), zipBtn = $('zipBtn'), allBtn = $('allBtn');
const dlOneBtn = $('dlOneBtn');
const picked = new Set();          // 存 rel，刷新列表后仍保留选择
function picking(){ return !$('actbar').hidden; }
function allPicked(){
  const items = filelistEl.querySelectorAll('li.frow');
  let any = false;
  for (let i = 0; i < items.length; i++) {
    if (items[i].hidden) continue;
    any = true;
    const r = items[i].getAttribute('data-rel') || '';
    if (!r || !picked.has(r)) return false;
  }
  return any;
}
function syncBtns(){
  $('abCount').textContent = String(picked.size);
  zipBtn.textContent = picked.size ? '⬇ 合并下载 (' + picked.size + ')' : '⬇ 合并下载';
  zipBtn.disabled = picked.size === 0;
  dlOneBtn.disabled = picked.size === 0;
  allBtn.textContent = allPicked() ? '取消全选' : '全选';
  selBtn.textContent = picking() ? '☑ 退出' : '☑ 选择';
}
function setPicking(on){
  $('actbar').hidden = !on;
  filelistEl.classList.toggle('sel', on);
  document.body.classList.toggle('picking', on);
  applyPicked();
  syncBtns();
}
function applyPicked(){
  const items = filelistEl.querySelectorAll('li.frow');
  for (let i = 0; i < items.length; i++) {
    const rel = items[i].getAttribute('data-rel') || '';
    const cb = items[i].querySelector('.selbox');
    const on = !!rel && picked.has(rel);
    if (cb) cb.checked = on;
    items[i].classList.toggle('picked', on);
  }
  syncBtns();
}
selBtn.onclick = () => {
  const on = !picking();
  if (!on) picked.clear();
  setPicking(on);
};
$('selOffBtn').onclick = () => { picked.clear(); setPicking(false); };
allBtn.onclick = () => {
  const items = filelistEl.querySelectorAll('li.frow');
  const on = !allPicked();
  for (let i = 0; i < items.length; i++) {
    if (items[i].hidden) continue;
    const r = items[i].getAttribute('data-rel') || '';
    if (!r) continue;
    if (on) picked.add(r); else picked.delete(r);
  }
  applyPicked();
  syncBtns();
};
filelistEl.addEventListener('change', ev => {
  const cb = ev.target;
  if (!cb || !cb.classList || !cb.classList.contains('selbox')) return;
  const li = cb.closest ? cb.closest('li.frow') : null;
  const rel = li ? (li.getAttribute('data-rel') || '') : '';
  if (!rel) return;
  if (cb.checked) picked.add(rel); else picked.delete(rel);
  if (li) li.classList.toggle('picked', cb.checked);
  syncBtns();
});
zipBtn.onclick = () => {
  if (!picked.size) return;
  const qs = [];
  picked.forEach(r => qs.push('f=' + encodeURIComponent(r)));
  toast('正在合并 ' + picked.size + ' 个文件…');
  location.href = '/zip?' + qs.join('&');
};
// 分别下载：逐个触发浏览器下载（间隔 250ms，避免被浏览器当成连点拦截）
dlOneBtn.onclick = () => {
  if (!picked.size) return;
  const rels = [];
  picked.forEach(r => rels.push(r));
  toast('分别下载 ' + rels.length + ' 个文件…');
  for (let i = 0; i < rels.length; i++) {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = '/f/' + rels[i].split('/').map(encodeURIComponent).join('/');
      a.style.display = 'none';
      document.body.appendChild(a);
      if (a.click) a.click();
      setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 3000);
    }, i * 250);
  }
};

/* ---------- 初始化 ---------- */
applyView();
applySort();
applyOpenState();
applyPicked();
syncBtns();
applyFilter();
let saved = 'text';
try { saved = localStorage.getItem('lanTab') || 'text'; } catch {}
showTab(saved === 'file' ? 'file' : 'text', true);
updCount();
skeleton();
loadNotes();
setInterval(() => { if (!document.hidden && !secText.hidden) loadNotes(); }, 4000);
</script></body></html>`;
}

/* ---------- 合并下载：零依赖 ZIP（store + data descriptor，单遍流式，不落临时文件） ---------- */
const ZIP_LIMIT = 3.9 * 1024 * 1024 * 1024;   // 超过就提示分批下载（避开 zip64）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crcUpd(c, buf) { for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c; }
function dosStamp(ms) {
  const d = new Date(ms), y = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  };
}
function zipFileName() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `局域网共享-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
}
// 标志位 0x0808 = data descriptor + UTF-8 文件名；method 0 = store，所以长度能提前写死
function zipLocalHead(nb, size, t) {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0); b.writeUInt16LE(20, 4); b.writeUInt16LE(0x0808, 6);
  b.writeUInt16LE(0, 8); b.writeUInt16LE(t.time, 10); b.writeUInt16LE(t.date, 12);
  b.writeUInt32LE(0, 14); b.writeUInt32LE(size, 18); b.writeUInt32LE(size, 22);
  b.writeUInt16LE(nb.length, 26); b.writeUInt16LE(0, 28);
  return b;
}
function zipCentralHead(nb, e, t) {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0); b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6);
  b.writeUInt16LE(0x0808, 8); b.writeUInt16LE(0, 10);
  b.writeUInt16LE(t.time, 12); b.writeUInt16LE(t.date, 14);
  b.writeUInt32LE(e.crc, 16); b.writeUInt32LE(e.size, 20); b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(nb.length, 28);
  b.writeUInt16LE(0, 30); b.writeUInt16LE(0, 32); b.writeUInt16LE(0, 34); b.writeUInt16LE(0, 36);
  b.writeUInt32LE(0, 38); b.writeUInt32LE(e.offset, 42);
  return b;
}
function zipEnd(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8); b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12); b.writeUInt32LE(cdOffset, 16);
  return b;
}
function waitDrain(res) {
  return new Promise(r => {
    const done = () => { res.removeListener('drain', done); res.removeListener('close', done); r(); };
    res.once('drain', done); res.once('close', done);
  });
}
async function zipPush(res, stream) {          // 边流边算 CRC32，带背压；客户端断了就停
  let c = 0xFFFFFFFF;
  for await (const chunk of stream) {
    if (res.destroyed || res.writableEnded) { stream.destroy(); break; }
    c = crcUpd(c, chunk);
    if (!res.write(chunk)) await waitDrain(res);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- 安装向导：目录浏览 / 端口检测 / 系统集成 ---------- */
function uiJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJsonBody(req, limit) {
  return readBody(req, limit || 65536).then(t => { try { return JSON.parse(t || '{}') || {}; } catch { return {}; } });
}
function driveList() {
  const out = [];                                   // 从 C: 起，A/B 软驱不用管
  for (let i = 67; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':' + path.sep;
    try { if (fs.existsSync(d)) out.push(d); } catch {}
  }
  return out;
}
function quickPlaces() {
  const home = os.homedir();
  const out = [];
  for (const [label, dir] of [['桌面', 'Desktop'], ['文档', 'Documents'], ['下载', 'Downloads'], ['图片', 'Pictures']]) {
    const p = path.join(home, dir);
    try { if (fs.existsSync(p)) out.push({ label, path: p }); } catch {}
  }
  out.push({ label: '用户目录', path: home });
  return out;
}
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'Config.Msi', 'Recovery']);
function browseDir(target) {                        // 向导只列文件夹，不列文件
  const p = path.resolve(String(target || ''));
  if (!fs.statSync(p).isDirectory()) throw new Error('不是文件夹');
  const all = [];
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    if (!ent.isDirectory() || SKIP_DIRS.has(ent.name)) continue;
    all.push({ name: ent.name, path: path.join(p, ent.name) });
  }
  all.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const parent = path.dirname(p);
  return { ok: true, path: p, parent: parent === p ? '' : parent, dirs: all.slice(0, 400), more: Math.max(0, all.length - 400) };
}
function writableDir(dir) {
  const probe = path.join(dir, '.lan-share-write-probe');
  try { fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); return true; } catch { return false; }
}
function dirStat(dir) {
  try {
    let files = 0, folders = 0;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) { if (ent.isDirectory()) folders++; else files++; }
    return { files, folders };
  } catch { return { files: 0, folders: 0 }; }
}
function portFree(port) {
  // Windows 下 0.0.0.0 和 127.0.0.1 可以各绑一份，所以两边都试一遍才算数
  const probe = host => new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    try { s.listen(port, host); } catch { resolve(false); }
  });
  return probe('0.0.0.0').then(ok => ok ? probe('127.0.0.1') : false);
}
async function suggestPort(from) {
  const start = Math.max(1, Math.min(65535, Number(from) || 8080));
  for (let p = start; p <= Math.min(65535, start + 40); p++) if (await portFree(p)) return p;
  return 0;
}
function sysExe(rel) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const p = path.join(root, rel);
  try { if (fs.existsSync(p)) return p; } catch {}
  return path.basename(rel);
}
// 起一个系统 PowerShell（5.1）跑脚本；-STA 是 WinForms 对话框的要求。
// 第一句必须把 stdout 设成 UTF-8：5.1 默认按控制台 OEM 代码页输出，
// 中文路径传回来会变成乱码（踩过：快捷方式名 "局域网共享"）。
const PS_UTF8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';
function runPS(script, env) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(sysExe('System32\\WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-STA', '-Command', PS_UTF8 + '; ' + script], {
        env: Object.assign({}, process.env, env || {}), windowsHide: true
      });
    } catch (e) { return resolve({ ok: false, out: '', err: String(e.message || e) }); }
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => resolve({ ok: false, out: '', err: String(e.message || e) }));
    child.on('close', code => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
  });
}
// 系统原生的“选择文件夹”对话框（网页里的选择器选不了“目录”，只能传文件）
async function pickFolder(start) {
  if (process.env.SHARE_PICK_STUB) return process.env.SHARE_PICK_STUB;   // 测试钩子：不弹窗
  if (!IS_WIN) return '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "选择要共享的文件夹"',
    '$d.ShowNewFolderButton = $true',
    'if ($env:SHARE_PICK_START -and (Test-Path -LiteralPath $env:SHARE_PICK_START)) { $d.SelectedPath = $env:SHARE_PICK_START }',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
  ].join('; ');
  const r = await runPS(script, { SHARE_PICK_START: String(start || '') });
  if (!r.ok) return '';
  return String(r.out).split(/\r?\n/).pop().trim();
}
/* —— 开机启动（HKCU\...\Run，不需要管理员）与桌面快捷方式 —— */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'LanShare';
const SHORTCUT_NAME = '局域网共享.lnk';
function hiddenLauncher() {                          // 写个小 vbs，用 wscript 无窗口拉起
  const vbs = path.join(appDir(), 'hidden-launch.vbs');
  const body = 'CreateObject("WScript.Shell").Run """' + process.execPath + '"" --no-open", 0, False\r\n';
  fs.mkdirSync(appDir(), { recursive: true });
  fs.writeFileSync(vbs, body);
  return { vbs, cmd: 'wscript.exe "' + vbs + '"' };
}
function setAutostart(on, cmd) {
  const args = on
    ? ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', cmd, '/f']
    : ['delete', RUN_KEY, '/v', RUN_NAME, '/f'];
  if (process.env.SHARE_DRY_SYSTEM === '1') return { ok: true, dry: true };
  try {
    const r = spawnSync(sysExe('System32\\reg.exe'), args, { windowsHide: true, encoding: 'utf8' });
    return { ok: !r.error && (on ? r.status === 0 : true), status: r.status };
  } catch (e) { return { ok: false, err: String(e.message || e) }; }
}
function autostartState() {
  if (process.env.SHARE_DRY_SYSTEM === '1') return false;
  try { return spawnSync(sysExe('System32\\reg.exe'), ['query', RUN_KEY, '/v', RUN_NAME], { windowsHide: true }).status === 0; } catch { return false; }
}
function desktopDir() {                              // 只是兜底：真正的位置问系统（可能在 OneDrive 下）
  const home = os.homedir();
  for (const p of [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')]) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return home;
}
// 桌面的真实位置交给系统回答：重定向过或者 OneDrive 托管的配置文件里，
// %USERPROFILE%\Desktop 可能压根不存在。脚本最后把用到的 .lnk 路径打出来。
function makeShortcut(name) {
  const script = [
    '$desk = [Environment]::GetFolderPath("Desktop")',
    'if (-not $desk) { $desk = Join-Path $env:USERPROFILE "Desktop" }',
    'if (-not (Test-Path -LiteralPath $desk)) { New-Item -ItemType Directory -Force -Path $desk | Out-Null }',
    '$lnk = Join-Path $desk $env:SHARE_LNK_NAME',
    '$w = New-Object -ComObject WScript.Shell',
    '$s = $w.CreateShortcut($lnk)',
    '$s.TargetPath = $env:SHARE_TARGET',
    '$s.WorkingDirectory = $env:SHARE_WORKDIR',
    '$s.IconLocation = $env:SHARE_TARGET',
    '$s.Description = "局域网共享"',
    '$s.Save()',
    '[Console]::Out.Write($lnk)'
  ].join('; ');
  const fallback = path.join(desktopDir(), name);
  if (process.env.SHARE_DRY_SYSTEM === '1') return Promise.resolve({ ok: true, dry: true, lnk: fallback });
  return runPS(script, { SHARE_LNK_NAME: name, SHARE_TARGET: process.execPath, SHARE_WORKDIR: path.dirname(process.execPath) })
    .then(r => {
      const lnk = String(r.out || '').split(/\r?\n/).pop().trim();
      return { ok: r.ok && !!lnk, lnk: lnk || fallback, err: r.err };
    });
}
function lanUrls(port) {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) for (const a of (ifs[k] || [])) {
      if (a && a.family === 'IPv4' && !a.internal) out.push('http://' + a.address + ':' + port + '/');
    }
  } catch {}
  return out;
}
function openBrowser(url) {
  if (process.env.SHARE_NO_BROWSER === '1') return;
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}
// 向导里选定的目录要就地生效：这几个量本来是常量，现在跟着配置走
function applyConfig(cfg) {
  ROOT = path.resolve(cfg.root);
  DATA = path.resolve(cfg.data || path.join(path.dirname(ROOT), path.basename(ROOT) + '-data'));
  NOTES = path.join(DATA, 'notes.jsonl');
  META = path.join(DATA, 'files.json');
  PORT = Number(cfg.port) || PORT;
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(path.join(ROOT, DIR_FILES), { recursive: true });
  fs.mkdirSync(path.join(ROOT, DIR_TEXT), { recursive: true });
  setupMode = false;
}
function doUninstall() {
  const cfg = readConfig();
  const say = m => console.log('[uninstall] ' + m);
  const r = setAutostart(false);
  say('开机启动：' + (r.ok ? '已移除' : '清理失败'));
  const lnk = cfg.shortcutPath || path.join(desktopDir(), SHORTCUT_NAME);
  try { fs.unlinkSync(lnk); say('桌面快捷方式：已删除'); } catch { say('桌面快捷方式：没找到'); }
  if (cfg.vbs) { try { fs.unlinkSync(cfg.vbs); } catch {} }
  let removedCfg = false;
  for (const p of [CONFIG_FILE, path.join(appDir(), CONFIG_NAME)]) {
    try { fs.unlinkSync(p); removedCfg = true; say('配置文件：已删除 ' + p); } catch {}
  }
  if (!removedCfg) say('配置文件：没找到');
  say('共享文件夹里的东西一个都没动。');
}

/* ---------- 安装向导页面（只有 setupMode 下才渲染）---------- */
// 注意：下面是模板字符串，客户端 JS 里不能出现反斜杠或意料之外的 ${ }
function setupPage() {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>局域网共享 · 安装向导</title>
<style>
 :root{
  --bg:#f2f4f8; --card:#fff; --line:rgba(17,24,39,.08); --fg:#111827; --muted:#6b7280;
  --accent:#2563eb; --accent-soft:#e8efff; --danger:#dc2626; --ok:#059669; --radius:14px;
  --shadow:0 1px 2px rgba(16,24,40,.04), 0 4px 14px rgba(16,24,40,.06);
 }
 @media (prefers-color-scheme:dark){
  :root{ --bg:#0e0f12; --card:#18191d; --line:rgba(255,255,255,.09); --fg:#e8eaed; --muted:#9aa0a6;
         --accent:#6ea8fe; --accent-soft:#1e2a3d; --danger:#f87171; --ok:#34d399;
         --shadow:0 1px 2px rgba(0,0,0,.4), 0 6px 18px rgba(0,0,0,.35); }
 }
 *{box-sizing:border-box}
 html,body{margin:0}
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
   background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;padding:26px 14px 40px}
 .wrap{max-width:720px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px;letter-spacing:.2px}
 .sub{color:var(--muted);font-size:13px;margin-bottom:16px}
 .steps{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
 .steps span{font-size:12.5px;color:var(--muted);background:var(--card);border:1px solid var(--line);
   border-radius:999px;padding:5px 12px;box-shadow:var(--shadow)}
 .steps span.on{color:#fff;background:var(--accent);border-color:transparent;font-weight:600}
 .steps span.done{color:var(--ok)}
 .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
   box-shadow:var(--shadow);padding:18px}
 .card h2{font-size:15.5px;margin:0 0 12px}
 .hint{color:var(--muted);font-size:12.5px;margin-top:10px}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 input[type=text],input[type=number]{flex:1 1 260px;min-width:0;font:14px/1.4 inherit;color:var(--fg);
   background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
 input[type=number]{flex:0 0 120px}
 button{font:600 13.5px/1 inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);
   border-radius:10px;padding:10px 14px;cursor:pointer;white-space:nowrap}
 button:hover{border-color:var(--accent)}
 button.primary{background:var(--accent);color:#fff;border-color:transparent}
 button.primary[disabled]{opacity:.55;cursor:default}
 button.ghost{background:transparent}
 button:disabled{opacity:.45;cursor:default}
 .list{max-height:250px;overflow:auto;border:1px solid var(--line);border-radius:10px;margin-top:10px}
 .list div{padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--line);font-size:14px}
 .list div:last-child{border-bottom:0}
 .list div:hover{background:var(--accent-soft)}
 .pick{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
 .pick button{font-weight:500;font-size:12.5px;padding:7px 11px}
 .opts label{display:flex;gap:11px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--line);cursor:pointer}
 .opts label:last-child{border-bottom:0}
 .opts b{font-weight:600;font-size:14.5px;display:block}
 .opts i{color:var(--muted);font-size:12.5px;font-style:normal}
 .opts input{margin-top:4px;flex:0 0 auto;width:17px;height:17px;accent-color:var(--accent)}
 .state{font-size:13px;margin-top:8px;color:var(--muted)}
 .state.ok{color:var(--ok)}
 .state.bad{color:var(--danger)}
 .foot{display:flex;align-items:center;gap:10px;margin-top:16px}
 .foot .sp{flex:1}
 .kv{font-size:13.5px;margin:7px 0;display:flex;gap:8px}
 .kv b{color:var(--muted);font-weight:500;flex:0 0 108px}
 .kv span{min-width:0;word-break:break-all}
 .urls{font-size:13.5px;margin-top:10px;line-height:1.9}
 .urls b{color:var(--muted);font-weight:500}
 .urls a{color:var(--accent);text-decoration:none;word-break:break-all}
 .hide{display:none}
</style></head><body><div class="wrap">
<h1>局域网共享 · 安装向导</h1>
<div class="sub">第一次运行需要设置几件事，之后双击就能直接开始共享。</div>
<div class="steps"><span id="t1" class="on">1 共享文件夹</span><span id="t2">2 端口</span><span id="t3">3 选项</span><span id="t4">4 完成</span></div>

<section id="s1" class="card">
  <h2>要共享哪个文件夹？</h2>
  <div class="row">
    <input type="text" id="path" spellcheck="false" autocomplete="off">
    <button id="open">打开</button>
    <button id="browse">浏览…</button>
  </div>
  <div class="hint" id="ph">别人通过浏览器往这个文件夹里上传、从这里下载。数据存在它旁边的 xxx-data 目录里，不会混进共享内容。</div>
  <div class="list" id="dirs"></div>
  <div class="pick" id="quick"></div>
  <div class="row" style="margin-top:10px">
    <button class="ghost" id="up">↑ 上一级</button>
    <button class="ghost" id="mkdir">＋ 新建文件夹</button>
  </div>
</section>

<section id="s2" class="card hide">
  <h2>用哪个端口？</h2>
  <div class="row">
    <input type="number" id="port" min="1" max="65535" step="1">
    <button id="suggest" class="hide"></button>
  </div>
  <div id="portState" class="state"></div>
  <div class="hint">别人在局域网里通过 http://你的IP:端口/ 访问。8080 是默认值，被占用时换一个就行。</div>
</section>

<section id="s3" class="card hide">
  <h2>还要点什么？</h2>
  <div class="opts">
    <label><input type="checkbox" id="optAuto"><span><b>开机自动启动</b><i>写在当前用户的 Run 启动项里，不需要管理员权限，随时可以关掉</i></span></label>
    <label><input type="checkbox" id="optHidden"><span><b>开机启动时不显示黑色窗口</b><i>开机时用 wscript 无窗口拉起；你自己双击 exe 时仍然会显示窗口（好看到网址）</i></span></label>
    <label><input type="checkbox" id="optOpen"><span><b>启动时自动打开浏览器</b><i>双击后直接把共享页面打开</i></span></label>
    <label><input type="checkbox" id="optShort"><span><b>在桌面创建快捷方式</b><i>只是一个指向 exe 的快捷方式，删了不影响使用</i></span></label>
  </div>
</section>

<section id="s4" class="card hide">
  <h2>确认一下</h2>
  <div id="summary"></div>
  <div id="doneBox" class="hide">
    <div class="state ok" id="doneMsg"></div>
    <div class="urls" id="doneUrls"></div>
    <div class="row" style="margin-top:12px"><button class="primary" id="openShare">打开共享页面</button></div>
  </div>
  <div class="hint" id="saveHint"></div>
</section>

<div class="foot">
  <button class="ghost hide" id="prev">上一步</button>
  <span class="sp"></span>
  <button class="primary" id="next">下一步</button>
  <button class="hide" id="finish">完成</button>
</div>
</div>
<script>
var K='${SETUP_TOKEN}';
var cur='', par='', exePath='', port=8080, step=1, saved=false;
var S={open:true,autostart:false,hidden:false,shortcut:true};
function $(id){return document.getElementById(id);}
function api(name,q,body){
  var u='/setup/api/'+name+'?k='+K+(q?'&'+q:'');
  var o={};
  if(body){o.method='POST';o.headers={'Content-Type':'application/json'};o.body=JSON.stringify(body);}
  return fetch(u,o).then(function(r){return r.json();});
}
function say(id,msg,bad){var e=$(id);if(!e)return;e.className='hint';e.style.color=bad?'var(--danger)':'';e.textContent=msg;}
function show(n){
  step=n;
  for(var i=1;i<=4;i++){
    var s=$('s'+i); if(s)s.className=(i===n)?'card':'card hide';
    var t=$('t'+i); if(t)t.className=(i===n)?'on':(i<n?'done':'');
  }
  $('prev').className=(n===1||saved)?'hide':'ghost';
  $('next').className=(n===4||saved)?'hide':'primary';
  $('finish').className=(n===4&&!saved)?'primary':'hide';
  if(n===4)sum();
}
function kv(box,k,v){var d=document.createElement('div');d.className='kv';var a=document.createElement('b');a.textContent=k;var c=document.createElement('span');c.textContent=v;d.appendChild(a);d.appendChild(c);box.appendChild(d);}
function sum(){
  var b=$('summary');b.className='';b.textContent='';
  kv(b,'共享文件夹',cur||'(没选)');
  kv(b,'端口',String(parseInt($('port').value,10)||0));
  kv(b,'开机启动',S.autostart?'开':'关');
  kv(b,'打开浏览器',S.open?'开':'关');
  kv(b,'隐藏窗口',S.hidden?'是':'否');
  kv(b,'桌面快捷方式',S.shortcut?'创建':'不创建');
  if(exePath)kv(b,'程序位置',exePath);
}
function load(p){
  return api('fs','path='+encodeURIComponent(p||cur)).then(function(r){
    if(!r.ok){say('ph','打不开这个路径：'+(r.error||''),true);return;}
    cur=r.path;par=r.parent||'';$('path').value=cur;
    var dl=$('dirs');dl.textContent='';
    (r.dirs||[]).forEach(function(d){
      var el=document.createElement('div');el.textContent='📁 '+d.name;
      el.onclick=function(){load(d.path);};
      dl.appendChild(el);
    });
    if(!(r.dirs||[]).length){var e=document.createElement('div');e.textContent='（没有子文件夹）';e.style.cursor='default';dl.appendChild(e);}
    if(r.more){var m=document.createElement('div');m.textContent='…还有 '+r.more+' 个没列出来';m.style.cursor='default';dl.appendChild(m);}
    $('up').disabled=!par;
    var st=r.stat||{files:0,folders:0};
    say('ph','这里有 '+st.folders+' 个子文件夹、'+st.files+' 个文件'+(r.writable?'，可以写入 ✓':'，⚠ 不能写入，换一个位置'),!r.writable);
  });
}
function portCheck(){
  var v=parseInt($('port').value,10)||0;
  return api('port','port='+v).then(function(r){
    if(r.free){say('portState','✓ '+r.port+' 端口可用',false);port=r.port;$('suggest').className='hide';}
    else{say('portState','✗ '+r.port+' 已被占用',true);
      if(r.suggestion){$('suggest').className='';$('suggest').textContent='改用 '+r.suggestion;}
      else{$('suggest').className='hide';}}
    return r;
  });
}
function save(){
  var b=$('finish');b.disabled=true;b.textContent='正在保存…';
  api('save','',{root:cur,port:parseInt($('port').value,10)||0,open:S.open,autostart:S.autostart,hidden:S.hidden,shortcut:S.shortcut}).then(function(r){
    if(!r.ok){
      b.disabled=false;b.textContent='完成';
      say('saveHint','保存失败：'+(r.error||'未知错误'),true);
      return;
    }
    saved=true;port=r.port;
    $('summary').className='hide';$('doneBox').className='';
    say('doneMsg','设置好了，共享已经开起来。',false);
    var u=$('doneUrls');u.textContent='';
    var box=document.createElement('div');
    var b1=document.createElement('b');b1.textContent='本机 ';
    var a1=document.createElement('a');a1.href='http://127.0.0.1:'+r.port+'/';a1.textContent='http://127.0.0.1:'+r.port+'/';
    box.appendChild(b1);box.appendChild(a1);u.appendChild(box);
    (r.urls||[]).forEach(function(t){
      var d=document.createElement('div');var lb=document.createElement('b');lb.textContent='局域网 ';
      var a=document.createElement('a');a.href=t;a.textContent=t;
      d.appendChild(lb);d.appendChild(a);u.appendChild(d);
    });
    var extra='配置文件：'+r.configFile;
    if(r.autostart)extra=extra+'　开机启动：已开';
    if(r.shortcut)extra=extra+'　桌面快捷方式：已创建';
    say('saveHint',extra,false);
    $('finish').className='hide';
    $('prev').className='hide';
  });
}
function init(){
  api('places').then(function(r){
    cur=r['default']||'';port=r.port||8080;exePath=r.exe||'';
    $('port').value=port;
    var q=$('quick');q.textContent='';
    (r.places||[]).forEach(function(p){
      var b=document.createElement('button');b.textContent=p.label;
      b.onclick=function(){load(p.path);};q.appendChild(b);
    });
    (r.drives||[]).forEach(function(d){
      var b=document.createElement('button');b.textContent='💽 '+d;
      b.onclick=function(){load(d);};q.appendChild(b);
    });
    load(cur);portCheck();
  });
  $('next').onclick=function(){
    if(step===1&&!cur){say('ph','先选一个文件夹',true);return;}
    if(step===2){
      // 端口被占着就别往下走了，否则最后一步必然保存失败
      portCheck().then(function(r){
        if(!r.free){say('portState','✗ '+r.port+' 已被占用'+(r.suggestion?'，点上面那个按钮改用 '+r.suggestion:'，换一个端口'),true);return;}
        show(3);
      });
      return;
    }
    show(step+1);
  };
  $('prev').onclick=function(){ show(step-1); };
  $('finish').onclick=save;
  $('open').onclick=function(){ load($('path').value); };
  $('up').onclick=function(){ if(par)load(par); };
  $('path').onkeydown=function(e){ if(e.key==='Enter')load($('path').value); };
  $('browse').onclick=function(){
    say('ph','已经弹出选择框，去屏幕上挑一个文件夹…',false);
    api('pick','',{start:cur}).then(function(r){
      if(r.path){load(r.path);}else{say('ph','没有选（或者打不开选择框）',false);}
    });
  };
  $('mkdir').onclick=function(){
    var n=prompt('新文件夹叫什么名字？');
    if(!n)return;
    api('mkdir','',{parent:cur,name:n}).then(function(r){
      if(r.ok){load(r.path);}else{say('ph','新建失败：'+(r.error||''),true);}
    });
  };
  $('suggest').onclick=function(){ if($('suggest').textContent){$('port').value=parseInt($('suggest').textContent.replace(/[^0-9]/g,''),10)||port;portCheck();} };
  $('port').oninput=portCheck;
  $('openShare').onclick=function(){ location.href='http://127.0.0.1:'+port+'/'; };
  function bind(id,key,on){var e=$(id);e.checked=!!on;e.onchange=function(){S[key]=e.checked;};}
  bind('optAuto','autostart',false);
  bind('optHidden','hidden',false);
  bind('optOpen','open',true);
  bind('optShort','shortcut',true);
}
init();
</script></body></html>`;
}

/* ---------- 向导的接口（只在 setupMode 下存在）---------- */
async function handleSetup(req, res, urlPath, rawQuery) {
  if (!setupMode) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('已经配置好了。要重新配置，请关掉它再运行 lan-share.exe --setup');
  }
  const q = new URLSearchParams(rawQuery || '');
  if ((q.get('k') || '') !== SETUP_TOKEN) return uiJson(res, 403, { ok: false, error: 'bad-token' });

  if (urlPath === '/setup') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer'
    });
    return res.end(setupPage());
  }

  if (urlPath === '/setup/api/places') {
    return uiJson(res, 200, {
      ok: true, drives: driveList(), places: quickPlaces(),
      default: process.env.SHARE_SETUP_DEFAULT || ROOT,
      port: PORT, exe: process.execPath, sea: SEA, configFile: CONFIG_FILE
    });
  }

  if (urlPath === '/setup/api/fs') {
    try {
      const info = browseDir(q.get('path') || ROOT);
      info.writable = writableDir(info.path);
      info.stat = dirStat(info.path);
      return uiJson(res, 200, info);
    } catch (e) {
      return uiJson(res, 200, { ok: false, error: String(e.code === 'ENOENT' ? '这个路径不存在' : '不是文件夹或者打不开') });
    }
  }

  if (req.method === 'POST' && urlPath === '/setup/api/pick') {
    const body = await readJsonBody(req);
    const picked = await pickFolder(body.start || ROOT);
    return uiJson(res, 200, { ok: true, path: picked });
  }

  if (req.method === 'POST' && urlPath === '/setup/api/mkdir') {
    const body = await readJsonBody(req);
    const name = safeName(String(body.name || '').trim());
    const parent = path.resolve(String(body.parent || ROOT));
    const full = path.join(parent, name);
    try { fs.mkdirSync(full, { recursive: false }); return uiJson(res, 200, { ok: true, path: full }); }
    catch (e) {
      const msg = e.code === 'EEXIST' ? '已经有同名的了' : (e.code === 'ENOENT' ? '上一级不存在' : '建不出来（可能没有权限）');
      return uiJson(res, 200, { ok: false, error: msg });
    }
  }

  if (urlPath === '/setup/api/port') {
    const want = Number(q.get('port') || PORT) || 0;
    const okRange = want >= 1 && want <= 65535;
    const free = okRange ? await portFree(want) : false;
    const suggestion = free ? 0 : await suggestPort(okRange && want < 65535 ? want + 1 : 8080);
    return uiJson(res, 200, { ok: true, port: want, free, suggestion });
  }

  if (req.method === 'POST' && urlPath === '/setup/api/save') {
    const body = await readJsonBody(req);
    const root = String(body.root || '');
    if (!root || !path.isAbsolute(root)) return uiJson(res, 200, { ok: false, error: '请先选一个文件夹' });
    const port = Number(body.port) || 0;
    if (!(port >= 1 && port <= 65535)) return uiJson(res, 200, { ok: false, error: '端口要填 1 到 65535' });
    try { fs.mkdirSync(root, { recursive: true }); }
    catch { return uiJson(res, 200, { ok: false, error: '这个文件夹建不出来，换一个位置试试' }); }
    if (!writableDir(root)) return uiJson(res, 200, { ok: false, error: '这个文件夹不能写，换一个位置试试' });
    if (port !== listenPort && !(await portFree(port))) {
      const s = await suggestPort(port + 1);
      return uiJson(res, 200, { ok: false, error: '端口 ' + port + ' 被占用了' + (s ? '，可以改成 ' + s : ''), suggestion: s });
    }

    const abs = path.resolve(root);
    const cfg = {
      root: abs,
      port,
      data: path.join(path.dirname(abs), path.basename(abs) + '-data'),
      open: body.open !== false,
      autostart: !!body.autostart,
      hidden: !!body.hidden,
      shortcut: !!body.shortcut
    };

    if (cfg.shortcut) {
      const r = await makeShortcut(SHORTCUT_NAME);
      cfg.shortcutPath = r.ok ? r.lnk : '';
    }
    if (cfg.autostart) {
      let cmd = '"' + process.execPath + '"';
      if (cfg.hidden) { try { const h = hiddenLauncher(); cmd = h.cmd; cfg.vbs = h.vbs; } catch {} }
      const r = setAutostart(true, cmd);
      if (r.ok) cfg.runValue = cmd;
      cfg.autostart = r.ok;
    } else {
      setAutostart(false);
    }

    let saved;
    try {
      saved = writeConfig(cfg);
      cfg.configFile = saved;
    } catch (e) {
      return uiJson(res, 200, { ok: false, error: '配置写不进去：' + String(e.message || e) });
    }

    const moved = Number(port) !== listenPort;      // 用户挑的端口和现在在听的不是一个就得换
    applyConfig(cfg);
    uiJson(res, 200, {
      ok: true, root: ROOT, data: DATA, port: PORT, configFile: saved,
      urls: lanUrls(PORT), autostart: cfg.autostart, shortcut: cfg.shortcutPath || ''
    });
    if (cfg.open) openBrowser('http://127.0.0.1:' + PORT + '/');
    if (moved) setImmediate(() => relisten(PORT));
    return;
  }

  return uiJson(res, 404, { ok: false, error: 'not found' });
}

/* ---------- 路由 ---------- */
const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const qi = rawUrl.indexOf('?');
  const rawQuery = qi === -1 ? '' : rawUrl.slice(qi + 1);
  let urlPath;
  try { urlPath = decodeURIComponent(qi === -1 ? rawUrl : rawUrl.slice(0, qi)); }
  catch { res.writeHead(400); return res.end('bad request'); }

  const ip = clientIp(req);

  // Host / Origin 校验（挡 DNS rebinding 与跨站请求）
  if (!sameSite(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  const meId = ensureId(req, res);

  // 向导模式：只有向导自己的接口能过，其它一律引导到向导（此时只监听 127.0.0.1）
  if (setupMode) {
    if (urlPath === '/setup' || urlPath.slice(0, 7) === '/setup/') {
      handleSetup(req, res, urlPath, rawQuery).catch(() => {
        try { uiJson(res, 500, { ok: false, error: 'internal' }); } catch {}
      });
      return;
    }
    res.writeHead(302, { Location: '/setup?k=' + SETUP_TOKEN, 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (req.method === 'GET' && urlPath === '/t/list') {
    // 默认只给 1 天内的文本；“查看更早信息”时带 older=1 单独取
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const all = readNotes();
    const recent = [], older = [];
    for (let i = 0; i < all.length; i++) (all[i].t >= cutoff ? recent : older).push(all[i]);
    const wantOlder = /(^|&)older=1(&|$)/.test(rawQuery);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Older-Count': String(older.length)
    });
    return res.end(JSON.stringify((wantOlder ? older : recent).reverse()));
  }

  if (req.method === 'POST' && urlPath === '/t') {
    readBody(req, NOTE_MAX_CHARS * 4 + 4096).then(raw => {
      let text = '';
      try { const o = JSON.parse(raw || '{}') || {}; text = String(o.text || ''); } catch {}
      text = text.replace(/\r\n/g, '\n').trim();
      if (!text) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('内容为空'); }
      if (text.length > NOTE_MAX_CHARS) text = text.slice(0, NOTE_MAX_CHARS);
      const n = addNote(text, ip, meId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, id: n.id, file: n.file || null }));
    });
    return;
  }

  if (req.method === 'DELETE' && urlPath.startsWith('/t/')) {
    const id = urlPath.slice(3);
    const list = readNotes();
    list.filter(n => n.id === id).forEach(removeNoteFile);
    const next = list.filter(n => n.id !== id);
    writeNotes(next);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, removed: list.length - next.length }));
  }

  if (req.method === 'GET' && urlPath.startsWith('/t/raw/')) {
    const n = readNotes().find(x => x.id === urlPath.slice(7));
    res.writeHead(n ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(n ? n.text : 'not found');
  }

  if (req.method === 'PUT' && urlPath.startsWith('/u/')) {
    const free = freeBytes();
    if (free !== undefined && free < MIN_FREE) {
      res.writeHead(507, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('磁盘剩余空间不足');
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > MAX_UPLOAD) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('超过单文件上限');
    }
    const folder = DIR_FILES + '/' + todayFolder();
    const dir = path.join(ROOT, ...folder.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const name = uniqueIn(dir, safeName(urlPath.slice(3)));
    const rel = folder + '/' + name;
    const dest = path.join(dir, name);
    const ws = fs.createWriteStream(dest);
    let failed = false, got = 0, lastCheck = 0;
    const abort = (code, msg) => {
      if (failed) return;
      failed = true;
      try { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); } catch {}
      ws.destroy(); fs.unlink(dest, () => {}); req.destroy();
    };
    req.on('aborted', () => { failed = true; ws.destroy(); fs.unlink(dest, () => {}); });
    req.on('data', c => {
      got += c.length;
      if (got > MAX_UPLOAD) return abort(413, '超过单文件上限');
      if (got - lastCheck > 64 * 1024 * 1024) {
        lastCheck = got;
        const f = freeBytes();
        if (f !== undefined && f < MIN_FREE_MID) return abort(507, '磁盘剩余空间不足');
      }
    });
    req.pipe(ws);
    ws.on('error', () => {
      failed = true; try { fs.unlinkSync(dest); } catch {}
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('写入失败');
    });
    ws.on('finish', () => {
      if (failed) return;
      setFileMeta(rel, ip, meId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, path: rel, ip }));
    });
    return;
  }

  if (req.method === 'DELETE' && urlPath.startsWith('/f/')) {
    const t = safeRel(urlPath.slice(3));
    if (!t) { res.writeHead(404); return res.end('not found'); }
    let st; try { st = fs.statSync(t.full); } catch { res.writeHead(404); return res.end('not found'); }
    if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
    if (!canDeleteFile(t.rel, meId, ip)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'only-uploader' }));
    }
    try { fs.unlinkSync(t.full); } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('删除失败');
    }
    const mm = readMeta();
    if (mm[t.rel]) { delete mm[t.rel]; writeMeta(mm); }
    const ns = readNotes();
    const kept = ns.filter(n => n.file !== t.rel);
    if (kept.length !== ns.length) writeNotes(kept);
    const dir = path.dirname(t.full);
    if (path.resolve(dir) !== path.resolve(ROOT)) {
      try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, removed: t.rel }));
  }

  if (req.method === 'GET' && urlPath.startsWith('/f/')) {
    const t = safeRel(urlPath.slice(3));
    if (!t) { res.writeHead(404); return res.end('not found'); }
    let st; try { st = fs.statSync(t.full); } catch { res.writeHead(404); return res.end('not found'); }
    if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[extOf(t.full)] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(t.full))}`
    });
    return fs.createReadStream(t.full).on('error', () => res.end()).pipe(res);
  }

  if (req.method === 'GET' && urlPath.startsWith('/i/')) {
    const t = safeRel(urlPath.slice(3));
    if (!t || !IMG_EXT.has(extOf(t.full))) { res.writeHead(404); return res.end('not found'); }
    let st; try { st = fs.statSync(t.full); } catch { res.writeHead(404); return res.end('not found'); }
    if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[extOf(t.full)] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=120'
    });
    return fs.createReadStream(t.full).on('error', () => res.end()).pipe(res);
  }

  if (req.method === 'GET' && urlPath === '/zip') {
    let wanted = [];
    try { wanted = new URL('http://x/?' + rawQuery).searchParams.getAll('f'); } catch { wanted = []; }
    const seen = new Set(), entries = [];
    let skipped = 0;
    for (const raw of wanted) {
      const t = safeRel(raw);
      if (!t || seen.has(t.rel)) { skipped++; continue; }
      let st; try { st = fs.statSync(t.full); } catch { skipped++; continue; }
      if (!st.isFile()) { skipped++; continue; }
      seen.add(t.rel);
      entries.push({ rel: t.rel, full: t.full, size: st.size, name: Buffer.from(t.rel, 'utf8'), stamp: dosStamp(st.mtimeMs) });
    }
    if (!entries.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('没有可下载的文件');
    }
    let total = 0;
    for (const e of entries) total += e.size;
    if (total > ZIP_LIMIT) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('一次最多合并约 3.9 GB，请分几批下载');
    }
    let head = 22, cdSize = 0;
    for (const e of entries) { head += 30 + e.name.length + e.size + 16; cdSize += 46 + e.name.length; }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': head + cdSize,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(zipFileName()),
      'X-Skipped-Count': String(skipped),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    (async () => {
      try {
        let offset = 0;
        for (const e of entries) {
          res.write(zipLocalHead(e.name, e.size, e.stamp));
          res.write(e.name);
          e.offset = offset;
          e.crc = await zipPush(res, fs.createReadStream(e.full));
          if (res.destroyed || res.writableEnded) break;
          const d = Buffer.alloc(16);
          d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(e.crc, 4);
          d.writeUInt32LE(e.size, 8); d.writeUInt32LE(e.size, 12);
          res.write(d);
          offset += 30 + e.name.length + e.size + 16;
        }
        if (res.destroyed || res.writableEnded) return;
        for (const e of entries) { res.write(zipCentralHead(e.name, e, e.stamp)); res.write(e.name); }
        res.end(zipEnd(entries.length, cdSize, offset));
      } catch (err) { try { res.destroy(); } catch {} }
    })();
    return;
  }

  if (req.method === 'GET' && (urlPath === '/' || urlPath === '')) {
    const files = listFiles();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    return res.end(page(files, meId, ip));
  }

  res.writeHead(404); res.end('not found');
});

/* ---------- 启动 ---------- */
let listenTries = (SEA || setupMode) ? 10 : 0;                // exe / 向导模式下端口被占就自动往后退
function banner() {
  console.log('[share] content = ' + ROOT);
  console.log('[share] data    = ' + DATA);
  console.log('[share] 本机    http://127.0.0.1:' + listenPort + '/');
  for (const u of lanUrls(listenPort)) console.log('[share] 局域网  ' + u);
  if (setupMode) console.log('[share] 安装向导 http://127.0.0.1:' + listenPort + '/setup?k=' + SETUP_TOKEN);
}
function relisten(port) {                                     // 向导里换了端口：换个口继续服务
  // server.close 会等在途连接结束；万一有连接挂着不走，2 秒后强制收掉，别让服务卡在半路
  const timer = setTimeout(() => {
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch {}
  }, 2000);
  try {
    server.close(() => {
      clearTimeout(timer);
      try {
        server.listen(port, '0.0.0.0', () => { listenPort = port; banner(); });
      } catch (e) { console.error('[share] 换端口失败，仍在原端口服务：' + e.message); }
    });
  } catch (e) { clearTimeout(timer); }
}
server.on('error', err => {
  const code = err && err.code;
  if (code === 'EADDRINUSE' && listenTries > 0) {
    listenTries--;
    listenPort += 1;
    console.warn('[share] 端口被占用，换到 ' + listenPort + ' 再试');
    setImmediate(() => server.listen(listenPort, setupMode ? '127.0.0.1' : '0.0.0.0'));
    return;
  }
  console.error('[share] 启动失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});

if (FLAGS.has('--uninstall')) {
  doUninstall();
  process.exit(0);
}

(async () => {
  if (setupMode && !(await portFree(PORT))) {                 // 向导端口别和正在跑的服务打架
    const alt = await suggestPort(PORT + 1);
    if (alt) {
      console.log('[share] ' + PORT + ' 被占用，向导改用 ' + alt);
      listenPort = alt;
    }
  }
  server.listen(listenPort, setupMode ? '127.0.0.1' : '0.0.0.0', () => {
    banner();
    if (AUTO_OPEN) openBrowser('http://127.0.0.1:' + listenPort + '/');
  });
})();
