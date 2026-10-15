import { extractImages } from './pdfExtract.js';
import { draftViaEndpoint } from './byok.js';
import { draftLocal } from './localVlm.js';

const $ = (id) => document.getElementById(id);
let drafts = [];

// Restore non-secret prefs; key is never persisted.
try {
  $('baseUrl').value = localStorage.getItem('paf.baseUrl') || '';
  $('model').value = localStorage.getItem('paf.model') || '';
  $('lang').value = localStorage.getItem('paf.lang') || 'en';
  $('localModel').value = localStorage.getItem('paf.localModel') || '';
} catch { /* private mode */ }

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

function setStatus(msg) { $('status').textContent = msg; }

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
    fullLink.appendChild(img); prev.appendChild(fullLink); tr.appendChild(prev);

    const ctx = document.createElement('td');
    const ctxBox = document.createElement('div'); ctxBox.className = 'ctx';
    ctxBox.textContent = d.context || '—'; ctx.appendChild(ctxBox); tr.appendChild(ctx);

    const altTd = document.createElement('td');
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
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset to AI draft';
    resetBtn.setAttribute('aria-label', `Reset alt-text for ${d.id} to the AI draft`);
    const syncEdited = () => {
      const edited = ta.value !== (d.original || '');
      editedSmall.textContent = d.error ? '' : (edited ? 'edited' : 'AI draft — unedited');
      resetBtn.disabled = edited ? false : true;
    };
    ta.addEventListener('input', () => { drafts[i].alt = ta.value; syncEdited(); });
    resetBtn.addEventListener('click', () => {
      ta.value = d.original || '';
      drafts[i].alt = ta.value;
      const cb = document.getElementById(`dec-${d.id}`);
      if (cb) { cb.checked = !!d.decorative; drafts[i].decorative = !!d.decorative; }
      syncEdited();
    });
    altTd.appendChild(resetBtn);
    syncEdited();
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
    cb.setAttribute('aria-label', `Mark page ${d.page} decorative`);
    cb.addEventListener('change', () => { drafts[i].decorative = cb.checked; });
    dec.appendChild(cb); tr.appendChild(dec);

    body.appendChild(tr);
  });
  $('resultsTable').hidden = drafts.length === 0;
  $('exportJson').disabled = $('exportCsv').disabled = drafts.length === 0;
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

  setStatus('Extracting embedded images…');
  let pages;
  try {
    const minSize = Math.max(1, parseInt($('minSize').value, 10) || 50);
    pages = await extractImages(file, { minSize });
  } catch (e) { return setStatus(`PDF extraction failed: ${e.message}`); }
  if (!pages.length) return setStatus('No images found (try lowering the minimum size).');
  const embeddedCount = pages.filter((p) => !p.fullPage).length;
  const modeNote = embeddedCount
    ? `${embeddedCount} embedded image(s)`
    : 'no embedded images — full-page fallback (scanned PDF?)';

  drafts = [];
  for (const p of pages) {
    setStatus(`Generating ${p.id} (${pages.indexOf(p) + 1}/${pages.length}) via ${engine}…`);
    try {
      const raw = engine === 'byok'
        ? await draftViaEndpoint({ baseUrl, apiKey, model, lang, dataUrl: p.dataUrl, context: p.context })
        : await draftLocal(p.dataUrl, { model: localModel },
            (prog) => setStatus(`Loading local model… ${Math.round((prog.progress || 0))}%`));
      const decorative = raw.trim() === 'DECORATIVE';
      const alt = decorative ? '' : raw;
      drafts.push({ ...p, alt, original: alt, decorative });
    } catch (e) {
      drafts.push({ ...p, alt: '', decorative: false, error: String(e.message || e) });
      setStatus(`Item ${p.id} failed: ${e.message} — continuing.`);
    }
    renderRows();
  }
  setStatus(`Done: ${drafts.length} draft(s) — ${modeNote}. Edit, then export.`);
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
  download('alt-texts.json', JSON.stringify(drafts.map(({ id, page, alt, decorative }) => ({ id, page, alt, decorative })), null, 2), 'application/json');
});
$('exportCsv').addEventListener('click', () => {
  const rows = [['id', 'page', 'alt', 'decorative']];
  drafts.forEach((d) => rows.push([d.id, d.page, `"${(d.alt || '').replace(/"/g, '""')}"`, d.decorative ? '1' : '0']));
  download('alt-texts.csv', rows.map((r) => r.join(',')).join('\n'), 'text/csv');
});
