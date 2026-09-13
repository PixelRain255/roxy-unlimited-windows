// ============================================================
//  fingerprint.mjs  —  shared fingerprint synthesis + lumi.conf codec
//
//  Used by roxy-api.mjs / mkprofile.mjs / roxy-direct-launch.ps1 so the
//  three paths produce identical, fully randomised profiles.
//
//  Key facts (reversed from dist/main.mjs):
//    * lumi.conf = base64( AES-256-GCM(json, key, iv) || authTag )
//      key "402ead7d23b43b6d1e0528d4f99c59bd", iv "3a105229aa31" (hard-coded)
//    * the patched core reads lumi.conf from --user-data-dir itself
//      (services/fingerprint_inject/fingerprint_inject_service.cc)
//    * timeZone / appLocale / acceptLang are top-level keys and ARE honoured
//      — they drive Intl timezone, navigator.language and navigator.languages.
//      They are omitted from a config when the upstream getters return
//      undefined, which is why some stock profiles appear to lack them.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- codec ----------
const KEY = Buffer.from('402ead7d23b43b6d1e0528d4f99c59bd', 'utf8');
const IV  = Buffer.from('3a105229aa31', 'utf8');

export const encLumi = (text) => {
  const c = crypto.createCipheriv('aes-256-gcm', KEY, IV);
  return Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
};
export const decLumi = (b64) => {
  const raw = Buffer.from(b64.trim(), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, IV);
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
};

// ---------- paths ----------
export const ROOT    = path.join(process.env.APPDATA, 'RoxyBrowser');
export const CACHE   = path.join(ROOT, 'browser-cache');
export const BIN     = path.join(ROOT, 'chrome-bin');
export const INSTALL = path.join(process.env.LOCALAPPDATA, 'Programs', 'RoxyBrowser');
export const EXT_DIR = path.join(INSTALL, 'resources', 'app.asar.unpacked', 'resources', 'automation-control-extension');

export const profileDir = (dirId) => path.join(CACHE, dirId);
export const lumiPath   = (dirId) => path.join(profileDir(dirId), 'lumi.conf');
export const isDirId    = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/i.test(s);
export const hasProfile = (dirId) => isDirId(dirId) && fs.existsSync(lumiPath(dirId));

export function readFingerprint(dirId) {
  try { return JSON.parse(decLumi(fs.readFileSync(lumiPath(dirId), 'utf8'))); } catch { return null; }
}

