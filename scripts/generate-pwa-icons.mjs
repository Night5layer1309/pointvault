// Generate PWA + favicon icons from public/app-icon-source.png.
// Re-run when the source icon changes:  node scripts/generate-pwa-icons.mjs
//
// The source is a high-res raster (the compass-lock design on a navy rounded
// square with white background). We trim the white off, then export at the
// sizes the manifest + iOS + browsers need.

import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const sourcePath = join(root, "public", "app-icon-source.png");
const source = readFileSync(sourcePath);

const sizes = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "favicon-32.png", size: 32 },
];

for (const { name, size } of sizes) {
  await sharp(source)
    .trim({ threshold: 10 })
    .resize(size, size, {
      fit: "contain",
      background: { r: 30, g: 41, b: 82, alpha: 1 },
    })
    .png({ compressionLevel: 9 })
    .toFile(join(root, "public", name));
  console.log(`Wrote public/${name} (${size}x${size})`);
}
