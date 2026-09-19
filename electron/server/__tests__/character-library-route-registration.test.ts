import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const routesIndex = readFileSync(resolve(import.meta.dirname, '../routes/index.ts'), 'utf8')
const characterRoutes = readFileSync(resolve(import.meta.dirname, '../routes/character-library.ts'), 'utf8')

test('character reference images are served through the main API router', () => {
  assert.match(routesIndex, /characterLibraryRouter/)
  assert.match(routesIndex, /app\.use\('\/api', characterLibraryRouter\)/)
  assert.match(characterRoutes, /\/character-library\/:id\/reference-image\/:filename/)
  assert.match(characterRoutes, /await readFile\(file\)/)
  // Bound to the validated local `filename`, not the raw route param — the
  // membership check alone was insufficient because `updateLibraryCharacter`
  // merges a caller-supplied `references` object verbatim, so the allow-list
  // itself could carry a traversal payload.
  assert.match(characterRoutes, /res\.type\(filename\)\.send\(image\)/)
  assert.match(characterRoutes, /path\.basename\(filename\) !== filename/)
})
