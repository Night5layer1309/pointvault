// Generates the 1024x500 Google Play feature graphic from brand assets.
// Run: node scripts/make-feature-graphic.mjs
import sharp from 'sharp'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const W = 1024
const H = 500

const bg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#27336a"/>
      <stop offset="1" stop-color="#131c3d"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="372" y="305" width="150" height="5" rx="2.5" fill="#5b6ba8"/>
  <text x="372" y="225" font-family="Arial, Segoe UI, sans-serif" font-size="92" font-weight="bold" fill="#ffffff">PointVault</text>
  <text x="376" y="285" font-family="Arial, Segoe UI, sans-serif" font-size="34" fill="#aab4d4">Field surveying companion</text>
  <text x="376" y="365" font-family="Arial, Segoe UI, sans-serif" font-size="24" fill="#8794be">Import  •  Map  •  Locate  •  Share survey points</text>
</svg>`

const icon = await sharp(path.join(root, 'public/icon-512.png'))
  .resize(280, 280)
  .toBuffer()

const out = path.join(root, 'PointVault - Google Play package/feature-graphic-1024x500.png')
await sharp(Buffer.from(bg))
  .composite([{ input: icon, top: 110, left: 70 }])
  .png()
  .toFile(out)

console.log('Wrote', out)
