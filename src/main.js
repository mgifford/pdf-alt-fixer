import { extractImages, pageThumbnail } from './pdfExtract.js';
import { draftViaEndpoint } from './byok.js';
import { draftLocal } from './localVlm.js';
import { rateAlt } from './altQuality.js';

const $ = (id) => document.getElementById(id);
let drafts = [];
let currentFile = null;
let lastDebug = null;
let lastMeta = null;

function renderSourceMeta() {
  const el = $('sourceMeta');
  if (!lastMeta) { el.textContent = ''; return; }
  const bits = [`${lastMeta.file} (${lastMeta.sizeKB} KB)`];
  if (lastMeta.title) bits.push(`Title: ${lastMeta.title}`);
  if (lastMeta.author) bits.push(`Author: ${lastMeta.author}`);
  if (lastMeta.producer) bits.push(`Producer: ${lastMeta.producer}`);
  if (lastMeta.creator) bits.push(`Creator: ${lastMeta.creator}`);
  el.textContent = bits.join(' · ');
}

// Restore non-secret prefs; key is never persisted.
try {
  $('baseUrl').value = localStorage.getItem('paf.baseUrl') || '';
  $('model').value = localStorage.getItem('paf.model') || '';
  $('lang').value = localStorage.getItem('paf.lang') || 'en';
  $('localModel').value = localStorage.getItem('paf.localModel') || '';
  $('maxPages').value = localStorage.getItem('paf.maxPages') || '20';
} catch { /* private mode */ }

const dropzone = $('dropzone');
const fileInput = $('pdfFile');

function setStatus(msg) { $('status').textContent = msg; }

function setProgress(frac, label, detail) {
  const wrap = $('progressWrap');
  wrap.hidden = false;
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  $('progressBar').value = pct;
  $('progressBar').textContent = `${pct}%`;
  if (label) $('progressLabel').textContent = label;
  if (detail !== undefined) $('progressDetail').textContent = detail;
}

function showFileName() {
  const f = fileInput.files[0];
  $('fileName').textContent = f ? `${f.name} (${Math.round(f.size / 1024)} KB)` : '';
}

function acceptFile(f) {
  if (!f) return;
  if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
    setStatus('Only PDF files please.');
    return;
  }
  const dt = new DataTransfer();
  dt.items.add(f);
  fileInput.files = dt.files;
  showFileName();
  setStatus('');
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
}));
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) acceptFile(f);
});
fileInput.addEventListener('change', showFileName);

function currentEngine() {
  return document.querySelector('input[name="engine"]:checked').value;
}

function syncEngineFields() {
  const byok = currentEngine() === 'byok';
  $('byokFields').hidden = !byok;
  $('localFields').hidden = byok;
  $('gpuNote').hidden = byok;
}
document.querySelectorAll('input[name="engine"]').forEach((r) =>
  r.addEventListener('change', syncEngineFields)
);
syncEngineFields();

