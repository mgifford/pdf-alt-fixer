// Embedded-image extraction via pdf.js operator lists.
//
// v2: walks each page's operator list, tracks the CTM (save/restore/transform),
// and pulls every paintImageXObject / paintInlineImageXObject into a canvas.
// Items too small in both natural and displayed size are treated as
// decorative spacers/icons and skipped (same min-size idea as the Python path).
//
// Falls back to one full-page render per page when a document has no embedded
// images (e.g. scanned PDFs), so the tool stays useful there.

import * as pdfjs from 'pdfjs-dist';
// Vite resolves the worker; Pages serves it relative.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const IDENTITY = [1, 0, 0, 1, 0, 0];

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
  if (pdfImage && typeof pdfImage.createImageData === 'function') {
    // forceRGBA=true guarantees RGBA_32BPP output in pdf.js.
    const r = pdfImage.createImageData(true);
    return { width: r.width, height: r.height, data: r.data };
  }
  throw new Error('unsupported image object');
}

function rgbaToDataUrl(rgba, maxSide = 768) {
  const scale = Math.min(1, maxSide / Math.max(rgba.width, rgba.height));
  const w = Math.max(1, Math.round(rgba.width * scale));
  const h = Math.max(1, Math.round(rgba.height * scale));
  const full = document.createElement('canvas');
  full.width = rgba.width; full.height = rgba.height;
  full.getContext('2d').putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  if (scale === 1) return { dataUrl: full.toDataURL('image/png'), renderedWidth: w, renderedHeight: h };
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  small.getContext('2d').drawImage(full, 0, 0, w, h);
  return { dataUrl: small.toDataURL('image/png'), renderedWidth: w, renderedHeight: h };
}

function renderPageThumbnail(page) {
  const viewport = page.getViewport({ scale: 1.0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  return page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    .then(() => canvas.toDataURL('image/png'));
}

export function trimWords(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut) + ' …';
}

async function pageText(page, maxLen = 2000) {
  try {
    const tc = await page.getTextContent();
    return trimWords(tc.items.map((i) => ('str' in i ? i.str : '')).join(' '), maxLen);
  } catch {
    return '';
  }
}

async function extractEmbeddedImages(page, pageNum, minSize, seen) {
  const items = [];
  let opList;
  try {
    opList = await page.getOperatorList();
  } catch {
    return items;
  }
  const OPS = pdfjs.OPS;
  const { fnArray, argsArray } = opList;
  let ctm = [...IDENTITY];
  const stack = [];
  let imgCount = 0;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    try {
      if (fn === OPS.save) { stack.push(ctm); continue; }
      if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); continue; }
      if (fn === OPS.transform) { ctm = multiply(args, ctm); continue; }
      // Tiling-pattern fills and stencil masks: decorative by construction.
      if (fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObject) continue;

      let pdfImage = null;
      let unitW = 1, unitH = 1;
      if (fn === OPS.paintImageXObject) {
        const [name, w, h] = args;
        unitW = Math.abs(w || 1); unitH = Math.abs(h || 1);
        pdfImage = page.objs.get(name);
      } else if (fn === OPS.paintInlineImageXObject) {
        const [imgData, w, h] = args;
        unitW = Math.abs(w || imgData?.width || 1);
        unitH = Math.abs(h || imgData?.height || 1);
        pdfImage = imgData;
      } else {
        continue;
      }

      const rgba = pdfImageToRgba(pdfImage);
      if (!rgba.width || !rgba.height) continue;
      const sx = Math.hypot(ctm[0], ctm[1]) || 1;
      const sy = Math.hypot(ctm[2], ctm[3]) || 1;
      const dispW = unitW * sx, dispH = unitH * sy;
      const bigEnough =
        (rgba.width >= minSize && rgba.height >= minSize) ||
        (dispW >= minSize && dispH >= minSize);
      if (!bigEnough) continue;

      const key = hashDimsAndSample(rgba.width, rgba.height, rgba.data);
      if (seen.has(key)) continue;
      seen.add(key);

      const { dataUrl } = rgbaToDataUrl(rgba);
      imgCount++;
      items.push({
        id: `p${pageNum}_img${imgCount}`,
        page: pageNum,
        name: String(args[0] ?? `inline${imgCount}`),
        width: rgba.width,
        height: rgba.height,
        displayed: `${Math.round(dispW)} × ${Math.round(dispH)} pt`,
        dataUrl,
        fullPage: false,
      });
    } catch {
      // One corrupt image must not kill the page.
    }
  }
  return items;
}

/**
 * Extract per-image items from a PDF file.
 * @returns {Promise<Array>} items shaped {id,page,name,width,height,displayed,dataUrl,context,fullPage}
 */
export async function extractImages(file, { minSize = 50, maxImages = 100 } = {}) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const seen = new Set();
  const items = [];
  let fallbackNeeded = true;

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const context = await pageText(page);
    const found = await extractEmbeddedImages(page, n, minSize, seen);
    if (found.length) fallbackNeeded = false;
    for (const it of found) {
      if (items.length >= maxImages) break;
      items.push({ ...it, context });
    }
    if (items.length >= maxImages) break;
  }

  if (fallbackNeeded) {
    // Scanned/image-only PDF: one full-page item per page, as before.
    for (let n = 1; n <= pdf.numPages; n++) {
      if (items.length >= maxImages) break;
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1.0 });
      items.push({
        id: `p${n}`,
        page: n,
        name: 'full-page',
        width: Math.floor(viewport.width),
        height: Math.floor(viewport.height),
        displayed: `${Math.floor(viewport.width)} × ${Math.floor(viewport.height)} pt`,
        dataUrl: await renderPageThumbnail(page),
        context: await pageText(page),
        fullPage: true,
      });
    }
  }
  return items;
}
