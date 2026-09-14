// 验证：把 timeZone / appLocale / acceptLang 写进 lumi.conf 是否真的生效
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const KEY = Buffer.from('402ead7d23b43b6d1e0528d4f99c59bd', 'utf8');
const IV = Buffer.from('3a105229aa31', 'utf8');
const enc = (t) => { const c = crypto.createCipheriv('aes-256-gcm', KEY, IV); return Buffer.concat([c.update(t, 'utf8'), c.final(), c.getAuthTag()]).toString('base64'); };
const dec = (b) => { const r = Buffer.from(b.trim(), 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', KEY, IV); d.setAuthTag(r.subarray(r.length - 16)); return Buffer.concat([d.update(r.subarray(0, r.length - 16)), d.final()]).toString('utf8'); };

const PATHS.browserCacheDir = path.join(process.env.APPDATA, 'RoxyBrowser', 'browser-PATHS.browserCacheDir');
const PATHS.dataDir = path.join(process.env.APPDATA, 'RoxyBrowser');
const SRC = '2e30e3eade87826cef66504e452fbbbf';   // 有 timeZone/appLocale 的真实档案
const EXE = path.join(PATHS.dataDir, 'chrome-bin', '152', 'RoxyChrome.exe');

// ---- 两组对照：A 原样(Asia/Tokyo, ja-JP)  B 改成 BR ----
const cases = [
  { tag: 'A-continue-tokyo', tz: 'Asia/Tokyo',         locale: 'ja-JP', accept: 'ja-JP,ja' },
  { tag: 'B-switch-to-BR',   tz: 'America/Sao_Paulo',  locale: 'pt-BR', accept: 'pt-BR,pt' },
];

const results = [];

for (const c of cases) {
  const dirId = crypto.randomBytes(16).toString('hex');
  const ud = path.join(PATHS.browserCacheDir, dirId);
  fs.mkdirSync(ud, { recursive: true });

  const cfg = JSON.parse(dec(fs.readFileSync(path.join(PATHS.browserCacheDir, SRC, 'lumi.conf'), 'utf8')));
  cfg.windowName = c.tag;
  cfg.timeZone = c.tz;
  cfg.appLocale = c.locale;
  cfg.acceptLang = c.accept;
  cfg.browserIconPath = path.join(ud, 'chrome-icon.ico');
  fs.writeFileSync(path.join(ud, 'lumi.conf'), enc(JSON.stringify(cfg)));
  const ico = path.join(PATHS.browserCacheDir, SRC, 'chrome-icon.ico');
  if (fs.existsSync(ico)) fs.copyFileSync(ico, cfg.browserIconPath);

  const p = spawn(EXE, [
    '--disable-background-mode', '--no-first-run', '--no-default-browser-check',
    '--use-mock-keychain', '--no-sandbox', '--disable-setuid-sandbox',
    '--password-store=basic', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${ud}`, '--remote-debugging-port=0', '--headless=new',
    '--disable-gpu', 'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();

  // wait for DevToolsActivePort
  const f = path.join(ud, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const t = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      if (t[0] && parseInt(t[0], 10) > 0) { port = parseInt(t[0], 10); break; }
    } catch {}
  }
  if (!port) { results.push({ tag: c.tag, error: 'no devtools port' }); continue; }

  // CDP evaluate
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page') ?? list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const expr = `({tz: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, lang: navigator.language, langs: (navigator.languages||[]).join(','), off: new Date().getTimezoneOffset(), al: null})`;
  const got = await new Promise((res) => {
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m.result?.result?.value); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => res(null), 10000);
  });
  ws.close();

  results.push({ tag: c.tag, wanted: { tz: c.tz, locale: c.locale, accept: c.accept }, got, dirId });
  try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 500));
}

console.log(JSON.stringify(results, null, 2));
