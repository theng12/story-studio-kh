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
  assert.match(characterRoutes, /res\.sendFile\(file\)/)
})
