import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const POLICY = new URL('../../..', import.meta.url)
const POLICY_PATH = new URL('docs/product/content-store-paid-wave-boundaries.md', POLICY)

const REQUIRED_HEADINGS = [
  'Net-new outcome',
  'Material content',
  'No legacy rebilling',
  'Independent identity',
  'Proofable claim',
  'Complete use',
  'Transparent dependency',
]

const APPROVED_FOUNDATIONS = [
  'Wild Worlds',
  'First Humans',
  'Deep Time',
  'Business Explained',
  'Human Behavior',
  'History Explained',
  'A Life As…',
  'Calm Mind',
  'Build Momentum',
  'Sleep Journeys',
]

test('paid-wave boundary policy preserves the approved admission gates', async () => {
  const policy = await readFile(POLICY_PATH, 'utf8')
  const normalizedPolicy = policy.replace(/\s+/g, ' ')

  for (const heading of REQUIRED_HEADINGS) {
    assert.match(policy, new RegExp(`^## ${heading}$`, 'm'))
  }

  const foundations = [...policy.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm)]
    .map(([, foundation]) => foundation)
    .filter((foundation) => foundation !== 'Free foundation' && foundation !== '---')
  assert.deepEqual(foundations, APPROVED_FOUNDATIONS)

  assert.match(normalizedPolicy, /proposal[^\n]*before[^\n]*author/i)
  assert.match(normalizedPolicy, /Studio Library[^\n]*recommend[^\n]*owner[^\n]*(?:approve|decision)/i)
  assert.match(normalizedPolicy, /independent[^\n]*wave[^\n]*review/i)
  assert.match(normalizedPolicy, /no automatic(?:ally)?[^\n]*(?:publication|publish)/i)
  assert.match(normalizedPolicy, /unchanged[^\n]*legacy[^\n]*(?:content|files)[^\n]*cannot[^\n]*(?:sell|rebill)/i)

  assert.doesNotMatch(policy, /com\.storystudio\.[a-z0-9.-]+/i)
  assert.doesNotMatch(policy, /(?:product|pack|release|sku|family)\s+id\s*[:=]/i)
  assert.doesNotMatch(policy, /(?:recommended|catalog|credit|list)\s*price\s*[:=]\s*\d/i)
  assert.doesNotMatch(policy, /credit price\s*(?:is|of|:)\s*\d/i)
  assert.doesNotMatch(policy, /discount\s*[:=]\s*\d/i)
})
