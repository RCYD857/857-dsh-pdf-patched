# 857-dsh-pdf-patched

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 PDF 解析工具集 — 提供 `pdf_info` / `pdf_extract_text` / `pdf_render_page` 三个模型可见工具，双引擎架构，未内嵌中文字体的 PDF（如嘉立创 EDA / EasyEDA 导出的原理图）自动切换系统字体渲染。

[English](README.md) | [中文](README.zh.md)

**标签:** `dsh-plugin` · `pdf` · `pdfjs` · `canvas` · `schematic` · `tools`

## 安装

```sh
dsh plugin --profile web add github:RCYD857/857-dsh-pdf-patched
```

开发期可从本地源码安装：

```sh
dsh plugin --profile web add link:<路径>
```

重启 DSH（或开新会话）后生效，同时注入中文协作公告。

## 工具

| 工具 | 能力 |
|---|---|
| `pdf_info` | 页数、页面尺寸（pt）、文档元数据、字体列表及每项 `embedded` 内嵌标记。 |
| `pdf_extract_text` | 按页提取文字；可选 `page` 与 `withPosition`（每行 x/y 坐标 + 字号）。 |
| `pdf_render_page` | 把一页渲染为本地 PNG；`scale`/`outDir` 可配；渲染引擎自动选择。 |

## 为什么需要自研渲染器

pdfjs-dist 无法渲染「字体未内嵌且无 ToUnicode 映射」的 PDF 文字 —— 典型就是
**嘉立创 EDA / EasyEDA 导出的原理图**（SimSun/SimHei `Type0` 字体、
`UniGB-UCS2-H` 编码）：pdfjs 会报 `translateFont failed` 并丢字。

dsh-pdf 用双引擎解决：

- **pdfjs 引擎** — 字体全部内嵌时使用（常规 PDF）。
- **sysfont 引擎** — 自研内容流渲染器：自己解析文本算子
  （`BT/ET`、`Tf`、`Tm`、`Td`、`Tj`、`TJ`），把 `UniGB-UCS2-H`/UTF-16BE
  串解码为 Unicode，再经 `@napi-rs/canvas` 用**系统字体**（宋体、黑体、
  微软雅黑……）绘制。

文字提取同样自动选择：字体全内嵌 → pdfjs 文本层；存在未内嵌字体 →
自研解码器（正确还原 pdfjs 会丢失的中文）。

## 示例

```text
pdf_info("D:/Downloads/SCH_SA-V11A.pdf")
→ 3 页、A3 横向、jsPDF 生成、6 个字体（全部未内嵌）

pdf_extract_text("D:/Downloads/SCH_SA-V11A.pdf", { page: 1 })
→ 网络名、引脚号、中文标签（"主控板"、"嘉立创"……）

pdf_render_page("D:/Downloads/SCH_SA-V11A.pdf", { page: 1, scale: 2 })
→ D:/Downloads/SCH_SA-V11A-pages/page-1.png （2396×1698，engine: sysfont）
```

## 架构

- `lib/index.js` — cordis 插件入口（`name`、`inject`、`apply`）；以原生工具
  对象注册三个工具（标准 JSON-Schema `parameters`/`output`，无需依赖
  `@deepseek-ai/dsh-tools`），并注入中文协作公告（`systemPrompt.section`，
  order 160）。
- `lib/pdf-core.js` — 自包含引擎：PDF 对象解析器、字体扫描、基于 fs 的
  `CMapReaderFactory`/`StandardFontDataFactory` 加载 pdfjs（Node 24 全局
  `fetch` 不支持 `file://`）、自研文本提取器、sysfont 渲染器。
- `cordis.patch.yml` — `dsh.bundle.patch` 插入行。

## 限制

- 扫描件/纯图片 PDF 无文字层，提取不到文字（渲染仍可用，等同原图）。
- sysfont 渲染器假设 `Type0` 的 CID 即 Unicode 码点（`UniGB-UCS2-H` 导出
  成立）；特殊 CID 字体回退 pdfjs。
- 大文件整份读入内存解析。

## 许可证

[MIT](LICENSE)
