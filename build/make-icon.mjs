// Generate macOS iconset PNG files from icon.svg, then run iconutil to make icon.icns
import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const svgPath = path.join(__dirname, 'icon.svg')
const iconsetDir = path.join(__dirname, 'icon.iconset')
const icnsPath = path.join(__dirname, 'icon.icns')

await fs.rm(iconsetDir, { recursive: true, force: true })
await fs.mkdir(iconsetDir, { recursive: true })

const svgBuffer = await fs.readFile(svgPath)

// macOS iconset requires these exact filenames
const specs = [
  { size: 16, name: 'icon_16x16.png' },
  { size: 32, name: 'icon_16x16@2x.png' },
  { size: 32, name: 'icon_32x32.png' },
  { size: 64, name: 'icon_32x32@2x.png' },
  { size: 128, name: 'icon_128x128.png' },
  { size: 256, name: 'icon_128x128@2x.png' },
  { size: 256, name: 'icon_256x256.png' },
  { size: 512, name: 'icon_256x256@2x.png' },
  { size: 512, name: 'icon_512x512.png' },
  { size: 1024, name: 'icon_512x512@2x.png' },
]

for (const { size, name } of specs) {
  await sharp(svgBuffer).resize(size, size).png().toFile(path.join(iconsetDir, name))
  console.log(`  ${name} (${size}x${size})`)
}

// Also save a 512x512 PNG for generic use / Linux
await sharp(svgBuffer).resize(512, 512).png().toFile(path.join(__dirname, 'icon.png'))
console.log('  icon.png (512x512)')

// Convert iconset → icns using macOS's iconutil
execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`)
console.log(`\nGenerated: ${icnsPath}`)

// Cleanup iconset directory
await fs.rm(iconsetDir, { recursive: true, force: true })
