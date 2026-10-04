# 技术细节

## 从源码运行

```bash
git clone https://github.com/yourui233/best_lan-share.git && cd best_lan-share
node share-server.js ./shared 8080
```

需要 Node >= 18.15,不用 `npm install`:服务端只引用了内置模块
(`http fs path os net crypto child_process`)。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `共享目录` | `.` | 对外提供、也是上传落地的目录 |
| `端口` | `8080`(或 `$PORT`) | 监听端口,始终绑定 `0.0.0.0` |
| `数据目录` | `<共享目录>-data` | 只放内部记账数据,在共享目录之外 |

环境变量:`SHARE_MAX_UPLOAD`(默认 4 GiB)、`SHARE_HOSTS`(额外接受的 `Host` 名,逗号分隔)、
`SHARE_READONLY`(`1`/`true`/`yes`/`on`)、`PORT`;只读也可以直接用 `--read-only`。

启动横幅会把每张网卡的地址都列出来:

```
[share] content = /path/to/shared
[share] data    = /path/to/shared-data
[share] 本机    http://127.0.0.1:8080/
[share] 局域网  http://192.168.1.9:8080/
```

想用 Node 而不是 exe 开机自启:`start.vbs` 会用隐藏窗口把它拉起来,丢进
<kbd>Win</kbd>+<kbd>R</kbd> → `shell:startup` 即可。

## HTTP 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/` | 应用页面,文件列表由服务端渲染(带 `X-Rev` 头) |
| `GET` | `/rev` | 一个整数:有东西变了就 +1(页面轮询它决定要不要重拉列表) |
| `PUT` | `/u/<文件名>` | 流式上传到 `文件/<今天>/`(绝不覆盖同名文件);`?dir=<子目录>` 保留目录结构 |
| `GET` / `HEAD` / `DELETE` | `/f/<相对路径>` | 下载(强制附件,支持 `Range`)/ 删除 —— 仅上传者 |
| `GET` / `HEAD` | `/i/<相对路径>` | 内联图片(不含 SVG,带沙箱 CSP,支持 `Range`) |
| `GET` / `HEAD` | `/m/<相对路径>` | 内联音视频 —— 只放开这一类,别的类型不允许就地渲染 |
| `GET` | `/zip?f=<相对路径>&f=…` | 把选中的文件流式打成一个 zip;传文件夹会递归展开 |
| `GET` | `/qr?u=<url>` | 二维码(SVG);只接受本机自己的局域网地址 |
| `GET` | `/t/list` | 24 小时内的便签(`?older=1` 取更早的) |
| `POST` / `DELETE` | `/t`、`/t/<id>` | 发一条便签 / 删掉它和它的 `.txt` |
| `GET` | `/t/raw/<id>` | 便签的纯文本 |
| `POST` | `/unlock` | 用提取码兑换一张通行证 cookie（私有文件靠它可见） |
| `PATCH` | `/f/<相对路径>` | 文件设置：重命名 / 改可见范围 / 换提取码 —— 仅上传者 |
| `*` | `/setup`、`/setup/api/*` | 首次运行的安装向导 —— 只监听回环,配置好即消失 |

## 实时刷新、只读模式、二维码

- **实时刷新**:`LIST_REV` 是个内存计数器,上传完成、删文件、删便签、切换只读都会 +1。
  `GET /rev` 返回它(`/` 和 `/t/list` 的响应头里也有 `X-Rev`)。页面每 3 秒问一次,**只在页面可见
  时问**,而且只有数字变了才真的重拉列表 —— 所以另一台设备传完文件这边会自动出现,搜索词、排序、
  选中状态都不会被冲掉。基准值就是页面渲染时的那个版本号,所以"刚打开页面头几秒里的改动"也不会漏。
- **只读模式**:`lan-share.json` 里 `readOnly: true`、`--read-only`,或 `SHARE_READONLY=1`
  (命令行和环境变量优先于配置文件)。只在请求分发处挡一次:所有写请求 —— `PUT /u/*`、`POST /t`、
  `DELETE /f/*`、`DELETE /t/*` —— 一律返回 `403 {"error":"read-only"}`,同时页面渲染时就不带
  上传区、输入框和删除按钮。下载、打包、二维码、实时刷新都照常。
- **二维码**:`GET /qr?u=<url>` 输出 SVG(字节模式、纠错等级 M、版本 1–10,按 ISO/IEC 18004
  自己实现,不引依赖)。只为本机自己的局域网地址生成,顺便避免被当成公开的二维码生成器。地址列表里
  虚拟网卡(Hyper-V/WSL/VMware/VPN)排在最后并标注,尾数是 `.1`/`.254` 的网关型地址次之;
  如果访问者本来就是通过局域网地址连上来的,默认就选中它自己那个。
