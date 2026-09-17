# 857-dsh-pdf-patched

> PDF parsing toolkit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — three agent-facing tools (`pdf_info` / `pdf_extract_text` / `pdf_render_page`) with hybrid engines, including system-font rendering for PDFs with non-embedded CJK fonts (e.g. EasyEDA / JLC EDA schematic exports).

[English](README.md) | [中文](README.zh.md)

**Tags:** `dsh-plugin` · `pdf` · `pdfjs` · `canvas` · `schematic` · `tools`

## Install

```sh
dsh plugin --profile web add github:RCYD857/857-dsh-pdf-patched
```

Or from a local checkout during development:

```sh
dsh plugin --profile web add link:<path-to-repo>
```

Then restart DSH (or open a new session) — the three tools and an agent guidance block become available.

## Tools

| Tool | What it does |
|---|---|
| `pdf_info` | Page count, page sizes (pt), document metadata, and the font list with per-font `embedded` flags. |
| `pdf_extract_text` | Extracts text per page; optional `page` and `withPosition` (per-line x/y coordinates + font size). |
| `pdf_render_page` | Renders one page to a PNG (local file) with configurable `scale`/`outDir`; engine auto-selection. |

## Why a custom renderer?

pdfjs-dist cannot render text in PDFs whose fonts are not embedded and lack a
`ToUnicode` map — the classic case is **JLC EDA / EasyEDA schematic exports**
(SimSun/SimHei `Type0` fonts with `UniGB-UCS2-H` encoding): pdfjs emits
`translateFont failed` and drops the glyphs.

dsh-pdf solves this with a two-engine design:

- **pdfjs engine** — used when *all* fonts are embedded (standard PDFs).
- **sysfont engine** — a built-in content-stream renderer that decodes the
  PDF text operators (`BT/ET`, `Tf`, `Tm`, `Td`, `Tj`, `TJ`) itself, maps
  `UniGB-UCS2-H`/UTF-16BE strings to Unicode, and draws them with **system
  fonts** (`SimSun`, `SimHei`, `Microsoft YaHei`, …) via `@napi-rs/canvas`.

Text extraction uses the same auto-selection: embedded fonts → pdfjs
text layer; non-embedded fonts → the built-in decoder (which correctly
recovers CJK text pdfjs loses).

## Example

```text
pdf_info("D:/Downloads/SCH_SA-V11A.pdf")
→ 3 pages, A3 landscape, jsPDF producer, 6 fonts (all non-embedded)

pdf_extract_text("D:/Downloads/SCH_SA-V11A.pdf", { page: 1 })
→ net names, pin numbers, and Chinese labels ("主控板", "嘉立创", …)

pdf_render_page("D:/Downloads/SCH_SA-V11A.pdf", { page: 1, scale: 2 })
→ D:/Downloads/SCH_SA-V11A-pages/page-1.png  (2396×1698, engine: sysfont)
```

## Architecture

- `lib/index.js` — cordis plugin entry (`name`, `inject`, `apply`); registers
  the three tools as native tool objects (plain JSON-Schema `parameters` and
  `output` — no `@deepseek-ai/dsh-tools` dependency needed) and injects the
  agent guidance block (`systemPrompt.section`, order 160).
- `lib/pdf-core.js` — self-contained engine: PDF object parser, font scanner,
  pdfjs loading with fs-based `CMapReaderFactory`/`StandardFontDataFactory`
  (Node 24's global `fetch` doesn't speak `file://`), the built-in text
  extractor, and the sysfont renderer.
- `cordis.patch.yml` — the `dsh.bundle.patch` insert row.

## Limitations

- Scanned/image-only PDFs have no text layer — extraction returns nothing
  (rendering still works, as a plain image).
- The sysfont renderer assumes `Type0` CID codes equal Unicode code points
  (true for `UniGB-UCS2-H` exports); exotic CID fonts fall back to pdfjs.
- Large PDFs are parsed fully into memory.

## License

[MIT](LICENSE)
