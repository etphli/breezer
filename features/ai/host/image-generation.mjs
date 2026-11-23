import { Buffer } from 'node:buffer';

const MAX_IMAGE_BASE64 = 820_000;

export async function generateOpenAiImage(prompt, signal, {
  apiKey = process.env.BREEZER_OPENAI_IMAGE_API_KEY ?? process.env.OPENAI_API_KEY,
  fetchImage = fetch,
} = {}) {
  if (!apiKey?.trim()) throw new Error('Image generation needs an OpenAI API key. Set BREEZER_OPENAI_IMAGE_API_KEY in Breezer’s environment and restart.');
  const response = await fetchImage('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey.trim(), 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    body: JSON.stringify({
      model: 'gpt-image-2.5-flare',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      output_format: 'webp',
      output_compression: 65,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('OpenAI image generation returned HTTP ' + response.status + '. Check API key access and image usage limits.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength;
    if (length > MAX_IMAGE_BASE64 + 32_000) throw new Error('The generated image exceeded Breezer’s reply size limit.');
    chunks.push(chunk);
  }
  const encoded = JSON.parse(Buffer.concat(chunks, length).toString('utf8'))?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || encoded.length < 20 || encoded.length > MAX_IMAGE_BASE64
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('OpenAI did not return a usable image.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP'
      || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error('OpenAI returned an unexpected image format.');
  }
  return 'data:image/webp;base64,' + encoded;
}
