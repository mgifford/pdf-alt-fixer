# PDF Alt-Fixer (standalone)

Browser + Actions companion to [pdf-crawler](https://github.com/mgifford/pdf-crawler).
Separate repo by design: the crawler finds `ImageAltTextTest` failures, this tool drafts fixes.

## Two engines (your choice)

| Mode | Where AI runs | Key handling | Best for |
|---|---|---|---|
| Browser-local VLM | In-page via transformers.js + WebGPU, no network | No key at all | Private tests, no setup |
| My endpoint + key | Your Ollama / llama-server / OpenRouter / OpenAI | Typed per session, memory only, cleared after run | Quality drafts, local hardware LLMs |

Local installs can point the endpoint at `http://localhost:11434/v1` (Ollama) or `http://localhost:8080/v1` (llama-server) — closest to the hardware, no cloud needed.

GitHub Pages cannot keep secrets, so hosted keys live only in Actions (`OPENAI_API_KEY` repo secret → `FIX:` issues), never in the static site.

## Test locally

```bash
cd pdf-alt-fixer
npm install          # macOS: use npm install --ignore-scripts (skips Node-only sharp build)
npm run dev        # open the printed localhost URL, upload a PDF
```

Python path (same engine the Action uses):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/generate_alt.py --pdf sample.pdf --out alt-texts.json \
  --base-url http://localhost:11434/v1 --model qwen2.5-vl
```

## Actions fixer (pdf-crawler style)

1. Set repo secret `OPENAI_API_KEY` (and optional var `OPENAI_BASE_URL`).
2. Open an issue titled `FIX: https://example.com/file.pdf`.
3. The workflow comments with drafts + uploads `alt-texts.json`.

## Limits (v1)

- Browser extracts embedded images per page (skips stencil masks, tiling patterns, and sub-`min-size` icons; dedupes shared XObjects). Scanned/image-only PDFs fall back to full-page renders.
- Context is page-level text (up to ~2000 chars, word-boundary trimmed, scrollable in the table) — not yet proximity-scoped to each image's position.
- Browser cannot write PDF/UA tag trees; export JSON/CSV for review, tag in the Python/Drupal path.
- Local VLM weights are hundreds of MB on first run and need WebGPU (Chrome/Edge 113+).
