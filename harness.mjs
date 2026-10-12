// harness.mjs — 风车云马系统级客户端
// 在 Node 中运行扩展的 background.js（shim 浏览器 API），捕获其生成的 PAC，
// 并在本地起一个按 PAC 分流的转发代理，然后设置系统自动代理指向本地。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ID = 'cmlfpongefnmhijkolpgfjlbpplahcfi';
const EXT_DIR = path.join(__dirname, 'ext');
const BG = fs.readFileSync(path.join(EXT_DIR, 'js', 'background.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const LOCALE = (() => {
  for (const l of ['zh_CN', 'zh', 'en']) {
    const p = path.join(EXT_DIR, '_locales', l, 'messages.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return {};
})();
const LOCAL_PROXY_PORT = parseInt(process.env.FCYM_PORT || '8931', 10);
const HOME = process.env.FCYM_HOME || __dirname;   // 数据目录（state.json / captured.pac），App 模式指向 Application Support
const STATE_FILE = path.join(HOME, 'state.json');

function log(...a) { console.log(new Date().toLocaleString('zh-CN', { hour12: false }), '[harness]', ...a); }

// ---------------- 状态 ----------------
let currentPAC = null;
let pacFn = null;
let cleared = true;
const pacHostCache = new Map();
let routeSample = null;
let authCreds = null;       // 407 时通过扩展的 onAuthRequired 逻辑取凭据
let authProbed = false;     // 是否已主动探测过凭据
let upstreamInfo = 'unknown';
const proxyStats = { start: Date.now(), conns: 0, tunneled: 0, direct: 0, errors: 0 };

// ---------------- localStorage / sessionStorage shim ----------------
function makeStorage(persistFile, seed) {
  let data = {};
  if (persistFile && fs.existsSync(persistFile)) {
    data = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
  } else if (seed) {
    data = { ...seed };
    try { if (persistFile) fs.writeFileSync(persistFile, JSON.stringify(data)); } catch {}
  }
  let timer = null;
  const flush = () => { timer = null; try { fs.writeFileSync(persistFile, JSON.stringify(data)); } catch (e) { console.error('[state] 保存失败', e.message); } };
  const qs = () => { if (persistFile && !timer) timer = setTimeout(flush, 1500); };
  return {
    _data: data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); qs(); },
    removeItem: (k) => { delete data[k]; qs(); },
    clear: () => { data = {}; qs(); },
    key: (i) => Object.keys(data)[i] ?? null,
    get length() { return Object.keys(data).length; },
  };
}
if (!fs.existsSync(STATE_FILE)) {
  console.error('[harness] 缺少 state.json，请先运行: node extract.mjs');
  process.exit(1);
}
const localStorage = makeStorage(STATE_FILE);
const sessionStorage = makeStorage(null);

// ---------------- webRequest 监听器捕获（认证凭据 / UA 过滤） ----------------
const wrListeners = { onAuthRequired: [], onBeforeSendHeaders: [] };
async function getAuthCredentials() {
  for (const fn of wrListeners.onAuthRequired) {
    try {
      const res = await new Promise((resolve) => {
        let settled = false;
        const done = (x) => { if (!settled) { settled = true; resolve(x || {}); } };
        const r = fn({ isProxy: true }, done);
        if (r && r.authCredentials) done(r);
      });
      if (res && res.authCredentials) {
        const u = String(res.authCredentials.username || '');
        log(`获取到代理认证凭据（usr=${u.slice(0, 3)}***，来自扩展 onAuthRequired）`);
        return res.authCredentials;
      }
    } catch {}
  }
  return null;
}
function filterRequestHeaders(url, headers) {
  for (const fn of wrListeners.onBeforeSendHeaders) {
    try {
      const r = fn({ url, requestHeaders: headers.map(([n, v]) => ({ name: n, value: v })) });
      if (r && Array.isArray(r.requestHeaders)) return r.requestHeaders;
    } catch {}
  }
  return null;
}

