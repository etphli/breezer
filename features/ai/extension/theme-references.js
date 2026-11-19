export function themeReferenceImages(attachments, history = []) {
  for (const files of [attachments, ...history.slice(-40).reverse().map(message => message?.attachments)]) {
    if (!Array.isArray(files)) continue;
    const images = files.filter(file => typeof file?.image === 'string');
    if (images.length) return images;
  }
  return [];
}
