# lan-share 局域网共享

> 同一网络下的设备之间传文件、传文字 —— 一个 Node.js 文件,零依赖。

[English →](README.md)

<p align="center">
  <img src="docs/screenshots/mobile-files.png" width="230" alt="手机上的文件列表">
  <img src="docs/screenshots/mobile-select.png" width="230" alt="多选后分别下载 / 合并下载">
  <img src="docs/screenshots/mobile-notes.png" width="230" alt="文本便签">
  <img src="docs/screenshots/desktop-grid.png" width="480" alt="桌面端的网格视图">
</p>

## ⚠️ 没有鉴权

只适合*可信的局域网*。能访问到这个端口的人,就能浏览、下载、上传上面的所有东西 ——
不要直接暴露到公网,确有外网需求请放在带认证的反向代理(或 VPN)后面。

## Windows:不用装 Node

[下载 `best_lan-share-0.2.0-beta-win-x64.exe`](https://github.com/yourui233/best_lan-share/releases)(89 MB)
· 访问 GitHub 慢的话用 [加速下载](https://v4.gh-proxy.org/https://github.com/yourui233/best_lan-share/releases/download/v0.2.0-beta/best_lan-share-0.2.0-beta-win-x64.exe)。
双击即可:首次运行会在浏览器里打开安装向导(共享文件夹、端口、选项),只监听 `127.0.0.1`,
之后再双击就直接开始共享。

`SHA256 4035fd07bf769163273e7fd64435fdcb01f00ee173beeaa26868d5d1a23e93b5` —— 用
`certutil -hashfile best_lan-share-0.2.0-beta-win-x64.exe SHA256` 可以核对。

<p align="center">
  <img src="docs/screenshots/wizard-1-folder.png" width="400" alt="第 1 步:选择共享文件夹">
  <img src="docs/screenshots/wizard-3-options.png" width="400" alt="第 3 步:选项">
</p>

| 命令 | 作用 |
|---|---|
| `lan-share.exe` | 启动 —— 第一次走向导,之后直接服务 |
| `lan-share.exe --setup` | 重新配置 |
| `lan-share.exe --read-only` | 只读启动:别人只能看和下载,不能上传、发文字、删除 |
| `lan-share.exe --uninstall` | 清掉开机启动、桌面快捷方式和配置文件 |
| `lan-share.exe <目录> [端口] [数据目录]` | 跳过向导,与 Node 版一致 |

exe 没有代码签名,首次运行 SmartScreen 会拦一下(点「更多信息 → 仍要运行」),防火墙询问时
勾选**专用网络**。没有安装程序,不需要管理员权限,最多写一个注册表值。

## 快速开始

```bash
git clone https://github.com/yourui233/best_lan-share.git && cd best_lan-share
node share-server.js ./shared 8080        # 需要 Node >= 18.15,不用 npm install
```

然后用同一网络下的手机或电脑打开 `http://<这台机器的IP>:8080/`。

## 功能

- **文件** —— 拖拽或点选上传(支持多选),存进 `文件/<年-月-日>/`;把整个文件夹拖进来(或点
  「或选整个文件夹」)会连子目录一起保留。图片缩略图与灯箱、搜索、列表/网格切换、按时间/大小/
  名称排序。
- **断了也能续的下载** —— 勾选的文件、或者整个文件夹,都能「合并下载」打成一个流式 zip,也可以
  逐个下载。下载支持 HTTP `Range`:传到一半断了可以接着传,视频和音频还能直接在页面上播放。
- **列表自己会动** —— 别的设备上传或删除后,列表会自动更新(轮询一个很小的版本号;你在搜索框里
  打字时不会有任何重排)。
- **扫码进入** —— 页面上给出二维码和本机所有局域网地址(虚拟网卡会标出来),手机不用手输 IP。
- **只读模式** —— 向导里一个勾、`--read-only`,或 `SHARE_READONLY=1`:所有人只能浏览和下载,
  不能上传、发文字、删除。
- **文本便签** —— 粘贴一段文字或链接,所有设备都能看到,同时落一份 `快捷文本/*.txt`。
- **删除保护** —— 只有上传它的那台设备(或服务器本机)能删。
- **局域网防护** —— Host/Origin 校验(挡 DNS rebinding)、路径穿越与 Windows
  保留名处理、上传体积上限、剩余空间保护、`nosniff`、强制附件下载、SVG 永不内联。

<p align="center">
  <img src="docs/screenshots/connect-qr.png" width="300" alt="二维码与局域网地址,手机扫码进入">
  <img src="docs/screenshots/readonly.png" width="360" alt="只读模式:只能下载">
</p>

其他技术细节:
**[docs/technical.zh-CN.md](docs/technical.zh-CN.md)**。

## 许可证

MIT
