// ============================================================
//  roxy-api.mjs  —  Roxy-compatible local OpenAPI for UNLIMITED windows
//
//  Why this instead of patching the official asar:
//    the official OpenAPI resolves every dirId through the server
//    (user_get_window_info_v2), so it can never exceed maxWindowCount.
//    This server speaks the SAME response shape but resolves dirIds
//    locally, so it is not bound by the account quota at all.
//
//  Response shape is identical to the official one:
//    {code:0,msg:"成功",data:{dirId,ws,http,coreVersion,driver,sortNum,windowName,pid}}
//
//  Run:  node roxy-api.mjs --port 50001
// ============================================================
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import {
  getPaths, pathHelp, show, LOCALE_PRESETS, SCREENS, WINDOWS_PROFILES,
  coreExe, coreVersion, lumiPath, profileDir, hasProfile, isDirId,
  readFingerprint, createProfileOnDisk, buildFingerprint, encLumi, parseProxy,
} from './fingerprint.mjs';

const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0], 10);
if (NODE_MAJOR < 22) {
  console.error(`[roxy-api] Node.js >= 22 is required; found ${process.versions.node}.`);
  process.exit(2);
}
// ---------- config ----------
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const PORT      = parseInt(argOf('port', '50000'), 10);
const HEADLESS  = argv.includes('--headless-default');
const WORKBENCH = argv.includes('--workbench-default');
const APP_PORT  = parseInt(argOf('app-port', '45535'), 10);
const DEF_LOCALE = argOf('locale', null);
const FULL_PATHS = argv.includes('--full-paths');   // 默认脱敏显示路径
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_UI_FILE = path.join(HERE, 'webui', 'index.html');
const API_KEY = argOf('api-key', process.env.ROXY_API_KEY ?? '');

// 路径自动发现：--data-dir / --install-dir / ROXY_HOME / ROXY_INSTALL / 常见位置 / 注册表 / 运行中进程
const PATHS = getPaths({ dataDir: argOf('data-dir'), installDir: argOf('install-dir') });

const DRIVER = () => PATHS.chromedriver ?? path.join(path.dirname(coreExe()), 'chromedriver.exe');
const windowNameOf = (dirId) => readFingerprint(dirId)?.windowName || (dirId ? String(dirId).slice(0, 8) : 'unknown');

// ---------- per-profile canvas/audio noise via CDP ----------
// The core's own canvasContext.noise knobs are inert in this build (verified:
// four configs differing only in enable/value produce one identical canvas hash),
// and MAIN-world content scripts do not inject reliably here, so the shim is
// installed over CDP with Page.addScriptToEvaluateOnNewDocument — the same
// mechanism Playwright uses. It survives detach for the lifetime of each target.
const NOISE_SRC_DIR = path.join(HERE, 'noise-ext');
const NOISE_SRC = path.join(NOISE_SRC_DIR, 'noise.js');
const NOISE_TEMP = path.join(PATHS.tempDir ?? process.cwd(), 'profile-noise');
const noiseSource = (dirId, fp) => {
  const seedSource = String(fp?.canvasContext?.canvasContextNoiseValue ?? '') + '|' + dirId;
  const seed = crypto.createHash('sha256').update(seedSource).digest().readUInt32BE(0);
  // replaceAll, not replace: __SEED__ also appears in the file's header comment
  return fs.readFileSync(NOISE_SRC, 'utf8').replaceAll('__SEED__', String(seed >>> 0));
};

/** Per-profile unpacked extension copy — Chromium loads one instance per dirId. */
function materializeNoiseExt(dirId, fp) {
  const dir = path.join(NOISE_TEMP, dirId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'noise.js'), noiseSource(dirId, fp));
  for (const f of ['manifest.json', 'bg.js']) fs.copyFileSync(path.join(NOISE_SRC_DIR, f), path.join(dir, f));
  return dir;
}

/** Keeps a controller CDP connection alive so new tabs also get the shim. */
async function installNoiseShim(wsUrl, source) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  let id = 0;
  const pending = new Map();
  const send = (method, params, sessionId) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); res(null); } }, 8000);
  });

  const inject = async (sessionId) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, sessionId);
  };

  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Target.attachedToTarget') {
      const t = m.params.targetInfo;
      if (t.type === 'page' || t.type === 'iframe') inject(m.params.sessionId).catch(() => {});
    }
  });

  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  // cover targets that already existed before auto-attach was armed
  const list = await send('Target.getTargets', {});
  for (const t of list?.targetInfos ?? []) {
    if (t.type !== 'page' && t.type !== 'iframe') continue;
    const att = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    if (att?.sessionId) await inject(att.sessionId);
  }
  return ws;
}

// ---------- running-window registry ----------
/** dirId -> {dirId,pid,ws,http,windowName,coreVersion,driver,startedAt} */
const running = new Map();
const proxyStore = new Map();
const accountStore = new Map();

