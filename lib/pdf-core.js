// pdf-core.js — dsh-pdf 插件引擎 (优化版 v2)
// P0 对象解析器重写 / P1 文本引擎 / P2 渲染引擎, 详见文件末尾注释块。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.dirname(HERE);
const PDFJS_URL = pathToFileURL(path.join(PKG_ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href;
const CMAPS_DIR = path.join(PKG_ROOT, 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const STDFONTS_DIR = path.join(PKG_ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep;
const CANVAS_URL = pathToFileURL(path.join(PKG_ROOT, 'node_modules', '@napi-rs', 'canvas', 'index.js')).href;

const pdfjs = await import(PDFJS_URL);
const canvasMod = await import(CANVAS_URL);
const { createCanvas, GlobalFonts, loadImage } = canvasMod;

const FONT_FILES = [
  'C:/Windows/Fonts/simsun.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/simfang.ttf',
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/times.ttf',
  'C:/Windows/Fonts/cour.ttf',
];
const REGISTERED = new Set();
if (GlobalFonts) {
  for (const f of FONT_FILES) {
    if (!fs.existsSync(f)) continue;
    try {
      for (const fam of GlobalFonts.registerFromPath(f)) {
        if (fam && fam.family) REGISTERED.add(fam.family);
      }
    } catch { /* skip */ }
  }
}

function pdfFontToFamily(baseFont) {
  const n = (baseFont || '').replace(/[+#,]/g, ' ').trim().toLowerCase();
  const map = [
    [/simsun|song|宋体|sun/, ['SimSun', '宋体']],
    [/simhei|hei|黑体/, ['SimHei', '黑体']],
    [/yahei|microsoft yahei|msyh/, ['Microsoft YaHei', '微软雅黑']],
    [/kaiti|kai/, ['KaiTi', '楷体']],
    [/fangsong/, ['FangSong', '仿宋']],
    [/times|serif/, ['Times New Roman']],
    [/courier|mono/, ['Courier New']],
    [/arial|helvetica|sans/, ['Arial']],
  ];
  for (const [re, candidates] of map) {
    if (re.test(n)) {
      for (const c of candidates) {
        for (const reg of REGISTERED) {
          if (reg.toLowerCase() === c.toLowerCase() || reg.toLowerCase().startsWith(c.toLowerCase() + ' ')) return reg;
        }
      }
      return candidates[0];
    }
  }
  return 'Arial';
}
// ---------- P0: PDF 词法器 (符合 PDF 定界符规则) ----------
const WS_CHARS = ' \t\r\n\f\0';
const DELIM_CHARS = '()<>[]{}/%';
const isWsChar = (c) => c !== undefined && WS_CHARS.indexOf(c) >= 0;
const isDelimChar = (c) => c !== undefined && DELIM_CHARS.indexOf(c) >= 0;
const NUM_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;

function skipWs(raw, i) {
  while (i < raw.length) {
    const c = raw[i];
    if (isWsChar(c)) { i++; continue; }
    if (c === '%') { while (i < raw.length && raw[i] !== '\n' && raw[i] !== '\r') i++; continue; }
    break;
  }
  return i;
}

function readToken(raw, i) {
  const start = i;
  while (i < raw.length && !isWsChar(raw[i]) && !isDelimChar(raw[i])) i++;
  return { text: raw.slice(start, i), next: i };
}

function readNameAt(raw, i) {
  i++;
  let name = '';
  while (i < raw.length && !isWsChar(raw[i]) && !isDelimChar(raw[i])) {
    if (raw[i] === '#' && i + 2 < raw.length && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
      name += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 3;
    } else { name += raw[i]; i++; }
  }
  return { value: name, next: i, isName: true };
}

function readLiteralStringAt(raw, i) {
  i++;
  let depth = 1;
  const bytes = [];
  while (i < raw.length && depth > 0) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if (n === 'n') { bytes.push(10); i += 2; }
      else if (n === 'r') { bytes.push(13); i += 2; }
      else if (n === 't') { bytes.push(9); i += 2; }
      else if (n === 'b') { bytes.push(8); i += 2; }
      else if (n === 'f') { bytes.push(12); i += 2; }
      else if (n === '\n') { i += 2; }
      else if (n === '\r') { i += raw[i + 2] === '\n' ? 3 : 2; }
      else if (n >= '0' && n <= '7') {
        let oct = '';
        let k = i + 1;
        while (k < raw.length && oct.length < 3 && raw[k] >= '0' && raw[k] <= '7') { oct += raw[k]; k++; }
        bytes.push(parseInt(oct, 8) & 0xff);
        i = k;
      } else if (n !== undefined) { bytes.push(n.charCodeAt(0) & 0xff); i += 2; }
      else { i++; }
      continue;
    }
    if (c === '(') { depth++; bytes.push(40); i++; continue; }
    if (c === ')') { depth--; if (depth > 0) bytes.push(41); i++; continue; }
    bytes.push(c.charCodeAt(0) & 0xff);
    i++;
  }
  return { value: { __bytes: Buffer.from(bytes) }, next: i };
}

function readHexStringAt(raw, i) {
  i++;
  let hex = '';
  while (i < raw.length && raw[i] !== '>') { if (!isWsChar(raw[i])) hex += raw[i]; i++; }
  i++;
  if (hex.length % 2) hex += '0';
  return { value: { __hex: hex }, next: i };
}
function readArrayAt(raw, i) {
  i++;
  const arr = [];
  while (i < raw.length) {
    i = skipWs(raw, i);
    if (i >= raw.length) break;
    if (raw[i] === ']') { i++; break; }
    const v = parseValueAt(raw, i);
    arr.push(v.value);
    i = v.next;
    if (v.eof) break;
  }
  return { value: arr, next: i };
}

function readDictAt(raw, i) {
  i += 2;
  const dict = {};
  while (i < raw.length) {
    i = skipWs(raw, i);
    if (i >= raw.length) break;
    if (raw[i] === '>' && raw[i + 1] === '>') { i += 2; break; }
    const key = parseValueAt(raw, i);
    i = key.next;
    if (key.isName !== true || typeof key.value !== 'string') continue;
    const val = parseValueAt(raw, i);
    i = val.next;
    dict[key.value] = val.value;
    if (val.eof) break;
  }
  return { value: dict, next: i };
}

function parseValueAt(raw, i) {
  i = skipWs(raw, i);
  if (i >= raw.length) return { value: null, next: i, eof: true };
  const c = raw[i];
  if (c === '/') return readNameAt(raw, i);
  if (c === '(') return readLiteralStringAt(raw, i);
  if (c === '<') return raw[i + 1] === '<' ? readDictAt(raw, i) : readHexStringAt(raw, i);
  if (c === '[') return readArrayAt(raw, i);
  if (c === ']' || c === '>' || c === ')' || c === '}' || c === '{') return { value: null, next: i + 1 };
  const tk = readToken(raw, i);
  if (tk.text === '') return { value: null, next: i + 1 };
  if (NUM_RE.test(tk.text)) {
    const num = parseFloat(tk.text);
    if (/^\d+$/.test(tk.text)) {
      const j = skipWs(raw, tk.next);
      const t2 = readToken(raw, j);
      if (/^\d+$/.test(t2.text)) {
        const k = skipWs(raw, t2.next);
        const t3 = readToken(raw, k);
        if (t3.text === 'R') return { value: { __num: tk.text }, next: t3.next };
      }
    }
    return { value: num, next: tk.next };
  }
  if (tk.text === 'true') return { value: true, next: tk.next };
  if (tk.text === 'false') return { value: false, next: tk.next };
  if (tk.text === 'null') return { value: null, next: tk.next };
  return { value: tk.text, next: tk.next };
}

function parseDictTolerant(raw, startIdx) {
  try {
    const v = parseValueAt(raw, startIdx);
    return (v.value && typeof v.value === 'object' && !Array.isArray(v.value)) ? v.value : null;
  } catch { return null; }
}

const refNumOf = (v) => {
  if (v && typeof v === 'object' && v.__num !== undefined) return parseInt(v.__num, 10);
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
};

function decodeTextValue(v) {
  if (v && typeof v === 'object' && v.__bytes) return v.__bytes;
  if (v && typeof v === 'object' && v.__hex) {
    let h = v.__hex;
    if (h.length % 2) h += '0';
    return Buffer.from(h, 'hex');
  }
  if (typeof v === 'string') return Buffer.from(v, 'latin1');
  return Buffer.alloc(0);
}

function toNumberArray(v) {
  if (!Array.isArray(v)) return null;
  const nums = v.filter(x => typeof x === 'number' && Number.isFinite(x));
  return nums.length >= 4 ? nums : null;
}

function decodeAscii85(text) {
  const clean = text.replace(/\s/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const out = [];
  let acc = 0;
  let n = 0;
  for (const ch of clean) {
    if (ch === 'z' && n === 0) { out.push(0, 0, 0, 0); continue; }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    acc = acc * 85 + code;
    n++;
    if (n === 5) {
      out.push((acc >>> 24) & 0xff, (acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff);
      acc = 0; n = 0;
    }
  }
  if (n > 0) {
    for (let k = n; k < 5; k++) acc = acc * 85 + 84;
    const bytes = [(acc >>> 24) & 0xff, (acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff];
    for (let k = 0; k < n - 1; k++) out.push(bytes[k]);
  }
  return out;
}

function normCode(hexStr) {
  return parseInt(hexStr, 16).toString(16);
}

function hexToUnicode(hexStr) {
  let out = '';
  for (let i = 0; i + 3 < hexStr.length; i += 4) {
    const cu = parseInt(hexStr.slice(i, i + 4), 16);
    if (Number.isFinite(cu)) out += String.fromCharCode(cu);
  }
  return out;
}

function parseCMap(text) {
  const map = {};
  let m;
  const bf = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bf.exec(text)) !== null) {
    const pr = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let p;
    while ((p = pr.exec(m[1])) !== null) map[normCode(p[1])] = hexToUnicode(p[2]);
  }
  const br = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = br.exec(text)) !== null) {
    const body = m[1];
    const arrRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
    let p;
    while ((p = arrRe.exec(body)) !== null) {
      const lo = parseInt(p[1], 16);
      const items = p[3].match(/<[0-9a-fA-F]*>/g) || [];
      for (let k = 0; k < items.length; k++) map[normCode((lo + k).toString(16))] = hexToUnicode(items[k].slice(1, -1));
    }
    const oneRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    while ((p = oneRe.exec(body)) !== null) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const dst = parseInt(p[3], 16);
      for (let c = lo; c <= hi && c - lo < 65536; c++) map[normCode(c.toString(16))] = String.fromCodePoint(dst + (c - lo));
    }
  }
  return map;
}
function parsePdfObjects(buf) {
  const ascii = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  const heads = [];
  while ((m = re.exec(ascii)) !== null) heads.push({ num: parseInt(m[1], 10), headEnd: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const nextIdx = i + 1 < heads.length ? heads[i + 1].headEnd : ascii.length;
    const stop = Math.max(nextIdx, h.headEnd);
    objs.set(h.num, { num: h.num, gen: 0, start: h.headEnd, raw: h.num + ' 0 obj' + ascii.slice(h.headEnd, stop) });
  }
  const objBody = (o) => o.raw.slice(o.raw.indexOf('obj') + 3);

  function streamDataOfObj(o) {
    const sIdx = o.raw.indexOf('stream');
    if (sIdx < 0) return null;
    let start = sIdx + 6;
    if (o.raw[start] === '\r') start++;
    if (o.raw[start] === '\n') start++;
    const eIdx = o.raw.lastIndexOf('endstream');
    if (eIdx < 0 || eIdx < start) return null;
    let end = eIdx;
    while (end > start && (o.raw[end - 1] === '\n' || o.raw[end - 1] === '\r')) end--;
    let data = Buffer.from(o.raw.slice(start, end), 'latin1');
    const d = parseDictTolerant(objBody(o).slice(0, sIdx), 0) || {};
    const filters = Array.isArray(d.Filter) ? d.Filter : (d.Filter !== undefined ? [d.Filter] : []);
    for (const f of filters) {
      if (f === 'FlateDecode' || f === 'Fl') {
        try { data = zlib.inflateSync(data); }
        catch { try { data = zlib.inflateRawSync(data); } catch { return null; } }
      } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
        data = Buffer.from(data.toString('latin1').replace(/[^0-9a-fA-F]/g, ''), 'hex');
      } else if (f === 'ASCII85Decode' || f === 'A85') {
        try { data = Buffer.from(decodeAscii85(data.toString('latin1'))); } catch { return null; }
      }
    }
    return { data, dict: d };
  }

  function buildToUnicode(mapObj) {
    const num = refNumOf(mapObj);
    const so = num !== null ? objs.get(num) : null;
    if (!so) return null;
    const sd = streamDataOfObj(so);
    if (!sd || !sd.data) return null;
    return parseCMap(sd.data.toString('latin1'));
  }

  function expandObjectStreams() {
    for (const o of [...objs.values()]) {
      if (o.raw.indexOf('stream') < 0) continue;
      const d = parseDictTolerant(objBody(o), 0);
      if (!d || d.Type !== 'ObjStm') continue;
      const sd = streamDataOfObj(o);
      if (!sd || !sd.data) continue;
      const n = Number(d.N) || 0;
      const first = Number(d.First) || 0;
      const head = sd.data.slice(0, first).toString('latin1');
      const nums = head.match(/\d+/g) || [];
      for (let k = 0; k < n; k++) {
        const objNum = parseInt(nums[2 * k], 10);
        const off = parseInt(nums[2 * k + 1], 10);
        if (!Number.isFinite(objNum) || !Number.isFinite(off)) continue;
        const nextOff = (2 * (k + 1) + 1 < nums.length) ? parseInt(nums[2 * (k + 1) + 1], 10) : (sd.data.length - first);
        const body = sd.data.slice(first + off, first + nextOff).toString('latin1');
        if (!objs.has(objNum)) objs.set(objNum, { num: objNum, gen: 0, start: -1, raw: objNum + ' 0 obj ' + body });
      }
    }
  }

  let pagesRef = null;
  const tm = /\/Root\s+(\d+)\s+\d+\s+R/.exec(ascii);
  if (tm) {
    const rootObj = objs.get(parseInt(tm[1], 10));
    if (rootObj) {
      const rd = parseDictTolerant(objBody(rootObj), 0);
      const pr = rd ? refNumOf(rd.Pages) : null;
      if (pr !== null) pagesRef = pr;
    }
  }

  function getPages() {
    const out = [];
    if (pagesRef === null) return out;
    const seen = new Set();
    const walk = (num, inherited) => {
      if (seen.has(num)) return;
      seen.add(num);
      const o = objs.get(num);
      if (!o) return;
      const d = parseDictTolerant(objBody(o), 0);
      if (!d) return;
      const inh = {
        Resources: d.Resources !== undefined ? d.Resources : inherited.Resources,
        MediaBox: d.MediaBox !== undefined ? d.MediaBox : inherited.MediaBox,
        CropBox: d.CropBox !== undefined ? d.CropBox : inherited.CropBox,
        Rotate: d.Rotate !== undefined ? d.Rotate : inherited.Rotate,
      };
      const kids = d.Kids !== undefined ? (Array.isArray(d.Kids) ? d.Kids : [d.Kids]) : null;
      if (kids || d.Type === 'Pages') {
        for (const k of (kids || [])) {
          const kn = refNumOf(k);
          if (kn !== null) walk(kn, inh);
        }
        return;
      }
      out.push({ num, dict: d, inherited: inh, resources: inh.Resources, mediaBox: toNumberArray(inh.MediaBox), rotate: Number(inh.Rotate) || 0 });
    };
    walk(pagesRef, {});
    return out;
  }

  const api = {
    objs, objBody, ascii,
    parseDict: (raw, startIdx) => (parseDictTolerant(raw, startIdx) || {}),
    enrichDict: (d) => d,
    resolveRef: (v) => {
      const n = refNumOf(v);
      return n !== null ? (objs.get(n) || null) : null;
    },
    streamData: streamDataOfObj,
    buildToUnicode,
    decodeTextString: (str) => decodeTextValue(str),
    getPages,
  };
  expandObjectStreams();
  return api;
}

function scanFonts(pdf) {
  const fonts = [];
  for (const o of pdf.objs.values()) {
    let d;
    try { d = pdf.parseDict(pdf.objBody(o), 0); } catch { continue; }
    if (!d || d.Type !== 'Font') continue;
    let embedded = false;
    const checkDesc = (descRef) => {
      const descObj = pdf.resolveRef(descRef);
      if (!descObj) return;
      const dd = pdf.parseDict(pdf.objBody(descObj), 0);
      embedded = embedded || !!(dd && (dd.FontFile || dd.FontFile2 || dd.FontFile3));
    };
    if (d.FontDescriptor !== undefined) checkDesc(d.FontDescriptor);
    if (Array.isArray(d.DescendantFonts)) {
      for (const df of d.DescendantFonts) {
        const dfo = pdf.resolveRef(df);
        if (!dfo) continue;
        const dfd = pdf.parseDict(pdf.objBody(dfo), 0);
        if (dfd && dfd.FontDescriptor !== undefined) checkDesc(dfd.FontDescriptor);
      }
    }
    fonts.push({
      name: d.BaseFont || '?',
      subtype: d.Subtype || '?',
      encoding: typeof d.Encoding === 'string' ? d.Encoding : '?',
      embedded,
    });
  }
  return fonts;
}
// ---------- pdfjs 工厂 ----------
class FsCMapReaderFactory {
  constructor({ baseUrl, isCompressed = true }) {
    this.baseUrl = baseUrl;
    this.isCompressed = isCompressed;
  }
  async fetch({ name }) {
    const file = this.baseUrl + name + (this.isCompressed ? '.bcmap' : '');
    return new Uint8Array(await fs.promises.readFile(file));
  }
}
class FsStandardFontDataFactory {
  constructor({ baseUrl }) { this.baseUrl = baseUrl; }
  async fetch({ filename }) {
    return new Uint8Array(await fs.promises.readFile(this.baseUrl + filename));
  }
}

// P2: pdfjs 会把未内嵌 CID 字体里映射不出的码位当成 NUL 传给画布, @napi-rs/canvas
// 的 measureText/fillText 遇到 NUL 会抛 "Convert String to CString failed" 并直接 abort
// 整个进程 (不可 try/catch)。这里在画布入口把控制字符清洗掉。
const CTRL_RE = /[\u0000-\u001F\u007F]/g;
function sanitizeCanvasText(value) {
  return typeof value === 'string' ? value.replace(CTRL_RE, '') : value;
}
function wrapCanvasContext(ctx) {
  return new Proxy(ctx, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== 'function') return v;
      if (key === 'measureText' || key === 'fillText' || key === 'strokeText') {
        return (...args) => {
          if (args.length > 0) args[0] = sanitizeCanvasText(args[0]);
          return v.apply(target, args);
        };
      }
      return (...args) => v.apply(target, args);
    },
    set(target, key, value) {
      target[key] = key === 'font' ? sanitizeCanvasText(value) : value;
      return true;
    },
  });
}
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = wrapCanvasContext(canvas.getContext('2d'));
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