// ---------------- XMLHttpRequest shim（axios 用） ----------------
class XMLHttpRequestShim {
  constructor() {
    this.readyState = 0; this.status = 0; this.statusText = '';
    this.responseText = ''; this.response = ''; this.responseType = '';
    this.responseURL = ''; this.timeout = 0; this.withCredentials = false;
    this.upload = { addEventListener() {} };
    this._headers = {}; this._respHeaders = []; this._ctrl = null;
    this.onreadystatechange = null; this.onerror = null; this.ontimeout = null; this.onabort = null; this.onload = null;
  }
  open(method, url) { this._method = method; this._url = url; this.readyState = 1; }
  setRequestHeader(k, v) { this._headers[k] = v; }
  getAllResponseHeaders() { return this._respHeaders.map(([k, v]) => `${k}: ${v}`).join('\r\n'); }
  getResponseHeader(k) { const h = this._respHeaders.find(([n]) => n.toLowerCase() === k.toLowerCase()); return h ? h[1] : null; }
  addEventListener(ev, fn) { const p = 'on' + ev; if (this[p] == null) this[p] = fn; }
  _setReady(s) { this.readyState = s; if (typeof this.onreadystatechange === 'function') this.onreadystatechange(); }
  abort() { if (this._ctrl) { this._ctrl.abort('manual'); } this.onabort && this.onabort(); }
  send(body) {
    const headers = {};
    const mod = filterRequestHeaders(this._url, Object.entries(this._headers));
    if (mod) for (const { name, value } of mod) headers[name] = value;
    else Object.assign(headers, this._headers);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent'))
      headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
    // 非 latin1 字符会导致 fetch Headers 抛错（扩展的 UA 过滤器会注入 U+2002 等），做浏览器兼容清洗
    for (const k of Object.keys(headers)) {
      let v = String(headers[k]);
      if (/[^\x00-\xFF]/.test(v)) v = v.replace(/[^\x00-\xFF]/g, '');
      try { new Headers({ [k]: v }); } catch { delete headers[k]; continue; }
      headers[k] = v;
    }
    const ctrl = this._ctrl = new AbortController();
    const timer = this.timeout > 0 ? setTimeout(() => ctrl.abort('timeout'), this.timeout) : null;
    fetch(this._url, { method: this._method, headers, body: body || undefined, redirect: 'follow', signal: ctrl.signal })
      .then(async (res) => {
        if (process.env.FCYM_DEBUG) console.log('[xhr]', this._method, this._url, '->', res.status);
        const text = await res.text();
        this.status = res.status; this.statusText = res.statusText; this.responseURL = res.url;
        this._respHeaders = [...res.headers.entries()];
        this.responseText = text;
        this.response = (!this.responseType || this.responseType === 'text') ? text
          : (this.responseType === 'json' ? (() => { try { return JSON.parse(text); } catch { return text; } })() : text);
        if (timer) clearTimeout(timer);
        this._setReady(4);
      })
      .catch((err) => {
        if (process.env.FCYM_DEBUG) console.log('[xhr]', this._method, this._url, 'ERR', err?.message || err);
        if (timer) clearTimeout(timer);
        if (ctrl.signal.aborted && ctrl.signal.reason === 'timeout') this.ontimeout && this.ontimeout();
        else if (ctrl.signal.aborted) this.onabort && this.onabort();
        else this.onerror && this.onerror(err);
      });
  }
}

// ---------------- FileReader shim ----------------
class FileReaderShim {
  constructor() { this.result = null; this.onload = null; this.DONE = 2; }
  readAsDataURL(blob) { blob.arrayBuffer?.().then((ab) => {
    this.result = 'data:application/octet-stream;base64,' + Buffer.from(ab).toString('base64');
    this.onload && this.onload({ target: { readyState: this.DONE, result: this.result } });
  }).catch(() => {}); }
  readAsText(blob) { blob.text?.().then((t) => {
    this.result = t;
    this.onload && this.onload({ target: { readyState: this.DONE, result: t } });
  }).catch(() => {}); }
}

// ---------------- chrome.* shim ----------------
const noopListener = { addListener() {}, removeListener() {}, hasListener() { return false; } };
const mkWR = (name) => ({ addListener: (fn) => wrListeners[name].push(fn), removeListener() {}, hasListener() { return false; } });
const chrome = {
  runtime: {
    id: EXT_ID,
    getManifest: () => MANIFEST,
    getURL: (p) => `chrome-extension://${EXT_ID}/${String(p).replace(/^\//, '')}`,
    sendMessage: (msg, cb) => { if (typeof cb === 'function') cb(); },
    onMessage: noopListener, onInstalled: noopListener, onStartup: noopListener,
  },
  i18n: {
    getMessage: (key, subs) => {
      const m = LOCALE[key]; if (!m) return '';
      let s = m.message || '';
      if (subs) (Array.isArray(subs) ? subs : [subs]).forEach((v, i) => { s = s.replaceAll(`$${i + 1}$`, String(v)); });
      return s;
    },
    getUILanguage: () => 'zh-CN',
  },
  proxy: {
    settings: {
      set({ value }, cb) {
        const pac = value && value.pacScript && value.pacScript.data;
        if (pac) onPacCaptured(pac); else { cleared = true; log('扩展清空了代理（未登录/已停用）'); }
        cb && cb();
        setTimeout(() => { syncSystemProxy().catch(() => {}); }, 300);
      },
      clear(_s, cb) {
        cleared = true;
        setTimeout(() => { syncSystemProxy().catch(() => {}); }, 300);
        cb && cb();
      },
      get(_s, cb) { cb && cb({ value: {}, levelOfControl: 'controlled_by_this_extension' }); },
    },
    onProxyError: noopListener,
  },
  tabs: {
    create(o) { log('tabs.create（忽略）', o && o.url); },
    reload() {}, query(_q, cb) { cb && cb([]); },
    get(_id, cb) { cb && cb(null); },
    onRemoved: noopListener, onActivated: noopListener, onMessage: noopListener,
  },
  browserAction: { setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {}, onClicked: noopListener },
  notifications: { create(_id, _o, cb) { cb && cb(); } },
  management: { getAll(cb) { cb && cb([]); }, onEnabled: noopListener, onDisabled: noopListener },
  privacy: {
    network: {
      webRTCMultipleRoutesEnabled: { set(_v, cb) { cb && cb(); } },
      webRTCNonProxiedUdpEnabled: { set(_v, cb) { cb && cb(); } },
      webRTCIPHandlingPolicy: { set(_v, cb) { cb && cb(); } },
    },
  },
  webRequest: {
    onBeforeRequest: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    onErrorOccurred: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    onCompleted: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    onAuthRequired: mkWR('onAuthRequired'),
    onBeforeSendHeaders: mkWR('onBeforeSendHeaders'),
  },
};

