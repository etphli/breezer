const MAX_ATTACHMENT_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_EDGE = 16_384;
const MAX_SOURCE_PIXELS = 48 * 1024 * 1024;
const MAX_CANVAS_EDGE = 2560;
const MAX_CANVAS_PIXELS = 4 * 1024 * 1024;
const MAX_JPEG_HEADER_BYTES = 1024 * 1024;
const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function pngDimensions(header) {
  if (header.byteLength < 33 || header.getUint32(0) !== 0x89504e47 ||
      header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(8) !== 13 ||
      header.getUint32(12) !== 0x49484452) return null; // IHDR
  return [header.getUint32(16), header.getUint32(20)];
}

function jpegDimensions(header) {
  if (header.byteLength < 2 || header.getUint16(0) !== 0xffd8) return null;

  // Skip metadata segments until the Start of Frame marker, before the scan.
  let offset = 2;
  while (offset + 3 < header.byteLength && header.getUint8(offset++) === 0xff) {
    while (offset < header.byteLength && header.getUint8(offset) === 0xff) offset++;
    if (offset + 2 >= header.byteLength) break;
    const marker = header.getUint8(offset++);
    if (marker === 0xda || marker === 0xd9 || marker === 0) break;
    if (marker === 0x01) continue;
    const length = header.getUint16(offset);
    if (length < 2 || offset + length > header.byteLength) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) break;
      return [header.getUint16(offset + 5), header.getUint16(offset + 3)];
    }
    offset += length;
  }
  return null;
}

function webpDimensions(header) {
  if (header.byteLength < 25 || header.getUint32(0) !== 0x52494646 ||
      header.getUint32(8) !== 0x57454250) return null; // RIFF/WEBP

  const chunk = header.getUint32(12);
  const length = header.getUint32(16, true);
  if (chunk === 0x56503858 && length === 10 && header.byteLength >= 30) { // VP8X
    // The canvas dimensions are two little-endian 24-bit fields.
    const width = header.getUint32(23, true) >>> 8;
    const height = header.getUint32(26, true) >>> 8;
    return [width + 1, height + 1];
  }
  if (chunk === 0x5650384c && length >= 5 && header.getUint8(20) === 0x2f) { // VP8L
    const bits = header.getUint32(21, true);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 0x56503820 && length >= 10 && header.byteLength >= 30 && // VP8
      header.getUint8(23) === 0x9d && header.getUint16(24) === 0x012a) {
    return [header.getUint16(26, true) & 0x3fff, header.getUint16(28, true) & 0x3fff];
  }
  return null;
}

function withImageName(blob, original) {
  const extension = EXTENSIONS[blob.type];
  const stem = original.name.replace(/\.[^.]+$/, '').trim() || 'Pasted image';
  const name = `${stem.slice(0, 254 - extension.length)}.${extension}`;
  return new File([blob], name, { type: blob.type, lastModified: original.lastModified });
}

function encodeCanvas(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(blob => {
    // Canvas can fall back to PNG when the requested encoder is unavailable.
    resolve(blob?.type === type && blob.size ? blob : null);
  }, type, quality));
}

async function compressBitmap(bitmap, original) {
  const canvas = document.createElement('canvas');
  const { width, height } = bitmap;
  let scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(width, height),
    Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  let type = 'image/webp';

  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable.');
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      let blob = await encodeCanvas(canvas, type, 0.88);
      if (!blob && type === 'image/webp') {
        type = 'image/jpeg';
        blob = await encodeCanvas(canvas, type, 0.88);
      }
      if (blob && blob.size <= MAX_ATTACHMENT_BYTES) return withImageName(blob, original);

      blob = await encodeCanvas(canvas, type, 0.68);
      if (blob && blob.size <= MAX_ATTACHMENT_BYTES) return withImageName(blob, original);
      if (!blob) break;
      const shrink = Math.sqrt(MAX_ATTACHMENT_BYTES / blob.size) * 0.95;
      scale *= Math.max(0.5, Math.min(0.85, shrink));
    }
  } catch {
    throw new Error('Could not prepare the pasted image.');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
  throw new Error('Could not shrink the pasted image to 512 KB.');
}

export async function preparePastedImage(file) {
  if (!Object.hasOwn(EXTENSIONS, file?.type)) throw new Error('Paste a PNG, JPEG, or WebP image.');
  if (!file.size) throw new Error('The pasted image is empty.');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('The pasted image is too large. Try a smaller screenshot.');

  // A small compressed file can still expand to a very large bitmap.
  let dimensions;
  try {
    const headerBytes = file.type === 'image/jpeg' ? MAX_JPEG_HEADER_BYTES : 33;
    const header = new DataView(await file.slice(0, headerBytes).arrayBuffer());
    if (file.type === 'image/png') dimensions = pngDimensions(header);
    else if (file.type === 'image/jpeg') dimensions = jpegDimensions(header);
    else dimensions = webpDimensions(header);
  } catch {
    throw new Error('Could not read the pasted image.');
  }
  if (!dimensions?.every(Boolean)) throw new Error('Could not decode the pasted image.');
  const [width, height] = dimensions;
  if (Math.max(width, height) > MAX_SOURCE_EDGE || width * height > MAX_SOURCE_PIXELS) {
    throw new Error('The pasted image is too large. Try a smaller screenshot.');
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('Could not decode the pasted image.');
  });
  try {
    if (file.size <= MAX_ATTACHMENT_BYTES) {
      return file.name.trim() && file.name.length <= 255 ? file : withImageName(file, file);
    }
    return await compressBitmap(bitmap, file);
  } finally {
    bitmap.close();
  }
}