async function loadDoc(buf) {
  return await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    verbosity: 0,
    useSystemFonts: true,
    cMapUrl: CMAPS_DIR,
    cMapPacked: true,
    CMapReaderFactory: FsCMapReaderFactory,
    standardFontDataUrl: STDFONTS_DIR,
    StandardFontDataFactory: FsStandardFontDataFactory,
    canvasFactory: new NodeCanvasFactory(),
  }).promise;
}

async function pdfInfo(file) {
  const buf = fs.readFileSync(file);
  const pdf = parsePdfObjects(buf);
  const doc = await loadDoc(buf);
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      pages.push({ num: i, width: Math.round(vp.width * 100) / 100, height: Math.round(vp.height * 100) / 100 });
    }
    const meta = await doc.getMetadata();
    const info = meta.info || {};
    return {
      pageCount: doc.numPages,
      pages,
      metadata: {
        title: info.Title || null,
        author: info.Author || null,
        subject: info.Subject || null,
        creator: info.Creator || null,
        producer: info.Producer || null,
        creationDate: info.CreationDate || null,
        modDate: info.ModDate || null,
      },
      fonts: scanFonts(pdf),
    };
  } finally {
    await doc.destroy();
  }
}
// ---------- 内容流解释器 (文本提取与 sysfont 渲染共用) ----------
function mulMatrix(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

function tokenizeContent(raw) {
  const out = [];
  let stack = [];
  let i = 0;
  while (i < raw.length) {
    i = skipWs(raw, i);
    if (i >= raw.length) break;
    const c = raw[i];
    if (c === '/') { const n = readNameAt(raw, i); stack.push({ name: n.value }); i = n.next; continue; }
    if (c === '(') { const s = readLiteralStringAt(raw, i); stack.push(s.value); i = s.next; continue; }
    if (c === '<') {
      if (raw[i + 1] === '<') { const d = readDictAt(raw, i); stack.push({ dict: d.value }); i = d.next; continue; }
      const h = readHexStringAt(raw, i); stack.push(h.value); i = h.next; continue;
    }
    if (c === '[') { const a = readArrayAt(raw, i); stack.push({ array: a.value }); i = a.next; continue; }
    if (c === ']' || c === '>' || c === ')' || c === '{' || c === '}') { i++; continue; }
    const tk = readToken(raw, i);
    if (tk.text === '') { i++; continue; }
    i = tk.next;
    if (NUM_RE.test(tk.text)) { stack.push(parseFloat(tk.text)); continue; }
    if (tk.text === 'true') { stack.push(true); continue; }
    if (tk.text === 'false') { stack.push(false); continue; }
    if (tk.text === 'null') { stack.push(null); continue; }
    if (tk.text === 'BI') {
      const ei = /\bEI\b/.exec(raw.slice(i));
      i = ei ? i + ei.index + 2 : raw.length;
      out.push({ op: 'BI', args: [] });
      stack = [];
      continue;
    }
    out.push({ op: tk.text, args: stack });
    stack = [];
  }
  return out;
}

function resolveDictRef(pdf, value) {
  if (value && typeof value === 'object' && value.__num !== undefined) {
    const o = pdf.resolveRef(value);
    return o ? pdf.parseDict(pdf.objBody(o), 0) : null;
  }
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
}

function buildFontMap(pdf, resources) {
  const fonts = {};
  const res = resolveDictRef(pdf, resources);
  if (!res) return fonts;
  const fontDict = resolveDictRef(pdf, res.Font);
  if (!fontDict) return fonts;
  for (const [key, ref] of Object.entries(fontDict)) {
    const fo = pdf.resolveRef(ref);
    if (!fo) continue;
    const fd = pdf.parseDict(pdf.objBody(fo), 0);
    if (!fd) continue;
    fonts[key] = makeFontEntry(pdf, fd);
  }
  return fonts;
}

function fontIsEmbedded(pdf, fd) {
  const hasFile = (d) => !!(d && (d.FontFile || d.FontFile2 || d.FontFile3));
  const descOf = (ref) => {
    const o = pdf.resolveRef(ref);
    return o ? pdf.parseDict(pdf.objBody(o), 0) : null;
  };
  if (fd.FontDescriptor !== undefined && hasFile(descOf(fd.FontDescriptor))) return true;
  if (Array.isArray(fd.DescendantFonts)) {
    for (const df of fd.DescendantFonts) {
      const dfd = descOf(df);
      if (dfd && dfd.FontDescriptor !== undefined && hasFile(descOf(dfd.FontDescriptor))) return true;
    }
  }
  return false;
}

function makeFontEntry(pdf, fd) {
  const entry = {
    baseFont: fd.BaseFont || '',
    embedded: fontIsEmbedded(pdf, fd),
    subtype: fd.Subtype || '',
    encoding: typeof fd.Encoding === 'string' ? fd.Encoding : '',
    cid: fd.Subtype === 'Type0' || Array.isArray(fd.DescendantFonts),
    toUnicode: fd.ToUnicode !== undefined ? pdf.buildToUnicode(fd.ToUnicode) : null,
    widths: null,
    defaultWidth: 500,
    family: pdfFontToFamily(fd.BaseFont),
  };
  if (Array.isArray(fd.Widths)) {
    const first = Number(fd.FirstChar) || 0;
    const w = {};
    for (let k = 0; k < fd.Widths.length; k++) if (typeof fd.Widths[k] === 'number') w[first + k] = fd.Widths[k];
    entry.widths = w;
  }
  if (entry.cid && Array.isArray(fd.DescendantFonts)) {
    const dfo = pdf.resolveRef(fd.DescendantFonts[0]);
    const dfd = dfo ? pdf.parseDict(pdf.objBody(dfo), 0) : null;
    if (dfd) {
      if (typeof dfd.DW === 'number') entry.defaultWidth = dfd.DW;
      const W = dfd.W;
      if (Array.isArray(W)) {
        const w = {};
        let k = 0;
        while (k < W.length) {
          const first = W[k];
          const second = W[k + 1];
          if (Array.isArray(second)) {
            for (let j = 0; j < second.length; j++) if (typeof second[j] === 'number') w[first + j] = second[j];
            k += 2;
          } else if (typeof second === 'number' && typeof W[k + 2] === 'number') {
            for (let c = first; c <= second && c - first < 65536; c++) w[c] = W[k + 2];
            k += 3;
          } else k += 1;
        }
        entry.widths = w;
      }
    }
  }
  return entry;
}

function decodePdfText(bytes, font) {
  const tu = font && font.toUnicode;
  const twoByte = !!(font && font.cid);
  if (tu) {
    let out = '';
    let hits = 0;
    const step = twoByte ? 2 : 1;
    for (let i = 0; i + step <= bytes.length; i += step) {
      const code = twoByte ? ((bytes[i] << 8) | bytes[i + 1]) : bytes[i];
      const ch = tu[normCode(code.toString(16))];
      if (ch !== undefined) { out += ch; hits++; }
      else if (!twoByte) out += String.fromCharCode(code);
    }
    if (hits > 0) return out;
  }
  if (twoByte && bytes.length >= 2 && bytes.length % 2 === 0) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    const printable = [...out].filter(ch => ch.charCodeAt(0) > 31).length;
    if (out.length > 0 && printable >= out.length * 0.5) return out;
  }
  return bytes.toString('latin1');
}

