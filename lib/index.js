// dsh-pdf 宿主半部分: cordis 插件入口, 注册三个模型可见工具。
// 无浏览器半部分 (无 dsh.client), 工具在宿主进程内直接读写本地 PDF。
import { pdfInfo, extractText, renderPage } from './pdf-core.js';

/** 稳定 cordis 插件名。 */
export const name = "pdf";
/** 所需服务: tools(工具注册) + systemPrompt(agent 公告)。 */
export const inject = ["tools", "systemPrompt"];

/** 单个文本内容块 (这些工具唯一的 render 形态)。 */
function text(value) {
  return [{ type: "text", text: String(value) }];
}

/** 模型可见公告: 插件能力与限制。 */
const PDF_GUIDANCE = "本机已安装 dsh-pdf 插件（DSH PDF 解析）：提供 pdf_info / pdf_extract_text / pdf_render_page 三个工具。能力：pdf_info 读取页数、页面尺寸、元数据、字体列表及是否内嵌；pdf_extract_text 提取文字（可按页、可带坐标，中文 PDF 依赖 cmaps 解码）；pdf_render_page 把页面渲染成 PNG 并返回本地路径（所有字体已内嵌时用 pdfjs 引擎，存在未内嵌字体时自动切换自研系统字体引擎，适配嘉立创EDA导出的原理图）。限制：不识别图片型扫描件（无文字层则提不到文字，渲染也只是原图）；产物为本地 PNG 文件；超大 PDF 解析耗时较长。用户提到「PDF / 原理图 / 解析 PDF / 提取 PDF 文字 / 渲染 PDF 页面」时即指本插件，请据此协作。";

const TEXT_TIMEOUT_MS = 180000;
const RENDER_TIMEOUT_MS = 180000;

// ---------- 工具定义 (原生对象 + JSON Schema, 无需 @deepseek-ai/dsh-tools) ----------
const pdfInfoTool = {
  name: "pdf_info",
  description: "Read PDF metadata: page count, page sizes, document info, and the font list with an embedded flag for each font. Triggers: PDF info, inspect PDF, check PDF fonts, page count.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the local PDF file." }
    },
    required: ["path"]
  },
  output: {
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pageCount: { type: "integer" },
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              num: { type: "integer" },
              width: { type: "number" },
              height: { type: "number" }
            }
          }
        },
        metadata: { type: "object" },
        fonts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              subtype: { type: "string" },
              encoding: { type: "string" },
              embedded: { type: "boolean" }
            }
          }
        },
        error: { type: "string" }
      }
    },
    render: (_args, value) => {
      if (value.error) return text('error: ' + value.error);
      const lines = [
        `path: ${value.path}`,
        `pages: ${value.pageCount}`,
        ...(value.pages || []).map(p => `  page ${p.num}: ${p.width} x ${p.height} pt`),
        `metadata: ${Object.entries(value.metadata || {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`,
        `fonts:`
      ];
      for (const f of value.fonts || []) {
        lines.push(`  ${f.name} (${f.subtype}${f.encoding !== '?' ? ', ' + f.encoding : ''}) embedded=${f.embedded}`);
      }
      return text(lines.join('\n'));
    }
  },
  timeoutMs: 60000,
  async execute(args) {
    try {
      const info = await pdfInfo(args.path);
      return { path: args.path, ...info };
    } catch (err) {
      return { path: args.path, error: String(err && err.message || err) };
    }
  }
};

const pdfExtractTextTool = {
  name: "pdf_extract_text",
  description: "Extract text from a local PDF. By default returns one entry per page with the page text; withPosition also returns per-line coordinates (y/x in PDF units, y up from the page bottom). Triggers: PDF text, read PDF, extract PDF content, parse PDF.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the local PDF file." },
      page: { type: "integer", description: "Optional 1-based page number; default: all pages." },
      withPosition: { type: "boolean", description: "Also return per-line x/y coordinates and font size." }
    },
    required: ["path"]
  },
  output: {
    schema: {
      type: "object",
      properties: {
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              num: { type: "integer" },
              text: { type: "string" },
              rows: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    y: { type: "number" },
                    text: { type: "string" },
                    lines: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          text: { type: "string" },
                          x: { type: "number" },
                          y: { type: "number" },
                          size: { type: "number" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        error: { type: "string" }
      }
    },
    render: (_args, value) => {
      if (value.error) return text('error: ' + value.error);
      return text((value.pages || []).map(p => `========== PAGE ${p.num} ==========\n${p.text}`).join('\n'));
    }
  },
  timeoutMs: TEXT_TIMEOUT_MS,
  async execute(args) {
    try {
      return await extractText(args.path, { page: args.page ?? null, withPosition: !!args.withPosition });
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  }
};

const pdfRenderPageTool = {
  name: "pdf_render_page",
  description: "Render one page of a local PDF to a PNG file and return its local path. Engine auto-selects: pdfjs when all fonts are embedded, otherwise a system-font renderer (for PDFs with non-embedded fonts, e.g. EasyEDA exports). Triggers: render PDF page, PDF to image, view PDF page.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the local PDF file." },
      page: { type: "integer", description: "1-based page number, default 1." },
      scale: { type: "number", description: "Render scale relative to the PDF page size, default 2." },
      outDir: { type: "string", description: "Output directory; default: <pdf-dir>/<basename>-pages/." },
      engine: { type: "string", enum: ["auto", "pdfjs", "sysfont"], description: "Force a render engine; default auto." }
    },
    required: ["path"]
  },
  output: {
    schema: {
      type: "object",
      properties: {
        page: { type: "integer" },
        path: { type: "string" },
        width: { type: "integer" },
        height: { type: "integer" },
        engine: { type: "string" },
        error: { type: "string" }
      }
    },
    render: (_args, value) => {
      if (value.error) return text('error: ' + value.error);
      return text(`page ${value.page}: ${value.width}x${value.height} (${value.engine}) -> ${value.path}`);
    }
  },
  timeoutMs: RENDER_TIMEOUT_MS,
  async execute(args) {
    try {
      return await renderPage(args.path, {
        page: args.page ?? 1,
        scale: typeof args.scale === 'number' && args.scale > 0 ? args.scale : 2,
        outDir: args.outDir ?? null,
        engine: args.engine ?? 'auto'
      });
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  }
};

/**
 * 挂载 PDF 工具与 agent 公告。
 * @param ctx - 宿主插件上下文, 携带 tools / systemPrompt 服务。
 */
export function apply(ctx) {
  const tools = [pdfInfoTool, pdfExtractTextTool, pdfRenderPageTool];
  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-pdf: tools");
  ctx.effect(() => ctx.systemPrompt.section({
    name: "plugin:dsh-pdf",
    order: 160,
    text: PDF_GUIDANCE
  }), "dsh-pdf: guidance");
}
