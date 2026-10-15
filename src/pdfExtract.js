// Embedded-image extraction via pdf.js operator lists + object stores.
//
// Two nets: (1) walk each page's operator list with CTM tracking to find
// paintImageXObject / inline images and their approximate on-page bbox;
// (2) enumerate resolved objects in page.objs AND page.commonObjs (pdf.js
// parks globally-cached images in commonObjs) so nothing is missed when an
// op's object isn't synchronously resolvable.
// Falls back to one full-page render per page when a document has no
// embedded images (e.g. scanned PDFs).
//
// Existing /Alt text is collected best-effort from the structure tree.
// Matching a struct-tree Alt to a specific image is unreliable, so alts are
// reported per page with an explicit verify-which-figure caveat.

import * as pdfjs from 'pdfjs-dist';
// Vite resolves the worker; Pages serves it relative.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const IDENTITY = [1, 0, 0, 1, 0, 0];

export function trimWords(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut) + ' …';
}

function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function asPdfImage(v) {
  if (v && typeof v === 'object' && Number.isFinite(v.width) && Number.isFinite(v.height)
    && v.width > 0 && v.height > 0 && typeof v.createImageData === 'function') {
    return v;
  }
  return null;
}

function storesOf(page) {
  return [page.objs, page.commonObjs].filter(Boolean);
}

function resolveImageSync(page, name) {
  for (const store of storesOf(page)) {
    try {
      if (typeof store.has === 'function' && !store.has(name)) continue;
      const img = asPdfImage(store.get(name));
      if (img) return img;
    } catch { /* next store */ }
  }
  return null;
}

function resolveImageAsync(page, name, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(asPdfImage(v)); } };
    try {
      const sync = resolveImageSync(page, name);
      if (sync) return finish(sync);
    } catch { /* fall through to callback */ }
    const timer = setTimeout(() => finish(null), timeoutMs);
    for (const store of storesOf(page)) {
      try {
        if (store && typeof store.get === 'function') {
          store.get(name, (v) => { clearTimeout(timer); finish(v); });
        }
      } catch { /* ignore */ }
    }
  });
}

function collectResolvedImages(page) {
  // Second net: every resolved image-like object in either store.
  // Yields {id, img, store} so the debug inventory can show where each
  // object lives (pdf.js parks globally-cached images in commonObjs).
  const found = [];
  const seenIds = new Set();
  for (const [storeName, store] of [['page', page.objs], ['common', page.commonObjs]]) {
    if (!store) continue;
    try {
      for (const [id, data] of store) {
        const key = `${storeName}:${id}`;
        if (seenIds.has(key)) continue;
        const img = asPdfImage(data);
        if (img) { seenIds.add(key); found.push({ id: String(id), img, store: storeName }); }
      }
    } catch { /* store not iterable */ }
  }
  return found;
}

// Cheap hash for cross-page dedupe of shared XObjects.
function hashDimsAndSample(width, height, rgba) {
  let h = 2166136261;
  const n = Math.min(rgba.length, 4096);
  h ^= width & 0xffff; h = Math.imul(h, 16777619);
  h ^= height & 0xffff; h = Math.imul(h, 16777619);
  for (let i = 0; i < n; i += 16) {
    h ^= rgba[i]; h = Math.imul(h, 16777619);
  }
  return `${width}x${height}:${(h >>> 0).toString(16)}`;
}

function pdfImageToRgba(pdfImage) {
  // forceRGBA=true guarantees RGBA_32BPP output in pdf.js.
  const r = pdfImage.createImageData(true);
  if (!r || !r.data) throw new Error('no pixel data');
  return { width: r.width, height: r.height, data: r.data };
}

function rgbaToDataUrl(rgba, maxSide = 768) {
  const scale = Math.min(1, maxSide / Math.max(rgba.width, rgba.height));
  const w = Math.max(1, Math.round(rgba.width * scale));
  const h = Math.max(1, Math.round(rgba.height * scale));
  const full = document.createElement('canvas');
  full.width = rgba.width; full.height = rgba.height;
  full.getContext('2d').putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  if (scale === 1) return full.toDataURL('image/png');
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  small.getContext('2d').drawImage(full, 0, 0, w, h);
  return small.toDataURL('image/png');
}

export function renderPageThumbnail(page, scale = 0.5) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  return page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    .then(() => canvas.toDataURL('image/png'));
}

// Shared document cache so the "locate on page" view doesn't re-parse the PDF.
const docCache = new WeakMap();

async function docFor(file) {
  let p = docCache.get(file);
  if (!p) {
    p = file.arrayBuffer().then((buf) => pdfjs.getDocument({ data: buf }).promise);
    docCache.set(file, p);
  }
  return p;
}

/**
 * Render a page thumbnail for the locate-on-page overlay. Scale is relative
 * to full page size; keep small since it is only a locator.
 */