function textAdvance(font, bytes, size, charSpacing, wordSpacing, hScale) {
  let w = 0;
  const twoByte = !!(font && font.cid);
  const step = twoByte ? 2 : 1;
  for (let i = 0; i + step <= bytes.length; i += step) {
    const code = twoByte ? ((bytes[i] << 8) | bytes[i + 1]) : bytes[i];
    const gw = (font && font.widths && font.widths[code] !== undefined) ? font.widths[code] : (font ? font.defaultWidth : 500);
    w += (gw / 1000) * size + charSpacing + (code === 32 ? wordSpacing : 0);
  }
  return w * (hScale / 100);
}

function resolveXObject(pdf, resources, name) {
  const res = resolveDictRef(pdf, resources);
  if (!res) return null;
  const xdict = resolveDictRef(pdf, res.XObject);
  if (!xdict) return null;
  const ref = xdict[name];
  if (ref === undefined) return null;
  const o = pdf.resolveRef(ref);
  if (!o) return null;
  const d = pdf.parseDict(pdf.objBody(o), 0);
  const sd = pdf.streamData(o);
  if (!sd) return null;
  return { dict: d, data: sd.data };
}

async function runContentStream(pdf, data, resources, baseCtm, io, depth) {
  const depthNow = depth || 0;
  const tokens = tokenizeContent(data.toString('latin1'));
  const fonts = buildFontMap(pdf, resources);
  const stack = [];
  let st = {
    ctm: baseCtm.slice(),
    fill: [0, 0, 0], stroke: [0, 0, 0], lineWidth: 1,
    font: null, size: 12, charSpacing: 0, wordSpacing: 0, leading: 0, hScale: 100, rise: 0,
    tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0],
  };
  const cloneState = (s) => ({ ...s, ctm: s.ctm.slice(), fill: s.fill.slice(), stroke: s.stroke.slice(), tm: s.tm.slice(), tlm: s.tlm.slice() });
  const lastNums = (args, n) => args.slice(-n);
  const lastNum = (args) => (typeof args[args.length - 1] === 'number' ? args[args.length - 1] : NaN);

  const showWithAdvance = (items) => {
    for (const item of items) {
      if (typeof item === 'number') {
        st.tm = mulMatrix([1, 0, 0, 1, (-item / 1000) * st.size * (st.hScale / 100), 0], st.tm);
        continue;
      }
      if (!item || typeof item !== 'object' || (!item.__bytes && !item.__hex)) continue;
      const bytes = decodeTextValue(item);
      const text = decodePdfText(bytes, st.font);
      if (text && text.trim()) {
        const sizeMatrix = [st.size * st.hScale / 100, 0, 0, st.size, 0, st.rise];
        const trm = mulMatrix(st.ctm, mulMatrix(st.tm, sizeMatrix));
        io.showText(text, trm, st.font, st.size);
      }
      const adv = textAdvance(st.font, bytes, st.size, st.charSpacing, st.wordSpacing, st.hScale);
      st.tm = mulMatrix([1, 0, 0, 1, adv, 0], st.tm);
    }
  };

  for (const item of tokens) {
    const op = item.op;
    const args = item.args;
    switch (op) {
      case 'q': stack.push(cloneState(st)); io.save(); break;
      case 'Q': { const prev = stack.pop(); if (prev) st = prev; io.restore(); io.setCtm(st.ctm); break; }
      case 'cm': { const m = lastNums(args, 6); if (m.length === 6 && m.every(Number.isFinite)) { st.ctm = mulMatrix(m, st.ctm); io.setCtm(st.ctm); } break; }
      case 'w': { const v = lastNum(args); if (Number.isFinite(v)) { st.lineWidth = v; io.setLineWidth(v); } break; }
      case 'g': { const v = lastNum(args); if (Number.isFinite(v)) { st.fill = [v, v, v]; io.setFill(st.fill); } break; }
      case 'rg': { const c = lastNums(args, 3); if (c.length === 3 && c.every(Number.isFinite)) { st.fill = c; io.setFill(c); } break; }
      case 'k': { const c = lastNums(args, 4); if (c.length === 4 && c.every(Number.isFinite)) { const rgb = cmykToRgb(c); st.fill = rgb; io.setFill(rgb); } break; }
      case 'G': { const v = lastNum(args); if (Number.isFinite(v)) { st.stroke = [v, v, v]; io.setStroke(st.stroke); } break; }
      case 'RG': { const c = lastNums(args, 3); if (c.length === 3 && c.every(Number.isFinite)) { st.stroke = c; io.setStroke(c); } break; }
      case 'K': { const c = lastNums(args, 4); if (c.length === 4 && c.every(Number.isFinite)) { const rgb = cmykToRgb(c); st.stroke = rgb; io.setStroke(rgb); } break; }
      case 'BT': st.tm = [1, 0, 0, 1, 0, 0]; st.tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'ET': break;
      case 'Tf': {
        const nameObj = args.find(a => a && typeof a === 'object' && a.name !== undefined);
        if (nameObj) st.font = fonts[nameObj.name] || null;
        const size = lastNum(args);
        if (Number.isFinite(size)) st.size = size;
        io.setFont(st.font, st.size);
        break;
      }
      case 'TL': { const v = lastNum(args); if (Number.isFinite(v)) st.leading = v; break; }
      case 'Tc': { const v = lastNum(args); if (Number.isFinite(v)) st.charSpacing = v; break; }
      case 'Tw': { const v = lastNum(args); if (Number.isFinite(v)) st.wordSpacing = v; break; }
      case 'Tz': { const v = lastNum(args); if (Number.isFinite(v)) st.hScale = v; break; }
      case 'Ts': { const v = lastNum(args); if (Number.isFinite(v)) st.rise = v; break; }
      case 'Tm': { const m = lastNums(args, 6); if (m.length === 6 && m.every(Number.isFinite)) { st.tm = m.slice(); st.tlm = m.slice(); } break; }
      case 'Td': { const t = lastNums(args, 2); if (t.length === 2 && t.every(Number.isFinite)) { st.tlm = mulMatrix([1, 0, 0, 1, t[0], t[1]], st.tlm); st.tm = st.tlm.slice(); } break; }
      case 'TD': { const t = lastNums(args, 2); if (t.length === 2 && t.every(Number.isFinite)) { st.leading = -t[1]; st.tlm = mulMatrix([1, 0, 0, 1, t[0], t[1]], st.tlm); st.tm = st.tlm.slice(); } break; }
      case 'T*': { st.tlm = mulMatrix([1, 0, 0, 1, 0, -st.leading], st.tlm); st.tm = st.tlm.slice(); break; }
      case 'Tj': { const s = args.find(a => a && typeof a === 'object' && (a.__bytes || a.__hex)); if (s) showWithAdvance([s]); break; }
      case 'TJ': { const arr = args.find(a => a && typeof a === 'object' && a.array); if (arr) showWithAdvance(arr.array); break; }
      case "'": {
        const n = lastNums(args, 1);
        if (n.length) { st.tlm = mulMatrix([1, 0, 0, 1, 0, -st.leading], st.tlm); st.tm = st.tlm.slice(); }
        const s = args.find(a => a && typeof a === 'object' && (a.__bytes || a.__hex));
        if (s) showWithAdvance([s]);
        break;
      }
      case 'm': { const t = lastNums(args, 2); if (t.length === 2 && t.every(Number.isFinite)) io.moveTo(t[0], t[1]); break; }
      case 'l': { const t = lastNums(args, 2); if (t.length === 2 && t.every(Number.isFinite)) io.lineTo(t[0], t[1]); break; }
      case 'c': { const t = lastNums(args, 6); if (t.length === 6 && t.every(Number.isFinite)) io.curveTo(t[0], t[1], t[2], t[3], t[4], t[5]); break; }
      case 'v': { const t = lastNums(args, 4); if (t.length === 4 && t.every(Number.isFinite)) io.curveTo2(t[0], t[1], t[2], t[3]); break; }
      case 'y': { const t = lastNums(args, 4); if (t.length === 4 && t.every(Number.isFinite)) io.curveTo3(t[0], t[1], t[2], t[3]); break; }
      case 'h': io.closePath(); break;
      case 're': { const t = lastNums(args, 4); if (t.length === 4 && t.every(Number.isFinite)) io.rect(t[0], t[1], t[2], t[3]); break; }
      case 'S': io.stroke(); break;
      case 's': io.closePath(); io.stroke(); break;
      case 'f': case 'F': io.fill(false); break;
      case 'f*': io.fill(true); break;
      case 'B': case 'B*': io.fill(op === 'B*'); io.stroke(); break;
      case 'b': case 'b*': io.closePath(); io.fill(op === 'b*'); io.stroke(); break;
      case 'n': io.endPath(); break;
      case 'W': io.clip(false); break;
      case 'W*': io.clip(true); break;
      case 'Do': {
        const nameObj = args.find(a => a && typeof a === 'object' && a.name !== undefined);
        if (!nameObj) break;
        const xo = resolveXObject(pdf, resources, nameObj.name);
        if (!xo) break;
        if (xo.dict.Subtype === 'Form') {
          const mx = Array.isArray(xo.dict.Matrix) && xo.dict.Matrix.length >= 6 && xo.dict.Matrix.every(Number.isFinite) ? xo.dict.Matrix : [1, 0, 0, 1, 0, 0];
          if (depthNow < 6) {
            await runContentStream(pdf, xo.data, xo.dict.Resources !== undefined ? xo.dict.Resources : resources, mulMatrix(mx, st.ctm), io, depthNow + 1);
          }
        } else if (xo.dict.Subtype === 'Image') {
          await io.drawImage(xo, st.ctm);
        }
        break;
      }
      default: break;
    }
  }
}