// ---------------- window / document / navigator / location ----------------
function makeAnchor() {
  const el = {
    tagName: 'A', style: {}, children: [],
    setAttribute(k, v) { if (k === 'href') { try { this._u = new URL(v, 'http://localhost/'); } catch {} } },
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    get href() { return this._u ? this._u.href : ''; },
    get protocol() { return this._u ? this._u.protocol.replace(/:$/, '') : ''; },
    get host() { return this._u ? this._u.host : ''; },
    get hostname() { return this._u ? this._u.hostname : ''; },
    get search() { return this._u ? this._u.search.replace(/^\?/, '') : ''; },
    get hash() { return this._u ? this._u.hash.replace(/^#/, '') : ''; },
    get port() { return this._u ? this._u.port : ''; },
    get pathname() { return this._u ? this._u.pathname : ''; },
  };
  return el;
}
function makeElement(tag) {
  if (String(tag).toLowerCase() === 'a') return makeAnchor();
  return { tagName: String(tag).toUpperCase(), style: {}, children: [], setAttribute() {}, getAttribute() { return null; }, appendChild() {}, addEventListener() {}, removeAttribute() {}, click() {} };
}
const document = {
  cookie: '', domain: 'localhost', referrer: '', body: makeElement('body'), head: makeElement('head'),
  createElement: makeElement, createTextNode: (t) => ({ textContent: t }),
  addEventListener() {}, removeEventListener() {},
};
const navigatorShim = {
  product: 'Gecko', platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN', 'zh'],
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
};
const location = { href: `chrome-extension://${EXT_ID}/_generated_background_page.html`, protocol: 'chrome-extension:', host: EXT_ID, hostname: EXT_ID, port: '' };

// ---------------- PAC 捕获 ----------------
function onPacCaptured(pac) {
  cleared = false;
  currentPAC = pac;
  pacHostCache.clear();
  if (!authProbed) {
    authProbed = true;
    getAuthCredentials().then((c) => { if (c) { authCreds = authCreds || c; log('主动探测：代理认证凭据可用'); } else { log('主动探测：无代理认证凭据（extConfig.usr/pd 未下发）'); } }).catch(() => {});
  }
  try {
    pacFn = vm.runInNewContext(`${pac}\n;FindProxyForURL`, vm.createContext({}), { timeout: 5000 });
    try { routeSample = pacFn('https://www.google.com/', 'www.google.com'); } catch {}
    log(`已捕获 PAC（${pac?.length ?? ''} 字节），示例路由: ${routeSample}`);
    fs.writeFileSync(path.join(HOME, 'captured.pac'), pac);
  } catch (e) {
    console.error('[harness] PAC 编译失败', e.message);
  }
}

// ---------------- 全局 shim 安装 ----------------
const globalShims = {
  window: globalThis, document, location: { ...location },
  XMLHttpRequest: XMLHttpRequestShim, FileReader: FileReaderShim,
  alert: (m) => console.log('[alert]', m),
  chrome, localStorage, sessionStorage,
};
for (const [k, v] of Object.entries(globalShims)) {
  try { Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true }); }
  catch { try { globalThis[k] = v; } catch {} }
}
try { Object.defineProperty(globalThis, 'navigator', { value: navigatorShim, configurable: true }); }
catch { /* Node 自带 navigator getter，尽量覆盖失败则保留 */ }

// ---------------- XXTEA（与扩展一致，用于刷新端点配置） ----------------
const XXTEA_DELTA = 2654435769;
function xxToU32(bytes, includeLength) {
  let n = bytes.length >> 2;
  if (bytes.length & 3) n++;
  const v = includeLength ? new Uint32Array(n + 1) : new Uint32Array(n);
  if (includeLength) v[n] = bytes.length;
  for (let i = 0; i < bytes.length; i++) v[i >> 2] |= bytes[i] << ((i & 3) << 3);
  return v;
}
function xxToU8(v, includeLength) {
  let n = v.length << 2;
  if (includeLength) { const m = v[v.length - 1]; n -= 4; if (m < n - 3 || m > n) return null; n = m; }
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = v[i >> 2] >> ((i & 3) << 3);
  return b;
}
function xxFix(k) { if (k.length < 16) { const nk = new Uint8Array(16); nk.set(k); k = nk; } return k; }
function xxDecrypt(b64, keyStr) {
  const buf = Buffer.from(b64, 'base64');
  const v = new Uint32Array(buf.length >> 2);
  for (let i = 0; i < buf.length; i++) v[i >> 2] |= buf[i] << ((i & 3) << 3);
  const kb = xxFix(new TextEncoder().encode(keyStr));
  const k = new Uint32Array(4);
  for (let i = 0; i < 16; i++) k[i >> 2] |= kb[i] << ((i & 3) << 3);
  const n = v.length - 1;
  const rounds = Math.floor(6 + 52 / v.length);
  let sum = (rounds * XXTEA_DELTA) >>> 0, y, z = v[n], p, e;
  const mx = (s) => ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((s ^ y) + (k[(p & 3) ^ e] ^ z))) >>> 0;
  y = v[0];
  while (sum !== 0) {
    e = sum >>> 2 & 3;
    for (p = n; p > 0; p--) { z = v[p - 1]; y = v[p] = v[p] - mx(sum) >>> 0; }
    z = v[n]; y = v[0] = v[0] - mx(sum) >>> 0;
    sum = sum - XXTEA_DELTA >>> 0;
  }
  return Buffer.from(xxToU8(v, true)).toString('utf8');
}
function xxEncrypt(str, keyStr) {
  const enc = new TextEncoder().encode(str);
  const kb = xxFix(new TextEncoder().encode(keyStr));
  const k = new Uint32Array(4);
  for (let i = 0; i < 16; i++) k[i >> 2] |= kb[i] << ((i & 3) << 3);
  let v = xxToU32(enc, true);
  const n = v.length - 1;
  const rounds = Math.floor(6 + 52 / v.length);
  let sum = 0, y, z = v[n], p, e;
  const mx = (s) => ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((s ^ y) + (k[(p & 3) ^ e] ^ z))) >>> 0;
  for (let r = 0; r < rounds; r++) {
    sum = sum + XXTEA_DELTA >>> 0;
    e = sum >>> 2 & 3;
    for (p = 0; p < n; p++) { y = v[p + 1]; z = v[p] = v[p] + mx(sum) >>> 0; }
    y = v[0]; z = v[n] = v[n] + mx(sum) >>> 0;
  }
  return Buffer.from(xxToU8(v, false)).toString('base64');
}

