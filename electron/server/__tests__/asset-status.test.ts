/**
 * Tests for the asset-readiness contract — centralised in
 * services/asset-status.ts and consumed by routes/ideas.ts buildRow.
 *
 * Scope: only the pieces of the contract that have been formally extracted
 * as pure functions today (script vs introduction marker detection).
 * Image, video, and audio status helpers remain integration-tested via
 * the routes test (they require real on-disk fixtures + provider stubs);
 * extracting those is tracked separately in the system audit roadmap.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  isIntroductionMarker,
  isScriptChaptersDocx,
  deriveScriptFolderState,
  stripDecorativePrefix,
} from '../services/asset-status.js'

describe('isIntroductionMarker', () => {
  test('matches the .intro.json sidecar (current format)', () => {
    assert.equal(isIntroductionMarker('TN0001_Script_Narration.intro.json'), true)
    assert.equal(isIntroductionMarker('Anything.intro.json'), true)
  })

  test('matches the legacy *_Introduction.docx file (pre-merge era)', () => {
    // Self-healing: episodes generated before the unified-narration
    // refactor still report `introduction: true` so users don't see
    // a sudden status regression. New runs replace these with the
    // sidecar + the merged narration docx.
    assert.equal(isIntroductionMarker('TN0001_Script_Narration_Introduction.docx'), true)
  })

  test('rejects unrelated files', () => {
    assert.equal(isIntroductionMarker('TN0001_Script_Narration.docx'), false)
    assert.equal(isIntroductionMarker('TN0001_Scene_Prompts.docx'), false)
    // Defensive: contract is specific about the suffix.
    assert.equal(isIntroductionMarker('TN0001_Introduction.txt'), false)
    assert.equal(isIntroductionMarker('intro.json'), false)
  })
})

describe('isScriptChaptersDocx', () => {
  test('matches the unified narration docx', () => {
    assert.equal(isScriptChaptersDocx('TN0001_Script_Narration.docx'), true)
  })

  test('does NOT match the legacy separate intro file', () => {
    // Even though intro is now merged into the narration, the legacy
    // separate file still exists in older projects. It's not a chapters
    // file, so the script flag stays independent of intro presence.
    assert.equal(isScriptChaptersDocx('TN0001_Script_Narration_Introduction.docx'), false)
  })

  test('rejects non-docx files', () => {
    assert.equal(isScriptChaptersDocx('TN0001_Script_Narration.txt'), false)
    assert.equal(isScriptChaptersDocx('TN0001_Script_Narration.json'), false)
    assert.equal(isScriptChaptersDocx('TN0001_Script_Narration.intro.json'), false)
  })
})

describe('deriveScriptFolderState', () => {
  test('empty folder → both false', () => {
    assert.deepEqual(deriveScriptFolderState([]), { script: false, introduction: false })
  })

  test('chapters docx only → script true, introduction false', () => {
    assert.deepEqual(
      deriveScriptFolderState(['TN0001_Script_Narration.docx']),
      { script: true, introduction: false },
    )
  })

  test('chapters + intro sidecar → both true (new unified format)', () => {
    assert.deepEqual(
      deriveScriptFolderState([
        'TN0001_Script_Narration.docx',
        'TN0001_Script_Narration.intro.json',
      ]),
      { script: true, introduction: true },
    )
  })

  test('chapters + legacy separate intro docx → both true (back-compat)', () => {
    assert.deepEqual(
      deriveScriptFolderState([
        'TN0001_Script_Narration.docx',
        'TN0001_Script_Narration_Introduction.docx',
      ]),
      { script: true, introduction: true },
    )
  })

  test('legacy intro-only (no chapters) → introduction true, script false', () => {
    // Pre-existing edge case from the separate-files era. Shouldn't
    // happen with the new merged format (intro requires existing
    // chapters now), but the back-compat code path still reports it.
    assert.deepEqual(
      deriveScriptFolderState(['TN0001_Script_Narration_Introduction.docx']),
      { script: false, introduction: true },
    )
  })

  test('ignores unrelated files in the script folder', () => {
    assert.deepEqual(
      deriveScriptFolderState([
        'TN0001_Script_Narration.docx',
        '.DS_Store',
        'README.txt',
        'old_notes.md',
      ]),
      { script: true, introduction: false },
    )
  })
})

describe('stripDecorativePrefix', () => {
  // Guards the episode-dir match from silently failing when users (or
  // cloud-sync tools) rename a completed episode folder with a checkmark
  // prefix. Status detection normalises before comparing to the code.
  test('strips ✅ prefix with trailing space', () => {
    assert.equal(stripDecorativePrefix('✅ EP0001 - Title'), 'EP0001 - Title')
  })

  test('strips ✔️ prefix', () => {
    assert.equal(stripDecorativePrefix('✔️ TN0005 - Another Title'), 'TN0005 - Another Title')
  })

  test('strips leading whitespace', () => {
    assert.equal(stripDecorativePrefix('   EP0002 - Title'), 'EP0002 - Title')
  })

  test('leaves plain folder names untouched', () => {
    assert.equal(stripDecorativePrefix('EP0001 - Title'), 'EP0001 - Title')
  })
})
