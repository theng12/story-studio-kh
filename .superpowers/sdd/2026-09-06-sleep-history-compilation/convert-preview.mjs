// Deterministic house recipe: whole-image resize to 1672x941 (fill, lanczos3) → lossless WebP effort 6.
// Runs twice into separate buffers and refuses to write unless both are byte-identical.
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
const [src, dst] = process.argv.slice(2)
const srcBytes = readFileSync(src)
const meta = await sharp(srcBytes).metadata()
const encode = () => sharp(srcBytes).resize(1672, 941, { fit: 'fill', kernel: 'lanczos3' }).webp({ lossless: true, effort: 6 }).toBuffer()
const a = await encode(); const b = await encode()
if (!a.equals(b)) { console.error('NON-DETERMINISTIC'); process.exit(1) }
writeFileSync(dst, a)
const out = await sharp(a).metadata()
console.log(JSON.stringify({ src, src_sha256: createHash('sha256').update(srcBytes).digest('hex'), src_bytes: statSync(src).size, src_dims: `${meta.width}x${meta.height}`, src_format: meta.format,
  dst, sha256: createHash('sha256').update(a).digest('hex'), bytes: a.length, dims: `${out.width}x${out.height}`, format: out.format, deterministic: true }))
