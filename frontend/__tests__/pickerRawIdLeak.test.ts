/**
 * A picker may never show a customer a raw product handle.
 *
 * ── The defect ──
 *
 * `ModelMenu`'s trigger label ended in `|| props.modelValue`, and
 * `VoicePicker`'s ended in `|| (props.modelValue || '')`. Those last terms are
 * internal identifiers: a GenStudio product handle like
 * `gemini-3.1-flash-lite-discount`, or a voice id, or the `vsname:` transport
 * prefix a pooled local voice is saved under. In the happy path the chain never
 * reached them, which is why this survived so long.
 *
 * It reached them whenever the catalogue read FAILED. `ModelSelector` empties
 * `allModels` on a rejected fetch and deliberately does not run its "no longer
 * offered" branch (that would be a claim about a catalogue nobody has seen), so
 * the menu was left holding a saved id with no matching row and nothing to say
 * about it — and it said the id. `VoicePicker` had no fallback machinery of any
 * kind. Both then repeated the id in the trigger's `title`, so hovering did not
 * help either.
 *
 * ── What is pinned here ──
 *
 *   1. Under a FAILED catalogue read, no picker label contains the saved id, in
 *      the trigger text or anywhere else it is rendered.
 *   2. It says something true instead — the remembered name where there is one,
 *      a plain noun where there is not — and admits the app could not confirm it.
 *   3. Mid-flight nothing is called unverified: a read that has not failed yet
 *      must not be reported as one.
 *   4. A catalogue that DID load still speaks for itself, so the retirement
 *      message is not replaced by the unreachability message.
 *   5. The components carry no raw-id fallback in their source, and the tooltip
 *      renders the same label the trigger does.
 *
 * These are display rules only. Whether an unconfirmed selection may be
 * SUBMITTED is a separate question the server still answers exactly as before —
 * asserted below so a later reader does not mistake this for a relaxation.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  pickerTriggerLabel,
  unverifiedSelectionLabel,
  UNVERIFIED_SUFFIX,
} from '../utils/picker-trigger-label.ts'

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

/** The exact shape of handle that reached a customer's screen. */
const DEAD_HANDLE = 'gemini-3.1-flash-lite-discount'
const VOICE_HANDLE = 'genstudio-voice:8f2c1ad6e4b04c1e9a77'
const POOLED_LOCAL = 'vsname:Narrator Two'