// ---------------- 端点配置自动刷新（服务端会轮换 WS 端点，缓存过期会 NPE/挂起） ----------------
const CFG_SEP = 'E2DoIU#R';               // 扩展 N() 的配置分隔符（O(2)）
const CFG_KEY = 'Em2EDooaI$U1#NR0';       // 配置第二段 XXTEA 密钥（O(0)）
const CFG_FALLBACKS = [                   // 扩展内置兜底配置端点（C.c）
  'http://axwxu7j.globalnetwork.bond/ping2',
  'https://robensales.pages.dev/ping2',
  'https://thriving-naiad-ef49c7.netlify.app/ping2',
];
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  s = s.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of s) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
// z 函数源码（扩展用它作为配置 key 的 XXTEA 密钥——混淆手段）——从 background.js 动态提取
const Z_SOURCE = (() => {
  const m = BG.match(/function z\(\)\{var t=\{BTWJf:[\s\S]{0,200}?dsb[^)]*?\)\}/);
  if (!m) throw new Error('无法从 background.js 提取 z 函数源码（密钥）');
  return m[0];
})();
function lsMap() {
  const itKey = xxEncrypt('Windmill', '');
  const raw = localStorage.getItem(itKey);
  if (!raw) return null;
  return JSON.parse(xxDecrypt(raw, 'Windmill'));
}
function readIdx9ExtApi() {
  try {
    const map = lsMap();
    if (!map || !map.J) return null;
    const cfg = JSON.parse(xxDecrypt(localStorage.getItem(map.J), 'J'));
    if (!cfg || !cfg.key) return null;
    return JSON.parse(xxDecrypt(cfg.key, Z_SOURCE));
  } catch { return null; }
}
function writeIdx9ExtApi(cfgObj) {
  const map = lsMap();
  if (!map || !map.J) return false;
  const inner = xxEncrypt(JSON.stringify(cfgObj), Z_SOURCE);
  const cfg = { ios_min_ver: 1, win_min_ver: 1, ext_min_ver: 1, and_min_ver: 1, key: inner };
  localStorage.setItem(map.J, xxEncrypt(JSON.stringify(cfg), 'J'));
  return true;
}
async function fetchFreshExtApiConfig() {
  // 配置端点链：state 缓存(idx21) + 内置兜底
  const urls = [];
  let nextUrlList = null;   // part1 解出的下一轮配置服务器列表（顺便刷新 idx21）
  try {
    const map = lsMap();
    if (map && map.V) {
      const arr = JSON.parse(xxDecrypt(localStorage.getItem(map.V), 'V'));
      if (Array.isArray(arr)) urls.push(...arr);
    }
  } catch {}
  urls.push(...CFG_FALLBACKS);
  for (const u of urls) {
    try {
      const res = await fetch(u + '?' + Date.now(), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      const parts = text.split(CFG_SEP);
      if (parts.length < 2 || !parts[0].trim()) continue;
      // part0: base64 → {ios_min_ver..., key} —— key 用 z 函数源码做 XXTEA 密钥 → {web_site, ext_api, ...}
      const cfg9 = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
      if (!cfg9 || !cfg9.key) continue;
      const full = JSON.parse(xxDecrypt(cfg9.key, Z_SOURCE));
      if (!full || !Array.isArray(full.ext_api) || !full.ext_api.length) continue;
      // part1: base32 → XXTEA(CFG_KEY) → 下一轮配置服务器 URL 列表 → 刷新 idx21
      try {
        nextUrlList = JSON.parse(xxDecrypt(base32Decode(parts[1].trim()).toString('base64'), CFG_KEY));
      } catch {}
      full._nextUrlList = nextUrlList;
      return full;
    } catch {}
  }
  return null;
}
async function refreshEndpointsIfNeeded() {
  const fresh = await fetchFreshExtApiConfig();
  if (!fresh) { log('配置服务器不可达，沿用缓存端点'); return false; }
  // 顺带更新配置服务器轮换链（idx21）
  if (Array.isArray(fresh._nextUrlList) && fresh._nextUrlList.length) {
    try {
      const map = lsMap();
      if (map && map.V) localStorage.setItem(map.V, xxEncrypt(JSON.stringify(fresh._nextUrlList), 'V'));
    } catch {}
  }
  const cur = readIdx9ExtApi();
  const curList = (cur && cur.ext_api || []).join(',');
  const freshList = fresh.ext_api.join(',');
  if (curList === freshList) { log(`端点配置已最新（${freshList}）`); return false; }
  log(`检测到服务端轮换了 WS 端点：\n  旧: ${curList || '(空)'}\n  新: ${freshList}\n  已写入 state.json`);
  writeIdx9ExtApi(fresh);
  return true; // 调用方需重启 background.js 才能生效
}
// WebSocket 替换：ws 包 + 浏览器同款 Origin/UA 头（服务器校验 Origin）
import WS from 'ws';
const EDGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
class BrowserWS extends WS {
  constructor(url, protocols, options = {}) {
    super(url, protocols, {
      ...options,
      handshakeTimeout: 10000,   // 服务端轮换/退役端点时会挂起握手，必须超时让扩展重连逻辑继续
      headers: {
        Origin: `chrome-extension://${EXT_ID}`,
        'User-Agent': EDGE_UA,
        ...(options.headers || {}),
      },
    });
    if (process.env.FCYM_DEBUG) console.log('[ws] 连接', String(url).slice(0, 200));
    this.addEventListener('open', () => console.log('[ws] 已打开'));
    this.addEventListener('close', (e) => console.log('[ws] 已关闭 code=', e.code));
    this.addEventListener('error', (e) => console.log('[ws] 错误', e?.message || e?.error?.message || ''));
    this.addEventListener('message', (e) => {
      if (typeof e.data === 'string' && process.env.FCYM_DEBUG) {
        const sl = (e.data.includes('"initEXT"') || e.data.includes('"showNodes"')) ? 3500 : 300;
        console.log('[ws] <-', e.data.slice(0, sl));
      }
    });
    const origSend = this.send.bind(this);
    this.send = (d) => {
      if (process.env.FCYM_DEBUG && typeof d === 'string') console.log('[ws] ->', d.slice(0, 300));
      return origSend(d);
    };
  }
}
Object.defineProperty(globalThis, 'WebSocket', { value: BrowserWS, configurable: true, writable: true });

// 状态轮询（诊断扩展内部 PAC_Setting / 登录态）
setInterval(() => {
  if (!process.env.FCYM_DEBUG) return;
  try {
    const ps = globalThis.PAC_Setting;
    const ls = globalThis.loginStatus;
    const usr = globalThis.usr;
    console.log('[diag]', JSON.stringify({
      pac: ps ? (ps.pac ? `(${ps.pac.length}b)` : 'null') : '?',
      nodes: ps && ps._ns ? ps._ns.length : null,
      node: ps && ps.currentNode ? { id: ps.currentNode.id, ipInfo: ps.currentNode.ipInfo, infoLen: (ps.currentNode.info || '').length, enabled: ps.currentNode.enabled } : null,
      login: ls ? ls.status : null,
      email: usr ? usr.userEmail : null,
      expire: usr ? usr.expireTime : null,
    }));
  } catch (e) { console.log('[diag] err', e.message); }
}, 5000).unref?.();

console.clear = () => {};
console.info = () => {};
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack || e));

