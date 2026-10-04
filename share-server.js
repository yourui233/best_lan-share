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

// 兜底：单个请求出问题不该把整个共享服务带走。这里只记日志、不退出，
// 免得一次磁盘写失败就让所有人的页面全挂掉。
process.on('unhandledRejection', e => console.error('[share] unhandledRejection: ' + ((e && e.stack) || e)));
process.on('uncaughtException', e => console.error('[share] uncaughtException: ' + ((e && e.stack) || e)));

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

// 只读模式：别的设备只能看和下载。命令行 / 环境变量优先于配置文件（向导里也能勾）
const RO_FORCED = FLAGS.has('--read-only') || /^(1|true|yes|on)$/i.test(String(process.env.SHARE_READONLY || ''));
let READONLY = RO_FORCED || CFG.readOnly === true;
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

// 多语言地基：语言按 ?lang= > cookie > Accept-Language > 中文 决定（每次请求算一次）。
// 新加的文案一律写成 L('中文','English')，老文案在 i18n 那一轮统一迁移。
// 注意：整页文案还没迁完，所以 Accept-Language 自动识别先关着（AUTO_LANG=false），
// 否则英文系统的用户会看到「中文页面里夹几句英文」，比全中文更糟。
// 等所有文案都进了语言表，把 AUTO_LANG 改成 true 即可。
const AUTO_LANG = false;
const LANG_COOKIE = 'lan_lang';
let LANG = 'zh';
function L(zh, en) { return LANG === 'en' ? en : zh; }
function pickLang(req, rawQuery) {
  const q = /(^|&)lang=(zh|en)(&|$)/.exec(rawQuery || '');
  if (q) return q[2];
  const c = /(?:^|;\s*)lan_lang=(zh|en)/.exec(req.headers.cookie || '');
  if (c) return c[1];
  if (!AUTO_LANG) return 'zh';
  const al = String(req.headers['accept-language'] || '').toLowerCase();
  if (al && /(^|,)\s*en/.test(al) && !/(^|,)\s*zh/.test(al)) return 'en';
  return 'zh';
}
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

// 列表版本号：任何会让另一台设备看到不同内容的操作都 +1。
// 页面只轮询这个整数（不拉列表），变了才重新拉，省流量也不打断搜索/选中状态。
let LIST_REV = 1;
function bumpRev() {
  LIST_REV = LIST_REV >= 2147483000 ? 1 : LIST_REV + 1;
  return LIST_REV;
}

// 只读模式下要挡掉的请求：所有会改内容的写操作（下载、预览、状态探测都不受影响）
// 兑换提取码不算写操作：它只发一张"看得见私有文件"的通行证，不改磁盘上的东西
function isWrite(method, p) {
  if (method === 'PUT' && p.slice(0, 3) === '/u/') return true;
  if (method === 'PATCH' && p.slice(0, 3) === '/f/') return true;      // 重命名 / 改可见范围
  if (method === 'DELETE' && (p.slice(0, 3) === '/f/' || p.slice(0, 3) === '/t/')) return true;
  if (method === 'POST' && p === '/t') return true;
  return false;
}

// 上传时带的子目录（选整个文件夹上传）：只允许干净的相对路径，别的一律拒绝
// 返回 '' 表示没有目录；返回 null 表示不合法
function safeSub(raw) {
  if (raw == null || raw === '') return '';
  const parts = String(raw).split('/').filter(p => p !== '');
  if (parts.length > 8) return null;                       // 目录太深，多半不是正常上传
  const out = [];
  for (const p of parts) {
    if (p === '.' || p === '..') return null;
    if (p.length > 100) return null;
    if (RESERVED_NAME.test(p)) return null;                // con / prn / lpt1 …
    if (/[\u0000-\u001f<>:"|?*]/.test(p)) return null;     // Windows 不允许的字符
    if (/[. ]$/.test(p)) return null;                      // Windows 会把结尾的点/空格吃掉
    out.push(p);
  }
  return out.join('/');
}

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
// 网卡地址是会变的（DHCP 续租、插拔网卡、连上 VPN）。只在启动时抓一次快照，
// 后出现的地址就永远被拒 —— 而页面上的「接入」面板是实时枚举网卡的，于是它会
// 把服务器自己 403 的地址列出来给用户点。所以这里按 TTL 重算。
const HOSTS_TTL = 5000;
let _hosts = localHostNames(), _hostsAt = Date.now();
function HOSTS_now() {
  if (Date.now() - _hostsAt >= HOSTS_TTL) { _hosts = localHostNames(); _hostsAt = Date.now(); }
  return _hosts;
}
function hostNameOf(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) { const i = s.indexOf(']'); return (i > 0 ? s.slice(1, i) : s).toLowerCase(); }
  const i = s.lastIndexOf(':');
  return ((i > 0 && s.indexOf(':') === i) ? s.slice(0, i) : s).toLowerCase();
}
function sameSite(req) {
  const h = hostNameOf(req.headers.host);
  if (!h || !HOSTS_now().has(h)) return false;
  const o = req.headers.origin;
  if (o === undefined) return true;          // 非浏览器发起的请求（curl / 本机脚本）
  if (!o || o === 'null') return false;      // 沙箱/不透明源：拒绝
  try { return HOSTS_now().has(hostNameOf(new URL(o).host)); } catch { return false; }
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
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.apk': 'application/vnd.android.package-archive'
};
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']); // 不含 svg：避免内联 SVG 脚本
// 只有这些类型允许内联播放（HTML/SVG 之类内联就是自找 XSS）
const MEDIA_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov', '.ogv', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']);