describe('a failed catalogue read never renders a raw product handle', () => {
  test('model picker: with a remembered name, it names the model and admits it is unconfirmed', () => {
    const unverified = unverifiedSelectionLabel({
      savedId: DEAD_HANDLE,
      catalogueSize: 0,          // the read rejected — allModels was emptied
      loading: false,            // and it has finished failing
      rememberedName: 'Gemini 3.1 Flash Lite',
      unknownNoun: 'Saved model',
    })
    const label = pickerTriggerLabel({
      selectedLabel: '',
      missingLabel: '',
      unverifiedLabel: unverified,
      loading: false,
      loadingLabel: 'Loading models…',
      placeholder: 'Pick a model…',
    })

    assert.ok(!label.includes(DEAD_HANDLE), `the handle reached the trigger: ${label}`)
    assert.ok(label.startsWith('Gemini 3.1 Flash Lite'), `expected the remembered name: ${label}`)
    assert.ok(label.includes(UNVERIFIED_SUFFIX), `the customer must be told this is unconfirmed: ${label}`)
  })

  test('model picker: with NO remembered name it still refuses to show the handle', () => {
    // The worst case — a fresh machine, or a browser whose storage was cleared,
    // so there is genuinely no name to show. The old code fell through to the id
    // precisely here. A plain noun is a worse label and a better answer.
    const label = pickerTriggerLabel({
      unverifiedLabel: unverifiedSelectionLabel({
        savedId: DEAD_HANDLE,
        catalogueSize: 0,
        loading: false,
        rememberedName: '',
        unknownNoun: 'Saved model',
      }),
      loading: false,
      loadingLabel: 'Loading models…',
      placeholder: 'Pick a model…',
    })

    assert.ok(!label.includes(DEAD_HANDLE), `the handle reached the trigger: ${label}`)
    assert.ok(!label.includes('gemini'), `no fragment of the handle may leak: ${label}`)
    assert.equal(label, `Saved model ${UNVERIFIED_SUFFIX}`)
  })

  test('voice picker: the same rule, including the vsname transport prefix', () => {
    const cloud = unverifiedSelectionLabel({
      savedId: VOICE_HANDLE,
      catalogueSize: 0,
      loading: false,
      rememberedName: '',
      unknownNoun: 'Saved voice',
    })
    assert.ok(!cloud.includes(VOICE_HANDLE), `the voice id reached the trigger: ${cloud}`)
    assert.equal(cloud, `Saved voice ${UNVERIFIED_SUFFIX}`)

    // A pooled local voice is saved with a transport prefix. Rendering
    // `vsname:Narrator Two` shows the customer plumbing they did not ask about.
    const local = unverifiedSelectionLabel({
      savedId: POOLED_LOCAL,
      catalogueSize: 0,
      loading: false,
      rememberedName: 'Narrator Two',
      unknownNoun: 'Saved voice',
    })
    assert.ok(!local.includes('vsname:'), `the transport prefix reached the trigger: ${local}`)
    assert.equal(local, `Narrator Two ${UNVERIFIED_SUFFIX}`)
  })

  test('nothing is called unverified while the read is still in flight', () => {
    const remembered = unverifiedSelectionLabel({
      savedId: DEAD_HANDLE,
      catalogueSize: 0,
      loading: true,
      rememberedName: 'Gemini 3.1 Flash Lite',
      unknownNoun: 'Saved model',
    })
    assert.equal(remembered, 'Gemini 3.1 Flash Lite',
      'a read that has not failed must not be reported as a failure')

    // No remembered name mid-flight → the picker falls back to its loading word,
    // never to the id.
    const label = pickerTriggerLabel({
      unverifiedLabel: unverifiedSelectionLabel({
        savedId: DEAD_HANDLE,
        catalogueSize: 0,
        loading: true,
        rememberedName: '',
        unknownNoun: 'Saved model',
      }),
      loading: true,
      loadingLabel: 'Loading models…',
      placeholder: 'Pick a model…',
    })
    assert.equal(label, 'Loading models…')
    assert.ok(!label.includes(DEAD_HANDLE))
  })

  test('a catalogue that loaded still speaks for itself', () => {
    // Retirement and unreachability are different facts and must not share a
    // sentence. A loaded catalogue produces no unverified claim at all, so the
    // owner-supplied "No longer offered" wording survives.
    assert.equal(unverifiedSelectionLabel({
      savedId: DEAD_HANDLE,
      catalogueSize: 42,
      loading: false,
      rememberedName: 'Gemini 3.1 Flash Lite',
      unknownNoun: 'Saved model',
    }), '')

    assert.equal(pickerTriggerLabel({
      selectedLabel: '',
      missingLabel: 'No longer offered',
      unverifiedLabel: '',
      loading: false,
      placeholder: 'Pick a model…',
    }), 'No longer offered')

    // And a present row always wins over everything else.
    assert.equal(pickerTriggerLabel({
      selectedLabel: 'Claude Fable 5',
      missingLabel: 'No longer offered',
      unverifiedLabel: `Gemini 3.1 Flash Lite ${UNVERIFIED_SUFFIX}`,
    }), 'Claude Fable 5')
  })

  test('there is no branch that returns an identifier at all', () => {
    // Exhaustive over the empty state: with nothing selected, nothing remembered
    // and nothing loading, the only thing left is the placeholder.
    assert.equal(pickerTriggerLabel({ placeholder: 'Pick a model…' }), 'Pick a model…')
    assert.equal(pickerTriggerLabel({}), '')
    assert.equal(unverifiedSelectionLabel({
      savedId: '   ',
      catalogueSize: 0,
      loading: false,
      rememberedName: '',
      unknownNoun: 'Saved model',
    }), '', 'nothing selected means nothing to say')
  })
})