export async function pageThumbnail(file, pageNum, scale = 0.4) {
  const pdf = await docFor(file);
  const page = await pdf.getPage(Math.min(Math.max(1, pageNum), pdf.numPages));
  return renderPageThumbnail(page, scale);
}

async function pageText(page, maxLen = 2000) {
  try {
    const tc = await page.getTextContent();
    return trimWords(tc.items.map((i) => ('str' in i ? i.str : '')).join(' '), maxLen);
  } catch {
    return '';
  }
}

function collectStructAlts(node, out) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.alt === 'string' && node.alt.trim()) out.push(node.alt.trim());
  const kids = node.children;
  if (Array.isArray(kids)) kids.forEach((k) => collectStructAlts(k, out));
}

async function pageTaggedAlts(page) {
  // Best-effort: struct-tree Alt exposure varies by pdf.js version and by
  // whether the PDF is tagged at all. Returns { checked: bool, alts: [] }.
  try {
    if (typeof page.getStructTree !== 'function') return { checked: false, alts: [] };
    const tree = await page.getStructTree();
    const alts = [];
    collectStructAlts(tree, alts);
    return { checked: true, alts: [...new Set(alts)] };
  } catch {
    return { checked: false, alts: [] };
  }
}

async function extractEmbeddedImages(page, pageNum, pageW, pageH, minSize, seen, stats) {
  const items = [];
  let opList = null;
  try {
    opList = await page.getOperatorList();
  } catch (e) {
    stats.opListError = String((e && e.message) || e);
    return items;
  }
  const OPS = pdfjs.OPS || {};
  const { fnArray, argsArray } = opList;
  stats.ops = fnArray.length;
  let ctm = [...IDENTITY];
  const stack = [];
  let imgCount = 0;

  const take = (pdfImage, name, unitW, unitH, positioned) => {
    let rgba;
    try {
      rgba = pdfImageToRgba(pdfImage);
    } catch {
      stats.decodeErrors++;
      return;
    }
    const sx = Math.hypot(ctm[0], ctm[1]) || 1;
    const sy = Math.hypot(ctm[2], ctm[3]) || 1;
    const dispW = unitW * sx, dispH = unitH * sy;
    if (!((rgba.width >= minSize && rgba.height >= minSize)
      || (dispW >= minSize && dispH >= minSize))) {
      stats.skippedSmall++;
      return;
    }
    const key = hashDimsAndSample(rgba.width, rgba.height, rgba.data);
    if (seen.has(key)) { stats.skippedDupe++; return; }
    seen.add(key);
    imgCount++;
    // Approximate bbox in top-left-origin fractions for overlay rendering.
    let bbox = null;
    if (positioned) {
      const bw = Math.min(1, dispW / pageW), bh = Math.min(1, dispH / pageH);
      const bx = Math.min(Math.max(0, ctm[4] / pageW), 1 - bw);
      const byTop = Math.min(Math.max(0, 1 - (ctm[5] + dispH) / pageH), 1 - bh);
      bbox = { x: bx, y: byTop, w: Math.max(bw, 0.01), h: Math.max(bh, 0.01) };
    }
    stats.extracted++;
    items.push({
      id: `p${pageNum}_img${imgCount}`,
      page: pageNum,
      name: String(name),
      width: rgba.width,
      height: rgba.height,
      displayed: `${Math.round(dispW)} × ${Math.round(dispH)} pt`,
      bbox,
      dataUrl: rgbaToDataUrl(rgba),
      fullPage: false,
    });
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    try {
      if (fn === OPS.save) { stack.push(ctm); continue; }
      if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); continue; }
      if (fn === OPS.transform) { ctm = multiply(args, ctm); continue; }
      // Tiling-pattern fills and stencil masks: decorative by construction.
      if (fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObject
        || fn === OPS.paintSolidColorImageMask) continue;

      if (fn === OPS.paintImageXObject) {
        stats.paintImageOps++;
        const [name, w, h] = args;
        const img = resolveImageSync(page, name)
          || await resolveImageAsync(page, name);
        if (!img) { stats.unresolved++; continue; }
        stats.resolved++;
        take(img, name, Math.abs(w || img.width), Math.abs(h || img.height), true);
      } else if (fn === OPS.paintInlineImageXObject) {
        stats.inlineOps++;
        const [imgData] = args;
        const img = asPdfImage(imgData);
        if (!img) { stats.unresolved++; continue; }
        stats.resolved++;
        take(img, `inline${stats.inlineOps}`, img.width, img.height, true);
      }
    } catch {
      stats.errors++;
    }
  }

  // Second net: resolved images the op walk missed (e.g. unusual paint paths).
  try {
    for (const { id, img } of collectResolvedImages(page)) {
      let rgba;
      try {
        rgba = pdfImageToRgba(img);
      } catch { stats.decodeErrors++; continue; }
      const probe = hashDimsAndSample(rgba.width, rgba.height, rgba.data);
      if (seen.has(probe)) continue;
      if (rgba.width < minSize || rgba.height < minSize) { stats.skippedSmall++; continue; }
      seen.add(probe);
      imgCount++;
      stats.extracted++;
      stats.viaStoreEnum++;
      items.push({
        id: `p${pageNum}_img${imgCount}`,
        page: pageNum,
        name: String(id),
        width: rgba.width,
        height: rgba.height,
        displayed: 'position unknown — found via object store',
        bbox: null,
        dataUrl: rgbaToDataUrl(rgba),
        fullPage: false,
      });
    }
  } catch {
    stats.errors++;
  }
  return items;
}