/* 单区间 Range 解析：只认 bytes=a-b / bytes=a- / bytes=-n。
   返回 null = 照整文件发；{bad:true} = 416。 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {                                  // 后缀区间：最后 n 字节
    const n = Number(m[2]);
    if (!n) return { bad: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { bad: true };
  return { start, end };
}
// 所有文件响应都走这里：Range（断点续传、音视频拖进度条）、HEAD、inline / attachment
function sendFile(req, res, full, opts) {
  const o = opts || {};
  let st;
  try { st = fs.statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
  const head = {
    'Content-Type': o.ct || MIME[extOf(full)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    'Cache-Control': o.cache || 'no-store'
  };
  if (o.inline) {
    head['Content-Disposition'] = 'inline';
    head['Content-Security-Policy'] = "default-src 'none'; sandbox";
  } else {
    // o.dlName：磁盘名和用户看到的文件名不一样时（加密文件落盘是随机串）用真实名下载
    const dl = o.dlName || path.basename(full);
    head['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(dl);
  }
  const isHead = req.method === 'HEAD';
  const r = parseRange(req.headers.range, st.size);
  if (r && r.bad) {
    res.writeHead(416, Object.assign({}, head, { 'Content-Range': 'bytes */' + st.size, 'Content-Length': 0 }));
    return res.end();
  }
  if (r) {
    res.writeHead(206, Object.assign({}, head, {
      'Content-Range': 'bytes ' + r.start + '-' + r.end + '/' + st.size,
      'Content-Length': r.end - r.start + 1
    }));
    if (isHead) return res.end();
    return fs.createReadStream(full, { start: r.start, end: r.end }).on('error', () => res.end()).pipe(res);
  }
  res.writeHead(200, Object.assign({}, head, { 'Content-Length': st.size }));
  if (isHead) return res.end();
  return fs.createReadStream(full).on('error', () => res.end()).pipe(res);
}

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
// 追加一个 Set-Cookie，而不是覆盖 —— 同一个响应里可能既要下发 lan_id 又要下发通行证
function addCookie(res, value) {
  const cur = res.getHeader('Set-Cookie');
  const arr = cur === undefined ? [] : (Array.isArray(cur) ? cur.slice() : [String(cur)]);
  arr.push(value);
  res.setHeader('Set-Cookie', arr);
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
// 便签的归属：新数据带 owner（cookie 身份）；老数据没有，退回按 IP 比，跟文件一个思路
function canDeleteNote(n, meId, ip) {
  if (!n) return false;
  if (isHostSelf(ip)) return true;
  if (n.owner) return n.owner === meId;
  return !!n.ip && n.ip === ip;
}

/* ---------- 可见范围 / 提取码 / 加密标记 ----------
   元数据里新增的字段（老记录没有，一律按默认值读，所以旧的 files.json 不用迁移）：
     name  显示名。加密文件在磁盘上是随机名，真实文件名只存在这里
     vis   'public'（默认）| 'private'：私有文件对非所有者完全不可见（列表里不出现，直链 404）
     enc   true = 磁盘上是浏览器端加密后的密文，服务端不持有密钥、也不解密
     code  仅 private：提取码。谁拿到码就能"兑换"一张通行证 cookie，从而看到这个文件
   说明：这是局域网里的一道"软"隔离 —— 身份仍然只是 cookie，不是账号；提取码明文存在
   -data 里（该目录不对外提供），换来的通行证是 HMAC 签名的 cookie，服务端不存状态、
   重启即作废（重新输一次码即可）。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // 去掉 0/O/1/I/L 这些容易看错的
const CODE_LEN = 6;
function makeCode() {
  const b = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function isPrivateEntry(m) { return !!m && m.vis === 'private'; }
function isEncEntry(m) { return !!(m && m.enc); }
function displayNameOf(rel, m) { return (m && m.name) || path.basename(rel); }

const UNLOCK_COOKIE = 'lan_ok';
const UNLOCK_SECRET = crypto.randomBytes(32);
const UNLOCK_TTL = 7 * 24 * 3600 * 1000;
const UNLOCK_MAX = 200;                                    // 一张通行证最多记这么多文件，别撑爆 cookie
function signUnlock(rels) {
  const payload = Buffer.from(JSON.stringify({ r: rels.slice(0, UNLOCK_MAX), e: Date.now() + UNLOCK_TTL }), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', UNLOCK_SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function readUnlocked(req) {
  const raw = parseCookies(req)[UNLOCK_COOKIE] || '';
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return new Set();
  const payload = raw.slice(0, dot), mac = raw.slice(dot + 1);
  const want = crypto.createHmac('sha256', UNLOCK_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return new Set();
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || !Array.isArray(o.r) || !(o.e > Date.now())) return new Set();
    return new Set(o.r.map(String));
  } catch { return new Set(); }
}
function codeMatches(a, b) {
  const x = Buffer.from(String(a || '').trim().toUpperCase()), y = Buffer.from(String(b || '').trim().toUpperCase());
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
// 这个浏览器能不能看到这个文件：公开的都能；私有的只有所有者、服务器本机、或兑换过提取码的
function canSeeFile(rel, m, meId, ip, unlocked) {
  if (!isPrivateEntry(m)) return true;
  if (isHostSelf(ip)) return true;
  if (ownerOk(m, meId, ip)) return true;
  return !!(unlocked && unlocked.has(rel));
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
// 符号链接和目录联接（junction）都能把路径指到共享目录之外。Windows 上 junction 在
// lstat/readdir 里报的就是普通目录（libuv 只把真正的 symlink 标成 LINK），所以
// isSymbolicLink() 挡不住它 —— 只能靠 realpath 判断目标到底落在哪。
// 路径不存在时直接放行，交给后面的 stat 去回 404。
let _rootReal = '', _rootRealAt = 0;
function rootReal() {
  if (!_rootReal || Date.now() - _rootRealAt > 5000) {
    try { _rootReal = fs.realpathSync(ROOT); } catch { _rootReal = path.resolve(ROOT); }
    _rootRealAt = Date.now();
  }
  return _rootReal;
}
function stillInside(full) {
  let real;
  try { real = fs.realpathSync(full); } catch { return true; }
  const root = rootReal();
  return real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
function safeRel(rel) {
  const segs = String(rel || '').split('/').map(s => s.trim()).filter(s => s && s !== '.' && s !== '..')
    .map(s => { const t = s.replace(/[\\:*?"<>|\u0000-\u001f]/g, '_'); return RESERVED_NAME.test(t) ? '_' + t : t; });
  if (!segs.length) return null;
  const p = path.resolve(path.join(ROOT, ...segs));
  if (p !== path.resolve(ROOT) && !p.startsWith(path.resolve(ROOT) + path.sep)) return null;
  if (!stillInside(p)) return null;                       // 链接把目标指到共享目录之外
  return { rel: segs.join('/'), full: p, segs };
}

/* ---------- 元数据 ---------- */
function readMeta() { try { return JSON.parse(fs.readFileSync(META, 'utf8')) || {}; } catch { return {}; } }
function writeMeta(m) { try { fs.writeFileSync(META, JSON.stringify(m)); } catch {} }
// extra 里的字段（name / vis / enc / code）会一起存进去；重复调用时保留已有字段，
// 免得重命名或改可见范围的过程中把 enc、提取码这些信息冲掉。
function setFileMeta(rel, ip, id, extra) {
  const m = readMeta();
  m[rel] = Object.assign({}, m[rel], { id: id || '', ip, t: Date.now() }, extra || {});
  writeMeta(m);
}

/* ---------- 文本便签 ---------- */
function readNotes() {
  try {
    return fs.readFileSync(NOTES, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
// 这个函数绝不能往外抛：它的调用点都在 async 流程里，一抛就是 unhandled rejection，
// 整个共享服务会跟着退出（磁盘写满、杀软瞬时锁住 notes.jsonl、数据目录被外部删掉都会命中）。
// 返回 false 让调用方回一个明确的 500。
function writeNotes(list) {
  try {
    fs.writeFileSync(NOTES, list.map(n => JSON.stringify(n)).join('\n') + (list.length ? '\n' : ''));
    return true;
  } catch (e) {
    console.error('[share] 写 notes.jsonl 失败：' + (e && e.message ? e.message : e));
    return false;
  }
}
function noteFileName(t) {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function addNote(text, ip, meId) {
  const list = readNotes();
  const t = Date.now();
  const n = { id: t.toString(36) + Math.random().toString(36).slice(2, 7), t, text, ip, owner: meId || '' };
  try {
    const dir = path.join(ROOT, DIR_TEXT);
    fs.mkdirSync(dir, { recursive: true });
    const name = uniqueIn(dir, noteFileName(t) + '.txt');
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
    n.file = DIR_TEXT + '/' + name;
    setFileMeta(n.file, ip, meId);
  } catch {}
  list.push(n);
  return { note: n, saved: writeNotes(list) };
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
// 先遍历出磁盘上的全部文件（元数据清理必须基于"全部"，见下面的 valid），
// 再按可见范围过滤出这台设备能看到的：私有文件对别人连存在性都不暴露。
function listFiles(meId, ip, unlocked) {
  const meta = readMeta();
  const all = [];
  const walk = (dir, relDir, depth) => {
    // 12 层：文件/<日期>/<上传文件夹…>/<文件> 最多 1+1+8+1，留点余量
    if (depth > 12) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name[0] === '.') continue;
      const full = path.join(dir, e.name);
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) { if (stillInside(full)) walk(full, rel, depth + 1); continue; }   // 不跟进链接
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      const m = meta[rel] || {};
      const mine = isHostSelf(ip) || ownerOk(m, meId, ip);
      all.push({
        rel, folder: relDir, disk: e.name,
        name: displayNameOf(rel, m),
        size: st.size, mtime: st.mtimeMs,
        ip: m.ip || '', id: m.id || '',
        vis: isPrivateEntry(m) ? 'private' : 'public',
        enc: isEncEntry(m),
        mine,
        code: mine && m.code ? String(m.code) : '',        // 提取码只回给所有者
        visible: canSeeFile(rel, m, meId, ip, unlocked)
      });
    }
  };
  walk(ROOT, '', 1);
  // 元数据里指向已消失文件的键要清掉。必须拿 all（含不可见的）来算，
  // 否则当前这个浏览器看不到的私有文件，记录会被顺手删掉。
  const valid = new Set(all.map(x => x.rel));
  let changed = false;
  for (const k of Object.keys(meta)) if (!valid.has(k)) { delete meta[k]; changed = true; }
  if (changed) writeMeta(meta);
  const out = all.filter(x => x.visible);
  // 分组顺序：快捷文本置顶；其余按日期倒序（最近的在上）；组内按修改时间倒序
  out.sort((a, b) => {
    const ra = a.folder === DIR_TEXT ? 0 : 1, rb = b.folder === DIR_TEXT ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.folder === b.folder) return b.mtime - a.mtime;
    return a.folder > b.folder ? -1 : 1;
  });
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

const CLIENT_CRYPTO_SRC = String.raw`
/* ==================== 浏览器端加密模块（原样内联进页面） ====================
   为什么不用 WebCrypto：http://192.168.x.x 不是"安全上下文"，crypto.subtle 在那种页面上
   直接是 undefined —— 而这正是本工具最主要的用法（手机扫局域网地址进来）。所以这里用纯 JS
   实现 ChaCha20-Poly1305（RFC 8439）+ PBKDF2-HMAC-SHA256，任何来源都能跑；随机数用
   crypto.getRandomValues（它不受安全上下文限制）。
   正确性：与 OpenSSL（node:crypto）逐项比对 sha256/hmac/pbkdf2/ChaCha20/Poly1305/AEAD，
   并核对 RFC 8439 §2.8.2 官方向量 —— 见外侧的 _lan_test/test-crypto.js。
   注意：这段会被塞进模板字符串，所以不能出现反引号或美元花括号插值语法。
   文件格式：64 字节头（magic/版本/KDF/算法/迭代次数/盐/分块大小/IV 前缀/明文长度）+
   逐块 ChaCha20-Poly1305（明文块 + 16 字节 tag），块号同时进 nonce 和 AAD，抗乱序与截断。 */
var LSENC = (function () {
  'use strict';
  var HEADER_LEN = 64;
  var KDF_PBKDF2 = 1;
  var CIPHER_CHACHA20_POLY1305 = 2;
  var DEFAULT_ITER = 150000;
  var DEFAULT_CHUNK = 8 * 1024 * 1024;
  var MAGIC = [0x4c, 0x53, 0x45, 0x4e, 0x43, 0x31, 0x00];   /* 'LSENC1\0' */

  /* ================= SHA-256 ================= */
  var K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  var H256 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var W256 = new Uint32Array(64);

  function sha256(msg) {
    var len = msg.length;
    var blocks = Math.ceil((len + 9) / 64);
    var buf = new Uint8Array(blocks * 64);
    buf.set(msg, 0);
    buf[len] = 0x80;
    var dv = new DataView(buf.buffer);
    var bitsHi = Math.floor(len / 536870912);
    var bitsLo = (len << 3) >>> 0;
    dv.setUint32(blocks * 64 - 8, bitsHi, false);
    dv.setUint32(blocks * 64 - 4, bitsLo, false);
    var h0 = H256[0], h1 = H256[1], h2 = H256[2], h3 = H256[3], h4 = H256[4], h5 = H256[5], h6 = H256[6], h7 = H256[7];
    for (var off = 0; off < blocks * 64; off += 64) {
      var i;
      for (i = 0; i < 16; i++) W256[i] = dv.getUint32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var x = W256[i - 15], y = W256[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        W256[i] = (W256[i - 16] + s0 + W256[i - 7] + s1) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[i] + W256[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    odv.setUint32(0, h0, false); odv.setUint32(4, h1, false); odv.setUint32(8, h2, false); odv.setUint32(12, h3, false);
    odv.setUint32(16, h4, false); odv.setUint32(20, h5, false); odv.setUint32(24, h6, false); odv.setUint32(28, h7, false);
    return out;
  }

  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  function hmac(key, msg) {
    var k = key.length > 64 ? sha256(key) : key;
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    ipad.set(k); opad.set(k);
    for (var i = 0; i < 64; i++) { ipad[i] ^= 0x36; opad[i] ^= 0x5c; }
    return sha256(concat(opad, sha256(concat(ipad, msg))));
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return new Uint8Array(out);
  }
  function pbkdf2(password, salt, iter, dkLen) {
    var pw = typeof password === 'string' ? utf8(password) : password;
    var out = new Uint8Array(dkLen);
    var blocks = Math.ceil(dkLen / 32);
    for (var b = 1; b <= blocks; b++) {
      var msg = new Uint8Array(salt.length + 4);
      msg.set(salt, 0);
      msg[salt.length] = (b >>> 24) & 255;
      msg[salt.length + 1] = (b >>> 16) & 255;
      msg[salt.length + 2] = (b >>> 8) & 255;
      msg[salt.length + 3] = b & 255;
      var u = hmac(pw, msg);
      var t = u.slice(0);
      for (var i = 1; i < iter; i++) {
        u = hmac(pw, u);
        for (var j = 0; j < 32; j++) t[j] ^= u[j];
      }
      out.set(t.subarray(0, Math.min(32, dkLen - (b - 1) * 32)), (b - 1) * 32);
    }
    return out;
  }

  /* ================= ChaCha20（RFC 8439） ================= */
  function rotl(v, n) { return ((v << n) | (v >>> (32 - n))) | 0; }
  function chachaBlock(key, nonce, counter, out, off) {
    var s = new Uint32Array(16);
    s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
    for (var i = 0; i < 8; i++) s[4 + i] = (key[i * 4] | (key[i * 4 + 1] << 8) | (key[i * 4 + 2] << 16) | (key[i * 4 + 3] << 24)) | 0;
    s[12] = counter | 0;
    s[13] = (nonce[0] | (nonce[1] << 8) | (nonce[2] << 16) | (nonce[3] << 24)) | 0;
    s[14] = (nonce[4] | (nonce[5] << 8) | (nonce[6] << 16) | (nonce[7] << 24)) | 0;
    s[15] = (nonce[8] | (nonce[9] << 8) | (nonce[10] << 16) | (nonce[11] << 24)) | 0;
    var x = new Int32Array(16);
    for (i = 0; i < 16; i++) x[i] = s[i];
    function qr(a, b, c, d) {
      x[a] = (x[a] + x[b]) | 0; x[d] = rotl(x[d] ^ x[a], 16);
      x[c] = (x[c] + x[d]) | 0; x[b] = rotl(x[b] ^ x[c], 12);
      x[a] = (x[a] + x[b]) | 0; x[d] = rotl(x[d] ^ x[a], 8);
      x[c] = (x[c] + x[d]) | 0; x[b] = rotl(x[b] ^ x[c], 7);
    }
    for (var r = 0; r < 10; r++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    var dv = new DataView(out.buffer, out.byteOffset + off, 64);
    for (i = 0; i < 16; i++) dv.setUint32(i * 4, (x[i] + s[i]) | 0, true);
  }
  /* 用 ChaCha20 的密钥流异或一段数据；counter 指起始块号 */
  function chachaXor(key, nonce, counter, data) {
    var out = new Uint8Array(data.length);
    var ks = new Uint8Array(64);
    for (var off = 0; off < data.length; off += 64) {
      chachaBlock(key, nonce, counter + (off / 64), ks, 0);
      var n = Math.min(64, data.length - off);
      for (var i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
    }
    return out;
  }

  /* ================= Poly1305（用 BigInt 做 130 位运算） ================= */
  var CLAMP = BigInt('0x0ffffffc0ffffffc0ffffffc0fffffff');
  var P1305 = (BigInt(1) << BigInt(130)) - BigInt(5);
  function leToBig(bytes) {
    var v = BigInt(0);
    for (var i = bytes.length - 1; i >= 0; i--) v = (v << BigInt(8)) | BigInt(bytes[i]);
    return v;
  }
  function bigToLe(v, n) {
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) { out[i] = Number(v & BigInt(255)); v >>= BigInt(8); }
    return out;
  }
  function poly1305(msg, key) {
    var r = leToBig(key.subarray(0, 16)) & CLAMP;
    var s = leToBig(key.subarray(16, 32));
    var acc = BigInt(0);
    for (var i = 0; i < msg.length; i += 16) {
      var end = Math.min(i + 16, msg.length);
      var n = leToBig(msg.subarray(i, end)) + (BigInt(1) << BigInt(8 * (end - i)));
      acc = ((acc + n) * r) % P1305;
    }
    return bigToLe((acc + s) & ((BigInt(1) << BigInt(128)) - BigInt(1)), 16);
  }
  function pad16(n) { return (16 - (n % 16)) % 16; }
  function le64(n) {
    var b = new Uint8Array(8);
    var v = BigInt(n);
    for (var i = 0; i < 8; i++) { b[i] = Number(v & BigInt(255)); v >>= BigInt(8); }
    return b;
  }
  /* AEAD 构造：Poly1305 的输入 = aad || pad || ct || pad || len(aad) || len(ct)（都是小端） */
  function macData(aad, ct) {
    var parts = [aad, new Uint8Array(pad16(aad.length)), ct, new Uint8Array(pad16(ct.length)), le64(aad.length), le64(ct.length)];
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }
  function aeadSeal(key, nonce, aad, plain) {
    var polyKey = chachaXor(key, nonce, 0, new Uint8Array(64)).subarray(0, 32);
    var ct = chachaXor(key, nonce, 1, plain);
    return { ct: ct, tag: poly1305(macData(aad, ct), polyKey) };
  }
  function aeadOpen(key, nonce, aad, ct, tag) {
    var polyKey = chachaXor(key, nonce, 0, new Uint8Array(64)).subarray(0, 32);
    var want = poly1305(macData(aad, ct), polyKey);
    var diff = 0;
    for (var i = 0; i < 16; i++) diff |= want[i] ^ tag[i];
    if (diff !== 0) throw new Error('bad-tag');
    return chachaXor(key, nonce, 1, ct);
  }

  /* ================= 文件格式 ================= */
  function chunkNonce(ivPrefix, idx) {
    var n = new Uint8Array(12);
    n.set(ivPrefix, 0);
    var v = BigInt(idx);
    for (var i = 0; i < 8; i++) { n[4 + i] = Number(v & BigInt(255)); v >>= BigInt(8); }
    return n;
  }
  function chunkAad(idx) { return le64(idx); }
  function packHeader(o) {
    var b = new Uint8Array(HEADER_LEN);
    for (var i = 0; i < MAGIC.length; i++) b[i] = MAGIC[i];
    b[7] = 1; b[8] = KDF_PBKDF2; b[9] = CIPHER_CHACHA20_POLY1305;
    var dv = new DataView(b.buffer);
    dv.setUint32(12, o.iter, true);
    b.set(o.salt, 16);
    dv.setUint32(32, o.chunkSize, true);
    b.set(o.ivPrefix, 36);
    var v = BigInt(o.plainSize);
    for (i = 0; i < 8; i++) { b[40 + i] = Number(v & BigInt(255)); v >>= BigInt(8); }
    return b;
  }
  function parseHeader(b0) {
    var b = b0 instanceof Uint8Array ? b0 : new Uint8Array(b0);
    if (b.length < HEADER_LEN) throw new Error('文件头不完整');
    for (var i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) throw new Error('不是加密文件');
    if (b[7] !== 1) throw new Error('版本不支持');
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return {
      kdf: b[8], cipher: b[9],
      iter: dv.getUint32(12, true),
      salt: b.slice(16, 32),
      chunkSize: dv.getUint32(32, true),
      ivPrefix: b.slice(36, 40),
      plainSize: leToBig(b.subarray(40, 48))
    };
  }
  function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
  function encChunkCount(plainSize, chunkSize) {
    var p = BigInt(plainSize), c = BigInt(chunkSize);
    var n = (p + c - BigInt(1)) / c;
    return Number(n < BigInt(1) ? BigInt(1) : n);
  }
  /* 加密一块（供分块上传用）：返回 { ct, tag, done } */
  function sealChunk(key, ivPrefix, idx, bytes) {
    var r = aeadSeal(key, chunkNonce(ivPrefix, idx), chunkAad(idx), bytes);
    var out = new Uint8Array(r.ct.length + 16);
    out.set(r.ct, 0); out.set(r.tag, r.ct.length);
    return out;
  }
  function openChunk(key, ivPrefix, idx, bytes) {
    if (bytes.length < 16) throw new Error('密文块损坏');
    var ct = bytes.subarray(0, bytes.length - 16), tag = bytes.subarray(bytes.length - 16);
    return aeadOpen(key, chunkNonce(ivPrefix, idx), chunkAad(idx), ct, tag);
  }
  return {
    HEADER_LEN: HEADER_LEN, DEFAULT_ITER: DEFAULT_ITER, DEFAULT_CHUNK: DEFAULT_CHUNK,
    CIPHER_CHACHA20_POLY1305: CIPHER_CHACHA20_POLY1305,
    sha256: sha256, hmac: hmac, pbkdf2: pbkdf2,
    chachaXor: chachaXor, poly1305: poly1305, aeadSeal: aeadSeal, aeadOpen: aeadOpen,
    packHeader: packHeader, parseHeader: parseHeader, rand: rand,
    encChunkCount: encChunkCount, sealChunk: sealChunk, openChunk: openChunk,
    chunkNonce: chunkNonce, chunkAad: chunkAad
  };
})();
`;

/* ---------- 页面 ---------- */
function fileGroupHtml(files) {
  if (!files.length) {
    return READONLY
      ? `<div class="empty"><div class="eicon">📭</div><div class="etitle">还没有文件</div>
      <div class="esub">${L('只读模式下不能上传，等共享者放文件进来', 'Read-only: nothing can be uploaded, wait for the host to add files')}</div></div>`
      : `<div class="empty"><div class="eicon">📭</div><div class="etitle">还没有文件</div>
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
      const urlSegs = f.rel.split('/').map(encodeURIComponent).join('/');   // 链接一律用磁盘上的真实路径
      const href = '/f/' + urlSegs;
      const imgUrl = '/i/' + urlSegs;
      const kind = kindOf(f.name);                       // 类型看显示名：加密文件的磁盘名是随机串
      const isMedia = !f.enc && (kind === 'video' || kind === 'audio');
      const thumb = (!f.enc && isImg(f.name))
        ? `<img class="thumb" src="${imgUrl}" data-img="${imgUrl}" loading="lazy" alt="">`
        : `<span class="thumb ico">${f.enc ? '🔐' : (isMedia ? (kind === 'video' ? '▶' : '♪') : kindLabel(f.name))}</span>`;
      const mediaAttr = isMedia
        ? ` data-media="/m/${urlSegs}" data-mkind="${kind}" title="${L('点一下在线播放', 'Click to play')}"`
        : '';
      const tags = (f.vis === 'private' ? `<span class="tagon" title="${L('仅自己可见', 'Only you can see this')}">🔒</span>` : '')
        + (f.enc ? `<span class="tagon" title="${L('浏览器端加密，需要密码', 'End-to-end encrypted - password required')}">🔐</span>` : '');
      const act = f.mine && !READONLY
        ? `<button class="btn ghost fgear" data-rel="${esc(f.rel)}" data-name="${esc(f.name)}" data-vis="${f.vis}" data-enc="${f.enc ? 1 : 0}" data-code="${esc(f.code)}" data-size="${f.size}" data-note="${f.folder === DIR_TEXT ? 1 : 0}" title="${L('设置', 'Settings')}" aria-label="${L('设置', 'Settings')} ${esc(f.name)}">⚙</button>`
          + `<button class="btn ghost danger fdel" data-rel="${esc(f.rel)}" data-name="${esc(f.name)}" title="删除" aria-label="删除 ${esc(f.name)}">✕</button>`
        : (READONLY ? '' : `<span class="editlock" title="${L('只有上传者能删除', 'Only the uploader can delete')}">🔒</span>`);
      return `<li class="frow" data-name="${esc(f.name.toLowerCase())}" data-disp="${esc(f.name)}" data-rel="${esc(f.rel)}" data-kind="${kind}" data-size="${f.size}"${f.enc ? ' data-enc="1"' : ''}><input type="checkbox" class="selbox" aria-label="选择 ${esc(f.name)}"><a class="row" href="${href}"${mediaAttr}>
  ${thumb}
  <span class="mid"><span class="nm">${esc(f.name)}${tags}</span><span class="meta">${esc(f.ip || '未记录')} · ${ts}</span></span>
  <span class="sz">${human(f.size)}</span>
</a>${act}</li>`;
    }).join('');
    const grpZip = g.k === '（根目录）'
      ? ''
      : `<button type="button" class="btn ghost mini grpzip" data-rel="${esc(g.k)}" title="${L('把这个文件夹打包成 zip 下载', 'Download this folder as a zip')}">zip</button>`;
    return `<details class="grp" data-folder="${esc(g.k)}"${openKeys.has(g.k) ? ' open' : ''}><summary class="folder"><span class="chev">▸</span><span class="fname">📂 ${esc(g.k)}</span>${grpZip}<span class="cnt">${g.list.length}</span></summary><ul class="list">${rows}</ul></details>`;
  }).join('');
}

function page(files, meIp) {
  const free = freeBytes();

  return `<!doctype html><html lang="${LANG === 'en' ? 'en' : 'zh-CN'}"><head>
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
 .grpzip{margin-left:auto;font-size:11px;padding:3px 8px;line-height:1.2}
 ul.list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
 li.frow{display:flex;align-items:center;gap:8px}
 .fdel{flex:0 0 auto;padding:9px 13px;border-radius:11px;font-size:14px;line-height:1}
 .editlock{flex:0 0 auto;padding:9px 10px;font-size:14px;opacity:.4;user-select:none}
 /* 设置（⚙）只出现在自己传的文件上；🔒/🔐 是小小的一行标记，别抢文件名的地方 */
 .fgear{flex:0 0 auto;padding:9px 11px;border-radius:11px;font-size:14px;line-height:1}
 .tagon{font-size:11px;margin-left:5px;opacity:.85;white-space:nowrap}
 /* 待上传列表：选好文件后先在这里逐个设置，再统一上传 */
 .stage{margin-top:12px}
 .scard{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:11px 12px;margin-bottom:8px}
 .stop{display:flex;align-items:center;gap:8px}
 .snm{flex:1;min-width:0;font-weight:600;font-size:14px;word-break:break-all}
 .ssz{color:var(--muted);font-size:12px;white-space:nowrap}
 .scfg{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:9px}
 .scfg .wide{grid-column:1/-1}
 .slab{font-size:12px;color:var(--muted);display:block;margin-bottom:3px}
 .sin{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg);
   color:inherit;font:13.5px inherit;outline:none;box-sizing:border-box}
 .sin:focus{border-color:var(--accent)}
 .sck{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--muted);margin:5px 0}
 .sck input{width:16px;height:16px;accent-color:var(--accent);flex:0 0 auto}
 .spw{margin-top:7px}
 .spw .sin{margin-bottom:6px}
 .shint{font-size:12px;color:var(--muted);margin-top:5px}
 select.sin{font:13.5px inherit}
 .stagebar{display:flex;gap:8px;align-items:center;margin-bottom:8px}
 .stagebar .sp{flex:1}
 /* 对话框（提取码 / 文件设置 / 解密）沿用 .mdl 的壳子，只是内容宽一点、左对齐 */
 .mdlbox.wide{max-width:520px;text-align:left}
 .mdlbox.wide h3{margin-bottom:10px}
 .fld{margin:11px 0}
 .dlgmsg{font-size:13px;color:var(--muted);margin-top:9px;min-height:18px;word-break:break-all}
 .dlgnote{font-size:12.5px;color:var(--muted);margin:8px 0;line-height:1.55}
 .coderow{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}
 .codename{flex:1;min-width:110px;font-size:13.5px;word-break:break-all}
 .progbar{height:6px;background:var(--bg);border-radius:99px;overflow:hidden;margin-top:10px}
 .progbar i{display:block;height:100%;width:0;background:var(--accent);transition:width .18s}
 @media (max-width:430px){ .scfg{grid-template-columns:1fr} }
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
 #filelist.grid .fgear{position:absolute;top:5px;right:34px;padding:4px 7px;font-size:12px;border:0;
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
 .lb video{max-width:100%;max-height:100%;border-radius:8px;background:#000}
 .lb audio{width:min(560px,90vw)}
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
 .robar{margin:0 0 12px;padding:9px 12px;border-radius:var(--radius);background:var(--accent-soft);
  color:var(--accent);font-size:13px;font-weight:600;text-align:center}
 .ro-hide{display:none!important}
 .hright{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
 /* 「接入」是别人进到这个共享的唯一入口（手机扫码），别让它长得像个次要按钮。
    高度写死 30px，和旁边的容量 chip（29px）齐平 —— 靠实心底色和字重醒目，不靠体积。
    这里刻意用长写属性：font 简写里放 inherit 是非法值，整条会被浏览器丢掉，
    line-height 一失效就会被 🔗 这个 emoji 的字形把行盒撑高（实测 35px）。 */
 .lkbtn{position:relative;display:inline-flex;align-items:center;justify-content:center;
   height:30px;padding:0 14px;border:0;border-radius:11px;cursor:pointer;white-space:nowrap;
   background:var(--accent);color:#fff;
   font-family:inherit;font-size:13px;font-weight:700;line-height:1;
   box-shadow:0 1px 6px rgba(37,99,235,.3);
   transition:transform .12s, box-shadow .18s, filter .18s}
 .lkbtn:hover{filter:brightness(1.06);box-shadow:0 2px 10px rgba(37,99,235,.45)}
 .lkbtn:active{transform:scale(.97)}
 .lkbtn::after{content:'';position:absolute;inset:-1px;border-radius:12px;border:2px solid var(--accent);
   animation:lkring 2.6s ease-out infinite;pointer-events:none}
 @keyframes lkring{
   0%{opacity:.5;transform:scale(.98)}
   70%,100%{opacity:0;transform:scale(1.18)}
 }
 @media (prefers-color-scheme:dark){
   .lkbtn{color:#0b1220;box-shadow:0 1px 6px rgba(110,168,254,.3)}
   .lkbtn:hover{box-shadow:0 2px 10px rgba(110,168,254,.45)}
 }
 @media (prefers-reduced-motion:reduce){ .lkbtn::after{animation:none;opacity:0} }
 .mdl{position:fixed;inset:0;z-index:70;background:rgba(15,23,42,.45);display:grid;place-items:center;padding:18px}
 .mdlbox{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px;
  max-width:420px;width:100%;text-align:center;box-shadow:0 18px 50px rgba(15,23,42,.28)}
 .mdlbox h3{margin:0 0 12px;font-size:16px}
 .qrslot{background:#fff;border-radius:12px;padding:10px;display:inline-block}
 .qrslot img{display:block;width:230px;height:230px}
 .mdlurls{margin:12px 0 0;display:flex;flex-direction:column;gap:6px}
 .mdlurls a{font-size:13px;color:var(--accent);word-break:break-all;text-decoration:none;cursor:pointer}
 .mdlurls a.on{font-weight:700;text-decoration:underline}
 .mdlurls .virt{color:var(--muted);font-size:11px}
 .mdlrow{display:flex;gap:8px;justify-content:center;margin-top:12px}
 .mdlhint{color:var(--muted);font-size:12px;margin-top:10px}
 [hidden]{display:none!important}
</style></head><body>
<div class="wrap">
  <header>
    <div class="brand">
      <h1>局域网共享</h1>
      <div class="sub">同一 WiFi 下的设备都能用 · 上传 / 下载 / 传文本</div>
    </div>
    <div class="hright">
      ${free === undefined ? '' : `<span class="chip">💾 可用 <b>${human(free)}</b></span>`}
      <button class="lkbtn" id="lkBtn" title="${L('手机怎么连进来', 'How to open this from a phone')}">${L('🔗 接入', '🔗 Connect')}</button>
      <button class="btn ghost mini" id="unBtn" title="${L('输入提取码，解锁别人设成「仅自己可见」的文件', 'Enter an extract code to unlock a private file someone shared with you')}">🔑 ${L('提取码', 'Code')}</button>
    </div>
  </header>
${READONLY ? `
  <div class="robar">${L('🔒 只读模式：只能查看和下载，上传、发文字与删除都已关闭', '🔒 Read-only: viewing and downloading only — upload, text and delete are off')}</div>` : ''}

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
    <div class="card pad${READONLY ? ' ro-hide' : ''}">
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
    <div class="drop${READONLY ? ' ro-hide' : ''}" id="drop">
      <div class="di">📤</div>
      <div class="dt">点这里选择文件</div>
      <div class="ds">自动存入 文件/${todayFolder()}/ · 电脑上也可以直接把文件或文件夹拖进来</div>
      <input id="file" type="file" multiple hidden>
      <input id="dir" type="file" webkitdirectory directory multiple hidden>
      <button class="btn ghost mini" id="pickDir" type="button">${L('或选整个文件夹', 'or pick a whole folder')}</button>
    </div>
    <div class="stage ro-hide" id="stage" hidden>
      <div class="stagebar">
        <span class="tbinfo" id="stageInfo"></span>
        <button class="btn ghost mini" id="stageClear" type="button">${L('清空', 'Clear')}</button>
        <button class="btn mini" id="stageGo" type="button">${L('开始上传', 'Upload')}</button>
      </div>
      <div id="stageList"></div>
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
      ${fileGroupHtml(files)}
    </div>
    <div id="noHit" class="empty" hidden><div class="eicon">🔍</div><div class="etitle">没有匹配的内容</div></div>
  </section>
</div>

<div class="dragmask" id="mask">松开即可上传</div>
<div class="lb" id="lb" hidden><img id="lbimg" alt=""><video id="lbvid" controls playsinline hidden></video><audio id="lbaud" controls hidden></audio><button class="lbclose" id="lbclose">关闭 ✕</button></div>
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

<div class="mdl" id="mdl" hidden>
  <div class="mdlbox" role="dialog" aria-modal="true" aria-label="${L('手机扫码进入', 'Scan to open on your phone')}">
    <h3>${L('手机扫码进入', 'Scan to open on your phone')}</h3>
    <div class="qrslot"><img id="qrimg" alt="${L('二维码', 'QR code')}"></div>
    <div class="mdlurls" id="mdlUrls"></div>
    <div class="mdlrow">
      <button class="btn ghost mini" id="mdlCopy">${L('复制网址', 'Copy URL')}</button>
      <button class="btn mini" id="mdlClose">${L('关闭', 'Close')}</button>
    </div>
    <div class="mdlhint">${L('手机要和这台电脑在同一个 WiFi / 局域网里。带「虚拟网卡」标记的地址一般是连不通的。',
      'The phone must be on the same WiFi / LAN as this computer. Addresses marked as virtual adapters usually do not work.')}</div>
  </div>
</div>

<div class="mdl" id="undlg" hidden>
  <div class="mdlbox wide" role="dialog" aria-modal="true" aria-label="${L('输入提取码', 'Enter extract code')}">
    <h3>🔑 ${L('输入提取码', 'Enter extract code')}</h3>
    <div class="dlgnote">${L('别人把文件设成「仅自己可见」时会拿到一个提取码。输进去，这个浏览器就能看到那个文件（换设备要重输）。',
      'A file set to "only me" comes with an extract code. Enter it here and this browser can see that file.')}</div>
    <input id="unCode" class="sin" type="text" autocomplete="off" spellcheck="false" placeholder="${L('例如 K7M2QP', 'e.g. K7M2QP')}">
    <div class="dlgmsg" id="unMsg"></div>
    <div class="mdlrow">
      <button class="btn ghost mini" id="unClose" type="button">${L('关闭', 'Close')}</button>
      <button class="btn mini" id="unGo" type="button">${L('兑换', 'Unlock')}</button>
    </div>
  </div>
</div>

<div class="mdl" id="setdlg" hidden>
  <div class="mdlbox wide" role="dialog" aria-modal="true" aria-label="${L('文件设置', 'File settings')}">
    <h3>⚙ ${L('文件设置', 'File settings')}</h3>
    <div class="fld">
      <span class="slab">${L('文件名（重命名）', 'Name (rename)')}</span>
      <input id="setName" class="sin" type="text" autocomplete="off">
    </div>
    <div class="fld">
      <span class="slab">${L('可见范围', 'Visibility')}</span>
      <label class="sck"><input type="radio" name="setVis" id="setVisPub"> ${L('所有人可见', 'Everyone')}</label>
      <label class="sck"><input type="radio" name="setVis" id="setVisPriv"> ${L('仅自己可见（生成提取码）', 'Only me (generates an extract code)')}</label>
    </div>
    <div class="fld" id="setCodeRow">
      <span class="slab">${L('提取码：发给别人，他们输入后就能看到这个文件', 'Extract code: share it and others can see this file')}</span>
      <div class="coderow">
        <span class="codebox" id="setCode">—</span>
        <button class="btn ghost mini" id="setCopy" type="button">${L('复制', 'Copy')}</button>
        <button class="btn ghost mini" id="setRotate" type="button">${L('换一个', 'New code')}</button>
      </div>
    </div>
    <div class="dlgnote" id="setEncNote"></div>
    <div class="fld" id="setEncRow">
      <span class="slab">${L('把已上传的文件也加密', 'Encrypt this file too')}</span>
      <div class="dlgnote" style="margin:4px 0 8px">${L('先在浏览器里加密，再把密文上传，最后删掉原文件（中途磁盘上会短暂地同时存在两份）。加密后的文件会落在今天的文件夹里。',
        'Encrypt in this browser, upload the ciphertext, then delete the original (both exist briefly). The encrypted copy lands in the folder dated today.')}</div>
      <button class="btn ghost mini" id="setEncBtn" type="button">🔐 ${L('加密此文件', 'Encrypt this file')}</button>
      <div id="setEncBox" hidden>
        <input id="setEncPw" class="sin" type="password" autocomplete="new-password" placeholder="${L('新密码（丢了就打不开）', 'New password (unrecoverable)')}" style="margin-top:8px">
        <input id="setEncPw2" class="sin" type="password" autocomplete="new-password" placeholder="${L('再输一次', 'Repeat it')}" style="margin-top:6px">
        <div class="dlgmsg" id="setEncMsg"></div>
        <button class="btn mini" id="setEncGo" type="button" style="margin-top:6px">${L('开始加密', 'Encrypt now')}</button>
      </div>
    </div>
    <div class="dlgmsg" id="setMsg"></div>
    <div class="mdlrow">
      <button class="btn ghost mini" id="setClose" type="button">${L('关闭', 'Close')}</button>
      <button class="btn mini" id="setSave" type="button">${L('保存', 'Save')}</button>
    </div>
  </div>
</div>

<div class="mdl" id="decdlg" hidden>
  <div class="mdlbox wide" role="dialog" aria-modal="true" aria-label="${L('解密下载', 'Decrypt and download')}">
    <h3 id="decTitle">🔐 ${L('解密下载', 'Decrypt and download')}</h3>
    <div class="dlgnote">${L('这个文件在服务器上是密文。密码只在这个浏览器里用，不会发出去；解密完成后直接存成原文件，服务器上留下的还是密文。',
      'The server only holds the ciphertext. Your password is used in this browser and never sent; the file is saved locally under its real name.')}</div>
    <input id="decPw" class="sin" type="password" autocomplete="off" placeholder="${L('文件密码', 'File password')}">
    <div class="progbar" id="decBar"><i></i></div>
    <div class="dlgmsg" id="decMsg"></div>
    <div class="mdlrow">
      <button class="btn ghost mini" id="decClose" type="button">${L('关闭', 'Close')}</button>
      <button class="btn mini" id="decGo" type="button">${L('解密并下载', 'Decrypt')}</button>
    </div>
  </div>
</div>

<div class="mdl" id="codesdlg" hidden>
  <div class="mdlbox wide" role="dialog" aria-modal="true" aria-label="${L('提取码', 'Extract codes')}">
    <h3>🔑 ${L('提取码（现在就记下来）', 'Extract codes (save them now)')}</h3>
    <div class="dlgnote">${L('这些文件设成了「仅自己可见」。把提取码发给别人，他们输进去就能看到并下载；自己在这个浏览器上一直能看到，也可以随时在 ⚙ 里查看和更换。',
      'These files are private. Share a code and others can see that file; you can always see them in this browser, and review or rotate codes under the gear icon.')}</div>
    <div id="codesList"></div>
    <div class="mdlrow"><button class="btn mini" id="codesClose" type="button">${L('知道了', 'Got it')}</button></div>
  </div>
</div>

<script>${CLIENT_CRYPTO_SRC}</script>
<script>
const $ = id => document.getElementById(id);
const RO = ${READONLY ? 'true' : 'false'};        // 只读模式：写操作的入口都不渲染，这里再兜一层
function why(status){ return status === 403 && RO ? ${JSON.stringify(L('只读模式已开启', 'read-only mode is on'))} : String(status); }
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
const lb = $('lb'), lbimg = $('lbimg'), lbvid = $('lbvid'), lbaud = $('lbaud');
function lbShow(){ lb.hidden = false; requestAnimationFrame(() => lb.classList.add('in')); }
function stopMedia(){
  for (const el of [lbvid, lbaud]) {
    try { el.pause(); } catch (e) {}
    el.hidden = true;
    el.removeAttribute('src');
    try { el.load(); } catch (e) {}          // 不加这行，某些浏览器会继续缓冲上一首
  }
  lbimg.removeAttribute('src');
}
function openLb(src){ stopMedia(); lbimg.hidden = false; lbimg.src = src; lbShow(); }
function openMedia(src, kind){
  stopMedia();
  const el = kind === 'audio' ? lbaud : lbvid;
  lbimg.hidden = true;
  el.hidden = false;
  el.src = src;
  const p = el.play && el.play();
  if (p && p.catch) p.catch(() => {});       // 浏览器可能因为没有用户手势拒绝，让它自己显示控制条
  lbShow();
}
function closeLb(){
  lb.classList.remove('in');
  setTimeout(() => { lb.hidden = true; stopMedia(); }, 160);
}
lb.addEventListener('click', closeLb);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) closeLb(); });
document.addEventListener('click', ev => {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-img],[data-media]') : null;
  if (!el) return;
  const media = el.getAttribute('data-media');
  if (media) {
    if (picking()) return;                   // 选择模式下点一下是勾选，不是播放
    ev.preventDefault();
    openMedia(media, el.getAttribute('data-mkind'));
    return;
  }
  ev.preventDefault();
  openLb(el.getAttribute('data-img'));
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
  let del = null;
  if (!RO && n.can) {              // can 由服务端算好：只有发布者本人和本机会拿到 true
    del = document.createElement('button'); del.className='btn ghost danger'; del.textContent='删除'; del.setAttribute('aria-label','删除这条文本');
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
        if (r.ok) { toast('已删除'); loadNotes(); }
        else {
          let msg = '删除失败：' + why(r.status);
          try { const j = await r.json(); if (j && j.message) msg = j.message; } catch (e) {}
          toast(msg, true);
        }
      } catch (e) { toast('删除失败', true); }
    };
  }
  acts.appendChild(cp); if (del) acts.appendChild(del);
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
    else toast('发送失败：' + why(r.status), true);
  } catch (e) { toast('发送失败：' + e.message, true); }
  sendBtn.disabled = false; sendBtn.textContent = '发送';
};
ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendBtn.click(); });

