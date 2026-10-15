#!/usr/bin/env python3
"""Generate draft alt-texts for PDF images via any OpenAI-compatible endpoint.

Local use (Ollama / llama-server need no key):
    python scripts/generate_alt.py --pdf sample.pdf --out alt-texts.json \\
        --base-url http://localhost:11434/v1 --model qwen2.5-vl

Actions use: pass --base-url/--model and set OPENAI_API_KEY env.
v1 outputs per-image drafts (JSON). Full PDF/UA retagging is out of scope.
"""
import argparse
import base64
import io
import json
import os
import sys

import fitz  # PyMuPDF
import httpx


def pixmap_b64(page, xref, max_side=768):
    pix = fitz.Pixmap(page.parent, xref)
    if pix.n > 4:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    w, h = pix.width, pix.height
    scale = min(1.0, max_side / max(w, h))
    if scale < 1.0:
        mat = fitz.Matrix(scale, scale)
        pix = fitz.Pixmap(page.parent, xref)  # reload, then scale via page render below
        # Fallback: render cropped page region instead of raw xref scaling.
    buf = io.BytesIO()
    pix.save(buf, "png")
    return base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", default="alt-texts.json")
    ap.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", "http://localhost:11434/v1"))
    ap.add_argument("--model", default=os.environ.get("VLM_MODEL", "qwen2.5-vl"))
    ap.add_argument("--api-key", default=os.environ.get("OPENAI_API_KEY", ""))
    ap.add_argument("--lang", default="en")
    ap.add_argument("--min-size", type=int, default=50)
    ap.add_argument("--max-images", type=int, default=50)
    args = ap.parse_args()

    doc = fitz.open(args.pdf)
    items = []
    seen = set()
    for pno, page in enumerate(doc, start=1):
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                continue
            seen.add(xref)
            try:
                pix = fitz.Pixmap(doc, xref)
            except Exception:
                continue
            if pix.width < args.min_size or pix.height < args.min_size:
                continue
            words = " ".join(w[4] for w in page.get_text("words")[:150])
            items.append({"id": f"p{pno}_x{xref}", "page": pno, "xref": xref,
                          "width": pix.width, "height": pix.height, "context": words[:1000]})
            if len(items) >= args.max_images:
                break
        if len(items) >= args.max_images:
            break

    headers = {"Content-Type": "application/json"}
    if args.api_key:
        headers["Authorization"] = f"Bearer {args.api_key}"
    url = args.base_url.rstrip("/") + "/chat/completions"
    drafts = []
    with httpx.Client(timeout=120) as client:
        for it in items:
            page = doc[it["page"] - 1]
            try:
                b64 = pixmap_b64(page, it["xref"])
            except Exception as e:
                drafts.append({**it, "alt": "", "error": f"extract: {e}"})
                continue
            prompt = (f"Write concise alt-text ({args.lang}, max 250 chars, no quotes) for this PDF image. "
                      f"Context: {it['context'] or 'none'}. If purely decorative reply exactly: DECORATIVE.")
            try:
                r = client.post(url, headers=headers, json={
                    "model": args.model,
                    "messages": [{"role": "user", "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}],
                    "max_tokens": 200})
                r.raise_for_status()
                text = (r.json()["choices"][0]["message"]["content"] or "").strip()
            except Exception as e:
                drafts.append({**it, "alt": "", "error": str(e)[:300]})
                continue
            drafts.append({**it, "alt": "" if text == "DECORATIVE" else text,
                           "decorative": text == "DECORATIVE"})
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(drafts, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(drafts)} draft(s) to {args.out}")


if __name__ == "__main__":
    sys.exit(main())
