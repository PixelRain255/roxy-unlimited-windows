// ============================================================
//  mkprofile.mjs  —  RoxyBrowser offline profile generator
//
//  Creates browser-cache/<dirId>/ with a fully valid, encrypted
//  lumi.conf, WITHOUT contacting Roxy's server and WITHOUT touching
//  the account quota (maxWindowCount / useWindowCount).
//
//  Fingerprint fields are randomised into a self-consistent set
//  (UA / userAgentMetadata / navigator / WebGL stay coherent).
//
//  Usage:
//    node mkprofile.mjs --count 3
//    node mkprofile.mjs --name mybot --proxy "socks5://u:p@host:1080"
//    node mkprofile.mjs --from <existingDirId> --count 1   # inherit real fields
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const KEY = Buffer.from('402ead7d23b43b6d1e0528d4f99c59bd', 'utf8');
const IV = Buffer.from('3a105229aa31', 'utf8');
const encLumi = (t) => {
  const c = crypto.createCipheriv('aes-256-gcm', KEY, IV);
  return Buffer.concat([c.update(t, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
};
const decLumi = (b64) => {
  const raw = Buffer.from(b64.trim(), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, IV);
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
};

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : (argv[i + 1] ?? true); };
const COUNT = parseInt(arg('count', '1'), 10);
const NAME = arg('name', null);
const PROXY = arg('proxy', null);
const FROM = arg('from', null);

const APPDATA = process.env.APPDATA;
const ROOT = path.join(APPDATA, 'RoxyBrowser');
const CACHE = path.join(ROOT, 'browser-cache');
const INSTALL = path.join(process.env.LOCALAPPDATA, 'Programs', 'RoxyBrowser');

// ---------- random helpers ----------
const rnd = (n) => crypto.randomBytes(n);
const hex = (n) => rnd(n).toString('hex');
const pick = (a) => a[crypto.randomInt(a.length)];
const rint = (a, b) => crypto.randomInt(a, b + 1);
const rfloat = (a, b, p = 6) => +(a + Math.random() * (b - a)).toFixed(p);
const WIN_RES = [[1280,720],[1366,768],[1440,900],[1536,864],[1600,900],[1920,1080],[2048,1152],[2560,1440]];

// ---------- detect installed core version ----------
function detectCoreVersion() {
  const bin = path.join(ROOT, 'chrome-bin');
  try {
    for (const d of fs.readdirSync(bin, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const full = path.join(bin, d.name);
      const sub = fs.readdirSync(full, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(e.name))
        .map((e) => e.name);
      if (sub.length) return sub.sort().at(-1);
    }
  } catch {}
  return '152.0.7977.65';
}

// ---------- GPU pool (all plausible on Windows; index 0 = this machine) ----------
const GPU_POOL = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.1720)', webgpu: 'NVIDIA' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3699)', webgpu: 'NVIDIA' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.4601)', webgpu: 'NVIDIA' },
  { vendor: 'Google Inc. (AMD)',    renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.24033.1003)', webgpu: 'AMD' },
  { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.2114)', webgpu: 'Intel' },
];