/* 页面任意处粘贴 -> 填入输入框 */
window.addEventListener('paste', e => {
  if (RO) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  const t = e.clipboardData && e.clipboardData.getData('text/plain');
  if (!t) return;
  if (secText.hidden) showTab('text');
  ta.value = t; updCount(); ta.focus();
  toast('已粘贴到输入框');
});

/* ---------- 上传 ---------- */
const drop = $('drop'), inp = $('file'), dirInp = $('dir'), mask = $('mask');
const droppedDirs = new WeakMap();                 // File -> '子目录/文件名'（拖进来的文件夹用）
drop.addEventListener('click', () => { if (!RO) inp.click(); });
$('pickDir').addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); if (!RO) dirInp.click(); });
inp.addEventListener('change', () => { if (!RO) stageAdd(Array.from(inp.files)); inp.value = ''; });
dirInp.addEventListener('change', () => { if (!RO) stageAdd(Array.from(dirInp.files)); dirInp.value = ''; });
let dragDepth = 0;
/* 拖进来的可能整个是文件夹：用 webkitGetAsEntry 递归读（entry 必须在事件里同步取，之后 items 就失效了） */
function entriesOf(dt) {
  const items = dt && dt.items;
  if (!items || !items.length) return null;
  const out = [];
  for (const it of Array.from(items)) {
    if (it.kind !== 'file') continue;
    const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (en) out.push(en);
  }
  return out.length ? out : null;
}
async function filesFromEntries(entries) {
  const out = [];
  const readAll = reader => new Promise(res => reader.readEntries(res, () => res([])));
  const walk = async (entry, prefix) => {
    if (out.length > 3000) return;
    if (entry.isFile) {
      const f = await new Promise(res => entry.file(res, () => res(null)));
      if (f) { if (prefix) droppedDirs.set(f, prefix + f.name); out.push(f); }
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await readAll(reader);
      if (!batch.length) break;
      for (const en of batch) await walk(en, prefix + entry.name + '/');
    }
  };
  for (const en of entries) await walk(en, '');
  return out;
}
window.addEventListener('dragenter', e => { e.preventDefault(); if (RO) return; if (++dragDepth === 1) mask.classList.add('on'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', e => { e.preventDefault(); if (RO) return; if (--dragDepth <= 0) { dragDepth = 0; mask.classList.remove('on'); } });
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; mask.classList.remove('on');
  if (RO || !e.dataTransfer) return;
  const dtFiles = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
  const entries = entriesOf(e.dataTransfer);
  if (!entries) { if (dtFiles.length) stageAdd(dtFiles); return; }
  filesFromEntries(entries).then(list => {
    if (list.length) stageAdd(list);
    else if (dtFiles.length) stageAdd(dtFiles);
  });
});

/* 真正的上传在页面末尾那段（脚本 2）里：先入待上传列表，设置好重命名/加密/可见范围再传 */

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

/* ---------- 接入方式：局域网网址 + 二维码 ---------- */
const LK = ${JSON.stringify(lanCandidates(listenPort))};
const mdl = $('mdl'), qrimg = $('qrimg'), mdlUrls = $('mdlUrls');
// 如果这台设备本来就是用某个局域网地址连上来的（手机、另一台电脑），默认就选它——一定连得通
let lkPick = Math.max(0, LK.findIndex(c => c.url.indexOf('//' + ${JSON.stringify(String(meIp))} + ':') === 0));
function lkRender(){
  const cur = LK[lkPick];
  qrimg.src = '/qr?u=' + encodeURIComponent(cur ? cur.url : location.origin + '/');
  mdlUrls.textContent = '';
  if (!LK.length) {
    const d = document.createElement('div'); d.className = 'virt';
    d.textContent = ${JSON.stringify(L('（没找到局域网地址，可能没连网）', '(no LAN address found - is this machine online?)'))};
    mdlUrls.appendChild(d);
    return;
  }
  LK.forEach((c, i) => {
    const a = document.createElement('a');
    a.href = c.url;
    a.textContent = c.url + ' · ' + c.name + (c.virtual ? ${JSON.stringify(L('（虚拟网卡，多半连不通）', ' (virtual adapter, probably unreachable)'))} : '');
    a.className = (i === lkPick ? 'on' : '') + (c.virtual ? ' virt' : '');
    a.onclick = ev => { ev.preventDefault(); lkPick = i; lkRender(); };
    mdlUrls.appendChild(a);
  });
}
$('lkBtn').onclick = () => { lkRender(); mdl.hidden = false; };
$('mdlClose').onclick = () => { mdl.hidden = true; };
mdl.onclick = ev => { if (ev.target === mdl) mdl.hidden = true; };
$('mdlCopy').onclick = () => copyText(LK[lkPick] ? LK[lkPick].url : location.href);
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !mdl.hidden) mdl.hidden = true; });