describe('the components cannot reintroduce the fallback', () => {
  const modelMenu = source('../components/ModelMenu.vue')
  const modelSelector = source('../components/ModelSelector.vue')
  const voicePicker = source('../components/VoicePicker.vue')

  test('ModelMenu builds its label from the shared rule and echoes it in the tooltip', () => {
    assert.match(modelMenu, /pickerTriggerLabel\(\{/)
    // The tooltip used to repeat the raw id, so hovering a dead pin showed the
    // handle even once the visible text was fixed.
    assert.match(modelMenu, /:title="triggerLabel"/)
    assert.doesNotMatch(modelMenu, /:title="selectedOption\?\.label \|\| modelValue/)
    assert.doesNotMatch(
      modelMenu, /triggerLabel[\s\S]{0,240}\|\|\s*props\.modelValue/,
      'the trigger label must never fall through to the saved id',
    )
  })

  test('both pickers feed the shared rule instead of writing their own wording', () => {
    assert.match(modelSelector, /unverifiedLabel\(\{/)
    assert.match(modelSelector, /:unverified-selection-label="unverifiedSelectionLabel"/)
    assert.match(voicePicker, /unverifiedSelectionLabel\(\{/)
    assert.doesNotMatch(
      voicePicker, /currentVoiceName = computed\([\s\S]{0,300}\|\|\s*\(props\.modelValue \|\| ''\)/,
      'the voice trigger must never fall through to the saved id',
    )
  })

  test('every successful read teaches the cache a name for the next failure', () => {
    // The fallback is only worth anything if something populates it. A picker
    // that reads a catalogue and does not remember the names has a fallback that
    // is empty on exactly the day it is needed.
    assert.match(modelSelector, /rememberedNames\.remember\(models\)/)
    assert.match(modelSelector, /rememberedNames\.hydrate\(\)/)
    assert.match(voicePicker, /rememberedVoiceNames\.remember\(/)
    assert.match(voicePicker, /rememberedVoiceNames\.hydrate\(\)/)
  })

  test('the money-fence is untouched — this changed what is SAID, not what may be sent', () => {
    // `selectModel` still refuses a model the loaded catalogue calls unusable,
    // and still refuses one that is not in the loaded catalogue at all. A
    // remembered NAME never becomes permission to submit.
    assert.match(modelSelector, /function selectModel\(value: string\): void \{\s*\n\s*const model = allModels\.value\.find/)
    assert.match(modelSelector, /if \(!model \|\| isDisabled\(model\)\) return/)
  })
})

/**
 * The fallback is only worth anything if something fills it. These exercise the
 * two caches directly — a name learned from a successful read must survive into
 * the next launch, which is the only moment the label above is ever needed.
 */
describe('remembered names survive to the failure that needs them', () => {
  test('a model name learned from a catalogue read is readable on the next launch', async () => {
    const { useGenStudioModelDisplay } = await import('../composables/useGenStudioModelDisplay.ts')
    const display = useGenStudioModelDisplay()

    display.remember([
      { id: DEAD_HANDLE, label: 'Gemini 3.1 Flash Lite', legacy_ids: ['gemini-flash-lite-legacy'] },
    ])

    // A fresh read straight out of storage — the shape a cold start sees.
    const stored = JSON.parse(localStorage.getItem('genstudio_model_display_labels_v1') || '{}')
    assert.equal(stored[DEAD_HANDLE], 'Gemini 3.1 Flash Lite')
    assert.equal(stored['gemini-flash-lite-legacy'], 'Gemini 3.1 Flash Lite',
      'a legacy id names the same product, so it must resolve to the same name')

    display.hydrate()
    assert.equal(display.knownName(DEAD_HANDLE), 'Gemini 3.1 Flash Lite')
    // '' for something never seen — NEVER the id, which is what `displayName`
    // returns and why a separate reader exists.
    assert.equal(display.knownName('a-product-this-browser-never-saw'), '')
    assert.equal(display.knownName(''), '')
  })

  test('a voice name learned from a catalogue read survives the same way', async () => {
    const { useRememberedVoiceNames } = await import('../composables/useRememberedVoiceNames.ts')
    const voices = useRememberedVoiceNames()

    voices.remember([
      { id: VOICE_HANDLE, name: 'Evening Narrator' },
      { id: POOLED_LOCAL, name: 'Narrator Two' },
      { id: '', name: 'ignored' },
      { id: 'no-name', name: '' },
    ])
    voices.hydrate()

    assert.equal(voices.knownName(VOICE_HANDLE), 'Evening Narrator')
    // Keyed by the ENCODED id — the same string that lands in `modelValue` — so
    // a pooled voice reads back as its name and never as its transport prefix.
    assert.equal(voices.knownName(POOLED_LOCAL), 'Narrator Two')
    assert.equal(voices.knownName('never-seen'), '', 'an unknown voice yields nothing, never its id')

    const stored = JSON.parse(localStorage.getItem('genstudio_voice_display_names_v1') || '{}')
    assert.ok(!('no-name' in stored), 'an entry with no name teaches nothing and is not stored')
    assert.ok(!('' in stored))
  })

  test('a remembered name feeds the label the customer actually reads', async () => {
    const { useRememberedVoiceNames } = await import('../composables/useRememberedVoiceNames.ts')
    const voices = useRememberedVoiceNames()
    voices.remember([{ id: VOICE_HANDLE, name: 'Evening Narrator' }])

    // The whole chain, as the picker runs it when its read has just failed.
    const label = unverifiedSelectionLabel({
      savedId: VOICE_HANDLE,
      catalogueSize: 0,
      loading: false,
      rememberedName: voices.knownName(VOICE_HANDLE),
      unknownNoun: 'Saved voice',
    })
    assert.equal(label, `Evening Narrator ${UNVERIFIED_SUFFIX}`)
    assert.ok(!label.includes(VOICE_HANDLE))
  })
})

describe('the outline review panel never shows a raw model or narrator-style id', () => {
  test('model and style are rendered through display names only', () => {
    const panel = source('../components/OutlineReviewPanel.vue')
    assert.doesNotMatch(panel, /\{\{\s*currentModel\s*\}\}/)
    assert.doesNotMatch(panel, /\{\{\s*outlineModel\s*\}\}/)
    assert.doesNotMatch(panel, /\{\{\s*generationParams\.style\s*\}\}/)
    assert.doesNotMatch(panel, /Narrator style: \$\{gp\.style\}/)
    assert.match(panel, /findChatModel\(currentModel\.value\)\?\.display_name/)
    assert.match(panel, /props\.styleLabels\?\.\[id\] \|\| ''/, 'an unknown style shows nothing, not its id')
  })
})
