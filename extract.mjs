// extract.mjs — 从 Edge 的 LevelDB 中提取风车云马扩展的 localStorage 种子数据
// 用法: node extract.mjs [--state state.json]
import { ClassicLevel } from 'classic-level';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EXT_ID = 'cmlfpongefnmhijkolpgfjlbpplahcfi';
const ORIGIN = `chrome-extension://${EXT_ID}`;
const SRC = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'),
      'Microsoft', 'Edge', 'User Data', 'Default', 'Local Storage', 'leveldb')
  : path.join(os.homedir(), 'Library/Application Support/Microsoft Edge/Default/Local Storage/leveldb');
const TMP = path.join(os.tmpdir(), `fcym-leveldb-${Date.now()}`);

// 复制一份（Edge 运行时持有 LOCK）
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
for (const f of fs.readdirSync(SRC)) {
  try { fs.copyFileSync(path.join(SRC, f), path.join(TMP, f)); } catch {}
}

const db = new ClassicLevel(TMP, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
const entries = {};
for await (const [k, v] of db.iterator()) {
  const ks = k.toString('latin1');
  const idx = ks.indexOf(ORIGIN);
  if (idx === -1) continue;
  let rest = ks.slice(idx + ORIGIN.length);
  // Chromium LocalStorage v2: 键 = <origin>\x00\x01<key>，值首字节 0x01 为版本号
  if (!rest.startsWith('\x00\x01')) continue;
  const key = rest.slice(2);
  if (!key) continue; // META 条目
  let val = v.toString('latin1');
  if (val.charCodeAt(0) === 1) val = val.slice(1); // 去版本字节
  entries[key] = val; // latin1 保持字节原样（XXTEA/base64 均为 ASCII 安全）
}
await db.close();
fs.rmSync(TMP, { recursive: true, force: true });

const out = process.argv.includes('--state')
  ? path.resolve(process.argv[process.argv.indexOf('--state') + 1])
  : path.join(process.env.FCYM_HOME || process.cwd(), 'state.json');
fs.writeFileSync(out, JSON.stringify(entries, null, 1));
console.log(`[extract] 提取到 ${Object.keys(entries).length} 条 localStorage 记录 -> ${out}`);
const hasUD = entries['_UD'] !== undefined;
console.log(`[extract] _UD(用户域名): ${hasUD ? '有' : '无'}  _SD(系统域名): ${entries['_SD'] !== undefined ? '有' : '无'}`);
if (Object.keys(entries).length < 5) {
  console.error('[extract] 警告：记录过少，请确认 Edge 已登录过风车云马扩展后重试');
  process.exit(1);
}