/* 分组标题上的 zip 按钮：点它别触发 details 的开合 */
document.addEventListener('click', ev => {
  const b = ev.target && ev.target.closest ? ev.target.closest('.grpzip') : null;
  if (!b) return;
  ev.preventDefault(); ev.stopPropagation();
  location.href = '/zip?f=' + encodeURIComponent(b.getAttribute('data-rel'));
}, true);

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
/* 别的设备动了东西就自动刷新：每 3 秒问一次版本号，变了才真的拉列表。
   初始值必须用服务端渲染时的版本号，否则页面加载后头几秒内的改动会被漏掉。 */
let listRev = ${LIST_REV};
async function syncRev(){
  if (document.hidden) return;
  try {
    const r = await fetch('/rev', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const rev = Number(j && j.rev) || 0;
    if (listRev && rev && rev !== listRev) {
      if (!secFile.hidden) await loadFiles();
      if (!secText.hidden) await loadNotes();
    }
    listRev = rev;
  } catch (e) {}
}
setInterval(syncRev, 3000);
syncRev();
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncRev(); });
</script>
<script>
/* ============ 新功能：待上传设置 / 提取码 / 文件设置 / 浏览器端加解密 ============ */
const ENC_WARN_BYTES = 384 * 1024 * 1024;
const stageEl = $('stage'), stageListEl = $('stageList'), stageInfoEl = $('stageInfo');
const staged = [];

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function encHint(size) {
  let s = '加密在本机浏览器里完成，密码不会发给服务器。';
  if (size > ENC_WARN_BYTES) s += ' 文件不小（' + human(size) + '），纯 JS 加解密约 18 MB/s，要等一会儿。';
  return s;
}