function cmykToRgb(c) {
  const k = c[3];
  return [
    (1 - Math.min(1, c[0] + k)),
    (1 - Math.min(1, c[1] + k)),
    (1 - Math.min(1, c[2] + k)),
  ];
}

// 自研文本提取: 用解释器收集文字与真实页面坐标
async function extractTextOwn(buf, page, withPosition) {
  const pdf = parsePdfObjects(buf);
  const pages = pdf.getPages();
  if (!pages.length) throw new Error('no pages found (unsupported page tree)');
  const out = [];
  for (let idx = 0; idx < pages.length; idx++) {
    const pg = pages[idx];
    if (page && idx + 1 !== page) continue;
    const items = [];
    const io = makeTextCollector(items);
    const contents = pg.dict.Contents !== undefined ? (Array.isArray(pg.dict.Contents) ? pg.dict.Contents : [pg.dict.Contents]) : [];
    for (const cRef of contents) {
      const co = pdf.resolveRef(cRef);
      if (!co) continue;
      const sd = pdf.streamData(co);
      if (!sd || !sd.data) continue;
      await runContentStream(pdf, sd.data, pg.resources, [1, 0, 0, 1, 0, 0], io, 0);
    }
    out.push({ num: idx + 1, ...groupRows(items, withPosition) });
  }
  return { pages: out };
}
function makeTextCollector(items) {
  return {
    save() {}, restore() {}, setCtm() {}, setLineWidth() {}, setFill() {}, setStroke() {}, setFont() {},
    moveTo() {}, lineTo() {}, curveTo() {}, curveTo2() {}, curveTo3() {}, closePath() {}, rect() {},
    stroke() {}, fill() {}, clip() {}, endPath() {},
    showText(text, trm, font, size) {
      if (!text || !text.trim()) return;
      items.push({ text, x: trm[4], y: trm[5], size: Math.abs(trm[3]) || size, font: font ? font.baseFont : '' });
    },
    async drawImage() {},
  };
}