// --dry-proxy 自检：打印各平台将执行的系统代理命令，便于在目标机器上人工验证（不启动服务）
if (process.argv.includes('--dry-proxy')) {
  const PAC = `http://127.0.0.1:${LOCAL_PROXY_PORT}/proxy.pac`;
  const WIN = process.platform === 'win32';
  const REGBASE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  console.log(`platform=${process.platform} PAC=${PAC}`);
  console.log('apply(on):', WIN ? `reg.exe add ${REGBASE} /v AutoConfigURL /t REG_SZ /d ${PAC} /f` : `networksetup -setautoproxyurl <service> ${PAC}`);
  console.log('apply(off):', WIN ? `reg.exe delete ${REGBASE} /v AutoConfigURL /f` : 'networksetup -setautoproxystate <service> off');
  console.log('check:', WIN ? `reg.exe query ${REGBASE} /v AutoConfigURL` : 'networksetup -getautoproxyurl Wi-Fi');
  console.log('wininet refresh: powershell Add-Type + InternetSetOption(39/37)');
  process.exit(0);
}

// ---------------- 运行扩展 background.js ----------------
// 启动前刷新端点配置（服务端会轮换 WS 端点；旧端点会 NPE 500 或挂起握手）
const boot = async () => {
  try {
    await refreshEndpointsIfNeeded();   // 若端点变化已写入 state.json，本次启动即用新端点
  } catch (e) { console.error('[harness] 端点刷新失败（不阻塞启动）:', e.message); }

  log(`启动扩展 background.js (v${MANIFEST.version}) ...`);
  try {
    vm.runInThisContext(BG, { filename: 'background.js' });
  } catch (e) {
    console.error('background.js 运行失败:', e.stack);
    process.exit(1);
  }

  // 登录看护：90 秒内未完成登录（PAC 未就绪）→ 刷新端点；若变化则退出（由 App/CLI 守护重启后生效）
  setTimeout(async () => {
    if (currentPAC && !cleared) return;
    try {
      log('登录迟迟未就绪，尝试刷新端点配置 ...');
      if (await refreshEndpointsIfNeeded()) {
        log('端点已更新，退出以应用新配置（守护进程会自动重启）');
        revertSystemProxySync();
        process.exit(1);
      }
    } catch {}
  }, 90000);
};
boot();

// ---------------- PAC 路由 ----------------
function routeViaPac(host, url) {
  if (!pacFn) return 'DIRECT';
  if (pacHostCache.has(host)) return pacHostCache.get(host);
  let r = 'DIRECT';
  try { r = pacFn(url || `https://${host}/`, host) || 'DIRECT'; } catch { r = 'DIRECT'; }
  pacHostCache.set(host, r);
  return r;
}
function parseUpstreams(s) { return String(s || '').split(';').map((x) => x.trim()).filter(Boolean); }