const json = (res, obj, status = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const ok  = (res, data) => json(res, { code: 0, msg: 'Success', data: data ?? null });
const err = (res, msg, code = 101) => json(res, { code, msg, data: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readDevTools(ud) {
  const f = path.join(ud, 'DevToolsActivePort');
  try {
    const t = fs.readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    const port = parseInt(t[0], 10);
    if (port > 0 && t[1]) {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return { port, wsPath: t[1] };
    }
  } catch { /* stale or not ready */ }
  return null;
}

async function waitDevTools(ud, proc, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const endpoint = await readDevTools(ud);
    if (endpoint) return endpoint;
    if (proc && proc.exitCode !== null) {
      throw new Error(`RoxyChrome exited before DevTools became ready (pid=${proc.pid}, code=${proc.exitCode ?? 'unknown'}, signal=${proc.signalCode ?? 'none'})`);
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for DevTools endpoint (pid=${proc?.pid ?? 'unknown'}, profile=${ud})`);
}

function showWindow(port) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'window showing is only supported on Windows' });
  const script = path.join(HERE, 'roxy-open.ps1');
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(port),
    ], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) console.warn(`[roxy-api] window restore failed on port ${port}: ${error.message}`);
      resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '', error: error?.message ?? null });
    });
  });
}
async function recoverWindow(dirId, endpoint, bringToFront = false) {
  const current = running.get(dirId);
  if (current) return current;


  const fp = readFingerprint(dirId) ?? {};
  const rec = {
    dirId,
    pid: null,
    port: endpoint.port,
    http: `127.0.0.1:${endpoint.port}`,
    ws: `ws://127.0.0.1:${endpoint.port}${endpoint.wsPath}`,
    windowName: windowNameOf(dirId),
    coreVersion: coreVersion(),
    driver: DRIVER(),
    startedAt: Date.now(),
    noiseInstalled: false,
  };
  running.set(dirId, rec);
  try {
    rec.noiseController = await installNoiseShim(rec.ws, noiseSource(dirId, fp));
    rec.noiseInstalled = true;
  } catch (e) {
    console.warn(`[roxy-api] recovered noise shim failed for ${dirId}: ${e?.message ?? e}`);
  }
  if (bringToFront) await showWindow(endpoint.port);
  return rec;
}
async function launchWindow(dirId, opts = {}) {
  if (!hasProfile(dirId)) throw Object.assign(new Error('窗口/数据不存在，请刷新页面后重试'), { code: 101 });

  const cur = running.get(dirId);
  if (cur) { try { process.kill(cur.pid, 0); return cur; } catch { running.delete(dirId); } }

  const ud = profileDir(dirId);
  const existing = await readDevTools(ud);
  if (existing) return recoverWindow(dirId, existing, true);
  for (const f of ['DevToolsActivePort', 'SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    try { fs.rmSync(path.join(ud, f), { force: true }); } catch {}
  }

  const fp = readFingerprint(dirId) ?? {};
  let chainBridge = null;
  let originalLumiRaw = null;
  if (entryProxyConfig.enabled && entryProxyConfig.host && entryProxyConfig.port) {
    try {
      const exitProxy = fp.fproxy || null;
      chainBridge = await createLocalChainBridge(entryProxyConfig, exitProxy);
      const lp = lumiPath(dirId);
      if (fs.existsSync(lp)) {
        originalLumiRaw = fs.readFileSync(lp);
      }
      const modifiedFp = JSON.parse(JSON.stringify(fp));
      modifiedFp.fproxy = {
        type: 'socks5',
        host: '127.0.0.1',
        port: chainBridge.port,
        username: '',
        password: '',
        proxyByPassList: '127.0.0.1;localhost;::1',
      };
      if (!modifiedFp.portScan) {
        modifiedFp.portScan = { enablePortScanWhiteList: true, portScanWhiteList: '45535;' };
      }
      const curList = String(modifiedFp.portScan.portScanWhiteList || '');
      if (!curList.includes(String(chainBridge.port))) {
        modifiedFp.portScan.portScanWhiteList = `${curList};${chainBridge.port};`;
      }
      fs.writeFileSync(lp, encLumi(JSON.stringify(modifiedFp)));
    } catch (e) {
      console.warn(`[roxy-api] chain bridge init failed for ${dirId}: ${e?.message}`);
      if (chainBridge) {
        try { chainBridge.close(); } catch {}
        chainBridge = null;
      }
    }
  }
  // window size follows the profile's own screen config so the two never disagree
  const scr = fp.screen ?? {};
  const w = Number(scr.width) || 1920;
  const h = Number(scr.height) || 1080;

  const headless = opts.headless ?? HEADLESS;
  const args = [
    '--disable-background-mode',
    '--disable-popup-blocking',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--password-store=basic',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${ud}`,
    '--remote-debugging-port=0',          // official uses port 0 + DevToolsActivePort
    `--window-size=${w},${h}`,
  ];
  // keep the browser-level language in lockstep with lumi.conf's appLocale/acceptLang
  if (fp.appLocale)  args.push(`--lang=${fp.appLocale}`);
  if (fp.acceptLang) args.push(`--accept-lang=${fp.acceptLang}`);

  const useWorkbench = opts.workbench ?? WORKBENCH;
  if (useWorkbench) args.push(`http://127.0.0.1:${APP_PORT}/dashboard.html?id=${dirId}&workspaceType=0`);

  const exts = [];
  if (PATHS.extensionDir) exts.push(PATHS.extensionDir);           // vendor automation-control
  exts.push(materializeNoiseExt(dirId, fp));                // our per-profile noise
  args.push(`--load-extension=${exts.join(',')}`);

  if (Array.isArray(opts.args)) args.push(...opts.args);
  if (headless) args.push('--headless=new');
  if (opts.useGpu === false) args.push('--disable-gpu');
  args.push(opts.startUrl || 'about:blank');

  const proc = spawn(coreExe(), args, { detached: true, stdio: 'ignore', windowsHide: headless });
  proc.unref();
  if (chainBridge) {
    proc.on('exit', () => { try { chainBridge.close(); } catch {} });
  }
  if (originalLumiRaw) {
    setTimeout(() => {
      try { fs.writeFileSync(lumiPath(dirId), originalLumiRaw); } catch {}
    }, 4000);
  }
  const { port, wsPath } = await waitDevTools(ud, proc);
  const ws = `ws://127.0.0.1:${port}${wsPath}`;
  const rec = {
    dirId, pid: proc.pid, port,
    http: `127.0.0.1:${port}`,
    ws,
    windowName: windowNameOf(dirId),
    coreVersion: coreVersion(),
    driver: DRIVER(),
    startedAt: Date.now(),
    noiseInstalled: false,
    chainBridge,
  };
  running.set(dirId, rec);

  // per-profile canvas/audio shim — non-fatal if it fails
  try {
    rec.noiseController = await installNoiseShim(ws, noiseSource(dirId, fp));
    rec.noiseInstalled = true;
  } catch (e) {
    console.warn(`[roxy-api] noise shim failed for ${dirId}: ${e?.message ?? e}`);
  }

  if (!headless) await showWindow(port);
  return rec;
}

const handleOf = (rec, sortNum) => ({
  dirId: rec.dirId, ws: rec.ws, http: rec.http, coreVersion: rec.coreVersion,
  driver: rec.driver, sortNum: sortNum ?? 1, windowName: rec.windowName,
  windowRemark: '', pid: rec.pid,
});

async function cdpClose(wsUrl) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(); } };
    try {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      ws.addEventListener('error', fin);
      setTimeout(fin, 1500);
    } catch { fin(); }
  });
}

async function closeWindow(dirId) {
  const rec = running.get(dirId);
  try { rec?.chainBridge?.close(); } catch {}
  try { rec?.noiseController?.close(); } catch {}
  if (rec?.ws) {
    try { await cdpClose(rec.ws); } catch {}
  }
  await sleep(400);
  if (rec?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
  running.delete(dirId);
  return Boolean(rec);
}
async function removeProfileDir(dirId) {
  if (!isDirId(dirId)) return false;
  const ud = profileDir(dirId);
  if (!fs.existsSync(ud)) return true;
  await closeWindow(dirId);
  try {
    const pScript = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${dirId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFileSync('powershell', ['-NoProfile', '-Command', pScript], { stdio: 'ignore', timeout: 5000 });
  } catch {}
  await sleep(250);
  let removed = false;
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed = true;
      break;
    } catch (e) {
      await sleep(150);
    }
  }
  if (!removed && fs.existsSync(ud)) {
    try {
      execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', ud], { stdio: 'ignore', timeout: 5000 });
      removed = !fs.existsSync(ud);
    } catch {}
  }
  if (fs.existsSync(ud)) {
    throw new Error(`EPERM, Permission denied: \\\\?\\${ud}`);
  }
  return true;
}