function groupRows(lines, withPosition) {
  const sorted = lines.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let row = [];
  let lastY = null;
  const flush = () => {
    if (!row.length) return;
    row.sort((a, b) => a.x - b.x);
    rows.push({ y: row[0].y, text: row.map(r => r.text).join(' '), lines: row });
    row = [];
  };
  for (const l of sorted) {
    if (lastY !== null && Math.abs(l.y - lastY) > Math.max(Math.abs(l.size) || 6, 6) * 0.6) flush();
    row.push(l);
    lastY = l.y;
  }
  flush();
  return { text: rows.map(r => r.text).join('\n'), ...(withPosition ? { rows } : {}) };
}

// pdfjs 文字提取 (优先路径)
async function extractTextPdfjs(buf, page, withPosition) {
  const doc = await loadDoc(buf);
  try {
    const targets = page ? [page] : Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const pages = [];
    for (const p of targets) {
      if (p < 1 || p > doc.numPages) continue;
      const pdfPage = await doc.getPage(p);
      const content = await pdfPage.getTextContent();
      const lines = [];
      for (const item of content.items) {
        if (!item.str) continue;
        lines.push({
          text: item.str,
          x: Math.round(item.transform[4] * 100) / 100,
          y: Math.round(item.transform[5] * 100) / 100,
          size: Math.round((item.height || 0) * 100) / 100,
        });
      }
      pages.push({ num: p, ...groupRows(lines, withPosition) });
    }
    return { pages };
  } finally {
    await doc.destroy();
  }
}

