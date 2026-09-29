'use strict';
/*
 * 把 PE 文件里的 Authenticode 签名（证书表）摘掉。
 *
 * Node 官方打包单文件 exe 的文档要求先 `signtool remove /s`，因为注入 SEA blob 会让
 * 原签名失效。本机没有 signtool，所以这里直接把 optional header 里
 * IMAGE_DIRECTORY_ENTRY_SECURITY 那一项清零 —— 效果等价：Windows 找不到证书表，
 * 就不再校验那个已经失效的签名。
 *
 * 用法：node tools/strip-signature.js <file.exe>
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/strip-signature.js <file.exe>');
  process.exit(2);
}

const buf = fs.readFileSync(file);
if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {   // 'MZ'
  console.error('不是 PE 文件（缺 MZ 头）');
  process.exit(1);
}
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x00004550) {                // 'PE\0\0'
  console.error('不是 PE 文件（缺 PE 签名）');
  process.exit(1);
}

const optOff = peOff + 24;
const magic = buf.readUInt16LE(optOff);
const dirOff = optOff + (magic === 0x20b ? 112 : 96);        // PE32+ 与 PE32 的 data directory 位置不同
const sec = dirOff + 4 * 8;                                  // index 4 = 证书表

const va = buf.readUInt32LE(sec);
const size = buf.readUInt32LE(sec + 4);

if (va === 0 && size === 0) {
  console.log('[strip] 本来就没有签名，跳过');
  process.exit(0);
}
if (va + size > buf.length) {
  console.error('[strip] 证书表指向文件外，拒绝改动（' + va + '+' + size + ' > ' + buf.length + '）');
  process.exit(1);
}

buf.writeUInt32LE(0, sec);
buf.writeUInt32LE(0, sec + 4);
fs.writeFileSync(file, buf);
console.log('[strip] 已清掉签名：' + va + ' 字节 @ 0x' + va.toString(16));
