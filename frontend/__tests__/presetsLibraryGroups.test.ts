/**
 * The Presets library lists every preset pool the app writes.
 *
 * Its group list is hand-written, so a page that gains `usePresets({ configKey })`
 * silently leaves that pool off the library. This scan collects every configKey
 * the pages and components pass, and requires a group for each.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const library = readFileSync(join(root, 'pages/projects/[slug]/presets.vue'), 'utf8')

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? vueFiles(join(dir, entry.name))
    : entry.name.endsWith('.vue') ? [join(dir, entry.name)] : [])
}

test('every usePresets configKey has a group on the Presets page', () => {
  const used = new Set<string>()
  for (const file of [...vueFiles(join(root, 'pages')), ...vueFiles(join(root, 'components'))]) {
    if (file.endsWith('presets.vue')) continue
    for (const match of readFileSync(file, 'utf8').matchAll(/configKey:\s*'([a-z_]+)'/g)) used.add(match[1]!)
  }
  assert.ok(used.size > 10, 'the scan must actually find the pages')
  const missing = [...used].filter(key => !library.includes(`configKey: '${key}'`))
  assert.deepEqual(missing, [])
})

test('Introduction presets are read from where the Introduction page saves them', () => {
  const group = library.slice(library.indexOf("key: 'introduction'"), library.indexOf('},', library.indexOf("key: 'introduction'")))
  assert.match(group, /configKey: 'introduction'/)
  assert.match(group, /editLink: '\/introduction'/)
})

test('scene and thumbnail pools use their own keys, never the legacy image_* ones', () => {
  assert.doesNotMatch(library, /configKey: 'image_(prompts|generator)'/)
})