// ---------- 渲染: pdfjs 引擎 ----------
async function renderPdfjs(buf, pageNum, scale) {
  const doc = await loadDoc(buf);
  try {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const factory = new NodeCanvasFactory();
    const { canvas, context } = factory.create(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise;
    const png = canvas.toBuffer('image/png');
    const width = canvas.width;
    const height = canvas.height;
    factory.destroy({ canvas, context });
    return { png, width, height };
  } finally {
    await doc.destroy();
  }
}

// 供子进程调用: 渲染并落盘 (子进程崩了只影响它自己)
export async function renderPdfjsToFile(file, pageNum, scale, outPath) {
  const buf = fs.readFileSync(file);
  const raster = await renderPdfjs(buf, pageNum, scale);
  fs.writeFileSync(outPath, raster.png);
  return { width: raster.width, height: raster.height };
}

// ---------- 渲染: 自研 sysfont 引擎 (兜底) ----------
function baseMatrixFor(mediaBox, scale, rotate) {
  const mb = mediaBox || [0, 0, 595.28, 841.89];
  const x0 = mb[0], y0 = mb[1], x1 = mb[2], y1 = mb[3];
  if (rotate === 90) return [0, scale, scale, 0, -y0 * scale, -x0 * scale];
  if (rotate === 180) return [-scale, 0, 0, scale, x1 * scale, -y0 * scale];
  if (rotate === 270) return [0, -scale, -scale, 0, y1 * scale, x1 * scale];
  return [scale, 0, 0, -scale, -x0 * scale, y1 * scale];
}
function sizeForRotation(mediaBox, scale, rotate) {
  const mb = mediaBox || [0, 0, 595.28, 841.89];
  const w = (mb[2] - mb[0]) * scale;
  const h = (mb[3] - mb[1]) * scale;
  const swap = rotate === 90 || rotate === 270;
  return { width: Math.round(swap ? h : w), height: Math.round(swap ? w : h) };
}
const rgbToStyle = (c) => 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';

async function decodeImage(pdf, xo) {
  const d = xo.dict || {};
  const w = Number(d.Width) || 0;
  const h = Number(d.Height) || 0;
  if (!w || !h) return null;
  const filters = Array.isArray(d.Filter) ? d.Filter : (d.Filter !== undefined ? [d.Filter] : []);
  if (filters.indexOf('DCTDecode') >= 0) {
    try { return await loadImage(Buffer.from(xo.data)); } catch { return null; }
  }
  if (filters.some(f => f !== 'FlateDecode' && f !== 'Fl')) return null;
  if ((Number(d.BitsPerComponent) || 8) !== 8) return null;
  let cs = d.ColorSpace;
  let csName = cs;
  let lookup = null;
  if (Array.isArray(cs)) {
    csName = cs[0];
    if (csName === 'Indexed' && cs[3] !== undefined) {
      const lv = cs[3];
      if (lv && typeof lv === 'object' && lv.__num !== undefined) {
        const lo = pdf.resolveRef(lv);
        const ld = lo ? pdf.streamData(lo) : null;
        lookup = ld && ld.data ? ld.data : null;
      } else lookup = decodeTextValue(lv);
    }
  } else if (cs && typeof cs === 'object' && cs.__num !== undefined) {
    const cso = pdf.resolveRef(cs);
    const csd = cso ? pdf.parseDict(pdf.objBody(cso), 0) : null;
    csName = csd && csd.ColorSpace ? csd.ColorSpace : csName;
    if (Array.isArray(csName)) csName = csName[0];
  }
  const data = xo.data;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const px = img.data;
  if (csName === 'DeviceGray') {
    for (let i = 0; i < w * h; i++) { const v = data[i] || 0; px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
  } else if (csName === 'DeviceRGB') {
    for (let i = 0; i < w * h; i++) { px[i * 4] = data[i * 3] || 0; px[i * 4 + 1] = data[i * 3 + 1] || 0; px[i * 4 + 2] = data[i * 3 + 2] || 0; px[i * 4 + 3] = 255; }
  } else if (csName === 'Indexed' && lookup) {
    for (let i = 0; i < w * h; i++) {
      const idx = (data[i] || 0) * 3;
      px[i * 4] = lookup[idx] || 0;
      px[i * 4 + 1] = lookup[idx + 1] || 0;
      px[i * 4 + 2] = lookup[idx + 2] || 0;
      px[i * 4 + 3] = 255;
    }
  } else return null;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function makeCanvasIo(ctx, base, pdf, options) {
  const textOnly = !!(options && options.textOnly);
  const skipEmbeddedFonts = !!(options && options.skipEmbeddedFonts);
  let cur = { x: 0, y: 0 };
  let sub = { x: 0, y: 0 };
  let filled = false;
  let fillStyle = 'rgb(0,0,0)';
  let strokeStyle = 'rgb(0,0,0)';
  let lineWidth = 1;
  return {
    textOnly,
    save() { ctx.save(); },
    restore() { ctx.restore(); },
    setCtm(m) { const d = mulMatrix(base, m); ctx.setTransform(d[0], d[1], d[2], d[3], d[4], d[5]); },
    setLineWidth(w) { lineWidth = w; ctx.lineWidth = w; },
    setFill(c) { fillStyle = rgbToStyle(c); ctx.fillStyle = fillStyle; },
    setStroke(c) { strokeStyle = rgbToStyle(c); ctx.strokeStyle = strokeStyle; },
    setFont() {},
    moveTo(x, y) { if (!textOnly) ctx.moveTo(x, y); cur = { x, y }; sub = { x, y }; filled = false; },
    lineTo(x, y) { if (!textOnly) ctx.lineTo(x, y); cur = { x, y }; },
    curveTo(x1, y1, x2, y2, x3, y3) { if (!textOnly) ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3); cur = { x: x3, y: y3 }; },
    curveTo2(x2, y2, x3, y3) { if (!textOnly) ctx.bezierCurveTo(cur.x, cur.y, x2, y2, x3, y3); cur = { x: x3, y: y3 }; },
    curveTo3(x1, y1, x3, y3) { if (!textOnly) ctx.bezierCurveTo(x1, y1, x3, y3, x3, y3); cur = { x: x3, y: y3 }; },
    closePath() { ctx.closePath(); cur = { x: sub.x, y: sub.y }; },
    rect(x, y, w, h) { if (!textOnly) ctx.rect(x, y, w, h); cur = { x, y }; sub = { x, y }; filled = false; },
    stroke() { if (!textOnly) ctx.stroke(); ctx.beginPath(); filled = false; },
    fill(evenOdd) { if (!textOnly) ctx.fill(evenOdd ? 'evenodd' : 'nonzero'); filled = true; },
    clip(evenOdd) { if (!textOnly) ctx.clip(evenOdd ? 'evenodd' : 'nonzero'); },
    endPath() { ctx.beginPath(); filled = false; },
    showText(text, trm, font, size) {
      if (skipEmbeddedFonts && font && font.embedded) return;
      const m = mulMatrix(base, trm);
      const scaleY = Math.hypot(m[2], m[3]);
      if (!(scaleY > 0.0001)) return;
      const family = font && font.family ? font.family : 'Arial';
      const inv = 1 / scaleY;
      ctx.save();
      // 归一化到单位 em + canvas 文字是 y 向下 (本地 y 轴翻一次), 否则字号会被 CTM 二次放大
      ctx.setTransform(m[0] * inv, m[1] * inv, -m[2] * inv, -m[3] * inv, m[4], m[5]);
      ctx.font = scaleY + 'px "' + family + '", Arial, sans-serif';
      ctx.fillStyle = fillStyle;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    },
    async drawImage(xo, ctm) {
      if (textOnly) return;
      const img = await decodeImage(pdf, xo);
      if (!img) return;
      const m = mulMatrix(base, ctm);
      ctx.save();
      // 图像单位方块: 第 0 行对应 y=1, 同样需要本地 y 翻转
      ctx.setTransform(m[0], m[1], -m[2], -m[3], m[4], m[5]);
      ctx.drawImage(img, 0, -1, 1, 1);
      ctx.restore();
    },
  };
}

async function paintPageContent(pdf, pg, io) {
  const contents = pg.dict.Contents !== undefined ? (Array.isArray(pg.dict.Contents) ? pg.dict.Contents : [pg.dict.Contents]) : [];
  for (const cRef of contents) {
    const co = pdf.resolveRef(cRef);
    if (!co) continue;
    const sd = pdf.streamData(co);
    if (!sd || !sd.data) continue;
    await runContentStream(pdf, sd.data, pg.resources, [1, 0, 0, 1, 0, 0], io, 0);
  }
}

function pageGeometry(pg, scale) {
  const rotate = ((Math.round((pg.rotate || 0) / 90) * 90) % 360 + 360) % 360;
  return { rotate, dim: sizeForRotation(pg.mediaBox, scale, rotate), base: baseMatrixFor(pg.mediaBox, scale, rotate) };
}

// 子进程光栅化: 未内嵌字体的 PDF 会让 pdfjs 把 NUL 传给 @napi-rs/canvas, 后者可能直接
// 段错误 (0xC0000005) 掀翻整个宿主进程。放到子进程里跑, 崩了只丢这一次渲染。
function rasterInChild(file, pageNum, scale) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), 'dsh-pdf-' + process.pid + '-' + Date.now() + '.png');
    let done = false;
    const finish = (png) => {
      if (done) return;
      done = true;
      try { fs.unlinkSync(out); } catch { /* 可能没生成 */ }
      resolve(png);
    };
    let child = null;
    try {
      child = spawn(process.execPath, [path.join(HERE, 'render-child.mjs'), file, String(pageNum), String(scale), out], { stdio: 'ignore', windowsHide: true });
    } catch { finish(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } finish(null); }, 120000);
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try { finish(fs.readFileSync(out)); } catch { finish(null); }
      } else finish(null);
    });
  });
}