// ---------- official-compatible local data helpers ----------
const LOCAL_WORKSPACE = {
  id: '1',
  workspaceName: 'Local Workspace',
  project_details: [{ projectId: '1', projectName: 'Local Profiles' }],
};
const nowText = () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
const idListOf = (value) => Array.isArray(value)
  ? value.map((x) => String(x)).filter(Boolean)
  : String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const pageOf = (rows, source) => {
  const index = Math.max(1, Number(source.page_index ?? 1) || 1);
  const size = Math.max(1, Math.min(1000, Number(source.page_size ?? 15) || 15));
  return { total: rows.length, rows: rows.slice((index - 1) * size, index * size) };
};
function proxyInfoOf(fp) {
  const p = fp?.fproxy;
  if (!p?.host) return {
    moduleId: '0', proxyMethod: 'custom', proxyCategory: 'noproxy', ipType: 'IPV4', protocol: '',
    host: '', port: '', proxyUserName: '', proxyPassword: '', refreshUrl: '', lastIp: '',
    lastCountry: '', checkChannel: '',
  };
  const protocol = String(p.type || 'socks5').toUpperCase();
  return {
    moduleId: '0', proxyMethod: 'custom', proxyCategory: protocol, ipType: 'IPV4', protocol,
    host: String(p.host), port: String(p.port ?? ''), proxyUserName: p.username ?? '',
    proxyPassword: p.password ?? '', refreshUrl: '', lastIp: '', lastCountry: '', checkChannel: '',
  };
}
function proxyUrlOf(proxyInfo) {
  if (!proxyInfo || String(proxyInfo.proxyCategory || '').toLowerCase() === 'noproxy') return 'direct';
  const protocol = String(proxyInfo.protocol || proxyInfo.proxyCategory || 'socks5').toLowerCase();
  const host = String(proxyInfo.host || '');
  const port = String(proxyInfo.port || '');
  if (!host || !port) return undefined;
  const user = proxyInfo.proxyUserName ? encodeURIComponent(String(proxyInfo.proxyUserName)) : '';
  const pass = proxyInfo.proxyPassword ? `:${encodeURIComponent(String(proxyInfo.proxyPassword))}` : '';
  return `${protocol}://${user ? `${user}${pass}@` : ''}${host}:${port}`;
}
function officialProfileRow(dirId, fp, active, index) {
  const platformVersion = String(fp?.userAgentMetadata?.platformVersion || '15.0.0');
  const osVersion = platformVersion === '10.0.0' ? '10' : '11';
  const t = nowText();
  return {
    id: dirId,
    dirId,
    windowSortNum: index + 1,
    windowName: fp?.windowName ?? (dirId ? String(dirId).slice(0, 8) : 'profile'),
    coreVersion: String(fp?.chromeVersion ?? coreVersion()),
    coreType: 'Chrome',
    os: 'Windows',
    osVersion,
    userAgent: fp?.userAgent ?? '',
    cookie: [],
    searchEngine: fp?.searchEngine?.name ?? 'Google',
    windowPlatformList: [],
    defaultOpenUrl: Array.isArray(fp?.defaultOpenUrl) ? fp.defaultOpenUrl : [],
    windowRemark: fp?.windowRemark ?? '',
    projectId: '1',
    projectName: 'Local Profiles',
    openStatus: Boolean(active),
    statusInfo: active ? [{ openTime: t, openUserName: 'local' }] : [],
    createTime: t,
    updateTime: t,
    userName: 'local',
    openTime: active ? t : '',
    closeTime: '',
    proxyInfo: proxyInfoOf(fp),
    isOften: false,
    labelInfo: [],
  };
}
async function localProfileRows() {
  const entries = fs.readdirSync(PATHS.browserCacheDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && hasProfile(e.name));
  return Promise.all(entries.map(async (e, i) => {
    const fp = readFingerprint(e.name) ?? {};
    let active = running.get(e.name);
    if (!active) {
      const endpoint = await readDevTools(profileDir(e.name));
      if (endpoint) active = await recoverWindow(e.name, endpoint, false);
    }
    return { id: e.name, dirId: e.name, fp, active, index: i };
  }));
}
function normalizeProfileRequest(body) {
  const finger = body.fingerInfo ?? {};
  let proxy = body.proxy;
  if (proxy === undefined && body.proxyId) {
    const pItem = proxyStore.get(String(body.proxyId));
    if (pItem) proxy = proxyUrlOf(pItem);
  }
  if (proxy === undefined) {
    proxy = body.proxyInfo !== undefined
      ? proxyUrlOf(body.proxyInfo)
      : body.workspaceId !== undefined ? 'direct' : undefined;
  }
  const locale = body.locale ?? body.language ?? body.languages ?? body.lang
    ?? finger.language ?? finger.languages ?? finger.displayLanguage ?? finger.locale ?? undefined;
  const timeZone = body.timeZone ?? body.timezone ?? body.time_zone
    ?? finger.timeZone ?? finger.timezone ?? finger.time_zone ?? finger.timeZoneName ?? undefined;
  const acceptLang = body.acceptLang ?? body.accept_lang ?? body.acceptLanguage
    ?? finger.acceptLanguage ?? finger.acceptLang ?? undefined;
  let screen = body.screen;
  if (typeof screen === 'string' && /^\d+x\d+$/.test(screen)) screen = screen.split('x').map(Number);
  if (!screen && finger.resolutionType && finger.resolutionX && finger.resolutionY) screen = [Number(finger.resolutionX), Number(finger.resolutionY)];
  const os = body.os === 'Windows'
    ? (body.osVersion === '10' ? 'Windows 10' : body.osVersion === '11' ? 'Windows 11' : undefined)
    : body.os;
  const args = Array.isArray(body.args) ? [...body.args] : [];
  if (body.startupParam) args.push(...String(body.startupParam).split(';').map((x) => x.trim()).filter(Boolean));
  return {
    from: body.from,
    windowName: body.windowName,
    proxy,
    locale,
    timeZone,
    acceptLang: body.acceptLang,
    os,
    screen,
    startUrl: body.startUrl ?? body.defaultOpenUrl?.[0] ?? 'about:blank',
    open: body.open,
    headless: body.headless,
    workbench: body.workbench ?? (finger.openWorkbench === 1),
    useGpu: body.useGpu ?? finger.useGpu,
    args,
    portScanWhiteList: (body.portScanWhiteList ?? finger.portScanList)?.replaceAll(',', ';'),
  };
}
function modifyFingerprintOnDisk(dirId, body) {
  if (!hasProfile(dirId)) throw Object.assign(new Error('窗口/数据不存在'), { code: 101 });
  const fp = readFingerprint(dirId);
  if (!fp) throw new Error('lumi.conf 无法解密');
  const normalized = normalizeProfileRequest(body);
  const finger = body.fingerInfo ?? {};
  if (body.windowName !== undefined) fp.windowName = String(body.windowName);
  if (body.windowRemark !== undefined) fp.windowRemark = String(body.windowRemark);
  if (body.searchEngine !== undefined) fp.searchEngine = { name: String(body.searchEngine) };
  if (Array.isArray(body.defaultOpenUrl)) fp.defaultOpenUrl = body.defaultOpenUrl.map(String);
  if (normalized.locale) fp.appLocale = normalized.locale;
  if (normalized.timeZone) fp.timeZone = normalized.timeZone;
  if (normalized.acceptLang) fp.acceptLang = normalized.acceptLang;
  if (normalized.screen) {
    const screen = Array.isArray(normalized.screen) ? normalized.screen : String(normalized.screen).split('x').map(Number);
    if (screen.length === 2 && screen.every((x) => Number.isFinite(x))) fp.screen = { width: screen[0], height: screen[1], availWidth: screen[0], availHeight: screen[1], colorDepth: 24, pixelDepth: 24 };
  }
  if (body.osVersion) fp.userAgentMetadata = { ...(fp.userAgentMetadata ?? {}), platform: 'Windows', mobile: false, platformVersion: String(body.osVersion) === '10' ? '10.0.0' : '15.0.0' };
  if (body.proxy !== undefined || body.proxyInfo !== undefined || body.proxyId !== undefined) {
    if (normalized.proxy === 'direct') delete fp.fproxy;
    else if (normalized.proxy) fp.fproxy = parseProxy(normalized.proxy);
  }
  if (finger.hardwareConcurrent !== undefined) fp.navigator = { ...(fp.navigator ?? {}), hardwareConcurrency: Number(finger.hardwareConcurrent) };
  if (finger.deviceMemory !== undefined) fp.navigator = { ...(fp.navigator ?? {}), deviceMemory: Number(finger.deviceMemory) };
  if (finger.doNotTrack !== undefined) fp.doNotTrack = Boolean(finger.doNotTrack);
  if (finger.webGLManufacturer || finger.webGLRender) fp.WebGL = { ...(fp.WebGL ?? {}), webglVendor: finger.webGLManufacturer ?? fp.WebGL.webglVendor, webglRenderer: finger.webGLRender ?? fp.WebGL.webglRenderer };
  if (finger.portScanProtect !== undefined || finger.portScanList !== undefined) fp.portScan = { ...(fp.portScan ?? {}), enablePortScanWhiteList: Boolean(finger.portScanProtect ?? true), portScanWhiteList: String(finger.portScanList ?? fp.portScan?.portScanWhiteList ?? '') .replaceAll(',', ';') };
  if (body.startupParam !== undefined) fp.startupParam = String(body.startupParam);
  fs.writeFileSync(lumiPath(dirId), encLumi(JSON.stringify(fp)));
  return fp;
}
const PROXY_STORE_FILE = path.join(PATHS.dataDir || process.cwd(), 'proxy_pool.json');
const PROXY_IGNORED_FILE = path.join(PATHS.dataDir || process.cwd(), 'proxy_ignored.json');
const ENTRY_PROXY_FILE = path.join(PATHS.dataDir || process.cwd(), 'entry_proxy.json');
const ignoredExtractedProxies = new Set();
let entryProxyConfig = {
  enabled: false,
  protocol: 'socks5',
  host: '',
  port: '',
  username: '',
  password: '',
  remark: '',
  updateTime: '',
};

