// NativeDecoder before the complete-frame optimization, copied from protocol.mjs
// SHA-256: 225e443a35d306476a552eee1b3c4ff6559f9fb4f16bdeae119764df292ce13e.
import { TextDecoder, types } from 'node:util';
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class NativeDecoder {
  #header = Buffer.alloc(4);
  #headerBytes = 0;
  #body = null;
  #bodyBytes = 0;
  push(chunk) {
    if (!types.isUint8Array(chunk)) throw new TypeError('Native input must be a byte array.');
    const messages = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#body === null) {
        const size = Math.min(4 - this.#headerBytes, chunk.length - offset);
        this.#header.set(chunk.subarray(offset, offset + size), this.#headerBytes);
        this.#headerBytes += size;
        offset += size;
        if (this.#headerBytes !== 4) break;
        const length = this.#header.readUInt32LE(0);
        if (!length || length > MAX_MESSAGE_BYTES) throw new Error('Invalid native message length.');
        if (offset === chunk.length) break;
        this.#body = Buffer.alloc(length);
        this.#bodyBytes = 0;
      }
      const size = Math.min(this.#body.length - this.#bodyBytes, chunk.length - offset);
      this.#body.set(chunk.subarray(offset, offset + size), this.#bodyBytes);
      this.#bodyBytes += size;
      offset += size;
      if (this.#bodyBytes !== this.#body.length) break;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#body);
      messages.push(JSON.parse(text));
      this.#body = null;
      this.#bodyBytes = 0;
      this.#headerBytes = 0;
    }
    return messages;
  }
  finish() {
    if (this.#headerBytes || this.#body !== null) throw new Error('Truncated native message.');
  }
}

