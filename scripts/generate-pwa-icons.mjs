// Generate PNG PWA icons from public/favicon.svg.
// Run once when the source SVG changes:  node scripts/generate-pwa-icons.mjs
//
// The SVG itself is non-square (48x46) with a transparent background. Each
// output is the SVG centered with ~10% padding on a solid brand-purple
// background, so the icon looks like a real app tile on both light and dark
// home screens and survives Android's adaptive icon mask.

import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const svgPath = join(root, "public", "favicon.svg");
const svg = readFileSync(svgPath);

const sizes = [192, 512];
const brandPurple = { r: 134, g: 59, b: 255, alpha: 1 };

for (const size of sizes) {
  const padding = Math.round(size * 0.12);
  const innerSize = size - padding * 2;

  const innerPng = await sharp(svg, { density: 600 })
    .resize({
      width: innerSize,
      height: innerSize,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: brandPurple,
    },
  })
    .composite([{ input: innerPng, top: padding, left: padding }])
    .png({ compressionLevel: 9 })
    .toFile(join(root, "public", `icon-${size}.png`));

  console.log(`Wrote public/icon-${size}.png`);
}

// Also generate an Apple touch icon at 180x180 (iOS standard).
const appleSize = 180;
const applePadding = Math.round(appleSize * 0.12);
const appleInner = await sharp(svg, { density: 600 })
  .resize({
    width: appleSize - applePadding * 2,
    height: appleSize - applePadding * 2,
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

await sharp({
  create: {
    width: appleSize,
    height: appleSize,
    channels: 4,
    background: brandPurple,
  },
})
  .composite([{ input: appleInner, top: applePadding, left: applePadding }])
  .png({ compressionLevel: 9 })
  .toFile(join(root, "public", "apple-touch-icon.png"));

console.log("Wrote public/apple-touch-icon.png");