/* ---------- 待上传列表 ---------- */
function stageAdd(files) {
  if (RO || !files || !files.length) return;
  showTab('file');
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const relp = droppedDirs.get(f) || f.webkitRelativePath || '';
    const sub = relp ? relp.split('/').slice(0, -1).join('/') : '';
    staged.push({ file: f, sub: sub, name: f.name, enc: false, pw: '', pw2: '', vis: 'public' });
  }
  stageEl.hidden = false;
  renderStage();
  toast('已加入 ' + files.length + ' 个文件，设置好再点「开始上传」');
}

function renderStage() {
  stageListEl.textContent = '';
  stageInfoEl.textContent = staged.length ? ('待上传 ' + staged.length + ' 个文件') : '';
  const go = $('stageGo');
  go.textContent = RO ? '开始上传' : ('开始上传 (' + staged.length + ')');
  go.disabled = staged.length === 0;
  if (!staged.length) { stageEl.hidden = true; return; }
  staged.forEach(function (it) {
    const card = mk('div', 'scard');
    const top = mk('div', 'stop');
    const nm = mk('span', 'snm', (it.sub ? it.sub + '/' : '') + it.name);
    const sz = mk('span', 'ssz', human(it.file.size));
    const rm = mk('button', 'btn ghost mini', '移除');
    rm.type = 'button';
    rm.onclick = function () { const i = staged.indexOf(it); if (i >= 0) staged.splice(i, 1); renderStage(); };
    top.appendChild(nm); top.appendChild(sz); top.appendChild(rm);

    const cfg = mk('div', 'scfg');
    const c1 = mk('div');
    c1.appendChild(mk('span', 'slab', '文件名（上传前重命名）'));
    const nameIn = mk('input', 'sin');
    nameIn.type = 'text'; nameIn.value = it.name; nameIn.autocomplete = 'off';
    nameIn.oninput = function () { it.name = nameIn.value; nm.textContent = (it.sub ? it.sub + '/' : '') + it.name; };
    c1.appendChild(nameIn);

    const c2 = mk('div');
    c2.appendChild(mk('span', 'slab', '可见范围'));
    const vis = mk('select', 'sin');
    [['public', '所有人可见'], ['private', '仅自己可见（生成提取码）']].forEach(function (p) {
      const o = mk('option', null, p[1]); o.value = p[0]; vis.appendChild(o);
    });
    vis.value = it.vis;
    vis.onchange = function () { it.vis = vis.value; };
    c2.appendChild(vis);
    cfg.appendChild(c1); cfg.appendChild(c2);

    const c3 = mk('div', 'wide');
    const ck = mk('label', 'sck');
    const cb = mk('input'); cb.type = 'checkbox'; cb.checked = it.enc;
    ck.appendChild(cb);
    ck.appendChild(mk('span', null, '加密（密码不出浏览器，服务器只存密文）'));
    const pwBox = mk('div', 'spw');
    const pw1 = mk('input', 'sin'); pw1.type = 'password'; pw1.placeholder = '密码（丢了就打不开，没有找回）'; pw1.autocomplete = 'new-password';
    const pw2 = mk('input', 'sin'); pw2.type = 'password'; pw2.placeholder = '再输一次'; pw2.autocomplete = 'new-password';
    const showLb = mk('label', 'sck');
    const showCb = mk('input'); showCb.type = 'checkbox';
    showLb.appendChild(showCb); showLb.appendChild(mk('span', null, '显示密码'));
    showCb.onchange = function () { const t = showCb.checked ? 'text' : 'password'; pw1.type = t; pw2.type = t; };
    pw1.oninput = function () { it.pw = pw1.value; };
    pw2.oninput = function () { it.pw2 = pw2.value; };
    pwBox.appendChild(pw1); pwBox.appendChild(pw2); pwBox.appendChild(showLb);
    pwBox.hidden = !it.enc;
    const hint = mk('div', 'shint', it.enc ? encHint(it.file.size) : '');
    cb.onchange = function () {
      it.enc = cb.checked;
      pwBox.hidden = !it.enc;
      hint.textContent = it.enc ? encHint(it.file.size) : '';
    };
    c3.appendChild(ck); c3.appendChild(pwBox); c3.appendChild(hint);
    cfg.appendChild(c3);

    card.appendChild(top); card.appendChild(cfg);
    stageListEl.appendChild(card);
  });
}
$('stageClear').onclick = function () { staged.length = 0; renderStage(); };
$('stageGo').onclick = function () { runUpload(); };

/* ---------- 上传（明文直传 / 加密后传密文） ---------- */
function putFile(name, body, query, onProgress) {
  return new Promise(function (resolve, reject) {
    const x = new XMLHttpRequest();
    const t0 = Date.now();
    x.open('PUT', '/u/' + encodeURIComponent(name) + query);
    x.upload.onprogress = function (e) {
      if (!e.lengthComputable || !onProgress) return;
      const dt = (Date.now() - t0) / 1000;
      onProgress(e.loaded / e.total, dt > 0.3 ? fmtSpeed(e.loaded / dt) : '');
    };
    x.onload = function () {
      if (x.status >= 300) return reject(new Error(x.status === 403 && RO ? '只读模式' : ('HTTP ' + x.status)));
      let j = null;
      try { j = JSON.parse(x.responseText); } catch (e) {}
      resolve(j || {});
    };
    x.onerror = function () { reject(new Error('网络错误')); };
    x.send(body);
  });
}

async function encryptBlob(file, pw, onProgress) {
  if (typeof LSENC === 'undefined') throw new Error('加密模块没加载');
  const iter = LSENC.DEFAULT_ITER, chunk = LSENC.DEFAULT_CHUNK;
  const salt = LSENC.rand(16), ivPrefix = LSENC.rand(4);
  onProgress(0, '派生密钥…（约 1 秒）');
  await new Promise(function (r) { setTimeout(r, 30); });          // 先让上面的文字画出来
  const key = LSENC.pbkdf2(pw, salt, iter, 32);
  const total = file.size;
  const n = LSENC.encChunkCount(total, chunk);
  const parts = [LSENC.packHeader({ iter: iter, salt: salt, chunkSize: chunk, ivPrefix: ivPrefix, plainSize: total })];
  for (let i = 0; i < n; i++) {
    const slice = file.slice(i * chunk, Math.min(total, (i + 1) * chunk));
    const buf = new Uint8Array(await slice.arrayBuffer());
    parts.push(LSENC.sealChunk(key, ivPrefix, i, buf));
    onProgress((i + 1) / n, null);
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

async function runUpload() {
  if (RO || !staged.length) return;
  const list = staged.slice();
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it.name.trim()) return toast('文件名不能为空', true);
    if (it.enc && !it.pw) return toast('「' + it.name + '」选了加密，但还没填密码', true);
    if (it.enc && it.pw !== it.pw2) return toast('「' + it.name + '」两次输入的密码不一样', true);
  }
  staged.length = 0;
  renderStage();
  stageEl.hidden = true;
  $('prog').textContent = '';
  const jobs = list.map(function (it) {
    const row = mk('div', 'prow');
    const top = mk('div', 'top');
    const nm = mk('span', 'nmx', (it.sub ? it.sub + '/' : '') + it.name);
    const pct = mk('span', 'sz', '准备中…');
    top.appendChild(nm); top.appendChild(pct);
    const bar = mk('div', 'bar');
    const fill = mk('i');
    bar.appendChild(fill);
    row.appendChild(top); row.appendChild(bar);
    $('prog').appendChild(row);
    return { it: it, pct: pct, fill: fill };
  });
  let failed = 0;
  const codes = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i], it = j.it;
    try {
      let body = it.file, encFlag = '';
      if (it.enc) {
        j.pct.textContent = '准备加密…';
        body = await encryptBlob(it.file, it.pw, function (p, msg) {
          if (msg) { j.pct.textContent = msg; return; }
          const pc = Math.round(p * 100);
          j.pct.textContent = '加密 ' + pc + '%';
          j.fill.style.width = pc + '%';
        });
        encFlag = '&enc=1';
      }
      const q = '?ren=' + encodeURIComponent(it.name)
        + (it.sub ? '&dir=' + encodeURIComponent(it.sub) : '')
        + (it.vis === 'private' ? '&vis=private' : '')
        + encFlag;
      const r = await putFile(it.file.name, body, q, function (p, speed) {
        const pc = Math.round(p * 100);
        j.pct.textContent = pc + '%' + (speed ? ' · ' + speed : '');
        j.fill.style.width = pc + '%';
      });
      j.pct.textContent = '✅ 完成';
      j.pct.className = 'sz ok';
      j.fill.style.width = '100%';
      if (r && r.code) codes.push({ name: r.name || it.name, code: r.code });
    } catch (e) {
      failed++;
      j.pct.textContent = '❌ ' + ((e && e.message) || '失败');
      j.pct.className = 'sz bad';
      j.fill.style.width = '100%';
      j.fill.style.background = 'var(--danger)';
    }
  }
  toast(failed ? (failed + ' 个文件上传失败') : '上传完成', !!failed);
  await loadFiles();
  applySort(); applyOpenState(); applyPicked();
  setTimeout(function () { $('prog').textContent = ''; }, 1500);
  if (codes.length) showCodes(codes);
}