function proxyRow(id, value) {
  const p = value ?? {};
  const protocol = String(p.protocol || p.type || p.proxyCategory || 'SOCKS5').toUpperCase();
  return {
    id: String(id), checkStatus: p.checkStatus ?? 0, checkChannel: p.checkChannel ?? '', checkChannelValue: '', lastIp: p.lastIp ?? '',
    lastCountry: p.lastCountry ?? '', lastState: '', lastCity: '', ipType: p.ipType ?? 'IPV4', protocol,
    type: protocol.toLowerCase(), isSaved: p.isSaved !== false,
    host: String(p.host ?? ''), port: String(p.port ?? ''), proxyPassword: String(p.proxyPassword ?? p.password ?? ''),
    proxyUserName: String(p.proxyUserName ?? p.username ?? ''), refreshUrl: p.refreshUrl ?? '',
    remark: String(p.remark ?? p.title ?? p.name ?? ''),
    checkTime: p.checkTime ?? '', createTime: p.createTime ?? nowText(), updateTime: p.updateTime ?? nowText(),
  };
}
function cleanHostAndPort(rawHost, rawPort) {
  let host = String(rawHost || '').trim();
  let port = Number(rawPort) || 0;
  if (host.includes('://')) {
    try {
      const u = new URL(host);
      host = u.hostname;
      if (u.port) port = Number(u.port);
    } catch {
      host = host.replace(/^[a-zA-Z0-9]+:\/\//, '');
    }
  }
  if (host.includes('@')) host = host.split('@').pop();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end > -1) {
      const ipv6 = host.slice(1, end);
      const after = host.slice(end + 1);
      if (after.startsWith(':')) port = Number(after.slice(1)) || port;
      host = ipv6;
    }
  } else if (host.includes(':')) {
    const parts = host.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      host = parts[0];
      port = Number(parts[1]) || port;
    }
  }
  host = host.replace(/\/.*$/, '').trim();
  if (host.toLowerCase() === 'localhost') host = '127.0.0.1';
  return { host, port };
}

function officialProxyFromBody(body) {
  const p = body?.proxyInfo ?? body ?? {};
  const proto = String(p.protocol ?? p.proxyCategory ?? p.type ?? 'socks5').toLowerCase();
  const cleaned = cleanHostAndPort(p.host, p.port);
  return {
    proxyCategory: proto.toUpperCase(), protocol: proto.toUpperCase(), type: proto, ipType: p.ipType ?? 'IPV4',
    host: cleaned.host, port: cleaned.port ? String(cleaned.port) : String(p.port ?? '').trim(),
    proxyUserName: String(p.proxyUserName ?? p.username ?? p.user ?? '').trim(),
    proxyPassword: String(p.proxyPassword ?? p.password ?? p.pass ?? '').trim(),
    refreshUrl: String(p.refreshUrl ?? '').trim(), checkChannel: String(p.checkChannel ?? '').trim(),
    remark: String(p.remark ?? p.title ?? p.name ?? '').trim(),
    createTime: p.createTime ?? nowText(),
    updateTime: p.updateTime ?? nowText(),
  };
}

function loadProxyStore() {
  try {
    if (fs.existsSync(PROXY_STORE_FILE)) {
      const raw = fs.readFileSync(PROXY_STORE_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && item.id && item.host) {
            proxyStore.set(String(item.id), officialProxyFromBody(item));
          }
        }
      }
    }
    if (fs.existsSync(PROXY_IGNORED_FILE)) {
      const raw = fs.readFileSync(PROXY_IGNORED_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) if (item) ignoredExtractedProxies.add(String(item));
      }
    }
  } catch (err) {
    console.warn('[roxy-api] Failed to load proxy_pool.json or proxy_ignored.json:', err.message);
  }
}

function saveProxyStore() {
  try {
    const list = [];
    for (const [id, val] of proxyStore) {
      list.push({ id, ...val });
    }
    const dir = path.dirname(PROXY_STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROXY_STORE_FILE, JSON.stringify(list, null, 2), 'utf8');
    fs.writeFileSync(PROXY_IGNORED_FILE, JSON.stringify([...ignoredExtractedProxies], null, 2), 'utf8');
  } catch (err) {
    console.warn('[roxy-api] Failed to save proxy store:', err.message);
  }
}
function loadEntryProxyStore() {
  try {
    if (fs.existsSync(ENTRY_PROXY_FILE)) {
      const raw = fs.readFileSync(ENTRY_PROXY_FILE, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        entryProxyConfig = {
          enabled: Boolean(obj.enabled),
          protocol: String(obj.protocol || 'socks5').toLowerCase(),
          host: String(obj.host || '').trim(),
          port: String(obj.port || '').trim(),
          username: String(obj.username || obj.proxyUserName || '').trim(),
          password: String(obj.password || obj.proxyPassword || '').trim(),
          remark: String(obj.remark || '').trim(),
          updateTime: obj.updateTime || nowText(),
        };
      }
    }
  } catch (err) {
    console.warn('[roxy-api] Failed to load entry_proxy.json:', err.message);
  }
}

function saveEntryProxyStore() {
  try {
    const dir = path.dirname(ENTRY_PROXY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ENTRY_PROXY_FILE, JSON.stringify(entryProxyConfig, null, 2), 'utf8');
  } catch (err) {
    console.warn('[roxy-api] Failed to save entry_proxy.json:', err.message);
  }
}