// newest profile that actually has a lumi.conf — used as the structural template
export function newestTemplateDir() {
  const rows = fs.readdirSync(CACHE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(lumiPath(e.name)))
    .map((e) => ({ id: e.name, t: fs.statSync(lumiPath(e.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return rows.length ? rows[0].id : null;
}

// ---------- locale presets: one string keeps language + tz + accept-lang coherent ----------
export const LOCALE_PRESETS = {
  'pt-BR': { timeZone: 'America/Sao_Paulo', acceptLang: 'pt-BR,pt,en-US,en' },
  'en-US': { timeZone: 'America/New_York',  acceptLang: 'en-US,en' },
  'en-GB': { timeZone: 'Europe/London',     acceptLang: 'en-GB,en' },
  'es-ES': { timeZone: 'Europe/Madrid',     acceptLang: 'es-ES,es,en' },
  'es-MX': { timeZone: 'America/Mexico_City', acceptLang: 'es-MX,es,en' },
  'de-DE': { timeZone: 'Europe/Berlin',     acceptLang: 'de-DE,de,en' },
  'fr-FR': { timeZone: 'Europe/Paris',      acceptLang: 'fr-FR,fr,en' },
  'it-IT': { timeZone: 'Europe/Rome',       acceptLang: 'it-IT,it,en' },
  'nl-NL': { timeZone: 'Europe/Amsterdam',  acceptLang: 'nl-NL,nl,en' },
  'pl-PL': { timeZone: 'Europe/Warsaw',     acceptLang: 'pl-PL,pl,en' },
  'ru-RU': { timeZone: 'Europe/Moscow',     acceptLang: 'ru-RU,ru,en' },
  'tr-TR': { timeZone: 'Europe/Istanbul',   acceptLang: 'tr-TR,tr,en' },
  'ja-JP': { timeZone: 'Asia/Tokyo',        acceptLang: 'ja-JP,ja,en' },
  'ko-KR': { timeZone: 'Asia/Seoul',        acceptLang: 'ko-KR,ko,en' },
  'zh-CN': { timeZone: 'Asia/Shanghai',     acceptLang: 'zh-CN,zh,en' },
  'zh-TW': { timeZone: 'Asia/Taipei',       acceptLang: 'zh-TW,zh,en' },
  'hi-IN': { timeZone: 'Asia/Kolkata',      acceptLang: 'hi-IN,hi,en' },
  'id-ID': { timeZone: 'Asia/Jakarta',      acceptLang: 'id-ID,id,en' },
  'th-TH': { timeZone: 'Asia/Bangkok',      acceptLang: 'th-TH,th,en' },
  'vi-VN': { timeZone: 'Asia/Ho_Chi_Minh',  acceptLang: 'vi-VN,vi,en' },
  'ar-SA': { timeZone: 'Asia/Riyadh',       acceptLang: 'ar-SA,ar,en' },
  'pl':    { timeZone: 'Europe/Warsaw',     acceptLang: 'pl-PL,pl,en' },
};

export const SCREENS = [
  { width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 },
  { width: 1536, height: 864 },  { width: 1600, height: 900 },  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },  { width: 1440, height: 900 },
];

// all GPUs are Windows-plausible; index 0 mirrors this authoring machine
export const GPU_POOL = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.1720)', webgpu: 'NVIDIA' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.4601)', webgpu: 'NVIDIA' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3699)', webgpu: 'NVIDIA' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3623)', webgpu: 'NVIDIA' },
  { vendor: 'Google Inc. (AMD)',    renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.24033.1003)', webgpu: 'AMD' },
  { vendor: 'Google Inc. (AMD)',    renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.21912.14)', webgpu: 'AMD' },
  { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.2114)', webgpu: 'Intel' },
  { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.4314)', webgpu: 'Intel' },
  { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.4502)', webgpu: 'Intel' },
];

// both are coherent with a Windows kernel; do not spoof other OS families
export const WINDOWS_PROFILES = [
  { name: 'Windows 11', platformVersion: '15.0.0', nt: '10.0' },
  { name: 'Windows 10', platformVersion: '10.0.0', nt: '10.0' },
];

// ---------- helpers ----------
const pick  = (a) => a[crypto.randomInt(a.length)];
const rint  = (a, b) => crypto.randomInt(a, b + 1);
const hex   = (n) => crypto.randomBytes(n).toString('hex');
const rfloat = (a, b, p = 6) => +(a + Math.random() * (b - a)).toFixed(p);
const NOISE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const noiseStr = (n) => Array.from(crypto.randomBytes(n)).map((b) => NOISE_ALPHABET[b % 32]).join('');

export function coreExe() {
  const c = fs.readdirSync(BIN, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ exe: path.join(BIN, e.name, 'RoxyChrome.exe'), rank: /^\d+$/.test(e.name) ? parseInt(e.name, 10) : -1 }))
    .filter((x) => fs.existsSync(x.exe))
    .sort((a, b) => b.rank - a.rank);
  if (!c.length) throw new Error('RoxyChrome.exe not found under ' + BIN);
  return c[0].exe;
}
export const coreVersion = () => path.basename(path.dirname(coreExe()));

