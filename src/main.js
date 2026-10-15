import { extractPages } from './pdfExtract.js';
import { draftViaEndpoint } from './byok.js';
import { draftLocal } from './localVlm.js';

const $ = (id) => document.getElementById(id);
let drafts = [];

// Restore non-secret prefs; key is never persisted.
try {
  $('baseUrl').value = localStorage.getItem('paf.baseUrl') || '';
  $('model').value = localStorage.getItem('paf.model') || '';
  $('lang').value = localStorage.getItem('paf.lang') || 'en';
} catch { /* private mode */ }

document.querySelectorAll('input[name="engine"]').forEach((r) =>
  r.addEventListener('change', () => {
    const byok = document.querySelector('input[name="engine"]:checked').value === 'byok';
    $('byokFields').hidden = !byok;
  })
);
$('byokFields').hidden = document.querySelector('input[name="engine"]:checked').value !== 'byok';

function setStatus(msg) { $('status').textContent = msg; }

function renderRows() {
  const body = $('resultsBody');
  body.innerHTML = '';
  drafts.forEach((d, i) => {
    const tr = document.createElement('tr');

    const page = document.createElement('td'); page.textContent = d.page; tr.appendChild(page);

    const prev = document.createElement('td');
    const img = document.createElement('img'); img.src = d.dataUrl; img.alt = ''; img.className = 'thumb';
    prev.appendChild(img); tr.appendChild(prev);

    const ctx = document.createElement('td'); ctx.textContent = d.context || '—'; tr.appendChild(ctx);

    const altTd = document.createElement('td');
    const ta = document.createElement('textarea');
    ta.id = `alt-${d.id}`; ta.value = d.decorative ? '' : d.alt;
    const lb = document.createElement('label'); lb.htmlFor = ta.id; lb.textContent = `Alt-text for page ${d.page}`;
    lb.style.cssText = 'position:absolute;left:-999px;';
    altTd.appendChild(lb); altTd.appendChild(ta);
    ta.addEventListener('input', () => { drafts[i].alt = ta.value; });
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
  const engine = document.querySelector('input[name="engine"]:checked').value;
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('apiKey').value;
  const model = $('model').value.trim();
  const lang = $('lang').value;
  try {
    localStorage.setItem('paf.baseUrl', baseUrl);
    localStorage.setItem('paf.model', model);
    localStorage.setItem('paf.lang', lang);
  } catch { /* ignore */ }
  if (engine === 'byok' && (!baseUrl || !model)) return setStatus('Enter API base URL and model.');

  setStatus('Extracting pages…');
  let pages;
  try {
    pages = await extractPages(file);
  } catch (e) { return setStatus(`PDF extraction failed: ${e.message}`); }

  drafts = [];
  for (const p of pages) {
    setStatus(`Generating ${p.id} (${pages.indexOf(p) + 1}/${pages.length}) via ${engine}…`);
    try {
      const raw = engine === 'byok'
        ? await draftViaEndpoint({ baseUrl, apiKey, model, lang, dataUrl: p.dataUrl, context: p.context })
        : await draftLocal(p.dataUrl, (prog) => setStatus(`Loading local model… ${Math.round((prog.progress || 0))}%`));
      const decorative = raw.trim() === 'DECORATIVE';
      drafts.push({ ...p, alt: decorative ? '' : raw, decorative });
    } catch (e) {
      drafts.push({ ...p, alt: '', decorative: false, error: String(e.message || e) });
      setStatus(`Item ${p.id} failed: ${e.message} — continuing.`);
    }
    renderRows();
  }
  setStatus(`Done: ${drafts.length} draft(s). Edit, then export.`);
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
