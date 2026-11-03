export function encodeMessage(value) {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length > MAX_OUTPUT_BYTES) throw new Error('Native response is too large.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length);
  return Buffer.concat([header, json]);
}