function httpConnectTunnel(socket, targetHost, targetPort, auth) {
  return new Promise((resolve, reject) => {
    let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\n`;
    const u = auth?.username || auth?.proxyUserName || auth?.user || '';
    const p = auth?.password || auth?.proxyPassword || auth?.pass || '';
    if (u) {
      const creds = Buffer.from(`${u}:${p}`).toString('base64');
      req += `Proxy-Authorization: Basic ${creds}\r\n`;
    }
    req += '\r\n';
    socket.write(req);

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        cleanup();
        const headers = buf.subarray(0, headerEnd).toString('utf8');
        const firstLine = headers.split('\r\n')[0] || '';
        if (/^HTTP\/1\.[01]\s+200/i.test(firstLine)) {
          const rest = buf.subarray(headerEnd + 4);
          if (rest.length > 0) socket.unshift(rest);
          resolve(socket);
        } else {
          reject(new Error(`HTTP CONNECT 失败: ${firstLine}`));
        }
      }
    };
    const onError = (e) => { cleanup(); reject(e); };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    }
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function socks5ConnectTunnel(socket, targetHost, targetPort, auth) {
  return new Promise((resolve, reject) => {
    const u = auth?.username || auth?.proxyUserName || auth?.user || '';
    const p = auth?.password || auth?.proxyPassword || auth?.pass || '';
    const hasAuth = Boolean(u);

    if (hasAuth) {
      socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    } else {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    }

    let state = 'greeting';
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (state === 'greeting') {
          if (buf.length < 2) return;
          const [ver, method] = [buf[0], buf[1]];
          buf = buf.subarray(2);
          if (ver !== 0x05) throw new Error('非 SOCKS5 代理返回');
          if (method === 0x02) {
            if (!hasAuth) throw new Error('SOCKS5 代理要求认证，但未提供密码');
            state = 'auth';
            const uBuf = Buffer.from(u, 'utf8');
            const pBuf = Buffer.from(p, 'utf8');
            socket.write(Buffer.concat([
              Buffer.from([0x01, uBuf.length]),
              uBuf,
              Buffer.from([pBuf.length]),
              pBuf
            ]));
          } else if (method === 0x00) {
            sendConnect();
          } else {
            throw new Error(`SOCKS5 代理不支持该认证协商: 0x${method.toString(16)}`);
          }
        }
        if (state === 'auth') {
          if (buf.length < 2) return;
          const [ver, status] = [buf[0], buf[1]];
          buf = buf.subarray(2);
          if (status !== 0x00) throw new Error('SOCKS5 认证失败: 账号或密码不正确');
          sendConnect();
        }
        if (state === 'connect') {
          if (buf.length < 4) return;
          const [ver, rep, rsv, atyp] = [buf[0], buf[1], buf[2], buf[3]];
          if (rep !== 0x00) throw new Error(`SOCKS5 代理 CONNECT 失败 (rep=0x${rep.toString(16)})`);
          let minLen = 4;
          if (atyp === 0x01) minLen += 4 + 2;
          else if (atyp === 0x03) {
            if (buf.length < 5) return;
            minLen += 1 + buf[4] + 2;
          } else if (atyp === 0x04) minLen += 16 + 2;
          if (buf.length < minLen) return;

          const rest = buf.subarray(minLen);
          cleanup();
          if (rest.length > 0) socket.unshift(rest);
          resolve(socket);
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    };

    function sendConnect() {
      state = 'connect';
      const isIp = net.isIP(targetHost);
      let targetBuf;
      if (isIp === 4) {
        const parts = targetHost.split('.').map(Number);
        targetBuf = Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts, (targetPort >> 8) & 0xff, targetPort & 0xff]);
      } else {
        const domainBuf = Buffer.from(targetHost, 'utf8');
        targetBuf = Buffer.from([0x05, 0x01, 0x00, 0x03, domainBuf.length, ...domainBuf, (targetPort >> 8) & 0xff, targetPort & 0xff]);
      }
      socket.write(targetBuf);
    }

    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    }
    const onError = (e) => { cleanup(); reject(e); };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function tunnelViaProxy(socket, proxyNode, targetHost, targetPort) {
  const proto = String(proxyNode.protocol || proxyNode.type || proxyNode.proxyCategory || 'socks5').toLowerCase();
  if (proto.startsWith('socks')) {
    return socks5ConnectTunnel(socket, targetHost, targetPort, proxyNode);
  } else {
    return httpConnectTunnel(socket, targetHost, targetPort, proxyNode);
  }
}

function createLocalChainBridge(entryProxy, exitProxy) {
  return new Promise((resolve, reject) => {
    const activeSockets = new Set();
    const server = net.createServer((client) => {
      activeSockets.add(client);
      client.on('close', () => activeSockets.delete(client));
      let state = 'greeting';
      let buf = Buffer.alloc(0);

      client.on('error', () => { client.destroy(); });

      client.on('data', async (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (state === 'greeting') {
          if (buf.length < 3) return;
          const nmethods = buf[1];
          if (buf.length < 2 + nmethods) return;
          buf = buf.subarray(2 + nmethods);
          client.write(Buffer.from([0x05, 0x00]));
          state = 'request';
        }
        if (state === 'request') {
          if (buf.length < 4) return;
          const [ver, cmd, rsv, atyp] = [buf[0], buf[1], buf[2], buf[3]];
          if (cmd !== 0x01) {
            client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return client.destroy();
          }
          let destHost = '';
          let destPort = 0;
          let offset = 4;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            destHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            offset = 8;
          } else if (atyp === 0x03) {
            const len = buf[4];
            if (buf.length < 5 + len + 2) return;
            destHost = buf.subarray(5, 5 + len).toString('utf8');
            offset = 5 + len;
          } else if (atyp === 0x04) {
            if (buf.length < 22) return;
            destHost = '::1';
            offset = 20;
          } else {
            return client.destroy();
          }
          destPort = buf.readUInt16BE(offset);
          buf = buf.subarray(offset + 2);
          state = 'connected';

          try {
            const relaySocket = net.connect({ host: entryProxy.host, port: Number(entryProxy.port), timeout: 10000 });
            activeSockets.add(relaySocket);
            relaySocket.on('close', () => activeSockets.delete(relaySocket));

            await new Promise((res, rej) => {
              relaySocket.once('connect', res);
              relaySocket.once('error', rej);
              relaySocket.once('timeout', () => { relaySocket.destroy(); rej(new Error('连接入口代理超时 (10s)')); });
            });

            let activeTunnel = relaySocket;
            if (exitProxy && exitProxy.host && Number(exitProxy.port)) {
              await tunnelViaProxy(activeTunnel, entryProxy, exitProxy.host, Number(exitProxy.port));
              await tunnelViaProxy(activeTunnel, exitProxy, destHost, destPort);
            } else {
              await tunnelViaProxy(activeTunnel, entryProxy, destHost, destPort);
            }

            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (buf.length > 0) activeTunnel.write(buf);
            client.pipe(activeTunnel);
            activeTunnel.pipe(client);

            activeTunnel.on('error', () => client.destroy());
          } catch (err) {
            try { client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
            client.destroy();
          }
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        close() {
          for (const s of activeSockets) { try { s.destroy(); } catch {} }
          activeSockets.clear();
          try { server.close(); } catch {}
        }
      });
    });
    server.on('error', reject);
  });
}
function accountRow(id, body, times = {}) {
  return {
    id: String(id),
    platformUrl: body.platformUrl ?? '',
    platformUserName: body.platformUserName ?? '',
    platformPassword: body.platformPassword ?? '',
    platformEfa: body.platformEfa ?? '',
    platformCookies: Array.isArray(body.platformCookies) ? body.platformCookies : [],
    platformName: body.platformName ?? body.platformUrl ?? '',
    platformRemarks: body.platformRemarks ?? '',
    createTime: times.createTime ?? body.createTime ?? nowText(),
    updateTime: times.updateTime ?? body.updateTime ?? nowText(),
  };
}
function tokenOf(req) {
  const auth = String(req.headers.authorization ?? '');
  return req.headers.token ?? req.headers['x-api-key'] ?? req.headers['api-key']
    ?? (auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? '');
}
// ---------- HTTP ----------
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    return res.end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = req.method === 'POST' ? await readBody(req) : {};
  const query = Object.fromEntries(url.searchParams.entries());

  try {
    if (API_KEY && !['/health', '/', '/index.html', '/meta/info'].includes(p) && tokenOf(req) !== API_KEY) {
      return err(res, 'Unauthorized', 401);
    }
    if (p === '/health') return ok(res, 'ok');

    if (p === '/meta/info') {
      return ok(res, {
        apiPort: PORT,
        appPort: APP_PORT,
        coreVersion: PATHS.coreVersion,
        nodeVersion: process.versions.node,
        nodeMajor: NODE_MAJOR,
        webUiVersion: 4,
        apiKeyRequired: Boolean(API_KEY),
        officialPort: 50000,
        defaultLocale: DEF_LOCALE,
        headlessDefault: HEADLESS,
        workbenchDefault: WORKBENCH,
        defaultPortScanWhiteList: PORT + ';45535;' + APP_PORT + ';',
      });
    }

    if ((p === '/' || p === '/index.html') && req.method === 'GET') {
      const html = fs.readFileSync(WEB_UI_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    // minimal same-origin page: gives the per-profile noise extension a real
    // http origin to run on (content scripts never match about:blank)
    if (p === '/_blank') {
      const html = '<!doctype html><meta charset="utf-8"><title>blank</title><body></body>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(html);
    }

    // ---------- metadata: what the caller may ask for ----------
    if (p === '/meta/locales') {
      return ok(res, { locales: LOCALE_PRESETS, screens: SCREENS, os: WINDOWS_PROFILES.map((w) => w.name) });
    }

    if (p === '/browser/workspace' || p === '/workspace/list' || p === '/workspace' || p === '/browser/workspace/list') {
      return ok(res, { total: 1, rows: [LOCAL_WORKSPACE], workSpaceList: [LOCAL_WORKSPACE], workspaceList: [LOCAL_WORKSPACE] });
    }

    if (p === '/browser/account' || p === '/account/list') {
      const rows = [...accountStore.values()];
      return ok(res, pageOf(rows, query));
    }

    if (p === '/browser/label') {
      return ok(res, []);
    }

    if (p === '/browser/list_v3') {
      const wantedIds = idListOf(query.dirIds);
      const wantedSorts = idListOf(query.sortNums).map(Number);
      const rows = (await localProfileRows())
        .map((item) => officialProfileRow(item.id, item.fp, Boolean(item.active), item.index))
        .filter((row) => !wantedIds.length || wantedIds.includes(row.dirId))
        .filter((row) => !query.windowName || row.windowName.includes(query.windowName))
        .filter((row) => !wantedSorts.length || wantedSorts.includes(row.windowSortNum))
        .filter((row) => !query.os || row.os === query.os)
        .filter((row) => !query.projectIds || idListOf(query.projectIds).includes(row.projectId))
        .filter((row) => !query.windowRemark || row.windowRemark.includes(query.windowRemark));
      return ok(res, pageOf(rows, query));
    }

    if (p === '/browser/detail') {
      const dirId = query.dirId;
      if (!dirId || !hasProfile(dirId)) return err(res, '窗口/数据不存在', 101);
      const fp = readFingerprint(dirId);
      const active = running.get(dirId) || await (async () => {
        const endpoint = await readDevTools(profileDir(dirId));
        return endpoint ? await recoverWindow(dirId, endpoint, false) : null;
      })();
      return ok(res, { total: 1, rows: [officialProfileRow(dirId, fp ?? {}, Boolean(active), 0)] });
    }

    if (p === '/browser/template') {
      return ok(res, []);
    }

    if (p === '/browser/list') {
      const rows = await localProfileRows();
      const data = rows.map((item) => {
        const fp = item.fp ?? {};
        const dirId = item.dirId || item.id || '';
        return {
          id: dirId,
          dirId,
          windowName: fp.windowName ?? (dirId ? String(dirId).slice(0, 8) : '未命名'),
          windowSortNum: item.index + 1,
          openStatus: item.active ? 1 : 0,
          statusInfo: null,
          proxyInfo: fp.fproxy ?? {},
          timeZone: fp.timeZone ?? null,
          locale: fp.appLocale ?? null,
          screen: fp.screen ? `${fp.screen.width}x${fp.screen.height}` : null,
        };
      });
      return ok(res, { rows: data, total: data.length });
    }
    // ---------- create ----------
    if (p === '/browser/create') {
      const opts = normalizeProfileRequest(body);
      const built = createProfileOnDisk({
        ...opts,
        locale: opts.locale ?? DEF_LOCALE ?? undefined,
        portScanWhiteList: opts.portScanWhiteList ?? `${PORT};45535;${APP_PORT};`,
      });
      if (body.fingerInfo && typeof body.fingerInfo === 'object') {
        const fp = readFingerprint(built.dirId);
        fp.officialFingerInfo = body.fingerInfo;
        fs.writeFileSync(lumiPath(built.dirId), encLumi(JSON.stringify(fp)));
      }
      const info = {
        dirId: built.dirId,
        windowName: built.cfg.windowName,
        locale: built.locale,
        timeZone: built.timeZone,
        screen: `${built.screen.width}x${built.screen.height}`,
        os: built.os,
        proxy: built.cfg.fproxy ? `${built.cfg.fproxy.type}://${built.cfg.fproxy.host}:${built.cfg.fproxy.port}` : 'direct',
        portScanWhiteList: built.cfg.portScan?.portScanWhiteList ?? null,
        startUrl: opts.startUrl ?? null,
      };
      if (body.open) {
        const rec = await launchWindow(built.dirId, opts);
        return ok(res, { ...handleOf(rec), ...info });
      }
      return ok(res, info);
    }
    if (p === '/browser/open') {
      const dirId = body.dirId ?? body.id ?? query.dirId ?? query.id;
      if (!dirId) return err(res, 'dirId is required');
      const rec = await launchWindow(dirId, normalizeProfileRequest({ ...body, dirId }));
      return ok(res, handleOf(rec));
    }

    if (p === '/browser/mdf') {
      const dirId = body.dirId ?? body.id ?? query.dirId ?? query.id;
      if (!dirId) return err(res, 'dirId is required');
      let active = running.get(dirId);
      if (!active) {
        const endpoint = await readDevTools(profileDir(dirId));
        if (endpoint) active = await recoverWindow(dirId, endpoint, false);
      }
      if (active) await closeWindow(dirId);
      modifyFingerprintOnDisk(dirId, body);
      return ok(res);
    }

    if (p === '/browser/random_env') {
      const dirId = body.dirId ?? body.id ?? query.dirId ?? query.id;
      if (!dirId || !hasProfile(dirId)) return err(res, '窗口/数据不存在', 101);
      let active = running.get(dirId);
      if (!active) {
        const endpoint = await readDevTools(profileDir(dirId));
        if (endpoint) active = await recoverWindow(dirId, endpoint, false);
      }
      if (active) await closeWindow(dirId);
      const old = readFingerprint(dirId) ?? {};
      const opts = normalizeProfileRequest(body);
      const built = buildFingerprint({
        template: old,
        dirId,
        userDataDir: profileDir(dirId),
        windowName: opts.windowName || old.windowName,
        proxy: opts.proxy !== undefined ? (opts.proxy === 'direct' ? undefined : opts.proxy) : proxyUrlOf(proxyInfoOf(old)),
        locale: opts.locale ?? undefined,
        timeZone: opts.timeZone ?? undefined,
        acceptLang: opts.acceptLang ?? undefined,
        screen: opts.screen ?? undefined,
        os: opts.os ?? undefined,
        portScanWhiteList: opts.portScanWhiteList ?? old.portScan?.portScanWhiteList ?? `${PORT};45535;${APP_PORT};`,
      });
      fs.writeFileSync(lumiPath(dirId), encLumi(JSON.stringify(built.cfg)));
      return ok(res);
    }

    if (p === '/browser/clear_local_cache') {
      const ids = idListOf(body.dirIds ?? body.dirId ?? body.ids ?? body.id ?? query.dirIds ?? query.dirId ?? query.id);
      if (!ids.length) return err(res, 'dirIds is required');
      const type = String(body.type ?? 'all').toLowerCase();
      const partialNames = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Media Cache', 'Application Cache']);
      for (const dirId of ids) {
        if (!hasProfile(dirId)) continue;
        let active = running.get(dirId);
        if (!active) {
          const endpoint = await readDevTools(profileDir(dirId));
          if (endpoint) active = await recoverWindow(dirId, endpoint, false);
        }
        if (active) await closeWindow(dirId);
        for (const entry of fs.readdirSync(profileDir(dirId), { withFileTypes: true })) {
          const keep = ['lumi.conf', 'chrome-icon.ico', 'Cookies', 'Network', 'Local Storage', 'IndexedDB', 'Session Storage', 'Service Worker', 'Preferences', 'Secure Preferences', 'Login Data', 'Web Data'].includes(entry.name);
          const remove = type === 'partial' ? partialNames.has(entry.name) : !keep;
          if (remove) fs.rmSync(path.join(profileDir(dirId), entry.name), { recursive: true, force: true });
        }
      }
      return ok(res);
    }

    if (p === '/browser/clear_server_cache') {
      return ok(res);
    }

    if (p === '/proxy/detect_channel') {
      return ok(res, []);
    }

    if (p === '/proxy/bought_list') {
      return ok(res, { total: 0, rows: [] });
    }

    if (p === '/proxy/list') {
      const rows = [];
      const seen = new Set();
      for (const [id, value] of proxyStore) {
        rows.push(proxyRow(id, { ...value, isSaved: true }));
        seen.add(`${value.host}:${value.port}`);
      }
      for (const item of await localProfileRows()) {
        const pinfo = proxyInfoOf(item.fp);
        if (!pinfo.host || seen.has(`${pinfo.host}:${pinfo.port}`)) continue;
        const id = crypto.createHash('sha1').update(`${pinfo.host}:${pinfo.port}`).digest('hex').slice(0, 32);
        if (ignoredExtractedProxies.has(id) || ignoredExtractedProxies.has(`${pinfo.host}:${pinfo.port}`)) continue;
        rows.push(proxyRow(id, { ...pinfo, isSaved: false, remark: pinfo.remark || `从档案 ${item.windowName || item.id} 提取` }));
        seen.add(`${pinfo.host}:${pinfo.port}`);
      }
      return ok(res, pageOf(rows, query));
    }

    if (p === '/proxy/create') {
      const value = officialProxyFromBody(body);
      if (!value.host || !value.port) return err(res, 'host and port are required', 500);
      const id = body.id ? String(body.id) : crypto.randomBytes(8).toString('hex');
      ignoredExtractedProxies.delete(id);
      ignoredExtractedProxies.delete(`${value.host}:${value.port}`);
      proxyStore.set(id, value);
      saveProxyStore();
      return ok(res, { id, ...proxyRow(id, value) });
    }

    if (p === '/proxy/batch_create') {
      const created = [];
      const rawList = Array.isArray(body) ? body : (body.proxyList ?? body.proxies ?? body.list ?? []);
      for (const item of rawList) {
        const value = officialProxyFromBody(item);
        if (!value.host || !value.port) continue;
        const id = item.id ? String(item.id) : crypto.randomBytes(8).toString('hex');
        ignoredExtractedProxies.delete(id);
        ignoredExtractedProxies.delete(`${value.host}:${value.port}`);
        proxyStore.set(id, value);
        created.push(id);
      }
      saveProxyStore();
      return ok(res, { createdCount: created.length, ids: created });
    }

    if (p === '/proxy/modify') {
      if (!body.id) return err(res, 'id is required', 101);
      const id = String(body.id);
      let prev = proxyStore.get(id);
      if (!prev) {
        // 如果是从已有档案提取并首次编辑，将其转为代理池内持久化节点
        prev = officialProxyFromBody(body);
      }
      const updated = { ...prev, ...officialProxyFromBody(body), updateTime: nowText() };
      if (!updated.host || !updated.port) return err(res, 'host and port are required', 500);
      ignoredExtractedProxies.delete(id);
      ignoredExtractedProxies.delete(`${updated.host}:${updated.port}`);
      proxyStore.set(id, updated);
      saveProxyStore();
      return ok(res, { id, ...proxyRow(id, updated) });
    }

    if (p === '/proxy/delete') {
      const ids = idListOf(body.ids ?? body.id);
      for (const id of ids) {
        if (proxyStore.has(id)) {
          const p = proxyStore.get(id);
          if (p && p.host && p.port) ignoredExtractedProxies.add(`${p.host}:${p.port}`);
          proxyStore.delete(id);
        }
        ignoredExtractedProxies.add(id);
      }
      saveProxyStore();
      return ok(res, { deletedCount: ids.length });
    }

    if (p === '/proxy/detect') {
      let rawHost = String(body.host || '').trim();
      let rawPort = Number(body.port);
      if ((!rawHost || !rawPort) && body.id && proxyStore.has(String(body.id))) {
        const item = proxyStore.get(String(body.id));
        rawHost = item.host;
        rawPort = Number(item.port);
      }
      const { host, port } = cleanHostAndPort(rawHost, rawPort);
      if (!host || !port) return ok(res, { checkStatus: 0, msg: '未指定目标主机与端口' });
      const t0 = Date.now();
      const useChain = body.useChain !== undefined
        ? Boolean(body.useChain)
        : Boolean(entryProxyConfig.enabled && entryProxyConfig.host && entryProxyConfig.port);

      const checkPromise = new Promise(async (resolve) => {
        if (useChain && entryProxyConfig.host && entryProxyConfig.port) {
          try {
            const entryCleaned = cleanHostAndPort(entryProxyConfig.host, entryProxyConfig.port);
            const socket = net.createConnection({
              host: entryCleaned.host,
              port: Number(entryCleaned.port),
              timeout: 4500
            });
            socket.once('timeout', () => { socket.destroy(); resolve({ checkStatus: 2, msg: `入口代理连接超时 (4500ms): ${entryCleaned.host}:${entryCleaned.port}` }); });
            socket.once('error', (e) => {
              const detail = e.code === 'ECONNREFUSED'
                ? `入口代理拒绝连接 (${entryCleaned.host}:${entryCleaned.port})，请确认跳板服务已启动`
                : (e.code === 'ENOTFOUND' ? `无法解析入口代理主机名 (${entryCleaned.host})` : (e.message || '不可达'));
              resolve({ checkStatus: 2, msg: `入口代理连接失败: ${detail}` });
            });
            await new Promise((res, rej) => {
              socket.once('connect', res);
              socket.once('error', rej);
            });
            await tunnelViaProxy(socket, entryProxyConfig, host, port);
            const latency = Date.now() - t0;
            socket.destroy();
            resolve({
              checkStatus: 1,
              msg: `经入口代理连接成功 (${latency}ms)`,
              latency,
              chained: true,
              entryRemark: entryProxyConfig.remark || `${entryCleaned.host}:${entryCleaned.port}`
            });
          } catch (e) {
            resolve({ checkStatus: 2, msg: `经入口代理转发失败: ${e.message || '握手失败'}` });
          }
        } else {
          const socket = net.createConnection({ host, port, timeout: 3500 }, () => {
            const latency = Date.now() - t0;
            socket.destroy();
            resolve({ checkStatus: 1, msg: `TCP 连接成功 (${latency}ms)`, latency });
          });
          socket.on('timeout', () => { socket.destroy(); resolve({ checkStatus: 2, msg: `连接超时 (3500ms): ${host}:${port}` }); });
          socket.on('error', (e) => {
            const detail = e.code === 'ECONNREFUSED'
              ? `目标端口拒绝连接 (${host}:${port})。如为本地代理，请确认客户端正在运行并监听该端口`
              : (e.code === 'ENOTFOUND' ? `无法解析主机地址: ${host}` : (e.message || '连接失败'));
            resolve({ checkStatus: 2, msg: detail });
          });
        }
      });
      const checkResult = await checkPromise;
      if (body.id && proxyStore.has(String(body.id))) {
        const item = proxyStore.get(String(body.id));
        item.checkStatus = checkResult.checkStatus;
        item.checkTime = nowText();
      }
      return ok(res, checkResult);
    }

    if (p === '/proxy/entry') {
      if (req.method === 'POST') {
        if (body.enabled !== undefined) entryProxyConfig.enabled = Boolean(body.enabled);
        if (body.protocol !== undefined) {
          let pr = String(body.protocol || 'socks5').toLowerCase();
          entryProxyConfig.protocol = pr.includes('http') ? 'http' : 'socks5';
        }
        if (body.host !== undefined || body.port !== undefined) {
          const rawH = body.host !== undefined ? body.host : entryProxyConfig.host;
          const rawP = body.port !== undefined ? body.port : entryProxyConfig.port;
          const cl = cleanHostAndPort(rawH, rawP);
          entryProxyConfig.host = cl.host;
          entryProxyConfig.port = cl.port ? String(cl.port) : (body.port ? String(body.port).trim() : '');
        }
        if (body.username !== undefined) entryProxyConfig.username = String(body.username || body.proxyUserName || '').trim();
        if (body.password !== undefined) entryProxyConfig.password = String(body.password || body.proxyPassword || '');
        if (body.remark !== undefined) entryProxyConfig.remark = String(body.remark).trim();
        entryProxyConfig.updateTime = nowText();
        saveEntryProxyStore();
        return ok(res, entryProxyConfig);
      }
      return ok(res, entryProxyConfig);
    }

    if (p === '/proxy/entry/test') {
      const rawHost = String(body.host || entryProxyConfig.host || '').trim();
      const rawPort = Number(body.port || entryProxyConfig.port);
      const { host, port } = cleanHostAndPort(rawHost, rawPort);
      let proto = String(body.protocol || entryProxyConfig.protocol || 'socks5').toLowerCase();
      if (proto.includes('http')) proto = 'http';
      else proto = 'socks5';
      const username = String(body.username !== undefined ? body.username : (entryProxyConfig.username || '')).trim();
      const password = String(body.password !== undefined ? body.password : (entryProxyConfig.password || ''));

      if (!host || !port) return ok(res, { checkStatus: 0, msg: '未指定入口代理的主机与端口' });
      const t0 = Date.now();
      try {
        const socket = net.createConnection({ host, port, timeout: 3500 });
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
              reject(new Error(`无法连接 ${host}:${port} (ECONNREFUSED)。请确认 Clash / 代理客户端已启动且端口正确（例如 Clash Verge 默认端口为 7897，CFW 默认为 7890）`));
            } else if (err.code === 'ENOTFOUND') {
              reject(new Error(`无法解析主机地址: ${host} (ENOTFOUND)。请勿在主机栏中包含协议或端口`));
            } else {
              reject(err);
            }
          });
          socket.once('timeout', () => { socket.destroy(); reject(new Error(`入口代理连接超时 (3500ms): ${host}:${port}`)); });
        });

        if (proto.startsWith('socks')) {
          await new Promise((resolve, reject) => {
            const hasAuth = Boolean(username);
            if (hasAuth) socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
            else socket.write(Buffer.from([0x05, 0x01, 0x00]));

            const onData = (buf) => {
              socket.removeListener('data', onData);
              socket.removeListener('error', reject);
              if (buf.length >= 2 && buf[0] === 0x05) {
                resolve();
              } else if (buf.toString('utf8').includes('HTTP/')) {
                reject(new Error(`目标端口返回了 HTTP 协议响应，非标准 SOCKS5。请将协议类型切换为 HTTP (CONNECT) 后重试！`));
              } else {
                reject(new Error(`目标端口响应异常，非标准 SOCKS5 代理 (首字节 0x${(buf[0] || 0).toString(16)})`));
              }
            };
            socket.on('data', onData);
            socket.once('error', reject);
          });
        } else if (proto === 'http') {
          await new Promise((resolve, reject) => {
            let authHeader = '';
            if (username) {
              const b64 = Buffer.from(`${username}:${password}`).toString('base64');
              authHeader = `Proxy-Authorization: Basic ${b64}\r\n`;
            }
            socket.write(`CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n${authHeader}Proxy-Connection: keep-alive\r\n\r\n`);
            const onData = (buf) => {
              socket.removeListener('data', onData);
              socket.removeListener('error', reject);
              const head = buf.toString('utf8');
              if (head.startsWith('HTTP/1.') && (head.includes(' 200 ') || head.includes(' 407 ') || head.includes(' 502 ') || head.includes(' 503 '))) {
                if (head.includes(' 407 ')) {
                  reject(new Error('HTTP 代理需要身份认证 (407 Proxy Authentication Required)，请填写用户名与密码'));
                } else {
                  resolve();
                }
              } else if (buf.length >= 2 && buf[0] === 0x05) {
                reject(new Error('目标端口返回了 SOCKS5 协议响应，非 HTTP 代理。请将协议类型切换为 SOCKS5！'));
              } else {
                resolve();
              }
            };
            socket.on('data', onData);
            socket.once('error', reject);
          });
        }
        const latency = Date.now() - t0;
        socket.destroy();
        return ok(res, { checkStatus: 1, msg: `入口代理连通正常 (${latency}ms)`, latency, host, port, protocol: proto });
      } catch (err) {
        return ok(res, { checkStatus: 2, msg: err.message || '入口代理连接失败' });
      }
    }

    if (p === '/account/create') {
      const id = crypto.randomBytes(8).toString('hex');
      const t = nowText();
      accountStore.set(id, accountRow(id, body, { createTime: t, updateTime: t }));
      return ok(res, { platform_id: id });
    }

    if (p === '/account/batch_create') {
      for (const item of body.accountList ?? []) {
        const id = crypto.randomBytes(8).toString('hex');
        const t = nowText();
        accountStore.set(id, accountRow(id, item, { createTime: t, updateTime: t }));
      }
      return ok(res);
    }

    if (p === '/account/modify') {
      if (!body.id || !accountStore.has(String(body.id))) return err(res, 'account not found', 101);
      const old = accountStore.get(String(body.id));
      accountStore.set(String(body.id), accountRow(String(body.id), { ...old, ...body }, { createTime: old.createTime, updateTime: nowText() }));
      return ok(res);
    }
    if (p === '/account/delete') {
      idListOf(body.ids ?? body.id).forEach((id) => accountStore.delete(id));
      return ok(res);
    }
    if (p === '/browser/show') {
      const dirId = body.dirId ?? url.searchParams.get('dirId');
      if (!dirId) return err(res, 'dirId is required');
      let rec = running.get(dirId);
      if (!rec) {
        if (!hasProfile(dirId)) return err(res, '窗口/数据不存在');
        const endpoint = await readDevTools(profileDir(dirId));
        if (endpoint) rec = await recoverWindow(dirId, endpoint, false);
      }
      if (!rec) return err(res, 'window is not open');
      const result = await showWindow(rec.port);
      if (!result.ok) return err(res, `window restore failed: ${result.error ?? 'unknown error'}`, 500);
      return ok(res, { dirId, port: rec.port, output: result.stdout.trim() });
    }
    if (p === '/browser/connection_info') {
      const wanted = idListOf(query.dirIds ?? query.dirId ?? body.dirIds ?? body.dirId);
      const rows = await localProfileRows();
      const list = rows
        .filter((item) => item.active && (!wanted.length || wanted.includes(item.id)))
        .map((item, i) => handleOf(item.active, i + 1));
      return ok(res, list);
    }
    if (p === '/browser/close') {
      const dirId = body.dirId ?? body.id ?? query.dirId ?? query.id;
      if (!dirId) return err(res, 'dirId is required');
      const closed = await closeWindow(dirId);
      return closed ? ok(res) : err(res, 'window is not open');
    }

    if (p === '/browser/close_all') {
      const ids = [...running.keys()];
      for (const id of ids) await closeWindow(id);
      return ok(res, { closed: ids.length });
    }

    if (p === '/browser/delete') {
      const ids = idListOf(body.dirIds ?? body.dirId ?? body.ids ?? body.id ?? query.dirIds ?? query.dirId ?? query.id);
      if (!ids.length) return err(res, 'dirIds is required');
      for (const dirId of ids) {
        if (!isDirId(dirId)) return err(res, 'invalid dirId');
        await removeProfileDir(dirId);
      }
      return ok(res);
    }
    // read a profile's decrypted fingerprint (no secrets beyond what the caller owns)
    if (p === '/browser/fingerprint') {
      const dirId = url.searchParams.get('dirId') ?? url.searchParams.get('id') ?? body.dirId ?? body.id;
      if (!hasProfile(dirId)) return err(res, '窗口/数据不存在');
      const fp = readFingerprint(dirId);
      if (body.full === true || url.searchParams.get('full') === '1') return ok(res, fp);
      return ok(res, {
        windowName: fp.windowName, userAgent: fp.userAgent, platform: fp.navigator?.platform,
        hardwareConcurrency: fp.navigator?.hardwareConcurrency, deviceMemory: fp.navigator?.deviceMemory,
        webglVendor: fp.WebGL?.webglVendor, webglRenderer: fp.WebGL?.webglRenderer,
        timeZone: fp.timeZone ?? null, appLocale: fp.appLocale ?? null, acceptLang: fp.acceptLang ?? null,
        screen: fp.screen ?? null, proxy: fp.fproxy ?? null,
      });
    }

    return json(res, { code: 104, msg: 'Not Found', data: null }, 404);
  } catch (e) {
    return err(res, e?.message ?? String(e), e?.code ?? 500);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const id of [...running.keys()]) await closeWindow(id);
    server.close(() => process.exit(0));
  });
}

