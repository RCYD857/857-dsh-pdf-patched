# 这个包是什么

`857-dsh-pdf-patched`（原 `@zhtx2026/dsh-pdf` 的 DSH PDF 解析插件）**本地优化版**，自包含可运行：

- 打包时间：2026-09-16
- 来源：`%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\@zhtx2026\dsh-pdf`（本机已生效的副本）
- 版本：上游 0.1.1 + 本地补丁（P0 解析器 / P1 文本引擎 / P2 渲染引擎，见 `README-PATCH.md`）
- 依赖已随包（已解引用，非软链）：`pdfjs-dist` 4.10.38、`@napi-rs/canvas` 0.1.68 + `@napi-rs/canvas-win32-x64-msvc`（skia 原生二进制）
- 体积：376 个文件 / 约 70 MB

## 目录结构

```
dsh-pdf/
├─ lib/
│  ├─ index.js                     工具层（pdf_info / pdf_extract_text / pdf_render_page 定义，未改动）
│  ├─ pdf-core.js                  优化后的引擎（本次改动的主体）
│  ├─ pdf-core.js.orig-0.1.1       上游原文件（回滚用，sha256 5FF1CFAB…317E）
│  └─ render-child.mjs             新增：子进程光栅化助手
├─ node_modules/                   已随包的运行时依赖
├─ package.json / cordis.patch.yml / README.md / README.zh.md / LICENSE
├─ README-PATCH.md                 本次改动说明（根因、改动点、验证、已知局限）
└─ install-patch.ps1               把补丁写回已安装插件（插件升级覆盖后用它重放）
```

## 怎么用

**A. 当作独立可运行副本（不需要 npm/pnpm）**

```powershell
# 直接把整个 dsh-pdf 目录放到任意位置, 用 Node 直接调用验证
node -e "import('file:///路径/dsh-pdf/lib/pdf-core.js').then(async m => { const t = await m.extractText('目标.pdf', {}); console.log(t.pages.length, '页', t.pages.reduce((s,p)=>s+p.text.length,0), '字符'); })"
```

**B. 覆盖本机已安装的插件（推荐）**

```powershell
# 需要能写 %APPDATA% 的权限
$dst = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web\node_modules\@zhtx2026\dsh-pdf'
Copy-Item '.\dsh-pdf\lib\pdf-core.js'        (Join-Path $dst 'lib\pdf-core.js') -Force
Copy-Item '.\dsh-pdf\lib\render-child.mjs'   (Join-Path $dst 'lib\render-child.mjs') -Force
# 然后重启 DSH 服务（托盘菜单「重启服务」）
```

**C. 单纯回滚**：把 `lib\pdf-core.js.orig-0.1.1` 复制成 `lib\pdf-core.js`，删掉 `lib\render-child.mjs`，重启 DSH。

## 已验收的行为（2026-09-16）

| 样本 | 改动前 | 改动后 |
|---|---|---|
| WM03P41M 规格书（未内嵌字体） | 文本 0 字符 / 渲染 2397x1697 全白 | 4683 字符 / 1191x1684 有内容（hybrid） |
| 三星 IR-Short FAR 报告 | 0 字符 / 全白 | 4687 字符 / 1560x1080 |
| CH341 英文手册 | 0 字符 / 全白 | 1062 字符 / 1191x1684 |
| 嘉立创丝印 PDF | `no pages found` | 正常出图 1190x1684 |
| GSD 报告等 8 份（字体全内嵌） | — | 文本与渲染 sha256 **完全一致**（零回归） |
| TPV EK86752 FA 报告（7 页 PPT 版式） | — | 2032 字符 / 7 页 hybrid 出图，文件名含 U+00A0 需按精确字符调用 |

## 已知局限

见 `README-PATCH.md` 末尾「已知局限」：pdfjs 自身会把 Form XObject 内的标签画偏位；hybrid 叠加层字距有轻微漂移；纯 sysfont 兜底路径层仍有黑边块（文本层正常）。