export function parseProxy(s) {
  let type = 'socks5', rest = String(s), username = '', password = '';
  const m = /^([a-z0-9]+):\/\/(.*)$/i.exec(rest);
  if (m) { type = m[1].toLowerCase(); rest = m[2]; }
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const [u, p] = rest.slice(0, at).split(':');
    username = decodeURIComponent(u ?? ''); password = decodeURIComponent(p ?? '');
    rest = rest.slice(at + 1);
  }
  const i = rest.lastIndexOf(':');
  if (i === -1) throw new Error(`proxy must be host:port — got "${s}"`);
  return { type, host: rest.slice(0, i), port: parseInt(rest.slice(i + 1), 10), username, password, proxyByPassList: '' };
}

// ---------- main entry ----------
/**
 * Build a fully randomised, self-consistent fingerprint config.
 * @param {object} o
 * @param {object} o.template        decrypted template config (required)
 * @param {string} o.dirId
 * @param {string} o.userDataDir
 * @param {string} [o.windowName]
 * @param {string} [o.proxy]         socks5://u:p@host:port | host:port
 * @param {string} [o.locale]        e.g. "pt-BR" -> sets appLocale/acceptLang/timeZone
 * @param {string} [o.timeZone]      explicit IANA tz, overrides the preset
 * @param {string} [o.acceptLang]    explicit accept-lang list
 * @param {number[]} [o.screen]      [width,height], default random
 * @param {string} [o.os]            "Windows 11" | "Windows 10", default random
 * @returns {{cfg:object, screen:{width:number,height:number}, locale:string, timeZone:string}}
 */