// ---------- base template: inherit real machine fields from an existing profile ----------
function loadBase(dirId) {
  if (!dirId) return null;
  const f = path.join(CACHE, dirId, 'lumi.conf');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(decLumi(fs.readFileSync(f, 'utf8'))); } catch { return null; }
}
let base = loadBase(FROM);
if (!base) {
  // fall back to the newest profile in the cache
  const cands = fs.readdirSync(CACHE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(CACHE, e.name, 'lumi.conf')))
    .map((e) => ({ id: e.name, t: fs.statSync(path.join(CACHE, e.name, 'lumi.conf')).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (cands.length) { base = loadBase(cands[0].id); console.log(`[base] inherited machine fields from ${cands[0].id}`); }
}
if (!base) {
  console.error('[!] no existing profile to inherit from; pass --from <dirId>');
  process.exit(2);
}

const CORE_VER = detectCoreVersion();
console.log(`[core] detected installed core version: ${CORE_VER}`);

// ---------- fingerprint synthesis ----------
function buildFingerprint(idx, dirId, userDataDir, proxy) {
  const gpu = pick(GPU_POOL);
  const [sw, sh] = pick(WIN_RES);
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CORE_VER.split('.')[0]}.0.0.0 Safari/537.36`;
  const name = NAME ? (COUNT > 1 ? `${NAME}-${idx + 1}` : NAME) : null;

  const cfg = JSON.parse(JSON.stringify(base));   // structural clone of a proven config

  cfg.computerName = (name ?? pick(['DESKTOP', 'WIN', 'PC'])) + '-' + hex(4).toUpperCase();
  if (!/^DESKTOP-/.test(cfg.computerName) && !name) cfg.computerName = 'DESKTOP-' + hex(4).toUpperCase();
  cfg.macAddress = hex(6).toUpperCase();
  cfg.windowName = name ?? `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${idx + 1}`;
  cfg.chromeVersion = CORE_VER;
  cfg.userAgent = ua;

  cfg.audioBuffer.audioBufferNoiseValue = rfloat(0.01, 0.99);
  cfg.canvasContext.canvasContextNoiseValue = hex(16).toUpperCase();
  cfg.canvasContext.canvasContextNoiseValueV2 = rint(1000, 65000);
  cfg.clientRects.clientRectsNoiseFactorX = rfloat(-0.9, 0.9);
  cfg.clientRects.clientRectsNoiseFactorY = rfloat(-0.9, 0.9);

  cfg.WebGL.webglRenderer = gpu.renderer;
  cfg.WebGL.webglVendor = gpu.vendor;
  cfg.WebGL.webGLRendererNoiseValue = Array.from(rnd(8)).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  cfg.WebGPU.vendor = gpu.webgpu;

  cfg.navigator.hardwareConcurrency = pick([4, 6, 8, 8, 12, 12, 16]);
  cfg.navigator.deviceMemory = pick([4, 8, 8, 16]);
  cfg.navigator.platform = 'Win32';
  cfg.navigator.maxTouchPoints = 0;
  cfg.userAgentMetadata = { platform: 'Windows', mobile: false, platformVersion: '15.0.0' };

  // screen 0/0/0/0 = "use the real display", matching stock profiles
  cfg.screen = { pixelDepth: 0, colorDepth: 0, width: 0, height: 0, availWidth: 0, availHeight: 0 };

  cfg.browserIconPath = path.join(userDataDir, 'chrome-icon.ico');
  cfg.blockDomainPageFile = path.join(INSTALL, 'resources', 'app.asar.unpacked', 'dist', 'web', 'blockDomain.html');
  cfg.taskBarIcon = { color: 'FF' + hex(3), text: String(idx + 1) };
  cfg.geoLocation = { mode: 'allow', enableFakeLocationData: true, locationLatitude: null, locationLongitude: null, locationAccuracy: null, locationAltitude: null };

  // proxy: explicit --proxy wins, otherwise inherit the base profile's relay
  if (proxy) cfg.fproxy = parseProxy(proxy);
  else if (base.fproxy) cfg.fproxy = JSON.parse(JSON.stringify(base.fproxy));
  delete cfg['_screen'];

  return { cfg, sw, sh };
}

function parseProxy(s) {
  // accepts  socks5://user:pass@host:port  |  http://host:port  |  host:port
  let type = 'socks5', rest = s, username = '', password = '';
  const m = /^([a-z0-9]+):\/\/(.*)$/i.exec(s);
  if (m) { type = m[1].toLowerCase(); rest = m[2]; }
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const [u, p] = rest.slice(0, at).split(':');
    username = decodeURIComponent(u ?? ''); password = decodeURIComponent(p ?? '');
    rest = rest.slice(at + 1);
  }
  const [host, port] = rest.split(':');
  return { type, host, port: parseInt(port, 10), username, password, proxyByPassList: '' };
}

// ---------- create ----------
const created = [];
for (let i = 0; i < COUNT; i++) {
  const dirId = hex(16);                                  // 32 hex chars, same shape as stock ids
  const userDataDir = path.join(CACHE, dirId);
  fs.mkdirSync(userDataDir, { recursive: true });

  const { cfg } = buildFingerprint(i, dirId, userDataDir, PROXY);

  // icon: stock profiles carry a per-profile chrome-icon.ico
  const srcIcon = path.join(CACHE, fs.readdirSync(CACHE).find((d) => fs.existsSync(path.join(CACHE, d, 'chrome-icon.ico'))) ?? '', 'chrome-icon.ico');
  if (fs.existsSync(srcIcon)) fs.copyFileSync(srcIcon, path.join(userDataDir, 'chrome-icon.ico'));

  const file = path.join(userDataDir, 'lumi.conf');
  fs.writeFileSync(file, encLumi(JSON.stringify(cfg)));
  created.push({ dirId, userDataDir, windowName: cfg.windowName, ua: cfg.userAgent, gpu: cfg.WebGL.webglRenderer.slice(0, 60), proxy: cfg.fproxy ? `${cfg.fproxy.type}://${cfg.fproxy.host}:${cfg.fproxy.port}` : 'direct' });
}

console.log(`\n[created] ${created.length} offline profile(s) in ${CACHE}\n`);
for (const c of created) {
  console.log(`  dirId      ${c.dirId}`);
  console.log(`  userDataDir ${c.userDataDir}`);
  console.log(`  windowName ${c.windowName}`);
  console.log(`  proxy      ${c.proxy}`);
  console.log(`  gpu        ${c.gpu}`);
  console.log('');
}
// write next to this script, so roxy-newprofile.ps1 finds it wherever the pack is unpacked
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
fs.writeFileSync(path.join(HERE, 'last-created.json'), JSON.stringify(created, null, 2));
console.log(`[note] these profiles exist only on disk: useWindowCount is untouched.`);
console.log(`[next] pwsh -File _reverse\\roxy-direct-launch.ps1 -DirId ${created.map((c) => c.dirId).join(',')}`);
