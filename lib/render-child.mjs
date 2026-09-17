// render-child.mjs — 在独立子进程里用 pdfjs 光栅化一页, 避免原生崩溃拖垮 DSH 宿主进程。
// 用法: node render-child.mjs <pdf> <page> <scale> <out.png>
import fs from 'node:fs';
import { renderPdfjsToFile } from './pdf-core.js';

const [file, pageRaw, scaleRaw, out] = process.argv.slice(2);
const page = Number(pageRaw) || 1;
const scale = Number(scaleRaw) || 2;
try {
  await renderPdfjsToFile(file, page, scale, out);
  process.exit(0);
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exit(2);
}
