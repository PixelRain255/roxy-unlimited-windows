// ============================================================
//  paths-cli.mjs  —  把路径解析结果吐给 PowerShell 脚本用
//
//    node paths-cli.mjs --json                 -> JSON（供 ConvertFrom-Json）
//    node paths-cli.mjs                        -> 人话报告
//    node paths-cli.mjs --data-dir X --json
//
//  退出码：0 = 可用，2 = 环境不满足
// ============================================================
import { resolveRoxyPaths, explainFailure } from './paths.mjs';

const a = process.argv.slice(2);
const argOf = (n, d = null) => { const i = a.indexOf('--' + n); return i === -1 ? d : a[i + 1]; };

const P = resolveRoxyPaths({ dataDir: argOf('data-dir'), installDir: argOf('install-dir') });

if (a.includes('--json')) {
  process.stdout.write(JSON.stringify(P));
  process.exit(P.ok ? 0 : 2);
}

console.log(P.ok ? '环境检查通过' : explainFailure(P));
console.log(`  数据目录  : ${P.dataDir ?? '(未找到)'}`);
console.log(`  安装目录  : ${P.installDir ?? '(未找到)'}`);
console.log(`  内核      : ${P.coreExe ?? '(未找到)'}${P.coreVersion ? `  (v${P.coreVersion})` : ''}`);
console.log(`  chromedriver: ${P.chromedriver ?? '(未找到)'}`);
console.log(`  档案目录  : ${P.browserCacheDir ?? '(未找到)'}`);
process.exit(P.ok ? 0 : 2);