// 读取一行 HTTP 响应头（到 \r\n\r\n）
function readHead(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx >= 0) { cleanup(); resolve({ head: buf.slice(0, idx).toString('latin1'), rest: buf.slice(idx + 4) }); }
      else if (buf.length > 65536) { cleanup(); reject(new Error('head too large')); }
    };
    const cleanup = () => { sock.removeListener('data', onData); sock.removeListener('error', onErr); };
    const onErr = (e) => { cleanup(); reject(e); };
    sock.on('data', onData); sock.on('error', onErr);
  });
}
function connectUpstreamEntry(entry) {
  const [scheme, hp] = entry.split(' ');
  const m = hp.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  const h = m[1], p = parseInt(m[2] || (scheme === 'HTTPS' ? '443' : '8080'), 10);
  return new Promise((res, rej) => {
    const s = (scheme === 'HTTPS')
      ? tls.connect({ host: h, port: p, servername: h, rejectUnauthorized: false }, () => res(s))
      : net.connect({ host: h, port: p }, () => res(s));
    s.once('error', rej);
    setTimeout(() => rej(new Error('timeout ' + entry)), 15000);
  });
}
async function connectUpstream(routeList, destHost, destPort, earlyData, triedWithAuth) {
  const authHeader = () => {
    if (!authCreds) return null;
    return 'Proxy-Authorization: Basic ' + Buffer.from(authCreds.username + ':' + (authCreds.password || '')).toString('base64');
  };
  for (const entry of routeList) {
    if (entry === 'DIRECT') continue;
    if (!/^(PROXY|HTTPS|HTTP|SOCKS|SOCKS5)\s/i.test(entry)) continue;
    if (/^SOCKS/i.test(entry)) { log(`暂不支持 SOCKS 上游: ${entry}`); continue; }
    try {
      const sock = await connectUpstreamEntry(entry);
      const extra = [];
      const ah = authHeader();
      if (ah) extra.push(ah);
      sock.write(`CONNECT ${destHost}:${destPort} HTTP/1.1\r\nHost: ${destHost}:${destPort}\r\n${extra.join('\r\n')}${extra.length ? '\r\n' : ''}\r\n`);
      if (earlyData && earlyData.length) sock.write(earlyData);
      let hp;
      try { hp = await readHead(sock); } catch (e) { sock.destroy(); throw e; }
      const code = parseInt((hp.head.match(/^HTTP\/[\d.]+\s+(\d+)/) || [])[1] || '0', 10);
      if (code === 200) {
        if (hp.rest.length) sock.unshift(hp.rest);
        return sock;
      }
      if ((code === 407 || code === 404) && !authCreds) {
        // 407=标准代理认证；404=caddy-forwardproxy probe_resistance 伪装（未认证 CONNECT）
        // 向扩展注册的 onAuthRequired 处理器索要代理凭据（extConfig.usr/pd）后重试
        authCreds = await getAuthCredentials();
        if (authCreds) {
          sock.destroy();
          return await connectUpstream(routeList, destHost, destPort, earlyData);
        }
      }
      if (code === 404 && authCreds && !triedWithAuth) {
        // 已带凭据仍 404：凭据可能已轮换，作废重取一次
        sock.destroy();
        authCreds = null;
        authCreds = await getAuthCredentials();
        if (authCreds) return await connectUpstream(routeList, destHost, destPort, earlyData, true);
      }
      sock.destroy();
      log(`上游 ${entry} 拒绝 CONNECT: ${hp.head.split('\r\n')[0]}`);
    } catch (e) { log(`上游 ${entry} 连接失败: ${e.message}`); }
  }
  return null;
}

