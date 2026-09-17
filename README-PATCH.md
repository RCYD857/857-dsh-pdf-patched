# dsh-pdf 插件优化补丁 (原 @zhtx2026/dsh-pdf 0.1.1 → 857-dsh-pdf-patched 0.1.1+dsl1)

日期：2026-09-16　安装位置：`%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\@zhtx2026\dsh-pdf`

## 为什么改

同一份 Word/WPS 导出的 PDF（WM03P41M 规格书）在插件上表现为「文本全空 + 渲染全白」，实测 12 份样本里有 4 份中招。三个独立缺陷（都已定位到行并可复现）：

1. **对象解析器被「R 后面没空格」打穿（致命，白页 + 空文本的元凶）**
   `lib/pdf-core.js` 原先按空白切 token。Word/WPS 会写 `/Contents 907 0 R/Group<<...>>`（`R` 紧贴 `/Key`），旧逻辑把 `R/Group<<…>>/MediaBox[0` 当成一个 token 吞掉，
   页面字典因此丢掉 `Contents`/`Resources`/`MediaBox`：
   - `getPages()` 返回 `[3,84,92,100,3]`（5 项、首页重复）
   - 页面字典只剩 `{Annots,Parent,Tabs,Type}`
   - 渲染退化成兜底 MediaBox `[0,0,1198.4,848.4]` → 2397x1697 全白（4 页 sha256 完全相同）
   - 文本提取 5 页全空
   同类问题让嘉立创丝印 PDF 的 `/Kids[7 0 R]` 解析崩坏，直接报 `no pages found`。
2. **引擎选择判据错了**：原逻辑是「字体全内嵌 → pdfjs，否则 → 自研解析器」。但 pdfjs 的**文本提取**对这份文件完全正常（第 1 页 189 项 / 903 字符），
   却被绕过；而自研解析器又正因为第 1 条而全空。
3. **pdfjs 渲染会把 NUL 传给画布**：未内嵌 CID 字体让 pdfjs 调 `ctx.measureText("\u0000")`，`@napi-rs/canvas` 抛
   `Convert String to CString failed`，且实测还会**段错误**（exit 0xC0000005）——原插件从不在这类文件上走 pdfjs，所以从未暴露。

## 改了什么

| 层 | 改动 |
|---|---|
| P0 解析器 | 重写词法/取值解析：按 PDF 定界符（含 `/()<>[]{}`）切分、识别 `N G R` 间接引用、容忍 `R/Key` 与 `R]`；新增 ObjStm 对象流展开（PDF 1.5+）与页树属性继承（Resources/MediaBox/CropBox/Rotate）+ 访问去重 |
| P1 文本 | `extractText` 改为 **pdfjs 优先**，产出为空或抛错才回退自研解析器；自研解析器重写为完整内容流算子解释器（CTM/Tm/Td/TD/T*/Tj/TJ/Do/图形算子），坐标是真实页面坐标 |
| P2 渲染 | 画布入参清洗 NUL 等控制字符；`auto` 策略改为「字体全内嵌 → pdfjs；存在未内嵌字体 → **hybrid**（子进程 pdfjs 画图形 + 自研解释器只在未内嵌字体上叠文字）」；子进程崩了自动回退 sysfont；sysfont 补 CTM/文字矩阵、Form XObject 递归、图像解码、MediaBox 原点与 /Rotate |

新增文件：`lib/render-child.mjs`（子进程光栅化助手，避免原生崩溃拖垮 DSH 宿主）。

## 验证（12 份本机样本，改动前后对照）

- **修好 4 份**（原为空白/报错）：
  - WM03P41M 规格书：文本 0 → 4683 字符（4 页），渲染 2397x1697 全白 → 1191x1684 有内容（hybrid）
  - 三星 IR-Short FAR 报告：0 → 4687 字符，渲染空白 → 1560x1080
  - CH341 英文手册：0 → 1062 字符，渲染空白 → 1191x1684
  - 嘉立创丝印 PDF：`no pages found` → 正常出图 1190x1684
- **零回归 8 份**（GSD 报告等，字体全内嵌）：文本字符数与渲染尺寸/非白像素比与改动前**完全一致**（同一 sha256）。
- 安装副本在独立 Node 进程复跑通过：`extractText` 4 页 4683 字符、`renderPage` engine=hybrid 1191x1684、`pdfInfo` 4 页 21 字体。

## 已知局限（诚实记录）

- hybrid 的图形层来自 pdfjs，而 **pdfjs 自己**会把 Form XObject 里的绘图标签（`SOT-23`、`Device symbol` 等）画到偏位；这不是本次改动引入的（纯 pdfjs 渲染同样如此）。
- 叠加层是按 `Tj/TJ` 分块定位的，缺字宽信息时字距会有细微漂移（`Appl i cat i ons` 这类）。
- 纯 `sysfont` 引擎（仅在 hybrid/pdfjs 都失败时兜底）路径层仍有粗黑边块（Form BBox 未裁剪），文本层正常。
- 想要 100% 还原版面，可用 Windows 自带 `Windows.Data.Pdf`（WinRT）光栅化：`E:\DSH\.pdf-probe\winrt-render.ps1`。

## 重装 / 回滚

插件升级会覆盖这些文件。升级后重新应用：

```powershell
# 需管理员或允许写入 %APPDATA% 的权限
powershell -NoProfile -ExecutionPolicy Bypass -File E:\DSH\dsh-pdf-patch\install-patch.ps1
```

回滚：把 `pdf-core.orig.js` 复制回插件 `lib/pdf-core.js`，并删除 `lib/render-child.mjs`。

备份与原始文件：`E:\DSH\dsh-pdf-patch\pdf-core.orig.js`（sha256 5FF1CFAB…317E）、
`index.orig.js`；补丁后文件 `pdf-core.patched.js`（sha256 EC5489E9…08E1）、`render-child.mjs`。