/**
 * Extract per-image items from a PDF file.
 * @returns {Promise<{items,totalPages,pagesProcessed,debug}>} items shaped
 * {id,page,name,width,height,displayed,bbox,dataUrl,context,taggedAlts,fullPage}
 */
export async function extractImages(file, { minSize = 50, maxImages = 100, maxPages = 20, onProgress } = {}) {
  const pdf = await docFor(file);
  const pageCount = Math.min(pdf.numPages, Math.max(1, maxPages));
  const meta = await docMetadata(pdf);
  const emit = (stage, done, total) => {
    try { onProgress && onProgress({ stage, done, total }); } catch { /* ignore */ }
  };
  emit('metadata', 1, 1);
  const seen = new Set();
  const items = [];
  const debug = [];

  for (let n = 1; n <= pageCount; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1.0 });
    const context = await pageText(page);
    const tagged = await pageTaggedAlts(page);
    // Render FIRST: painting forces pdf.js to fully decode image XObjects
    // and resolve them into the page/common object stores. The thumbnail is
    // reused for fallback rows and the locate-on-page view.
    let pageThumb = null;
    try {
      pageThumb = await renderPageThumbnail(page, 0.5);
    } catch {
      pageThumb = null;
    }
    const stats = {
      page: n, ops: 0, paintImageOps: 0, inlineOps: 0, resolved: 0,
      extracted: 0, skippedSmall: 0, skippedDupe: 0, unresolved: 0,
      decodeErrors: 0, errors: 0, viaStoreEnum: 0, opListError: null,
    };
    const found = await extractEmbeddedImages(page, n, viewport.width, viewport.height, minSize, seen, stats);
    stats.taggedAltsFound = tagged.alts.length;
    stats.structChecked = tagged.checked;
    // Full inventory of resolved image objects (pre-filter): answers
    // "what images does this page actually contain?" regardless of min-size.
    const inventory = [];
    try {
      for (const { id, img, store } of collectResolvedImages(page)) {
        inventory.push({ store, id, w: img.width, h: img.height });
        if (inventory.length >= 80) break;
      }
    } catch { /* ignore */ }
    stats.storeImages = inventory.length;
    stats.inventory = inventory;
    debug.push(stats);
    for (const it of found) {
      if (items.length >= maxImages) break;
      items.push({ ...it, context, taggedAlts: tagged.alts, structChecked: tagged.checked, pageThumb });
    }
    if (items.length >= maxImages) break;
    emit('images', n, pageCount);
  }

  if (!items.length) {
    // Scanned/image-only PDF: one full-page item per page, flagged as such.
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      const tagged = await pageTaggedAlts(page);
      let pageThumb = null;
      try {
        pageThumb = await renderPageThumbnail(page, 0.5);
      } catch {
        pageThumb = null;
      }
      items.push({
        id: `p${n}`,
        page: n,
        name: 'full-page',
        width: 0,
        height: 0,
        displayed: 'full page',
        bbox: null,
        dataUrl: pageThumb,
        context: await pageText(page),
        taggedAlts: tagged.alts,
        structChecked: tagged.checked,
        pageThumb,
        fullPage: true,
      });
      emit('images', n, pageCount);
    }
  }
  return { items, totalPages: pdf.numPages, pagesProcessed: pageCount, debug, meta };
}

/**
 * Document-level metadata (filename is added by the caller).
 */
async function docMetadata(pdf) {
  try {
    const { info } = await pdf.getMetadata();
    const pick = (o, ...ks) => {
      for (const k of ks) if (o && o[k] != null && String(o[k])) return String(o[k]);
      return '';
    };
    return {
      title: pick(info, 'Title'),
      author: pick(info, 'Author'),
      subject: pick(info, 'Subject'),
      keywords: pick(info, 'Keywords'),
      creator: pick(info, 'Creator', 'CreatorTool'),
      producer: pick(info, 'Producer', 'ProducerTool'),
      created: pick(info, 'CreationDate'),
      modified: pick(info, 'ModDate'),
    };
  } catch {
    return {};
  }
}