// ---------------- 本地代理 ----------------
function isLoopback(h) { return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'; }

// 安全写回：客户端 socket 可能已断开（用户关页面/请求取消），任何写失败都不能抛 EPIPE 崩进程
function safeEnd(sock, data) {
  if (!sock || sock.destroyed) return;
  sock.on('error', () => {});
  try { sock.end(data); } catch {}
}
function safeWrite(sock, data) {
  if (!sock || sock.destroyed) return;
  sock.on('error', () => {});
  try { sock.write(data); } catch {}
}

async function handleConnect(client, host, port, early) {
  proxyStats.conns++;
  client.on('error', () => {});   // 兜底：客户端先断开是常态，吞掉所有客户端侧错误
  const route = isLoopback(host) ? 'DIRECT' : routeViaPac(host, `https://${host}/`);
  const list = parseUpstreams(route);
  if (list[0] === 'DIRECT') {
    proxyStats.direct++;
    const server = net.connect({ host, port }, () => {
      safeWrite(client, 'HTTP/1.1 200 Connection Established\r\n\r\n');
      if (early && early.length) safeWrite(server, early);
      server.pipe(client); client.pipe(server);
    });
    server.on('error', () => { safeEnd(client, 'HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    client.on('close', () => server.destroy());
    return;
  }
  const upstream = await connectUpstream(list, host, port, early);
  if (!upstream) { proxyStats.errors++; safeEnd(client, 'HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  proxyStats.tunneled++;
  safeWrite(client, 'HTTP/1.1 200 Connection Established\r\n\r\n');
  upstream.pipe(client); client.pipe(upstream);
  client.on('close', () => upstream.destroy());
  upstream.on('error', () => { try { client.destroy(); } catch {} });
}

const proxyServer = http.createServer((req, res) => {
  if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
    const u = new URL(req.url);
    proxyStats.conns++;
    const route = isLoopback(u.hostname) ? 'DIRECT' : routeViaPac(u.hostname, req.url);
    const list = parseUpstreams(route);
    if (list[0] === 'DIRECT') {
      proxyStats.direct++;
      const preq = http.request({ host: u.hostname, port: parseInt(u.port || '80', 10), method: req.method, path: u.pathname + u.search, headers: { ...req.headers, host: u.host } }, (pres) => {
        res.writeHead(pres.statusCode, pres.headers); pres.pipe(res);
      });
      preq.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
      req.pipe(preq);
      return;
    }
    (async () => {
      try {
        const sock = await connectUpstream(list, u.hostname, parseInt(u.port || '80', 10), null);
        if (!sock) throw new Error('no upstream');
        let head = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(req.headers)) head += `${k}: ${v}\r\n`;
        head += '\r\n';
        sock.write(head);
        req.pipe(sock);
        sock.pipe(res.socket);
        req.socket.on('error', () => {});
        sock.on('error', () => { try { res.socket && res.socket.destroy(); } catch {} });
      } catch { try { res.writeHead(502); res.end('upstream error'); } catch {} }
    })();
    return;
  }
  if (req.url === '/proxy.pac' || req.url === '/pac' || req.url === '/proxy.pac?') {
    const pac = `function FindProxyForURL(url, host) { if (isPlainHostName(host) || host === "127.0.0.1" || host === "localhost" || host === "::1" || shExpMatch(host, "127.*") || shExpMatch(host, "*.local")) return "DIRECT"; return "PROXY 127.0.0.1:${LOCAL_PROXY_PORT}"; }`;
    res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
    res.end(pac); return;
  }
  // 优雅停止（Windows 下无 SIGTERM，stop 脚本/托盘用 HTTP 触发）
  if (req.url === '/stop' || req.url === '/stop?') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stopping: true }));
    setTimeout(() => { shutdown('HTTP /stop'); }, 100);
    return;
  }
  // 签到（会员到期后服务端停发节点凭据，签到领免费时长恢复）
  if (req.url === '/checkin' || req.url === '/checkin?') {
    if (typeof globalThis.checkin === 'function') {
      globalThis.checkin();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent: true }));
    } else {
      res.writeHead(503); res.end(JSON.stringify({ ok: false, error: '尚未登录（checkin 不可用）' }));
    }
    return;
  }
  const ex = req.url.match(/^\/exchange\?code=([^&]+)/);
  if (ex) {
    if (typeof globalThis.exchange === 'function') {
      globalThis.exchange(decodeURIComponent(ex[1]));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent: true }));
    } else {
      res.writeHead(503); res.end(JSON.stringify({ ok: false, error: '尚未登录（exchange 不可用）' }));
    }
    return;
  }
  if (req.url === '/status' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: !!currentPAC && !cleared, pacReady: !!pacFn, cleared, routeSample,
      pacSize: currentPAC ? currentPAC.length : 0,
      model: (globalThis.PAC_Setting && globalThis.PAC_Setting.getModel) ? globalThis.PAC_Setting.getModel() : null,
      hasAuthCreds: !!authCreds || authProbed,
      user: (() => { const u = globalThis.usr; return u ? { email: u.userEmail, expireTime: u.expireTime, freeMins: u.freeMins } : null; })(),
      stats: proxyStats, time: new Date().toISOString(),
    }, null, 2));
    return;
  }
  // 运行模式：NModel=科学(白名单分流) AModel=全局(全流量走节点) CModel=关闭
  const modeSet = req.url.match(/^\/mode\?set=(NModel|AModel|CModel|RModel)/);
  if (modeSet) {
    const ps = globalThis.PAC_Setting;
    if (ps && ps.changeModel) {
      ps.changeModel(modeSet[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: ps.getModel() }));
      // 模式切换立即同步系统代理（不等 30s 自愈周期）
      setTimeout(() => { syncSystemProxy().catch(() => {}); }, 500);
    } else {
      res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'PAC_Setting not ready' }));
    }
    return;
  }
  if (req.url === '/mode' || req.url === '/mode?') {
    const ps = globalThis.PAC_Setting;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: ps && ps.getModel ? ps.getModel() : null }));
    return;
  }
  if (req.url === '/nodes') {
    const ps = globalThis.PAC_Setting;
    const nodes = (ps && ps._ns) ? ps._ns.map((n) => ({
      id: n.id,
      name: n.name || n.shortName || '',
      shortName: n.shortName || '',
      flag: n.flag || '',
      vip: !!n.type,
      enabled: !!n.enabled, hasInfo: !!(n.info && n.info.length),
      ping: typeof n.ping === 'number' ? n.ping : null,
      selected: !!(ps.currentNode && ps.currentNode.id === n.id),
    })) : [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ nodes, current: ps && ps.currentNode ? { id: ps.currentNode.id, name: ps.currentNode.name } : null }, null, 2));
    return;
  }
  const sel = req.url.match(/^\/select\?id=(\d+)/);
  if (sel) {
    const ps = globalThis.PAC_Setting;
    const node = ps && ps._ns ? ps._ns.find((n) => n && String(n.id) === sel[1] && n.info && n.enabled) : null;
    if (node) {
      try { ps.changeNode(node); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, switching: node.id })); return; } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); return;
      }
    }
    res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'node not found' })); return;
  }
  res.writeHead(404); res.end('not found');
});
proxyServer.on('connect', (req, client, head) => {
  const m = req.url.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  handleConnect(client, m[1], parseInt(m[2] || '443', 10), head);
});
proxyServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[proxy] 端口 ${LOCAL_PROXY_PORT} 已被占用（可能已有一个实例在运行），退出`);
    process.exit(1);
  }
  console.error('[proxy]', e.message);
});

// ---------------- 系统代理设置（跨平台：macOS networksetup / Windows 注册表+WinINET 刷新） ----------------
const IS_WIN = process.platform === 'win32';
const PAC_URL = () => `http://127.0.0.1:${LOCAL_PROXY_PORT}/proxy.pac`;
const WIN_REG = ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '/v', 'AutoConfigURL', '/t', 'REG_SZ', '/d', PAC_URL(), '/f'];
const WIN_REG_DEL = ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '/v', 'AutoConfigURL', '/f'];
const WIN_REG_QUERY = ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '/v', 'AutoConfigURL'];
// WinINET 广播：让所有应用立即感知代理设置变化（等价 macOS networksetup 即时生效）
const PS_REFRESH = "Add-Type -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);' -Name W -Namespace P; [P.W]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null; [P.W]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null";