/* ---------- 解密下载（浏览器里分块解密后另存） ---------- */
async function decryptDownload(rel, name, pw, onProgress) {
  if (typeof LSENC === 'undefined') throw new Error('加密模块没加载');
  const url = '/f/' + rel.split('/').map(encodeURIComponent).join('/');
  const hr = await fetch(url, { headers: { Range: 'bytes=0-63' }, cache: 'no-store' });
  if (!hr.ok) throw new Error('读取失败 ' + hr.status);
  const h = LSENC.parseHeader(new Uint8Array(await hr.arrayBuffer()));
  if (h.cipher !== LSENC.CIPHER_CHACHA20_POLY1305) throw new Error('不支持的加密格式');
  const total = Number(h.plainSize);
  const encChunk = h.chunkSize + 16;
  const n = LSENC.encChunkCount(total, h.chunkSize);
  const totalEnc = LSENC.HEADER_LEN + total + n * 16;
  onProgress(0, '派生密钥…（约 1 秒）');
  await new Promise(function (r) { setTimeout(r, 30); });
  const key = LSENC.pbkdf2(pw, h.salt, h.iter, 32);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const start = LSENC.HEADER_LEN + i * encChunk;
    const end = Math.min(totalEnc, start + encChunk) - 1;
    const res = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + end }, cache: 'no-store' });
    if (!res.ok && res.status !== 206) throw new Error('读取失败 ' + res.status);
    const piece = new Uint8Array(await res.arrayBuffer());
    let pt;
    try { pt = LSENC.openChunk(key, h.ivPrefix, i, piece); }
    catch (e) { throw new Error('密码不对，或者文件已经损坏'); }
    parts.push(pt);
    onProgress((i + 1) / n, null);
  }
  const blob = new Blob(parts);
  const burl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = burl; a.download = name; a.style.display = 'none';
  document.body.appendChild(a);
  if (a.click) a.click();
  setTimeout(function () { URL.revokeObjectURL(burl); if (a.parentNode) a.parentNode.removeChild(a); }, 120000);
}