function renderRows() {
  const body = $('resultsBody');
  body.innerHTML = '';
  drafts.forEach((d, i) => {
    const tr = document.createElement('tr');

    const page = document.createElement('td');
    page.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = `Page ${d.page}`;
    page.appendChild(strong);
    const idLine = document.createElement('div');
    idLine.innerHTML = '';
    const small = document.createElement('small');
    small.textContent = d.fullPage ? `${d.id} · full page` : `${d.id} · ${d.width}×${d.height}px · shown ${d.displayed || ''}`;
    idLine.appendChild(small);
    page.appendChild(idLine);
    tr.appendChild(page);

    const prev = document.createElement('td');
    const fullLink = document.createElement('a');
    fullLink.href = d.dataUrl; fullLink.target = '_blank'; fullLink.rel = 'noopener';
    fullLink.setAttribute('aria-label', `Open full-size image ${d.id} in a new tab`);
    fullLink.title = 'Open full size';
    const img = document.createElement('img'); img.src = d.dataUrl; img.alt = ''; img.className = 'thumb';
    fullLink.appendChild(img); prev.appendChild(fullLink);
    // "Where is this on the page?" — lazy page thumbnail with bbox overlay.
    if (d.bbox) {
      const locBtn = document.createElement('button');
      locBtn.type = 'button'; locBtn.className = 'linklike';
      locBtn.textContent = 'Locate on page';
      locBtn.setAttribute('aria-expanded', 'false');
      const locBox = document.createElement('div');
      locBox.className = 'locate'; locBox.hidden = true;
      locBtn.addEventListener('click', async () => {
        const open = locBox.hidden;
        locBox.hidden = !open;
        locBtn.setAttribute('aria-expanded', String(open));
        if (open && !locBox.dataset.loaded) {
          locBox.dataset.loaded = '1';
          locBox.textContent = 'Rendering page…';
          try {
            const thumb = d.pageThumb || await pageThumbnail(currentFile, d.page);
            locBox.innerHTML = '';
            const wrap = document.createElement('div');
            wrap.className = 'locateWrap';
            const pg = document.createElement('img');
            pg.src = thumb; pg.alt = ''; pg.className = 'locateImg';
            const rect = document.createElement('div');
            rect.className = 'locateRect';
            rect.setAttribute('aria-hidden', 'true');
            rect.style.left = `${d.bbox.x * 100}%`;
            rect.style.top = `${d.bbox.y * 100}%`;
            rect.style.width = `${d.bbox.w * 100}%`;
            rect.style.height = `${d.bbox.h * 100}%`;
            wrap.appendChild(pg); wrap.appendChild(rect);
            locBox.appendChild(wrap);
            const cap = document.createElement('div');
            cap.innerHTML = '';
            const capSmall = document.createElement('small');
            capSmall.textContent = 'Approximate position from the content stream.';
            cap.appendChild(capSmall);
            locBox.appendChild(cap);
          } catch (e) {
            locBox.textContent = `Could not render page: ${e.message}`;
          }
        }
      });
      prev.appendChild(locBtn);
      prev.appendChild(locBox);
    }
    tr.appendChild(prev);

    const ctx = document.createElement('td');
    const ctxBox = document.createElement('div'); ctxBox.className = 'ctx';
    ctxBox.textContent = d.context || '—'; ctx.appendChild(ctxBox); tr.appendChild(ctx);

    const altTd = document.createElement('td');
    // Existing tagged Alt already in the PDF (best-effort, page-level).
    const existBox = document.createElement('div');
    existBox.className = 'existAlt';
    existBox.innerHTML = '';
    if (!d.structChecked) {
      const s = document.createElement('small');
      s.textContent = 'Existing alt: could not check structure tree.';
      existBox.appendChild(s);
    } else if (!d.taggedAlts || !d.taggedAlts.length) {
      const s = document.createElement('small');
      s.textContent = 'Existing alt: none found in tagged structure.';
      existBox.appendChild(s);
    } else {
      const s = document.createElement('small');
      s.textContent = `Tagged alt on this page (${d.taggedAlts.length}) — verify which figure it belongs to:`;
      existBox.appendChild(s);
      const ul = document.createElement('ul');
      d.taggedAlts.forEach((a) => {
        const li = document.createElement('li');
        li.textContent = `“${a}”`;
        rateAlt(a).forEach((q) => {
          const b = document.createElement('span');
          b.className = `badge ${q.level}`;
          b.textContent = q.msg;
          li.appendChild(document.createTextNode(' '));
          li.appendChild(b);
        });
        ul.appendChild(li);
      });
      existBox.appendChild(ul);
    }
    altTd.appendChild(existBox);
    if (d.fullPage) {
      const fb = document.createElement('div');
      fb.className = 'fallbackHint';
      fb.innerHTML = '';
      const fbSmall = document.createElement('small');
      fbSmall.textContent = 'Full-page render, not an extracted figure: the caption below describes layout (“white and blue striped wall”), not content. Started as decorative — uncheck only if this page is genuinely image-only.';
      fb.appendChild(fbSmall);
      if (d.rawDraft) {
        const q = document.createElement('div');
        q.innerHTML = '';
        const qSmall = document.createElement('small');
        qSmall.textContent = `AI saw: “${d.rawDraft}”`;
        q.appendChild(qSmall);
        fb.appendChild(q);
      }
      altTd.appendChild(fb);
    }
    const ta = document.createElement('textarea');
    ta.id = `alt-${d.id}`; ta.value = d.decorative ? '' : d.alt;
    const lb = document.createElement('label'); lb.htmlFor = ta.id; lb.textContent = `Alt-text for ${d.id}`;
    lb.style.cssText = 'position:absolute;left:-999px;';
    altTd.appendChild(lb); altTd.appendChild(ta);
    const editedFlag = document.createElement('div');
    editedFlag.innerHTML = '';
    const editedSmall = document.createElement('small');
    editedFlag.appendChild(editedSmall);
    altTd.appendChild(editedFlag);
    const badgeBox = document.createElement('div');
    badgeBox.className = 'badges';
    altTd.appendChild(badgeBox);
    const refreshBadges = () => {
      badgeBox.innerHTML = '';
      rateAlt(ta.value).forEach((q) => {
        const b = document.createElement('span');
        b.className = `badge ${q.level}`;
        b.textContent = q.msg;
        badgeBox.appendChild(b);
        badgeBox.appendChild(document.createTextNode(' '));
      });
    };
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset to AI draft';
    resetBtn.setAttribute('aria-label', `Reset alt-text for ${d.id} to the AI draft`);
    const effectiveOriginal = () => (d.decorativeAtGenerate ? '' : (d.original || ''));
    const syncEdited = () => {
      const edited = ta.value !== effectiveOriginal();
      editedSmall.textContent = d.error ? '' : (edited ? 'edited' : 'AI draft — unedited');
      resetBtn.disabled = !edited;
    };
    ta.addEventListener('input', () => { drafts[i].alt = ta.value; syncEdited(); refreshBadges(); });
    resetBtn.addEventListener('click', () => {
      ta.value = effectiveOriginal();
      drafts[i].alt = ta.value;
      const cb = document.getElementById(`dec-${d.id}`);
      if (cb) { cb.checked = !!d.decorativeAtGenerate; drafts[i].decorative = !!d.decorativeAtGenerate; }
      syncEdited(); refreshBadges();
    });
    altTd.appendChild(resetBtn);
    syncEdited(); refreshBadges();
    if (d.error) {
      const err = document.createElement('div');
      err.innerHTML = '';
      const errSmall = document.createElement('small');
      errSmall.textContent = `Generation failed: ${d.error}`;
      err.appendChild(errSmall);
      altTd.appendChild(err);
    }
    tr.appendChild(altTd);

    const dec = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = `dec-${d.id}`; cb.checked = !!d.decorative;
    cb.setAttribute('aria-label', `Mark ${d.id} (page ${d.page}) decorative`);
    cb.addEventListener('change', () => { drafts[i].decorative = cb.checked; });
    dec.appendChild(cb); tr.appendChild(dec);

    body.appendChild(tr);
  });
  $('resultsTable').hidden = drafts.length === 0;
  $('exportJson').disabled = $('exportCsv').disabled = drafts.length === 0;
}

