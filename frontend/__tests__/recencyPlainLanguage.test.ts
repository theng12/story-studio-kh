/**
 * The Recency page speaks to a channel owner, not to the niche file's author.
 *
 * It used to explain itself in field names — `recencyAvoidance`, "the cycler",
 * "tell the LLM", `extractPatterns` in "the niche JSON" — showed a raw niche id
 * and "(project/niche/default)", and listed kinds by their storage keys.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/recency.vue', import.meta.url)), 'utf8')
const template = page.slice(page.indexOf('<template>'), page.indexOf('<script'))

test('no developer language on screen', () => {
  for (const word of [/recencyAvoidance/, /cycler/i, /\bLLM\b/, /extractPatterns/, /niche JSON/i, /state\.niche_id/, /state\.lookback_source \}\}/]) {
    assert.doesNotMatch(template, word)
  }
})

test('kinds are shown by name, not by storage key', () => {
  assert.doesNotMatch(template, /\{\{ entry\.kind \}\}|\{\{ k \}\}/)
  assert.match(template, /kindLabel\(entry\.kind\)/)
  assert.match(page, /function kindLabel/)
})
