// BYOK path: call any OpenAI-compatible chat-completions endpoint with vision.
// Key stays in page memory only. Local installs can point at
// http://localhost:11434/v1 (Ollama) or http://localhost:8080/v1 (llama-server).

export async function draftViaEndpoint({ baseUrl, apiKey, model, lang, dataUrl, context }) {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const prompt = `Write concise alt-text (${lang || 'en'}, max 250 characters, no quotes) for this PDF page image. ` +
    `Describe purpose/content for a screen-reader user. Context: ${context ? context.slice(0, 300) : 'none'}. ` +
    `If purely decorative, reply exactly: DECORATIVE.`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 200,
    }),
  });
  if (!res.ok) throw new Error(`Endpoint ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 300));
  const json = await res.json();
  const text = (json.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Empty response from endpoint.');
  return text;
}