// ---------- 启动前置检查：环境不对就别假装能跑 ----------
if (!PATHS.ok) {
  console.error(pathHelp(undefined, FULL_PATHS));
  console.error('提示：可用 --data-dir <路径> 或环境变量 ROXY_HOME 手动指定数据目录。\n');
  process.exit(2);
}
loadProxyStore();
loadEntryProxyStore();

server.listen(PORT, '127.0.0.1', () => {
  const s = (p) => show(p, FULL_PATHS);   // 默认把用户名换成 %USERPROFILE% 之类的占位符
  console.log(`[roxy-api] listening on http://127.0.0.1:${PORT}`);
  console.log(`[roxy-api] core        : ${s(PATHS.coreExe)}  (v${PATHS.coreVersion})`);
  console.log(`[roxy-api] data dir    : ${s(PATHS.dataDir)}`);
  console.log(`[roxy-api] profile base: ${s(PATHS.browserCacheDir)}`);
  console.log(`[roxy-api] install dir : ${s(PATHS.installDir) ?? '(未找到 — 官方扩展与拦截页将不可用，不影响启动)'}`);
  console.log(`[roxy-api] chromedriver: ${s(PATHS.chromedriver) ?? '(未找到)'}`);
  console.log(`[roxy-api] quota       : NONE — windows are resolved locally, no server call`);
  console.log(`[roxy-api] headless default: ${HEADLESS}   workbench default: ${WORKBENCH}`);
  console.log(`[roxy-api] default locale  : ${DEF_LOCALE ?? '(none — inherit template)'}`);
  console.log(`[roxy-api] proxy store    : ${proxyStore.size} item(s) loaded`);
  if (!FULL_PATHS) console.log(`[roxy-api] 路径已脱敏显示，加 --full-paths 看真实路径`);
});
