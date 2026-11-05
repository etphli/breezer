import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

// Compare the screenshot's actual surface paint with its DOM geometry. Stable
// PNG bytes alone can preserve a compositor's repeated-tile artifact.
async function surfacePaintMatches(page, png, surface) {
  return page.evaluate(async ({ png, surface }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.fillStyle = surface.color; context.fillRect(0, 0, 1, 1);
    const expected = context.getImageData(0, 0, 1, 1).data;
    context.drawImage(image, 0, 0);
    const { left, right, bottom } = surface.rect;
    return [left + 12, (left + right) / 2, right - 12].every(x => {
      const pixel = context.getImageData(Math.floor(x * image.width / innerWidth), Math.floor((bottom - 12) * image.height / innerHeight), 1, 1).data;
      return [0, 1, 2].every(channel => Math.abs(pixel[channel] - expected[channel]) <= 8);
    });
  }, { png: png.toString('base64'), surface });
}

export async function captureStablePanel(page, path, { surfaceSelector, corruptFixture } = {}) {
  await page.mouse.move(page.viewportSize().width - 2, 2);
  const surface = surfaceSelector ? await page.locator(surfaceSelector).evaluate(node => ({ rect: node.getBoundingClientRect().toJSON(), color: getComputedStyle(node).backgroundColor })) : null;
  if (surface) {
    assert.ok(surface.rect.left >= 0 && surface.rect.right <= page.viewportSize().width && surface.rect.top >= 0 && surface.rect.bottom <= page.viewportSize().height, 'Captured surface fits the viewport');
    if (corruptFixture) assert.equal(await surfacePaintMatches(page, await readFile(corruptFixture), surface), false, 'Surface guard rejects the recorded corrupt screenshot');
  }
  let previous;
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const image = await page.screenshot({ animations: 'disabled', scale: 'css' });
    if (surface && !await surfacePaintMatches(page, image, surface)) { previous = undefined; continue; }
    if (previous?.equals(image)) { await writeFile(path, image); return { stableCaptures: attempt + 1, surfacePaintChecked: Boolean(surface), scale: 'css' }; }
    previous = image;
  }
  assert.fail(`${path} did not settle with matching surface paint`);
}