function renderDebug() {
  const wrap = $('debugWrap');
  if (!lastDebug || !lastDebug.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const lines = lastDebug.map((s) =>
    `p${s.page}: ops=${s.ops} imgOps=${s.paintImageOps} inline=${s.inlineOps} ` +
    `resolved=${s.resolved} extracted=${s.extracted} small=${s.skippedSmall} ` +
    `dupe=${s.skippedDupe} unresolved=${s.unresolved} storeEnum=${s.viaStoreEnum} ` +
    `decodeErr=${s.decodeErrors} err=${s.errors} taggedAlts=${s.taggedAltsFound ?? '?'} ` +
    `struct=${s.structChecked ? 'yes' : 'no'}${s.opListError ? ` OPLIST-ERR=${s.opListError}` : ''}`);
  $('debugPre').textContent = `Source: ${lastMeta ? `${lastMeta.file} (${lastMeta.sizeKB} KB)` : '(unknown)'}`
    + (lastMeta && lastMeta.title ? ` — ${lastMeta.title}` : '')
    + `\n\n${lines.join('\n')}`
    + `\n\nXOBJECTS PER PAGE (from Resources dict — all image/form refs):\n`
    + lastDebug.map((s) => {
      if (!s.xobjects || !s.xobjects.length) return `p${s.page}: (no XObjects)`;
      return `p${s.page}: ` + s.xobjects.map((o) =>
        `${o.name}[${o.subtype}] ${o.w || '?'}x${o.h || '?'} ${o.cs || ''} ${o.bits || ''}bpc`
      ).join('; ');
    }).join('\n');
    + '\n\nIMAGE OBJECTS PER PAGE (resolved, before min-size filter):\n'
    + lastDebug.map((s) => {
      if (!s.inventory || !s.inventory.length) return `p${s.page}: (none resolved)`;
      return `p${s.page}: ` + s.inventory.map((o) => `[${o.store}] ${o.id} ${o.w}x${o.h}`).join(', ');
    }).join('\n')
    + '\n\nPaste this into a bug report if extraction misses figures.';
}

$('runBtn').addEventListener('click', async () => {
  const file = $('pdfFile').files[0];
  if (!file) return setStatus('Choose a PDF first.');
  const engine = currentEngine();
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('apiKey').value;
  const model = $('model').value.trim();
  const localModel = $('localModel').value.trim();
  const lang = $('lang').value;
  try {
    localStorage.setItem('paf.baseUrl', baseUrl);
    localStorage.setItem('paf.model', model);
    localStorage.setItem('paf.localModel', localModel);
    localStorage.setItem('paf.lang', lang);
  } catch { /* ignore */ }
  if (engine === 'byok' && (!baseUrl || !model)) return setStatus('Enter API base URL and model.');

  setProgress(0.01, 'Reading document metadata…', '');
  let result;
  try {
    const minSize = Math.max(1, parseInt($('minSize').value, 10) || 50);
    const maxPages = Math.max(1, parseInt($('maxPages').value, 10) || 20);
    try { localStorage.setItem('paf.maxPages', String(maxPages)); } catch { /* ignore */ }
    result = await extractImages(file, {
      minSize,
      maxPages,
      onProgress: ({ stage, done, total }) => {
        if (stage === 'metadata') {
          setProgress(0.04, 'Reading document metadata…', 'Counting pages…');
        } else if (stage === 'images') {
          setProgress(0.04 + 0.36 * (done / Math.max(1, total)),
            'Finding images…', `Page ${done} of ${total}`);
        }
      },
    });
  } catch (e) {
    setProgress(0, 'Failed.', String((e && e.message) || e));
    return setStatus(`PDF extraction failed: ${e.message}`);
  }
  const pages = result.items;
  if (!pages.length) return setStatus('No images found (try lowering the minimum size).');
  const embeddedCount = pages.filter((p) => !p.fullPage).length;
  const scopeNote = result.totalPages > result.pagesProcessed
    ? `first ${result.pagesProcessed} of ${result.totalPages} pages`
    : `${result.pagesProcessed} page(s)`;
  const modeNote = embeddedCount
    ? `${embeddedCount} embedded image(s), ${scopeNote}`
    : `no embedded images — full-page fallback, ${scopeNote}: captioning describes layout, not content, so rows start flagged decorative`;
  lastDebug = result.debug;
  lastMeta = {
    file: file.name,
    sizeKB: Math.round(file.size / 1024),
    ...(result.meta || {}),
    totalPages: result.totalPages,
    pagesProcessed: result.pagesProcessed,
  };
  renderSourceMeta();
  renderDebug();

  currentFile = file;
  drafts = [];
  const taggedTotal = pages.reduce((sum, p) => sum + (p.taggedAlts ? p.taggedAlts.length : 0), 0);
  setProgress(0.42, 'Reviewing existing alt-text…',
    taggedTotal ? `${taggedTotal} tagged alt(s) already in the document` : 'no tagged alt-text found in structure');
  setStatus(`Reviewing existing alt-text… ${taggedTotal} tagged alt(s) found.`);
  for (const p of pages) {
    const idx = pages.indexOf(p);
    setProgress(0.44 + 0.56 * ((idx + 1) / Math.max(1, pages.length)),
      'Proposing alt-text…', `${p.id} (${idx + 1}/${pages.length}) via ${engine}`);
    setStatus(`Generating ${p.id} (${idx + 1}/${pages.length}) via ${engine}…`);
    try {
      const raw = engine === 'byok'
        ? await draftViaEndpoint({ baseUrl, apiKey, model, lang, dataUrl: p.dataUrl, context: p.context })
        : await draftLocal(p.dataUrl, { model: localModel },
            (prog) => setStatus(`Loading local model… ${Math.round((prog.progress || 0))}%`));
      const decorative = p.fullPage ? true : raw.trim() === 'DECORATIVE';
      const alt = decorative && !p.fullPage ? '' : raw;
      drafts.push({ ...p, alt, original: alt, decorative, decorativeAtGenerate: decorative, rawDraft: raw });
    } catch (e) {
      drafts.push({ ...p, alt: '', original: '', decorative: !!p.fullPage, decorativeAtGenerate: !!p.fullPage, error: String(e.message || e) });
      setStatus(`Item ${p.id} failed: ${e.message} — continuing.`);
    }
    renderRows();
  }
  setStatus(`Done: ${drafts.length} draft(s) — ${modeNote}. Edit, then export.`);
  setProgress(1, 'Done.', `${drafts.length} draft(s) ready for review`);
  // Clear key from memory after run; user must re-enter per session.
  $('apiKey').value = '';
});

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('exportJson').addEventListener('click', () => {
  download('alt-texts.json', JSON.stringify({
    source: {
      ...(lastMeta || {}),
      exportedAt: new Date().toISOString(),
    },
    items: drafts.map(({ id, page, name, width, height, alt, decorative, error }) => (
      { id, page, name, width, height, alt, decorative, error: error || undefined }
    )),
  }, null, 2), 'application/json');
});
$('exportCsv').addEventListener('click', () => {
  const rows = [['id', 'page', 'alt', 'decorative']];
  drafts.forEach((d) => rows.push([d.id, d.page, `"${(d.alt || '').replace(/"/g, '""')}"`, d.decorative ? '1' : '0']));
  download('alt-texts.csv', rows.map((r) => r.join(',')).join('\n'), 'text/csv');
});