- **上传**:`PUT /u/<文件>?dir=a/b` 落到 `文件/<今天>/a/b/`,每一段目录名都校验(不许 `..`、
  不许保留设备名、不许 Windows 非法字符、最多 8 层)。拖文件夹用 `webkitGetAsEntry` 递归读,
  「或选整个文件夹」用 `webkitdirectory`。

## 可见范围、提取码与浏览器端加密

**元数据**（`-data/files.json` 的每条记录，老记录没有这些字段，一律按默认值读，不需要迁移）：

| 字段 | 含义 |
|---|---|
| `id` / `ip` / `t` | 上传者的 cookie 身份 / IP / 时间（原有字段） |
| `name` | 显示名。加密文件在磁盘上是随机名，真实名字只存在这里 |
| `vis` | `'public'`（默认）/ `'private'` |
| `enc` | `true` = 磁盘上是浏览器端加密后的密文，服务端不持有密钥 |
| `code` | 仅 `private`：6 位提取码（明文存在 `-data` 里，只在所有者请求时下发给页面） |

**访问控制**只在服务端做一次判断（`canSeeFile`）：公开文件谁都可见；私有文件只有上传者 cookie、
服务器本机（`127.0.0.1`/`::1`）、或兑换过提取码的浏览器可见。不可见的文件在 `listFiles()` 里就被过滤掉
（列表里不出现、`tabCount` 不计），直链 `/f/`、`/i/`、`/m/`、`/zip` 一律 404 —— 连"存在性"都不暴露。

注意元数据清理（删掉指向已消失文件的键）必须基于**全部**文件而不是过滤后的列表，否则当前浏览器看不到的
私有文件，记录会被顺手删掉。

**提取码通行证**：`POST /unlock` 拿码去比对 `code`（大小写不敏感、定长比较），命中就把命中的
rel 合并进一张 HMAC-SHA256 签名的 cookie（`lan_ok`，7 天有效）。服务端不存状态，重启即全部作废
（重新输一次码即可）；一张通行证最多记 200 个文件，避免撑爆 cookie。兑换不算"写操作"，
所以只读模式下也能用 —— 它只改变可见性，不动磁盘内容。

**加密文件格式**（64 字节头 + 逐块 AEAD，服务端完全不解析，只当不透明二进制）：

```
偏移  长度  内容
0     7     'LSENC1\0'
7     1     版本 = 1
8     1     KDF = 1（PBKDF2-HMAC-SHA256）
9     1     算法 = 2（ChaCha20-Poly1305）
12    4     迭代次数（小端 u32，默认 150000）
16    16    盐
32    4     分块大小（小端 u32，默认 8 MiB）
36    4     IV 前缀（每文件随机，用于拼 12 字节 nonce）
40    8     明文长度（小端 u64，所以 >4 GB 也表达得了）
48    16    保留
```

之后是逐块密文：第 i 块 = `ChaCha20-Poly1305(key, iv = ivPrefix || le64(i), aad = le64(i), 明文块)`，
密文长度 = 明文块长 + 16（tag）。块号同时进 nonce 和 AAD，所以**乱序、重复、截断、篡改任何一块都会
被认证失败拦下**。密钥 = `PBKDF2(password, salt, iter, 32)`。

**为什么是纯 JS、不用 WebCrypto**：`http://192.168.x.x` 不是"安全上下文"，浏览器在这种页面上
**不提供 `crypto.subtle`** —— 而这正是本工具最主要的用法（手机扫局域网地址进来）。所以 SHA-256 /
HMAC / PBKDF2 / ChaCha20 / Poly1305 都是自己实现的（随机数仍用 `crypto.getRandomValues`，
它不受安全上下文限制）。正确性靠与 OpenSSL 逐项比对（sha256、hmac、pbkdf2、ChaCha20 密钥流、
ChaCha20-Poly1305 的密文与 tag）+ RFC 8439 §2.8.2 官方向量保证；性能约 18 MB/s，
PBKDF2 15 万次迭代约 0.8 秒（桌面 V8）。

上传流程（客户端）：浏览器里分块加密成 Blob → `PUT /u/...?enc=1&ren=<真实名>&vis=`。服务端只收到
`enc=1` 这个标记，据此把记录标成加密、落盘换成 `随机24位hex.bin`、并在 `/f/` 上强制
`application/octet-stream` + 真实名 + `.lsenc`。下载流程：先 `Range: bytes=0-63` 取头部，派生密钥，
再按块 Range 拉取解密，最后拼成 Blob 触发另存。

