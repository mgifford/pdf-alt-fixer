// Heuristic quality checks for alt text — applied to both tagged (existing)
// Alt values found in the PDF and AI-generated drafts. Heuristics only flag
// likely problems for the reviewer; they never block export.

const GENERIC = new Set([
  'image', 'photo', 'picture', 'graphic', 'logo', 'icon', 'banner',
  'embedded image', 'figure', 'illustration', 'diagram',
]);

export function rateAlt(text) {
  const issues = [];
  const t = (text || '').trim();
  if (!t) return [{ level: 'error', msg: 'Empty — needs alt text or decorative flag.' }];
  if (t.length < 10) {
    issues.push({ level: 'warn', msg: 'Very short — unlikely to convey the content.' });
  }
  if (t.length > 250) {
    issues.push({ level: 'warn', msg: `Long (${t.length} chars) — aim under ~250.` });
  }
  if (/\.(jpe?g|png|gif|svg|webp|bmp|tiff?)(\s|$)/i.test(t) || (/^[^\s]*\.(jpe?g|png|gif)$/i.test(t))) {
    issues.push({ level: 'error', msg: 'Looks like a file name, not a description.' });
  }
  if (GENERIC.has(t.toLowerCase())) {
    issues.push({ level: 'error', msg: 'Generic single word — describes nothing.' });
  }
  if (/^(an?\s+)?(image|picture|photo|graphic|screenshot|illustration)\s+of\s+(an?\s+)?(image|picture|photo|graphic)/i.test(t)) {
    issues.push({ level: 'warn', msg: 'Redundant phrasing ("picture of a picture") — describe the subject directly.' });
  } else if (/^(image|picture|photo|graphic|screenshot)\s+of\b/i.test(t)) {
    issues.push({ level: 'warn', msg: 'Starts with "image of" — screen readers already announce it as an image.' });
  }
  if (/^(todo|tbd|alt\s*text|description|untitled|placeholder)/i.test(t)) {
    issues.push({ level: 'error', msg: 'Placeholder text, not a description.' });
  }
  return issues;
}