export function buildFingerprint(o) {
  const { template, dirId, userDataDir } = o;
  if (!template) throw new Error('template config is required');
  const cfg = JSON.parse(JSON.stringify(template));

  const preset = o.locale
    ? (LOCALE_PRESETS[o.locale] ?? LOCALE_PRESETS[String(o.locale).replace('_', '-')] ?? null)
    : null;
  const locale = o.locale ?? null;
  const timeZone = o.timeZone ?? preset?.timeZone ?? null;
  const acceptLang = o.acceptLang ?? preset?.acceptLang ?? null;

  const win = o.os ? (WINDOWS_PROFILES.find((w) => w.name === o.os) ?? pick(WINDOWS_PROFILES)) : pick(WINDOWS_PROFILES);
  const gpu = pick(GPU_POOL);
  const scr = Array.isArray(o.screen) && o.screen.length === 2
    ? { width: o.screen[0], height: o.screen[1] }
    : pick(SCREENS);

  const ver = coreVersion();
  const major = ver.split('.')[0];

  // ---- identity ----
  cfg.computerName = 'DESKTOP-' + hex(4).toUpperCase();
  cfg.macAddress = hex(6).toUpperCase();
  cfg.windowName = o.windowName || `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${rint(100, 999)}`;
  cfg.chromeVersion = ver;
  cfg.chromeType = 'Google Chrome';
  cfg.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  cfg.userAgentMetadata = { platform: 'Windows', mobile: false, platformVersion: win.platformVersion };

  // ---- locale / timezone (top-level keys, honoured by the injector) ----
  if (locale)     cfg.appLocale = locale;
  if (acceptLang) cfg.acceptLang = acceptLang;
  if (timeZone)   cfg.timeZone = timeZone;

  // ---- noise surfaces ----
  cfg.audioBuffer = {
    version: '2',
    enableAudioBufferNoise: true,
    audioBufferNoiseValue: rfloat(0.01, 0.99),
    audioBufferNoiseInterval: 100,
  };
  cfg.canvasContext = {
    enableCanvasContextNoise: true,
    canvasContextNoiseValue: hex(16).toUpperCase(),
    canvasContextNoiseValueV2: rint(1000, 65000),
  };
  cfg.clientRects = {
    enable: true,
    clientRectsNoiseFactorX: rfloat(-0.9, 0.9),
    clientRectsNoiseFactorY: rfloat(-0.9, 0.9),
  };
  cfg.WebGL = {
    webglRenderer: gpu.renderer,
    webglVendor: gpu.vendor,
    enableWebGLRendererNoise: true,
    webGLRendererNoiseInterval: 1,
    webGLRendererNoiseValue: noiseStr(16),
  };
  cfg.WebGPU = { mode: 'webgl', vendor: gpu.webgpu };

  // ---- hardware ----
  cfg.navigator = {
    platform: 'Win32',
    hardwareConcurrency: pick([4, 6, 8, 8, 12, 12, 16, 16, 24]),
    maxTouchPoints: 0,
    // Chrome 的 navigator.deviceMemory 规范只允许 0.25/0.5/1/2/4/8，
    // 真实浏览器永远不会报 16/32 —— 那是能被指纹库直接抓到的异常值。
    deviceMemory: pick([4, 4, 8, 8, 8, 8, 8]),
    plugins: [],
  };

  // ---- screen: concrete dims (all-zero inherits the host, which in headless is 800x600)
  // NOTE: the injector forces availWidth/availHeight to equal width/height — writing a
  // taskbar-sized gap here is silently ignored, so we keep the two consistent ourselves.
  cfg.screen = {
    width: scr.width, height: scr.height,
    availWidth: scr.width, availHeight: scr.height,
    colorDepth: 24, pixelDepth: 24,
  };

  // ---- per-profile cosmetics ----
  cfg.browserIconPath = path.join(userDataDir, 'chrome-icon.ico');
  cfg.blockDomainPageFile = path.join(INSTALL, 'resources', 'app.asar.unpacked', 'dist', 'web', 'blockDomain.html');
  cfg.taskBarIcon = { color: 'FF' + hex(3), text: String(rint(1, 9)) };

  // ---- local port whitelist ----
  // RoxyChrome enforces portScanProtect: any loopback port not listed here is
  // refused with net::ERR_ADDRESS_UNREACHABLE. Stock profiles whitelist only the
  // workbench (45535), which silently breaks every other local automation endpoint.
  if (o.portScanWhiteList !== undefined) {
    cfg.portScan = {
      enablePortScanWhiteList: true,
      portScanWhiteList: String(o.portScanWhiteList),
    };
  } else if (cfg.portScan && !String(cfg.portScan.portScanWhiteList || '').includes(';')) {
    cfg.portScan.portScanWhiteList = `${cfg.portScan.portScanWhiteList};`;
  }

  // ---- proxy ----
  // 'direct' strips the relay entirely; anything else parses to a relay.
  // Either way localhost must stay reachable, otherwise a dead or slow relay
  // also swallows 127.0.0.1 and local automation endpoints become unreachable
  // (observed as net::ERR_ADDRESS_UNREACHABLE on the DevTools-adjacent page).
  if (o.proxy === 'direct') {
    delete cfg.fproxy;
  } else if (o.proxy) {
    cfg.fproxy = parseProxy(o.proxy);
  }
  if (cfg.fproxy) {
    cfg.fproxy.proxyByPassList = '127.0.0.1;localhost;::1';
  }

  return { cfg, screen: scr, locale: locale ?? null, timeZone: timeZone ?? null, os: win.name };
}

// ---------- profile creation on disk ----------
export function createProfileOnDisk(opts) {
  const dirId = crypto.randomBytes(16).toString('hex');
  const userDataDir = profileDir(dirId);
  fs.mkdirSync(userDataDir, { recursive: true });

  const tplDir = opts.from ?? newestTemplateDir();
  if (!tplDir) throw new Error('no existing profile available as a structural template');
  const template = readFingerprint(tplDir);
  if (!template) throw new Error(`template ${tplDir} could not be decrypted`);

  const built = buildFingerprint({ ...opts, template, dirId, userDataDir });

  const icon = path.join(CACHE, tplDir, 'chrome-icon.ico');
  if (fs.existsSync(icon)) fs.copyFileSync(icon, built.cfg.browserIconPath);

  fs.writeFileSync(lumiPath(dirId), encLumi(JSON.stringify(built.cfg)));
  return { dirId, userDataDir, ...built };
}
