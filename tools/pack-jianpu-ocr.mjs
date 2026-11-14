import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';

const vendor = new URL('../vendor/tesseract/', import.meta.url);
const read = name => readFileSync(new URL(name, vendor));
const write = (name, bytes) => writeFileSync(new URL(name, vendor), gzipSync(bytes, { level: 9 }));

const model = gunzipSync(read('eng.traineddata.gz'));
const entries = model.readUInt32LE(0);
const offsets = Array.from({ length: entries }, (_, index) => Number(model.readBigInt64LE(4 + 8 * index)));
const header = Buffer.from(model.subarray(0, 4 + 8 * entries));
const components = [header];
let offset = header.length;
// Slot 19 is the English word dictionary (lstm-word-dawg). The glyph model stays intact.
for (const [index, start] of offsets.entries()) {
  if (start < 0 || index === 19) {
    header.writeBigInt64LE(-1n, 4 + 8 * index);
    continue;
  }
  const end = offsets.slice(index + 1).find(value => value >= 0) ?? model.length;
  components.push(model.subarray(start, end));
  header.writeBigInt64LE(BigInt(offset), 4 + 8 * index);
  offset += end - start;
}
write('eng-jianpu-v1.traineddata.gz', Buffer.concat(components));
const worker = Buffer.concat([
  read('tesseract-core-lstm.wasm.js'), Buffer.from('\n;\n'), read('worker.min.js'),
]);
write('jianpu-worker-v1.js.gz', worker);
writeFileSync(new URL('jianpu-worker-v1.js.br', vendor), brotliCompressSync(worker, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
}));
