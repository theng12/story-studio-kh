/**
 * Boundary coverage: no private routing identity reaches a screen.
 *
 * `kie`/`kie.ai` was the upstream aggregator Story Studio routed through before
 * everything moved behind the GenStudio gateway (v1.0.669), alongside `fal.ai`,
 * `openrouter`, `genaipro` and the raw vendor keys used as transport identities.
 * GenStudio owns provider selection and does not disclose these. What Story
 * Studio MAY show is what GenStudio publishes (a voice's `provider` /
 * `engine_name`, a TTS model's `provider_name`) and its own local features
 * (Voice Studio KH, Image Studio KH, Chat Studio, macOS `say`).
 *
 * These are source assertions, the same shape as genstudioOnboardingBoundary:
 * the failure mode is a template binding or a label map quietly reintroducing
 * one of these names, which no behavioural test of the surrounding page catches.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const read = (relative: string) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)),
  'utf8',
)

describe('the model-picker label map cannot name an aggregator', () => {
  const source = read('../composables/useModelGroups.ts')

  test('PROVIDER_DISPLAY has no entry for a private routing identity', () => {
    for (const entry of [
      "kie: 'kie.ai'", "fal: 'fal.ai", "genaipro: 'GenAIPro", "openrouter: 'OpenRouter'",
      "openai: 'OpenAI'", "deepseek: 'DeepSeek'", "elevenlabs: 'ElevenLabs",
    ]) {
      assert.equal(source.includes(entry), false, `useModelGroups still maps ${entry}`)
    }
  })

  test('the label lookup does not fall back to the raw provider id', () => {
    // `PROVIDER_DISPLAY[p] || p` is how a legacy id on disk printed itself.
    assert.doesNotMatch(source, /PROVIDER_DISPLAY\[\w+\]\s*\|\|\s*\w+\s*[,)\n]/)
    assert.match(source, /export function publicProviderLabel/)
  })

  test('no provider is inferred from a model id', () => {
    assert.equal(source.includes("id.startsWith('eleven_')"), false)
    assert.equal(source.includes("id.startsWith('genaipro-')"), false)
  })
})

describe('the Jobs page will not print a legacy provider from a stored record', () => {
  const source = read('../pages/projects/[slug]/jobs.vue')

  test('account chips render the allowlisted label, never the stored provider id', () => {
    assert.match(source, /publicProviderLabel/)
    // The old row iterated the raw map and put `pid` in the tooltip.
    assert.equal(source.includes('v-for="(acc, pid) in job.accounts_used"'), false)
    assert.equal(source.includes('`Provider: ${pid}'), false)
    assert.match(source, /function visibleAccounts/)
  })
})

describe('image surfaces invent no provider and echo no legacy one', () => {
  test('the prompt-cap table no longer defaults a model to the aggregator', () => {
    const source = read('../pages/projects/[slug]/image-prompts.vue')
    assert.equal(source.includes("|| 'kie'"), false,
      "`provider: m?.provider || 'kie'` labelled every unattributed model with the aggregator")
    assert.equal(source.includes('{{ row.provider }}'), false)
  })

  test('the repair detail rows keep provider identity and exact task ids internal', () => {
    const source = read('../pages/projects/[slug]/images.vue')
    assert.equal(source.includes("{{ item.provider || 'provider' }}"), false,
      'this printed the transport recorded in a pre-migration .task-manifest.json')
    assert.doesNotMatch(source, /Task: \{\{ item\.task_id \}\}/)
    assert.match(source, /Can be recovered for free/)
  })
})

describe('the missing-key toast names one key and no vendors', () => {
  const source = read('../composables/useToast.ts')

  test('the branch does not match or echo retired vendor names', () => {
    for (const vendor of ['kie', 'fal.ai', 'OpenRouter', 'GenAIPro', 'Anthropic']) {
      assert.equal(source.includes(vendor), false, `useToast still mentions ${vendor}`)
    }
  })

  test('it still tells the customer a key is missing, and which one', () => {
    assert.match(source, /API key configured/)
    assert.match(source, /GenStudio API key missing/)
  })
})
