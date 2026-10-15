// Browser-local VLM via transformers.js (no key, private).
// Heavy first load; needs WebGPU. Import lazily so BYOK users never pay the cost.

let captioner = null;

export async function draftLocal(dataUrl, onProgress) {
  if (!('gpu' in navigator)) {
    throw new Error('WebGPU not available in this browser — switch to endpoint mode or use Chrome/Edge 113+.');
  }
  const { pipeline } = await import('@huggingface/transformers');
  captioner ??= await pipeline(
    'image-to-text',
    'HuggingFaceTB/SmolVLM2-256M-Video-Instruct',
    {
      dtype: 'q4',
      device: 'webgpu',
      progress_callback: (p) => onProgress?.(p),
    }
  );
  const out = await captioner(dataUrl, {
    prompt: 'Describe this PDF page image in one concise alt-text sentence (max 250 characters).',
    max_new_tokens: 128,
  });
  const text = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
  return (text || '').trim() || 'DECORATIVE';
}
