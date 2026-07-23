import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import process from 'node:process'

const repoRoot = resolve(import.meta.dirname, '..')
const frontendRoot = join(repoRoot, 'frontend')
const sourceRoots = ['app.vue', 'assets', 'components', 'layouts', 'pages']
const sourceExtensions = new Set(['.css', '.scss', '.ts', '.vue'])
const minimumPixels = 12
const declarationPatterns = [
  /font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)px/gi,
  /fontSize\s*:\s*['"]([0-9]+(?:\.[0-9]+)?)px['"]/gi,
]

async function collectFiles(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath))
    else if (sourceExtensions.has(extname(entry.name))) files.push(entryPath)
  }

  return files
}

const files = []
for (const sourceRoot of sourceRoots) {
  const path = join(frontendRoot, sourceRoot)
  if (extname(path)) files.push(path)
  else files.push(...await collectFiles(path))
}

const violations = []
for (const file of files) {
  const content = await readFile(file, 'utf8')
  const lineStarts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') lineStarts.push(index + 1)
  }

  for (const pattern of declarationPatterns) {
    pattern.lastIndex = 0
    for (const match of content.matchAll(pattern)) {
      const size = Number(match[1])
      if (size >= minimumPixels) continue
      let line = 1
      while (line < lineStarts.length && lineStarts[line] <= match.index) line += 1
      violations.push({
        file: relative(repoRoot, file),
        line,
        size,
        declaration: match[0],
      })
    }
  }
}

if (violations.length) {
  console.error(`Typography check failed: ${violations.length} declaration(s) are below ${minimumPixels}px.`)
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} — ${violation.declaration}`)
  }
  console.error('Use var(--font-xs) for compact supporting text or a larger shared type token.')
  process.exit(1)
}

console.log(`Typography check passed: no source text is smaller than ${minimumPixels}px.`)
