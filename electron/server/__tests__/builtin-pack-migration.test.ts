/**
 * Built-ins → packs: the retired `builtin-*` visual style ids an episode may
 * still carry (content-packs/legacy-migration-dispositions.json, `style:builtin-*`).
 *
 * WHAT THIS PINS — item 7 of the 386 batch (owner, 2026-11-07): every retired
 * built-in id with an authored pack resolves, at read time, to the Store style
 * that pack ACTUALLY SHIPS. The ledger decides which ids retired and which pack
 * took each over; the pack's own content/visual-style.json says what style id
 * it publishes — so a broken or guessed alias fails here rather than in an
 * episode that names the id.
 *
 * Read-time only (AGENTS §5): no preset, project or pack is rewritten, and
 * this file touches no stored episode data.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { aliasedVisualStyleId } from '../content-packs/style-aliases.js'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const LEDGER = path.join(ROOT, 'content-packs', 'legacy-migration-dispositions.json')

interface LedgerDisposition {
  legacy_key?: string
  disposition?: string
  target?: { source_path?: string }
}

test('every retired built-in style id with an authored pack resolves to the style that pack ships', () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) as { dispositions: LedgerDisposition[] }
  const retired = ledger.dispositions.filter(entry =>
    entry.legacy_key?.startsWith('style:builtin-') && entry.disposition === 'authored-standalone')
  // The 17 ids of the retired frontend catalogue (removed 2026-09-02). A lower
  // count means the ledger lost entries this table still answers for.
  assert.ok(retired.length >= 17,
    `ledger lists ${retired.length} retired built-in styles with packs, expected at least 17`)

  for (const entry of retired) {
    const legacyId = entry.legacy_key!.slice('style:'.length)
    const styleId = aliasedVisualStyleId(legacyId)
    assert.ok(styleId,
      `${legacyId} is retired but carries no alias — an episode still naming it cannot resolve`)

    const sourcePath = entry.target?.source_path
    assert.ok(sourcePath, `${legacyId}: authored-standalone disposition without a source path`)
    const docPath = path.join(ROOT, sourcePath, 'content', 'visual-style.json')
    assert.ok(fs.existsSync(docPath),
      `${legacyId}: pack source missing at ${sourcePath} — the alias would point at nothing`)
    const doc = JSON.parse(fs.readFileSync(docPath, 'utf8')) as { id?: string }
    assert.equal(doc.id, styleId,
      `${legacyId} aliases ${styleId} but its pack ships ${doc.id} — broken reference`)
  }
})
