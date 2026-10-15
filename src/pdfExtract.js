// PDF extraction: per-page thumbnail + nearby text as context.
// v1 simplification: one item per page (rendered image + text context).
// Embedded-image extraction (like PyMuPDF) lives in scripts/generate_alt.py.

import * as pdfjs from 'pdfjs-dist';
// Vite resolves the worker; Pages serves it relative.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractPages(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1.0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const text = await page.getTextContent().then((tc) =>
      tc.items.map((i) => i.str).join(' ').slice(0, 600)
    ).catch(() => '');
    pages.push({
      id: `p${n}`,
      page: n,
      dataUrl: canvas.toDataURL('image/png'),
      context: text,
    });
  }
  return pages;
}
