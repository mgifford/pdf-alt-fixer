// Browser-local captioning via transformers.js (no key, private).
// Heavy first load; needs WebGPU for larger models (the tiny default also
// runs on WASM/CPU, slowly). Import lazily so endpoint users never pay it.
// Default is the classic vit-gpt2 captioning checkpoint because the
// (image) -> text call pattern is stable across transformers.js versions;
// bigger VLMs can be typed into the UI once their call pattern is confirmed.

let captioner = null;
let loadedModel = null;

export async function draftLocal(dataUrl, { model, useWebGpu = true } = {}, onProgress) {
  const id = (model || 'Xenova/vit-gpt2-image-captioning').trim();
  const { pipeline, env } = await import('@huggingface/transformers');
  if (!useWebGpu || !('gpu' in navigator)) {
    env.device = 'wasm';
  }
  if (!captioner || loadedModel !== id) {
    captioner = await pipeline('image-to-text', id, {
      progress_callback: (p) => onProgress?.(p),
    });
    loadedModel = id;
  }
  const out = await captioner(dataUrl, { max_new_tokens: 100 });
  const text = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
  return ((text || '').trim() || 'DECORATIVE').slice(0, 250);
}
