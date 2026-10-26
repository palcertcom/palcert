// Derives every runtime PalCert application icon from the master image.
//
//   node apps/web/assets/brand/generate-icons.mjs
//
// The master is the authoritative artwork. Derivatives are only resized
// (Lanczos, alpha preserved) and losslessly compressed — never recoloured,
// cropped or redrawn. Re-run after replacing the master.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..');
const require = createRequire(join(web, 'package.json'));
// sharp ships with Next.js (its image pipeline); no extra dependency.
const sharp = require(require.resolve('sharp', { paths: [dirname(require.resolve('next'))] }));

const master = join(here, 'palcert-icon-master.png');

async function png(size) {
  return sharp(master)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
}

/** A Windows icon container holding PNG images, as every modern browser reads. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const out = {
  // Next.js file-convention metadata icons (src/app).
  'src/app/favicon.ico': async () =>
    ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(size) })))),
  'src/app/icon.png': () => png(512),
  'src/app/apple-icon.png': () => png(180),
  // The in-app brand mark, bundled by Next (1x / 2x / 3x of its ~30px size).
  'src/assets/brand/palcert-icon-64.png': () => png(64),
  'src/assets/brand/palcert-icon-128.png': () => png(128),
};

for (const [path, make] of Object.entries(out)) {
  const data = await make();
  writeFileSync(join(web, path), data);
  process.stdout.write(`${path} ${data.length} bytes\n`);
}
