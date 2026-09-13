# RoxyBrowser 无限窗口工具包

> **⚠️ 仅供技术学习与研究使用。** 与本产品官方无关联、未获授权，所述做法可能违反其用户协议，
> 使用可能导致账号封禁或数据丢失。请仅在自己拥有或已获授权的设备与账号上操作，商业用途请购买授权。
> 按"现状"提供，不附带担保，作者不承担使用本文档造成的任何损失。继续阅读即表示接受。

---

## 这是什么

一组零依赖的 Node.js / PowerShell 脚本，让你可以启动**任意数量**的 RoxyBrowser 指纹窗口，
不受 Roxy 账号窗口额度（`maxWindowCount`）的限制。

原理：RoxyBrowser 的窗口 = **定制 Chromium 内核** + **档案目录里的加密指纹配置（`lumi.conf`）**，
两者都在本地，启动过程不需要联网。脚本绕过官方 launcher，直接驱动内核，
并提供一个与官方响应结构完全一致的本地 HTTP API。

## 包内容

```
README.md                    本文件
MANUAL-zh.md                 完整手册（原理 + 方法 + API + 五个坑）  ← 先看这个
TECHNICAL-zh.md              技术详解（含逆向依据、源码位置、已证伪结论附录）

scripts/                     核心脚本（全部零第三方依赖，需 Node ≥ 22）
  roxy-api.mjs               ★ 本地无限窗口 API 服务
  fingerprint.mjs            ★ 共享指纹合成 + lumi.conf 编解码
  noise-ext/                 按档案实例化的 canvas/音频噪声扩展
  roxy-direct-launch.ps1     命令行直启器
  roxy-newprofile.ps1        一键批量建档案 + 启动 + 健康检查
  mkprofile.mjs              离线档案生成器（命令行版）
  lumi.mjs                   lumi.conf 编解码器
  cdpcheck.mjs               零依赖 CDP 指纹探针
  probe-existing.mjs         探测已有档案的指纹
  verify-profile.mjs         自校验（建→开→逐项比对→清理）
  verify-quick.mjs           快速端到端验证
  diag-*.mjs / test-*.mjs    取证与诊断脚本

tools/                       静态分析工具（可选，与运行无关）
  asar.mjs                   asar 解包 / 列表 / 提取
  unmap.mjs                  从 sourcemap 还原可读源码
  ctx.mjs                    在压缩产物中按字节定位锚点
  patch_limit.mjs            app.asar 原位等长修补（含回滚）
```

## 快速开始

```powershell
# 1) 启动 API
node scripts\roxy-api.mjs --port 50001

# 2) 建一个窗口并打开
$API = "http://127.0.0.1:50001"
$h = (Invoke-RestMethod -Uri "$API/browser/create" -Method POST -ContentType "application/json" `
       -Body (@{ windowName="w1"; locale="pt-BR"; proxy="direct"; open=$true } | ConvertTo-Json)).data
$h | Format-List dirId, http, ws, driver, locale, timeZone, pid

# 3) 用 Playwright 接上去
#    const b = await chromium.connectOverCDP(`http://${h.http}`);

# 4) 全关
Invoke-RestMethod -Uri "$API/browser/close_all" -Method POST -ContentType "application/json" -Body '{}'
```

## 前置条件

| 项 | 要求 |
|---|---|
| OS | Windows |
| Node | ≥ 22（需要内置 `fetch` / `WebSocket`） |
| 依赖 | **无**，全部脚本零第三方依赖 |
| RoxyBrowser | 需已安装（脚本读取其内核与数据目录） |
| 官方 App | **不需要运行**（已实测） |

路径默认取自：

```
内核    %APPDATA%\RoxyBrowser\chrome-bin\<coreVersion>\RoxyChrome.exe
档案    %APPDATA%\RoxyBrowser\browser-cache\<dirId>\
安装    %LOCALAPPDATA%\Programs\RoxyBrowser\
```

## 三条必读注意事项

1. **本地端口必须进白名单**。RoxyChrome 强制端口扫描保护，不在 `lumi.conf` 的
   `portScan.portScanWhiteList` 里的本地端口一律不可达（`net::ERR_ADDRESS_UNREACHABLE`）。
   原厂档案只白名单了工作台 45535。`roxy-api.mjs` 建档案时会自动写入自身端口。
   排查"窗口连不上本地服务"**先看这个**，不要先怀疑代理。
2. **不传 `proxy` 会继承旧档案的代理**。要直连就显式传 `"proxy": "direct"`。
3. **没有代理预检**。官方打开前会验代理连通性，本工具不做，代理挂了照开。

完整清单见 `MANUAL-zh.md` 第六部分（五个坑）。

## 验证

```powershell
node scripts\verify-profile.mjs --name probe --locale pt-BR --screen 1920x1080
```

建档案 → 打开 → CDP 逐项比对指纹 → 自动清理，**9 项断言全过才 exit 0**。

## 边界

**已解除**：窗口数量上限、本地并发闸门、指纹注入（时区/语言/分辨率/GPU/硬件并发/canvas 隔离）、
代理、官方 automation-control 扩展。

**不具备**：云同步（Cookie/书签/localStorage 不上传）、官方工作台可见性、服务端记录、
代理预检、跨 OS 伪装（只随机 Win10/Win11）。

## 免责声明

本文档与脚本**仅供技术学习与研究使用**，与 RoxyBrowser 官方无任何关联、未获官方授权或许可。

- 所述做法**可能违反该软件的用户协议**，使用可能导致账号被封禁、订阅失效或本地数据丢失
- 请仅在**你自己拥有、或已获得明确书面授权**的设备与账号上操作；
  **用于商业用途前，请购买对应的软件授权与窗口额度**
- 按"现状"提供，不附带任何明示或暗示的担保；作者不对因使用本工具包造成的任何直接或间接损失负责
- 文中技术细节的目的是理解反检测浏览器的实现原理，
  **请勿用于违反所在地区法律法规或第三方平台规则的用途**
- 若官方认为内容不妥，请联系删除

**使用本工具包即表示你已理解并接受以上条款。**

*个人技术研究笔记，非官方出版物。*

许可条款见 [LICENSE](LICENSE)（Educational Use Only：允许学习研究使用，
**不授予商业用途授权**，亦不授予任何规避付费授权的商业性使用权利）。