function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() }));
  });
}
async function psRun(cmdStr) {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmdStr]);
}
async function networkServices() {
  const { stdout } = await exec('networksetup', ['-listallnetworkservices']);
  return stdout.split('\n').slice(1).map((s) => s.replace(/^\*/, '').trim())
    .filter((s) => s && !s.includes('(*)') && !s.startsWith('An asterisk'));
}
async function applySystemProxy(on) {
  if (IS_WIN) {
    const rs = [];
    const reg = on
      ? await exec('reg.exe', WIN_REG)
      : await exec('reg.exe', WIN_REG_DEL);
    rs.push({ service: 'WinINET(AutoConfigURL)', ok: !reg.err, msg: reg.stderr || reg.stdout });
    const refresh = await psRun(PS_REFRESH);   // 立即广播生效（不重启应用/浏览器）
    rs.push({ service: 'WinINET(refresh)', ok: !refresh.err, msg: refresh.stderr });
    return rs;
  }
  const svcs = await networkServices();
  const rs = [];
  for (const s of svcs) {
    const r = on
      ? await exec('networksetup', ['-setautoproxyurl', s, PAC_URL()])
      : await exec('networksetup', ['-setautoproxystate', s, 'off']);
    rs.push({ service: s, ok: !r.err, msg: r.stderr || r.stdout });
  }
  return rs;
}
async function systemProxyIsOurs() {
  if (IS_WIN) {
    const cur = await exec('reg.exe', WIN_REG_QUERY);
    return !cur.err && cur.stdout.includes(`127.0.0.1:${LOCAL_PROXY_PORT}`);
  }
  const cur = await exec('networksetup', ['-getautoproxyurl', 'Wi-Fi']);
  return cur.stdout.includes(`127.0.0.1:${LOCAL_PROXY_PORT}`) && /Enabled:\s*Yes/i.test(cur.stdout);
}
function revertSystemProxySync() {
  // 进程崩溃兜底：同步撤销（不做 WinINET 广播，系统读取时自然刷新）
  try {
    if (IS_WIN) {
      try { execFileSync('reg.exe', WIN_REG_DEL, { stdio: 'ignore' }); } catch {}
      try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_REFRESH], { stdio: 'ignore' }); } catch {}
    } else {
      for (const s of ['Wi-Fi', 'Thunderbolt Bridge', 'Ethernet', 'USB 10/100/1000 LAN', 'Bluetooth PAN']) {
        try { execFileSync('networksetup', ['-setautoproxystate', s, 'off'], { stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}
}

// 双向自愈：PAC 恢复时重新应用系统代理；扩展清空代理（关闭模式/登出）时撤销
async function syncSystemProxy() {
  const active = !!(currentPAC && !cleared);
  const ours = await systemProxyIsOurs();
  if (active && !ours) {
    const rs = await applySystemProxy(true);
    log(`检测到系统代理丢失，已重新应用（${rs.filter((r) => r.ok).length}/${rs.length} 项）`);
  } else if (!active && ours) {
    await applySystemProxy(false);
    log('代理已停用（关闭模式或登出），撤销系统代理');
  }
}

// ---------------- 主流程 ----------------
proxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1', () => {
  log(`本地代理已监听 127.0.0.1:${LOCAL_PROXY_PORT}（PAC: http://127.0.0.1:${LOCAL_PROXY_PORT}/proxy.pac）`);
  const waitPac = setInterval(async () => {
    if (currentPAC && !cleared) {
      clearInterval(waitPac);
      log('PAC 就绪，设置系统自动代理 ...');
      const rs = await applySystemProxy(true);
      for (const r of rs) log(`  ${r.service.padEnd(22)} ${r.ok ? 'OK' : 'FAIL ' + r.msg}`);
      log(`完成！系统级代理已生效。状态: http://127.0.0.1:${LOCAL_PROXY_PORT}/status`);
    }
  }, 1000);
  setInterval(() => { syncSystemProxy().catch(() => {}); }, 30000);
});

const shutdown = async (sig) => {
  log(`收到 ${sig}，撤销系统代理并退出 ...`);
  try { await applySystemProxy(false); } catch {}
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// App 模式下看护父进程：宿主 App 退出后自行撤销代理并退出（防止孤儿进程残留）
if (process.env.FCYM_SUPERVISED === '1') {
  setInterval(() => {
    if (process.ppid === 1) {
      console.log('[harness] 宿主 App 已退出，自动清理');
      shutdown('ORPHANED');
    }
  }, 3000).unref?.();
}
// 兜底：未知异常退出时同步撤销系统代理，避免 PAC 指向已死的本地端口
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e?.stack || e);
  revertSystemProxySync();
  process.exit(1);
});
