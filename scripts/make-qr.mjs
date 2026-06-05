// Generates QR assets that open PointVault directly (no typing, no search box).
// Run: node scripts/make-qr.mjs
import QRCode from 'qrcode'
import sharp from 'sharp'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'PointVault - share')
fs.mkdirSync(outDir, { recursive: true })

const URL = 'https://pointvault.app'

// 1) Plain high-res QR (for embedding anywhere)
const plainPath = path.join(outDir, 'qr-pointvault.png')
await QRCode.toFile(plainPath, URL, {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 900,
  color: { dark: '#1e2952', light: '#ffffff' },
})

// 2) A printable "scan card": white card, navy header, QR, name + URL
const qrBuf = await QRCode.toBuffer(URL, {
  errorCorrectionLevel: 'M',
  margin: 1,
  width: 620,
  color: { dark: '#1e2952', light: '#ffffff' },
})

const W = 800
const H = 1000
const card = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect width="${W}" height="170" fill="#1e2952"/>
  <text x="${W / 2}" y="105" text-anchor="middle" font-family="Arial, Segoe UI, sans-serif" font-size="64" font-weight="bold" fill="#ffffff">PointVault</text>
  <text x="${W / 2}" y="250" text-anchor="middle" font-family="Arial, Segoe UI, sans-serif" font-size="34" fill="#475569">Point your camera here to open the app</text>
  <rect x="78" y="300" width="644" height="644" rx="28" fill="none" stroke="#e2e8f0" stroke-width="3"/>
  <text x="${W / 2}" y="985" text-anchor="middle" font-family="Arial, Segoe UI, sans-serif" font-size="40" font-weight="bold" fill="#1e2952">pointvault.app</text>
</svg>`

const cardPath = path.join(outDir, 'qr-card-pointvault.png')
await sharp(Buffer.from(card))
  .composite([{ input: qrBuf, top: 312, left: 90 }])
  .png()
  .toFile(cardPath)

console.log('Wrote:')
console.log(' ', plainPath)
console.log(' ', cardPath)