// 混合引擎: pdfjs (子进程) 画图形/图像, 自研解释器只把文字叠上
async function renderHybrid(buf, pageNum, scale, file) {
  let rasterPng = null;
  let rasterW = 0;
  let rasterH = 0;
  if (file) {
    rasterPng = await rasterInChild(file, pageNum, scale);
  }
  if (!rasterPng) {
    const raster = await renderPdfjs(buf, pageNum, scale);
    rasterPng = raster.png;
    rasterW = raster.width;
    rasterH = raster.height;
  }
  const pdf = parsePdfObjects(buf);
  const pages = pdf.getPages();
  const pg = pages[pageNum - 1];
  if (!pg) return { png: rasterPng, width: rasterW, height: rasterH };
  const geo = pageGeometry(pg, scale);
  const img = await loadImage(rasterPng);
  const width = rasterW || img.width;
  const height = rasterH || img.height;
  if (geo.dim.width !== width || geo.dim.height !== height) {
    // 几何不一致 (含 /Rotate 等差异) 时不做叠加, 直接用 pdfjs 的图形结果
    return { png: rasterPng, width, height };
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const io = makeCanvasIo(ctx, geo.base, pdf, { textOnly: true, skipEmbeddedFonts: true });
  await paintPageContent(pdf, pg, io);
  return { png: canvas.toBuffer('image/png'), width, height };
}

async function renderSysfont(buf, pageNum, scale) {
  const pdf = parsePdfObjects(buf);
  const pages = pdf.getPages();
  const pg = pages[pageNum - 1];
  if (!pg) throw new Error('page ' + pageNum + ' not found');
  const geo = pageGeometry(pg, scale);
  const canvas = createCanvas(geo.dim.width, geo.dim.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, geo.dim.width, geo.dim.height);
  const io = makeCanvasIo(ctx, geo.base, pdf);
  ctx.setTransform(geo.base[0], geo.base[1], geo.base[2], geo.base[3], geo.base[4], geo.base[5]);
  await paintPageContent(pdf, pg, io);
  return { png: canvas.toBuffer('image/png'), width: geo.dim.width, height: geo.dim.height };
}

// ---------- 对外入口 ----------
export async function extractText(file, { page = null, withPosition = false } = {}) {
  const buf = fs.readFileSync(file);
  let fromPdfjs = null;
  try { fromPdfjs = await extractTextPdfjs(buf, page, withPosition); } catch { fromPdfjs = null; }
  const chars = fromPdfjs ? fromPdfjs.pages.reduce((s, p) => s + (p.text || '').replace(/\s/g, '').length, 0) : 0;
  if (chars > 0) return fromPdfjs;
  try {
    return await extractTextOwn(buf, page, withPosition);
  } catch (err) {
    if (fromPdfjs) return fromPdfjs;
    throw err;
  }
}

export async function renderPage(file, { page = 1, scale = 2, outDir = null, engine = 'auto' } = {}) {
  const buf = fs.readFileSync(file);
  let useEngine = engine;
  if (useEngine === 'auto') {
    // 字体全内嵌 -> pdfjs 即可; 存在未内嵌字体 -> pdfjs 画图形 + 自研解释器叠文字 (混合)
    const fonts = scanFonts(parsePdfObjects(buf));
    useEngine = fonts.length > 0 && fonts.every(f => f.embedded) ? 'pdfjs' : 'hybrid';
  }
  let result = null;
  try {
    if (useEngine === 'pdfjs') result = await renderPdfjs(buf, page, scale);
    else if (useEngine === 'hybrid') result = await renderHybrid(buf, page, scale, file);
    else if (useEngine !== 'sysfont') throw new Error('unknown engine: ' + useEngine);
  } catch (err) {
    if (engine !== 'auto' && engine !== 'hybrid') throw err;
    useEngine = 'sysfont';
  }
  if (!result) result = await renderSysfont(buf, page, scale);
  const base = path.basename(file, path.extname(file));
  const dir = outDir ? path.resolve(outDir) : path.join(path.dirname(file), base + '-pages');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'page-' + page + '.png');
  fs.writeFileSync(outPath, result.png);
  return { page, path: outPath, width: result.width, height: result.height, engine: useEngine };
}

export { REGISTERED, parsePdfObjects, scanFonts, pdfInfo };