**给已上传的文件就地加密**（⚙ → 加密此文件）走的是同一套原语，只是把顺序凑成
"整份下载 → 加密 → 上传密文 → DELETE 原件"：**先传后删**是故意的，中途失败最多多留一份而不是丢数据；
加密后的副本落在当天文件夹里（上传接口没有"写回指定日期目录"的能力），超过 1 GB 直接拒绝
（要整份读进浏览器内存），便签正文文件也不开放这个入口（删原件会连带删掉 notes 里那条记录）。

## 目录结构

```
shared/                          对外提供的内容 —— /f/ 和 /i/ 只能看到这里
  文件/2026-09-25/…               上传落地,一天一个文件夹
  文件/…/a3f9c1….bin               加密文件:随机名 + 密文(真实名在 files.json 里)
  快捷文本/2026-09-27_101500.txt   每条便签落一份 txt
shared-data/                     记账数据,刻意放在共享目录之外
  files.json                     rel → { id, ip, t, name, vis, enc, code }
  notes.jsonl                    一行一个 JSON 对象
lan-share.json                   向导写出的配置(仅 exe;写不进去时退到 %APPDATA%\lan-share)
```

身份认的是 `lan_id` cookie(16 字节随机数,`HttpOnly`、`SameSite=Lax`),不是会变的 IP;
上传者的 id 记在 `files.json` 里挨着每个文件。来自 `127.0.0.1` 的请求视为主人,可以删任何文件。

## exe 是怎么构建的

单文件、约 2900 行、没有框架:`share-server.js` 服务端渲染整个页面并负责一切。exe 就是你本机的
`node.exe`,把 `share-server.js` 作为
[Node SEA](https://nodejs.org/api/single-executable-applications.html) blob 注入进去:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1        # 版本号取自 package.json
powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1 -Version 0.1.0-beta
```

脚本会复制 `node.exe`、用 `tools/strip-signature.js` 抹掉它的 Authenticode 签名,再用
`npx postject` 注入 blob。`sea-config.json` 里特意关了 `useCodeCache`:这样同一份源码每次
构建出来的字节完全相同,发布出去的 `sha256` 是可复现的。

运行时 exe 会在自己旁边写 `lan-share.json`(那个目录不可写时退到 `%APPDATA%\lan-share`);
只有勾了开机自启,才会写一个注册表值 `HKCU\...\Run\LanShare`,指向一个隐藏窗口的
`wscript.exe` 启动脚本。`--setup` 重新走向导,`--uninstall` 清掉开机启动、快捷方式和配置。

## 已知限制

- **没有鉴权、没有 HTTPS** —— 能访问到端口的人就能读写一切。不要直接暴露到公网,确有外网需求
  请放在带认证的反向代理(或 VPN)后面。
- **"仅自己可见"和提取码都只是通行证,不是账号** —— 身份是 cookie,提取码是 6 位字符串(约 8.9 亿种
  组合,可在线暴力尝试,没有失败次数限制);拿到 cookie 或码的人就等于拿到了权限。要真正的身份边界,
  得加账号体系,那不在这个工具的范围内。提取码明文存在 `-data/files.json` 里。
- **加密只保护内容** —— 文件名、大小、上传者 IP 仍然是元数据;而且密码没有找回途径。加密文件的
  `/zip` 合并下载会被跳过(服务端解不开),在线预览/播放也不可用;解密需要把整份文件读进浏览器内存,
  上 GB 的文件在手机上容易失败。加密文件的"重命名"只改显示名,磁盘名保持随机串。
- **一次打包上限约 3.9 GB**(未实现 ZIP64);而且边生成边发送的 zip **不能断点续传** ——
  `Range` 对 `/zip` 不生效。单个文件(`/f/`、`/i/`、`/m/`)是可以续传的。
- **每次打开页面都会遍历一次共享目录**(最多 12 层)—— 几百个文件没问题,几十万个不行。
  待上传列表是每行一组 DOM,一次拖进上千个文件也会卡。
- **界面只有中文**。多语言的地基已经在了(`?lang=en`、`lan_lang` cookie、新文案用的
  `L(zh, en)`),但老文案还没迁进语言表,所以 `AUTO_LANG` 是刻意关掉的:英文系统的浏览器
  仍然拿到完整的中文页面,而不是"一半中文一半英文"。
- **预编译的 exe 没有签名,且只有 Windows x64 版。**
- **纯 JS 的加密实现没有经过第三方审计** —— 与 OpenSSL 逐项比对过,也有 RFC 8439 官方向量,
  但它不是密码学库。