/* ---------- 提取码兑换 ---------- */
$('unBtn').onclick = function () { $('unCode').value = ''; $('unMsg').textContent = ''; $('undlg').hidden = false; $('unCode').focus(); };
$('unClose').onclick = function () { $('undlg').hidden = true; };
$('unGo').onclick = async function () {
  const code = $('unCode').value.trim();
  if (!code) return $('unCode').focus();
  $('unGo').disabled = true;
  $('unMsg').textContent = '兑换中…';
  try {
    const r = await fetch('/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) });
    const j = await r.json();
    if (j && j.ok) {
      $('unMsg').textContent = '已解锁 ' + j.count + ' 个文件';
      await loadFiles(); applySort(); applyOpenState(); applyPicked();
      toast('已解锁 ' + j.count + ' 个文件' + (j.count > 1 ? '（可能不止一条同码）' : ''));
      setTimeout(function () { $('undlg').hidden = true; }, 600);
    } else {
      $('unMsg').textContent = '提取码不对，或者对应的文件已经不在了';
    }
  } catch (e) { $('unMsg').textContent = '兑换失败：' + e.message; }
  $('unGo').disabled = false;
};
$('unCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('unGo').click(); });

/* ---------- 文件设置（重命名 / 可见范围 / 提取码 / 给已有文件加密） ---------- */
let setRel = null;
let setInfo = null;
const ENC_INPLACE_MAX = 1024 * 1024 * 1024;      // 已上传文件再加密时，先整份拉进内存的上限
function openSettings(btn) {
  setRel = btn.getAttribute('data-rel');
  const isEnc = btn.getAttribute('data-enc') === '1';
  const isNote = btn.getAttribute('data-note') === '1';
  setInfo = {
    rel: setRel,
    name: btn.getAttribute('data-name') || '',
    vis: btn.getAttribute('data-vis') || 'public',
    enc: isEnc,
    size: Number(btn.getAttribute('data-size') || 0),
    note: isNote
  };
  $('setName').value = setInfo.name;
  $('setVisPub').checked = setInfo.vis !== 'private';
  $('setVisPriv').checked = setInfo.vis === 'private';
  $('setEncNote').textContent = isEnc
    ? '这个文件是浏览器端加密的：服务器上只有密文，密码丢了谁也打不开（包括服务器）。加密文件在磁盘上是随机名，所以重命名只改显示名。'
    : '加密只能在「上传前」选，或者用下面的「加密此文件」把已经传上来的这份就地加密。';
  // 已经加密的、便签正文、只读模式、或者大得拉不进内存的，都不给再加密的入口
  $('setEncRow').hidden = isEnc || isNote;
  $('setEncBox').hidden = true;
  $('setEncPw').value = '';
  $('setEncPw2').value = '';
  $('setEncMsg').textContent = '';
  $('setEncGo').disabled = false;
  setCode(btn.getAttribute('data-code') || '');
  $('setMsg').textContent = '';
  $('setSave').disabled = false;
  $('setdlg').hidden = false;
}
function setCode(c) {
  $('setCode').textContent = c || '—';
  $('setCodeRow').hidden = !c;
  $('setCopy').hidden = !c;
  $('setRotate').hidden = !c;
}
async function patchFile(body) {
  const r = await fetch('/f/' + setRel.split('/').map(encodeURIComponent).join('/'), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j.ok) throw new Error((j && (j.message || j.error)) || ('HTTP ' + r.status));
  return j;
}
$('setClose').onclick = function () { $('setdlg').hidden = true; };
$('setCopy').onclick = function () { copyText($('setCode').textContent); };
$('setSave').onclick = async function () {
  if (!setRel) return;
  $('setSave').disabled = true;
  $('setMsg').textContent = '保存中…';
  try {
    const j = await patchFile({ name: $('setName').value, vis: $('setVisPriv').checked ? 'private' : 'public' });
    setRel = j.rel;
    setCode(j.code || '');
    $('setMsg').textContent = j.vis === 'private'
      ? ('已保存 · 提取码 ' + (j.code || '') + '（发给别人，他们输入后就能看到）')
      : '已保存（所有人可见，原提取码已作废）';
    await loadFiles(); applySort(); applyOpenState(); applyPicked();
  } catch (e) { $('setMsg').textContent = '保存失败：' + e.message; }
  $('setSave').disabled = false;
};
$('setRotate').onclick = async function () {
  if (!setRel) return;
  $('setMsg').textContent = '正在换码…';
  try {
    const j = await patchFile({ rotate: true });
    setCode(j.code || '');
    $('setMsg').textContent = '新提取码：' + j.code + '（旧的立刻失效）';
    await loadFiles(); applySort(); applyOpenState(); applyPicked();
  } catch (e) { $('setMsg').textContent = '换码失败：' + e.message; }
};

/* 把已经上传的文件就地加密：下载 → 浏览器里加密 → 上传密文 → 删原件。
   先传后删是故意的：中途断了最多多留一份，不会丢东西。 */
$('setEncBtn').onclick = function () {
  if (!setInfo) return;
  if (setInfo.enc || setInfo.note) return;
  if (setInfo.size > ENC_INPLACE_MAX) {
    $('setEncMsg').textContent = '这个文件有 ' + human(setInfo.size) + '，超过 1 GB 拉不进浏览器内存。请先下载到电脑上加密，再上传新文件。';
    $('setEncBox').hidden = false;
    $('setEncGo').disabled = true;
    return;
  }
  $('setEncBox').hidden = false;
  $('setEncGo').disabled = false;
  $('setEncPw').focus();
};
$('setEncGo').onclick = async function () {
  if (!setInfo || !setRel) return;
  const info = setInfo;
  const pw = $('setEncPw').value, pw2 = $('setEncPw2').value;
  if (!pw) { $('setEncMsg').textContent = '先填一个密码'; return $('setEncPw').focus(); }
  if (pw !== pw2) { $('setEncMsg').textContent = '两次输入的密码不一样'; return; }
  $('setEncGo').disabled = true;
  $('setSave').disabled = true;
  const url = '/f/' + info.rel.split('/').map(encodeURIComponent).join('/');
  try {
    $('setEncMsg').textContent = '下载原文件…（' + human(info.size) + '）';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('下载失败 ' + res.status);
    const raw = await res.blob();
    $('setEncMsg').textContent = '加密中…';
    const encBlob = await encryptBlob(new File([raw], info.name), pw, function (p, msg) {
      if (msg) { $('setEncMsg').textContent = msg; return; }
      $('setEncMsg').textContent = '加密 ' + Math.round(p * 100) + '%';
    });
    $('setEncMsg').textContent = '上传密文…';
    const q = '?ren=' + encodeURIComponent(info.name) + (info.vis === 'private' ? '&vis=private' : '') + '&enc=1';
    const up = await putFile(info.name, encBlob, q, function (p) {
      $('setEncMsg').textContent = '上传 ' + Math.round(p * 100) + '%';
    });
    $('setEncMsg').textContent = '删除原文件…';
    const del = await fetch(url, { method: 'DELETE' });
    setRel = up.path || setRel;
    setInfo = Object.assign({}, info, { rel: setRel, enc: true });
    setCode(up.code || '');
    $('setEncNote').textContent = '这个文件已经加密：服务器上只有密文，密码丢了谁也打不开（包括服务器）。';
    $('setEncRow').hidden = true;
    $('setMsg').textContent = del.ok
      ? '加密完成，原文件已删除。新文件在「今天」的文件夹里。'
      : '密文已经上传成功，但原文件没能删掉（' + del.status + '），可以手动删一次。';
    if (up.code) $('setMsg').textContent += ' 新的提取码：' + up.code;
    await loadFiles(); applySort(); applyOpenState(); applyPicked();
    toast('已加密');
  } catch (e) {
    $('setEncMsg').textContent = '加密失败：' + e.message;
  }
  $('setEncGo').disabled = false;
  $('setSave').disabled = false;
};

/* ---------- 解密对话框 ---------- */
let decTarget = null;
function openDecrypt(rel, name) {
  decTarget = { rel: rel, name: name };
  $('decTitle').textContent = '🔐 解密下载：' + name;
  $('decPw').value = '';
  $('decMsg').textContent = '';
  $('decBar').firstElementChild.style.width = '0%';
  $('decdlg').hidden = false;
  $('decPw').focus();
}
$('decClose').onclick = function () { $('decdlg').hidden = true; };
$('decGo').onclick = async function () {
  if (!decTarget) return;
  const pw = $('decPw').value;
  if (!pw) return $('decPw').focus();
  $('decGo').disabled = true;
  try {
    await decryptDownload(decTarget.rel, decTarget.name, pw, function (p, msg) {
      if (msg) { $('decMsg').textContent = msg; return; }
      const pc = Math.round(p * 100);
      $('decMsg').textContent = '解密 ' + pc + '%';
      $('decBar').firstElementChild.style.width = pc + '%';
    });
    $('decMsg').textContent = '解密完成，已开始保存（浏览器可能会问存到哪里）';
    $('decBar').firstElementChild.style.width = '100%';
    toast('解密完成');
  } catch (e) {
    $('decMsg').textContent = e.message;
  }
  $('decGo').disabled = false;
};
$('decPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('decGo').click(); });

/* ---------- 提取码结果（上传完私有文件后弹一次） ---------- */
function showCodes(codes) {
  const box = $('codesList');
  box.textContent = '';
  codes.forEach(function (c) {
    const row = mk('div', 'coderow');
    row.appendChild(mk('span', 'codename', c.name));
    row.appendChild(mk('span', 'codebox', c.code));
    const cp = mk('button', 'btn ghost mini', '复制');
    cp.type = 'button';
    cp.onclick = function () { copyText(c.code); };
    row.appendChild(cp);
    box.appendChild(row);
  });
  $('codesdlg').hidden = false;
}
$('codesClose').onclick = function () { $('codesdlg').hidden = true; };

/* ---------- 点击接管：⚙ 打开设置，加密文件点一下先解密 ---------- */
document.addEventListener('click', function (ev) {
  const t = ev.target;
  if (!t || !t.closest) return;
  const gear = t.closest('.fgear');
  if (gear) { ev.preventDefault(); ev.stopPropagation(); openSettings(gear); return; }
  const li = t.closest('li.frow[data-enc="1"]');
  if (li && t.closest('a.row')) {
    ev.preventDefault();                                  // 密文直链别直接下，先解密
    if (picking()) {                                      // 选择模式下点一下 = 勾选，不是下载
      const cb = li.querySelector ? li.querySelector('.selbox') : null;
      const rel = li.getAttribute('data-rel');
      if (cb && rel) {
        cb.checked = !cb.checked;
        if (cb.checked) picked.add(rel); else picked.delete(rel);
        if (li.classList) li.classList.toggle('picked', cb.checked);
        syncBtns();
      }
      return;
    }
    openDecrypt(li.getAttribute('data-rel'), li.getAttribute('data-disp') || 'download.bin');
  }
}, true);

/* 合并/分别下载都跳过加密文件：服务端只有密文，打包出来也没法用 */
function pickedRows() {
  const out = [];
  const items = filelistEl.querySelectorAll('li.frow');
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getAttribute('data-rel');
    if (r && picked.has(r)) out.push({ rel: r, enc: items[i].getAttribute('data-enc') === '1', name: items[i].getAttribute('data-disp') || r });
  }
  return out;
}
zipBtn.onclick = function () {
  const rows = pickedRows();
  if (!rows.length) return;
  const plain = rows.filter(function (x) { return !x.enc; });
  if (!plain.length) return toast('加密文件不能合并下载，请点开逐个解密下载', true);
  if (plain.length < rows.length) toast('已跳过 ' + (rows.length - plain.length) + ' 个加密文件');
  location.href = '/zip?' + plain.map(function (x) { return 'f=' + encodeURIComponent(x.rel); }).join('&');
};
dlOneBtn.onclick = function () {
  const rows = pickedRows();
  const plain = rows.filter(function (x) { return !x.enc; });
  if (!plain.length) return toast('加密文件请点开逐个解密下载', true);
  toast('分别下载 ' + plain.length + ' 个文件…');
  plain.forEach(function (x, i) {
    setTimeout(function () {
      const a = document.createElement('a');
      a.href = '/f/' + x.rel.split('/').map(encodeURIComponent).join('/');
      a.download = x.name;
      a.style.display = 'none';
      document.body.appendChild(a);
      if (a.click) a.click();
      setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 3000);
    }, i * 250);
  });
};

/* 点空白处或按 Esc 关掉这些新对话框 */
['undlg', 'setdlg', 'decdlg', 'codesdlg'].forEach(function (id) {
  const d = $(id);
  d.addEventListener('click', function (ev) { if (ev.target === d) d.hidden = true; });
});
document.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Escape') return;
  ['undlg', 'setdlg', 'decdlg', 'codesdlg'].forEach(function (id) { if (!$(id).hidden) $(id).hidden = true; });
});
</script></body></html>`;
}

/* ---------- 合并下载：零依赖 ZIP（store + data descriptor，单遍流式，不落临时文件） ---------- */
const ZIP_LIMIT = 3.9 * 1024 * 1024 * 1024;   // 超过就提示分批下载（避开 zip64）
const MAX_ZIP_ENTRIES = 4000;                 // 文件夹打包时的条目上限，防止一次扫爆
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
  READONLY = RO_FORCED || cfg.readOnly === true;
  bumpRev();                                    // 开关变了，其它设备也要跟着换界面
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
    <label><input type="checkbox" id="optRO"><span><b>${L('只读模式', 'Read-only mode')}</b><i>${L('打开后别人只能查看和下载：不能上传、发文字、删除（本机也一样）。适合临时把文件给别人拿', 'Nobody can upload, post text or delete — only view and download; applies to this machine too.')}</i></span></label>
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
  kv(b,'只读模式',S.readOnly?'开（别人只能下载）':'关');
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
  bind('optRO','readOnly',false);
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
      shortcut: !!body.shortcut,
      readOnly: !!body.readOnly
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

/* ---------- 局域网地址（扫码用）----------
   非回环 IPv4 全列出来，但排序很讲究：手机应该扫到真正能连的那个。
   排序依据（依次）：名字像虚拟网卡 > 地址尾数是 .1/.254（多半是虚拟交换机的网关侧）> 其它。
   都不占优时按网卡名排。列表里会带上网卡名，让人自己判断。 */
const VIRTUAL_IF = /(vmware|virtualbox|vethernet|hyper-v|wsl|docker|tailscale|zerotier|radmin|hamachi|npcap|tap|tun|vpn|bluetooth)/i;
function lanCandidates(port) {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of (ifs[name] || [])) {
        if (!a || a.family !== 'IPv4' || a.internal) continue;
        if (String(a.address).startsWith('169.254.')) continue;      // 自动私有地址，扫了也连不上
        out.push({
          name,
          url: 'http://' + a.address + ':' + port + '/',
          virtual: VIRTUAL_IF.test(name),
          gatewayish: /\.(1|254)$/.test(a.address)
        });
      }
    }
  } catch {}
  const rank = c => (c.virtual ? 2 : (c.gatewayish ? 1 : 0));
  out.sort((x, y) => (rank(x) - rank(y)) || x.name.localeCompare(y.name));
  return out;
}

/* ---------- 二维码（字节模式 / 纠错等级 M / 版本 1–10，按 ISO/IEC 18004 自己实现）----------
   零依赖环境里没有现成的 QR 库，所以照规范写了一个。
   正确性验证：与独立实现（npm qrcode）逐模块比对 —— 96 个不同长度的输入，连掩码选择都一致。 */
const QR_TOTAL_CW = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];   // 总码字（数据+纠错）
const QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];                       // 纠错块数
const QR_EC_TOTAL = [0, 10, 16, 26, 36, 48, 64, 72, 88, 110, 130];         // 纠错码字总数
const QR_MAX_VERSION = 10;
const QR_PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };

const QR_EXP = new Uint8Array(512), QR_LOG = new Uint8Array(256);
(function qrInitGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) { QR_EXP[i] = x; QR_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
})();
function qrMul(a, b) { return (a && b) ? QR_EXP[QR_LOG[a] + QR_LOG[b]] : 0; }

// 生成多项式 g(x) = (x-α^0)(x-α^1)…：内部低次在前累乘，返回时翻成高次在前（g[0] = 1）
function qrGenPoly(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j + 1] ^= g[j];
      next[j] ^= qrMul(g[j], QR_EXP[i]);
    }
    g = next;
  }
  return g.reverse();
}
function qrRsEncode(data, ecLen) {
  const gen = qrGenPoly(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= qrMul(gen[j], factor);
  }
  return buf.slice(data.length);
}
function qrCodewords(bytes, version) {
  const total = QR_TOTAL_CW[version], ecTotal = QR_EC_TOTAL[version], blocks = QR_BLOCKS[version];
  const dataTotal = total - ecTotal;
  const ecPer = ecTotal / blocks;
  const g2 = dataTotal % blocks, g1 = blocks - g2;
  const c1 = Math.floor(dataTotal / blocks), c2 = c1 + 1;

  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);                                  // 字节模式
  push(bytes.length, version < 10 ? 8 : 16);        // 字符计数
  for (const b of bytes) push(b, 8);

  const cap = dataTotal * 8;
  if (bits.length + 4 <= cap) push(0, 4);           // 终止符
  while (bits.length % 8) bits.push(0);
  for (let i = 0; bits.length < cap; i++) push(i % 2 ? 0x11 : 0xEC, 8);

  const buf = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    buf.push(b);
  }
  const dc = [], ecs = [];
  let off = 0;
  for (let b = 0; b < blocks; b++) {
    const n = b < g1 ? c1 : c2;
    const blk = Uint8Array.from(buf.slice(off, off + n));
    off += n;
    dc.push(blk);
    ecs.push(qrRsEncode(blk, ecPer));
  }
  const out = [];
  for (let i = 0; i < c2; i++) for (let b = 0; b < blocks; b++) if (i < dc[b].length) out.push(dc[b][i]);
  for (let i = 0; i < ecPer; i++) for (let b = 0; b < blocks; b++) out.push(ecs[b][i]);
  return Uint8Array.from(out);
}
function qrAlignPositions(version) {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const interval = size === 145 ? 26 : Math.ceil((size - 13) / (2 * n - 2)) * 2;
  const out = [size - 7];
  for (let i = 1; i < n - 1; i++) out[i] = out[i - 1] - interval;
  out.push(6);
  return out.sort((a, b) => a - b);
}
function qrFormatBits(mask) {
  const data = (0 << 3) | mask;                     // 等级 M 的两位是 00
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | (rem & 0x3FF)) ^ 0x5412;
}
function qrVersionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= 0x1F25 << (i - 12);
  return (version << 12) | (rem & 0xFFF);
}
function qrMaskAt(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r * c) % 2 + (r * c) % 3 === 0;
    case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
    default: return ((r * c) % 3 + (r + c) % 2) % 2 === 0;
  }
}
function qrPickVersion(len) {
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const need = 4 + (v < 10 ? 8 : 16) + len * 8;
    if (need <= (QR_TOTAL_CW[v] - QR_EC_TOTAL[v]) * 8) return v;
  }
  return 0;
}
function qrEncode(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = qrPickVersion(bytes.length);
  if (!version) throw new Error('too long');
  const cw = qrCodewords(bytes, version);
  const size = version * 4 + 17;
  const mods = new Uint8Array(size * size);
  const res = new Uint8Array(size * size);
  const idx = (r, c) => r * size + c;
  const set = (r, c, dark, reserved) => { mods[idx(r, c)] = dark ? 1 : 0; if (reserved) res[idx(r, c)] = 1; };
  const isRes = (r, c) => res[idx(r, c)] === 1;

  // 定位图案 + 分隔带
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(rr, cc, ring || core ? 1 : 0, true);
    }
  }
  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0;
    set(6, i, dark, true);
    set(i, 6, dark, true);
  }
  // 对齐图案：只有三个角（压在定位图案上）不摆
  const pos = qrAlignPositions(version), lastPos = pos.length - 1;
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === lastPos) || (i === lastPos && j === 0)) continue;
    const cr = pos[i], cc = pos[j];
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      set(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0, true);
    }
  }
  const formatInfo = mask => {
    const bits = qrFormatBits(mask);
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1;
      if (i < 6) set(i, 8, bit, true);
      else if (i < 8) set(i + 1, 8, bit, true);
      else set(size - 15 + i, 8, bit, true);
      if (i < 8) set(8, size - i - 1, bit, true);
      else if (i < 9) set(8, 15 - i, bit, true);
      else set(8, 15 - i - 1, bit, true);
    }
    set(size - 8, 8, 1, true);                       // 固定暗模块
  };
  formatInfo(0);                                     // 先占位，免得数据摆进格式区
  if (version >= 7) {
    const bits = qrVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3 + size - 11, bit = (bits >> i) & 1;
      set(r, c, bit, true);
      set(c, r, bit, true);
    }
  }
  // 数据：从右下角开始，两列一组上下折返，跳过第 6 列（定时图案）
  let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (!isRes(row, col - c)) {
          let dark = 0;
          if (byteIndex < cw.length) dark = (cw[byteIndex] >>> bitIndex) & 1;
          set(row, col - c, dark);
          if (--bitIndex === -1) { byteIndex++; bitIndex = 7; }
        }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
  const applyMask = mask => {
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (isRes(r, c)) continue;
      if (qrMaskAt(mask, r, c)) mods[idx(r, c)] ^= 1;
    }
  };
  const penalty = () => {
    let points = 0, sameRow = 0, sameCol = 0, lastRow = -1, lastCol = -1;
    for (let r = 0; r < size; r++) {
      sameRow = 0; sameCol = 0; lastRow = -1; lastCol = -1;
      for (let c = 0; c < size; c++) {
        const a = mods[idx(r, c)];
        if (a === lastRow) sameRow++;
        else { if (sameRow >= 5) points += QR_PENALTY.N1 + (sameRow - 5); lastRow = a; sameRow = 1; }
        const b = mods[idx(c, r)];
        if (b === lastCol) sameCol++;
        else { if (sameCol >= 5) points += QR_PENALTY.N1 + (sameCol - 5); lastCol = b; sameCol = 1; }
      }
      if (sameRow >= 5) points += QR_PENALTY.N1 + (sameRow - 5);
      if (sameCol >= 5) points += QR_PENALTY.N1 + (sameCol - 5);
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const sum = mods[idx(r, c)] + mods[idx(r, c + 1)] + mods[idx(r + 1, c)] + mods[idx(r + 1, c + 1)];
      if (sum === 0 || sum === 4) points += QR_PENALTY.N2;
    }
    let bitsRow = 0, bitsCol = 0;
    for (let r = 0; r < size; r++) {
      bitsRow = 0; bitsCol = 0;
      for (let c = 0; c < size; c++) {
        bitsRow = ((bitsRow << 1) & 0x7FF) | mods[idx(r, c)];
        if (c >= 10 && (bitsRow === 0x5D0 || bitsRow === 0x05D)) points += QR_PENALTY.N3;
        bitsCol = ((bitsCol << 1) & 0x7FF) | mods[idx(c, r)];
        if (c >= 10 && (bitsCol === 0x5D0 || bitsCol === 0x05D)) points += QR_PENALTY.N3;
      }
    }
    let dark = 0;
    for (let i = 0; i < mods.length; i++) dark += mods[i];
    return points + Math.abs(Math.ceil((dark * 100 / mods.length) / 5) - 10) * QR_PENALTY.N4;
  };
  let best = 0, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    formatInfo(mask);
    applyMask(mask);
    const p = penalty();
    applyMask(mask);                                 // XOR 两次就还原
    if (p < bestPenalty) { bestPenalty = p; best = mask; }
  }
  applyMask(best);
  formatInfo(best);
  return { version, size, mask: best, modules: mods };
}
// 深色模块按行合并成水平线段，SVG 比一格一个 rect 小得多
function qrSvg(text, opts) {
  const o = opts || {};
  const scale = o.scale || 4, quiet = o.quiet == null ? 4 : o.quiet;
  const dark = o.dark || '#000000', light = o.light || '#ffffff';
  const q = qrEncode(text);
  const dim = q.size + quiet * 2;
  let d = '';
  for (let r = 0; r < q.size; r++) {
    let c = 0;
    while (c < q.size) {
      if (!q.modules[r * q.size + c]) { c++; continue; }
      let run = 1;
      while (c + run < q.size && q.modules[r * q.size + c + run]) run++;
      d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h' + run + 'v1h-' + run + 'z';
      c += run;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim * scale + '" height="' + dim * scale +
    '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR">' +
    '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
    '<path d="' + d + '" fill="' + dark + '"/></svg>';
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
  LANG = pickLang(req, rawQuery);
  if (/(^|&)lang=(zh|en)(&|$)/.test(rawQuery)) {          // 用 ?lang= 选过就记住
    try { res.setHeader('Set-Cookie', LANG_COOKIE + '=' + LANG + '; Path=/; Max-Age=31536000; SameSite=Lax'); } catch {}
  }

  // Host / Origin 校验（挡 DNS rebinding 与跨站请求）
  if (!sameSite(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  const meId = ensureId(req, res);
  const unlocked = readUnlocked(req);        // 提取码兑换来的通行证（私有文件的可见性靠它兜底）

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

  // 只读模式：写操作一律拒绝（下载、预览、列表刷新都不受影响）
  if (READONLY && isWrite(req.method, urlPath)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: false, error: 'read-only', message: L('只读模式已开启', 'read-only mode is on') }));
  }

  if (req.method === 'GET' && urlPath === '/qr') {
    // 只给本机自己的局域网地址生成二维码，免得变成一个公开的二维码生成器
    let u = '';
    try { u = new URL('http://x/?' + rawQuery).searchParams.get('u') || ''; } catch {}
    const allowed = new Set(lanCandidates(listenPort).map(c => c.url));
    allowed.add('http://127.0.0.1:' + listenPort + '/');
    let okUrl = false;
    try { const p = new URL(u); okUrl = p.protocol === 'http:' && allowed.has(p.origin + '/'); } catch {}
    if (!okUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('not a LAN address of this server');
    }
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(qrSvg(u, { scale: 6, quiet: 3 }));
  }

  if (req.method === 'GET' && urlPath === '/rev') {
    // 极便宜的变更探测：只回一个整数，页面拿它决定要不要拉列表
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end('{"rev":' + LIST_REV + '}');
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
      'X-Older-Count': String(older.length),
      'X-Rev': String(LIST_REV)
    });
    // can 只用来决定客户端渲不渲染删除按钮；真正的删除请求服务端会独立再校验一次
    const pack = arr => arr.map(n => ({ id: n.id, t: n.t, text: n.text, ip: n.ip, file: n.file, can: canDeleteNote(n, meId, ip) }));
    return res.end(JSON.stringify(pack(wantOlder ? older : recent).reverse()));
  }

  if (req.method === 'POST' && urlPath === '/t') {
    readBody(req, NOTE_MAX_CHARS * 4 + 4096).then(raw => {
      let text = '';
      try { const o = JSON.parse(raw || '{}') || {}; text = String(o.text || ''); } catch {}
      text = text.replace(/\r\n/g, '\n').trim();
      if (!text) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('内容为空'); }
      if (text.length > NOTE_MAX_CHARS) text = text.slice(0, NOTE_MAX_CHARS);
      const { note: n, saved } = addNote(text, ip, meId);
      if (!saved) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'save-failed', message: L('保存失败：服务端写不进文本索引', 'Could not save: the note index on the server is not writable') }));
      }
      bumpRev();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, id: n.id, file: n.file || null }));
    });
    return;
  }

  if (req.method === 'DELETE' && urlPath.startsWith('/t/')) {
    const id = urlPath.slice(3);
    const list = readNotes();
    const victim = list.filter(n => n.id === id);
    if (!victim.length) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'not-found' }));
    }
    // 便签同样要认归属，否则同一网络里任何人都能删掉别人发的文本（连同 快捷文本/*.txt）
    if (!victim.some(n => canDeleteNote(n, meId, ip))) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'only-owner', message: L('只有发布者能删除这条文本', 'Only the poster can delete this note') }));
    }
    victim.forEach(removeNoteFile);
    const next = list.filter(n => n.id !== id);
    if (!writeNotes(next)) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'save-failed', message: L('删除失败：服务端写不进文本索引', 'Delete failed: the note index on the server is not writable') }));
    }
    bumpRev();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, removed: list.length - next.length }));
  }

  if (req.method === 'GET' && urlPath.startsWith('/t/raw/')) {
    const n = readNotes().find(x => x.id === urlPath.slice(7));
    res.writeHead(n ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(n ? n.text : 'not found');
  }

  /* 提取码兑换：一个码只解锁它对应的那些文件，通行证写进 HMAC 签名的 cookie */
  if (req.method === 'POST' && urlPath === '/unlock') {
    readJsonBody(req, 4096).then(body => {
      const code = String(body.code || '').trim().toUpperCase();
      const meta = readMeta();
      const hit = Object.keys(meta).filter(rel => isPrivateEntry(meta[rel]) && meta[rel].code && codeMatches(code, meta[rel].code));
      const set = readUnlocked(req);
      hit.forEach(r => set.add(r));
      if (hit.length) {
        addCookie(res, UNLOCK_COOKIE + '=' + signUnlock([...set]) + '; Path=/; Max-Age=' + Math.floor(UNLOCK_TTL / 1000) + '; HttpOnly; SameSite=Lax');
      }
      uiJson(res, 200, { ok: hit.length > 0, count: hit.length, total: set.size });
    });
    return;
  }

  /* 文件设置：重命名 / 可见范围 / 换提取码 —— 只有上传者本人（或服务器本机）能动 */
  if (req.method === 'PATCH' && urlPath.startsWith('/f/')) {
    const t = safeRel(urlPath.slice(3));
    if (!t) { res.writeHead(404); return res.end('not found'); }
    let st; try { st = fs.statSync(t.full); } catch { res.writeHead(404); return res.end('not found'); }
    if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
    readJsonBody(req).then(body => {
      const meta = readMeta();
      const e = meta[t.rel] || {};
      if (!(isHostSelf(ip) || ownerOk(e, meId, ip))) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'only-uploader', message: L('只有上传者能改这个文件', 'Only the uploader can change this file') }));
      }
      let rel = t.rel, full = t.full;
      const patch = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = safeName(body.name);
      if (body.vis === 'private' || body.vis === 'public') patch.vis = body.vis;
      const wantPrivate = patch.vis ? patch.vis === 'private' : isPrivateEntry(e);
      if (!wantPrivate) patch.code = '';                                  // 转公开就把码作废
      else if (body.rotate === true || !e.code) patch.code = makeCode();  // 转私有或显式换码时发新码
      // 明文文件的磁盘名跟着显示名走 —— 别人用资源管理器翻共享目录时看到的也是一致的名字。
      // 加密文件不动磁盘名（那是随机串），只改元数据里的显示名。
      if (patch.name && !isEncEntry(e) && patch.name !== path.basename(full)) {
        const pdir = path.dirname(full);
        const target = uniqueIn(pdir, patch.name);
        const nrel = rel.split('/').slice(0, -1).concat([target]).join('/');
        try { fs.renameSync(full, path.join(pdir, target)); }
        catch (err) {
          return uiJson(res, 500, { ok: false, error: 'rename-failed', message: String((err && err.message) || err) });
        }
        delete meta[rel];
        // 便签的正文文件被改名时，notes.jsonl 里的引用要跟着改，否则那条便签就找不到自己的 txt 了
        const notes = readNotes();
        let touched = false;
        for (const n of notes) if (n.file === rel) { n.file = nrel; touched = true; }
        if (touched) writeNotes(notes);
        rel = nrel; full = path.join(pdir, target);
        patch.name = target;
      }
      meta[rel] = Object.assign({}, meta[rel] || e, patch);
      writeMeta(meta);
      bumpRev();
      return uiJson(res, 200, {
        ok: true, rel,
        name: displayNameOf(rel, meta[rel]),
        vis: isPrivateEntry(meta[rel]) ? 'private' : 'public',
        enc: isEncEntry(meta[rel]),
        code: meta[rel].code || ''
      });
    });
    return;
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
    // 上传时可选的三样设置，都走查询串：
    //   ?dir=<子目录>   选整个文件夹上传时保留目录结构
    //   &ren=<显示名>   上传前重命名
    //   &vis=private    仅自己可见（服务端自动生成提取码回给上传者）
    //   &enc=1          内容已经在浏览器里加密好了，磁盘上换成随机名、不给任何名字线索
    let qs = null;
    try { qs = new URL('http://x/?' + rawQuery).searchParams; } catch { qs = null; }
    const qget = k => (qs ? qs.get(k) : null);
    let sub = '';
    try { sub = safeSub(qget('dir')); } catch { sub = null; }
    if (sub === null) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('目录名不合法');
    }
    const wantEnc = qget('enc') === '1';
    const wantVis = qget('vis') === 'private' ? 'private' : 'public';
    const showName = safeName(qget('ren') || urlPath.slice(3));
    const folder = DIR_FILES + '/' + todayFolder() + (sub ? '/' + sub : '');
    const dir = path.join(ROOT, ...folder.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    // 加密文件的磁盘名是随机串：翻共享文件夹的人看不出这是什么、叫什么
    const diskWanted = wantEnc ? crypto.randomBytes(12).toString('hex') + '.bin' : showName;
    const name = uniqueIn(dir, diskWanted);
    const rel = folder + '/' + name;
    const dest = path.join(dir, name);
    const newCode = wantVis === 'private' ? makeCode() : '';
    const ws = fs.createWriteStream(dest);
    let failed = false, got = 0, lastCheck = 0;
    const abort = (code, msg) => {
      if (failed) return;
      failed = true;
      try { req.unpipe(ws); } catch {}
      ws.destroy(); fs.unlink(dest, () => {});
      // 先把响应刷出去再 destroy：直接 req.destroy() 会把还没落盘的响应一起带走，
      // 客户端看到的是连接重置，而不是「超过单文件上限」这句话
      try {
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(msg, () => { try { req.destroy(); } catch {} });
      } catch { try { req.destroy(); } catch {} }
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
      if (res.headersSent) return;      // abort() 可能已经回过 413/507，再 writeHead 会抛 ERR_HTTP_HEADERS_SENT
      try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('写入失败'); } catch {}
    });
    ws.on('finish', () => {
      if (failed) return;
      // 明文文件：显示名就是磁盘名（重名时 uniqueIn 会加 " (2)"，显示名得跟着走，
      // 否则两个不同的文件会在列表里显示成同一个名字）。
      // 加密文件：磁盘名是随机串，显示名才是用户给的真实名。
      const finalName = wantEnc ? showName : name;
      setFileMeta(rel, ip, meId, { name: finalName, vis: wantVis, enc: wantEnc, code: newCode });
      bumpRev();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, path: rel, ip, name: finalName, vis: wantVis, enc: wantEnc, code: newCode }));
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
    bumpRev();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, removed: t.rel }));
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith('/f/')) {
    const t = safeRel(urlPath.slice(3));
    if (!t) { res.writeHead(404); return res.end('not found'); }
    const fe = readMeta()[t.rel] || {};
    if (!canSeeFile(t.rel, fe, meId, ip, unlocked)) { res.writeHead(404); return res.end('not found'); }
    // 加密文件在磁盘上就是密文，这里发的也是密文（浏览器解密后才是原文件），
    // 所以强制 octet-stream，并且用真实文件名 + .lsenc 提示它还需要解密
    if (isEncEntry(fe)) return sendFile(req, res, t.full, { ct: 'application/octet-stream', dlName: displayNameOf(t.rel, fe) + '.lsenc' });
    return sendFile(req, res, t.full, {});                        // 一律强制下载
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith('/i/')) {
    const t = safeRel(urlPath.slice(3));
    if (!t || !IMG_EXT.has(extOf(t.full))) { res.writeHead(404); return res.end('not found'); }
    const ie = readMeta()[t.rel] || {};
    if (isEncEntry(ie) || !canSeeFile(t.rel, ie, meId, ip, unlocked)) { res.writeHead(404); return res.end('not found'); }
    return sendFile(req, res, t.full, { inline: true, cache: 'private, max-age=120' });
  }

  // 音视频内联播放（配合 Range 才能拖进度条）
  if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith('/m/')) {
    const t = safeRel(urlPath.slice(3));
    if (!t || !MEDIA_EXT.has(extOf(t.full))) { res.writeHead(404); return res.end('not found'); }
    const me0 = readMeta()[t.rel] || {};
    if (isEncEntry(me0) || !canSeeFile(t.rel, me0, meId, ip, unlocked)) { res.writeHead(404); return res.end('not found'); }
    return sendFile(req, res, t.full, { inline: true, cache: 'private, max-age=120' });
  }

  if (req.method === 'GET' && urlPath === '/zip') {
    let wanted = [];
    try { wanted = new URL('http://x/?' + rawQuery).searchParams.getAll('f'); } catch { wanted = []; }
    const seen = new Set(), entries = [];
    const zmeta = readMeta();
    let skipped = 0;
    // 私有且没兑换过提取码的文件、以及加密文件（服务端解不开）都不进压缩包
    const zipAllowed = rel => {
      const ze = zmeta[rel] || {};
      return !isEncEntry(ze) && canSeeFile(rel, ze, meId, ip, unlocked);
    };
    const addFile = (full, rel, st) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      entries.push({ rel, full, size: st.size, name: Buffer.from(rel, 'utf8'), stamp: dosStamp(st.mtimeMs) });
    };
    // 选中整个文件夹时递归展开，压缩包里保留相对目录结构
    const walkDir = (absDir, prefix) => {
      let items = [];
      try { items = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const it of items) {
        if (entries.length >= MAX_ZIP_ENTRIES) { skipped++; continue; }
        const full = path.join(absDir, it.name);
        const childRel = prefix + '/' + it.name;
        if (it.isSymbolicLink() || !stillInside(full)) { skipped++; continue; }   // 不跟着链接跑出共享目录
        if (!zipAllowed(childRel)) { skipped++; continue; }
        if (it.isDirectory()) {
          if (SKIP_DIRS.has(it.name)) { skipped++; continue; }
          walkDir(full, childRel);
          continue;
        }
        if (!it.isFile()) { skipped++; continue; }
        let st; try { st = fs.statSync(full); } catch { skipped++; continue; }
        addFile(full, childRel, st);
      }
    };
    for (const raw of wanted) {
      const t = safeRel(raw);
      if (!t || !zipAllowed(t.rel)) { skipped++; continue; }
      let st; try { st = fs.statSync(t.full); } catch { skipped++; continue; }
      if (st.isFile()) { addFile(t.full, t.rel, st); continue; }
      if (st.isDirectory()) { walkDir(t.full, path.basename(t.rel)); continue; }
      skipped++;
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
    const files = listFiles(meId, ip, unlocked);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Rev': String(LIST_REV)
    });
    return res.end(page(files, ip));
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
