import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const scripts = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)),
  'utf8',
)

describe('Script Generator workspace', () => {
  test('keeps regeneration controls visible without an advanced disclosure', () => {
    assert.match(scripts, /class="script-regeneration-controls"/)
    assert.match(scripts, /<strong>Force regenerate<\/strong>/)
    assert.doesNotMatch(scripts, /Normalize legacy narration/)
    assert.doesNotMatch(scripts, /label="Advanced options"/)
    assert.doesNotMatch(scripts, /scriptAdvancedExpanded/)
  })

  test('uses a Formula-owned narrator', () => {
    assert.match(scripts, /Formula narrator/)
    assert.match(scripts, /availableNarratorStyles/)
    assert.doesNotMatch(scripts, /A — Warm & intimate first-person/)
    assert.match(scripts, /Episode direction/)
  })

  test('the channel opening is no longer configured on this page at all', () => {
    // v1.4.73 — it was a checkbox on the Outline tab, gated on the niche's
    // `openingProfile`, which one niche of twenty-one declares. Seven of ten
    // channels had no control and no explanation. It is its own optional
    // stage now; see introductionSidebarStage.test.ts for the rendered proof.
    assert.doesNotMatch(scripts, /v-if="openingProfile"/,
      'the niche must not gate a control again')
    assert.doesNotMatch(scripts, /Include \{\{ openingProfile\.label \}\}/)
    assert.doesNotMatch(scripts, /watch\(openingProfile/,
      'nothing may reset the channel\'s answer on a context reload')
    assert.doesNotMatch(scripts, /class="opening-model-note"/)
    assert.doesNotMatch(scripts, /🎬 Introduction/)
    // Exactly one language-model picker on this page, as before.
    assert.equal(scripts.match(/<ModelSelector/g)?.length, 1)
  })

  test('the Introduction page owns the opening\u2019s model choice, not this one', () => {
    // REVERSES the v1.4.73 rule that used to be asserted here.
    //
    // The opening shipped with no picker at all, on the reasoning that one
    // language-model choice is easier to trust than two that can disagree.
    // The owner overruled it: "what is the model picker not added. i don't
    // care if it's the same model or a different model writing it."
    //
    // So the choice exists on the Introduction page, and the DEFAULT is still
    // the shared one — a blank saved model means "follow the Script
    // Generator", which is what every channel already had. The Script page
    // still keeps exactly one picker: this is not a second control here.
    const page = readFileSync(
      fileURLToPath(new URL('../pages/projects/[slug]/introduction.vue', import.meta.url)), 'utf8')
    assert.match(page, /<ModelSelector/, 'the owner asked for the picker; it must exist')
    assert.match(page, /The same one as the chapters/,
      'and the shared model must still be offered as the default choice')
    assert.equal(scripts.match(/<ModelSelector/g)?.length, 1,
      'the Script Generator still has exactly one picker of its own')
  })

  test('has one review-first creation action instead of a competing one-click script chain', () => {
    assert.match(scripts, /generate-label="Create Outline"/)
    assert.doesNotMatch(scripts, /⚡ Generate script/)
    assert.doesNotMatch(scripts, /Include introduction/)
    assert.doesNotMatch(scripts, /function generateScript\(/)
  })

  test('episode direction, Force and pasted import text never ride along to the next episode', () => {
    const swap = scripts.slice(scripts.indexOf('watch(() => form.episode_id, (newEp, oldEp) => {'))
    const body = swap.slice(0, swap.indexOf('\n})') + 3)
    for (const reset of [/form\.manual_guidance = ''/, /form\.force = false/, /byoText\.value = ''/,
      /outlineTotalChapters\.value = 0/, /autoIntroForEpisode\.value = ''/]) {
      assert.match(body, reset)
    }
    assert.match(body, /not carried over to/, 'the drop is announced (AGENTS.md §4)')
    // This episode's own saved direction comes back with its outline, once.
    assert.match(scripts, /payload\.episodeId === form\.episode_id && guidanceLoadedFor\.value !== form\.episode_id/)
    assert.match(scripts, /form\.manual_guidance = payload\.manualGuidance \|\| ''/)
  })

  test('Force switches itself off after a submit, and an existing outline is never replaced unasked', () => {
    const submit = scripts.slice(scripts.indexOf('async function submitOutline'), scripts.indexOf('function waitForJob'))
    assert.match(submit, /if \(outlineTotalChapters\.value > 0\)[\s\S]*?await ask\(/)
    assert.match(submit, /Create a new outline for \$\{targetEpisode\}\?/)
    assert.match(submit, /chapter\$\{written === 1 \? '' : 's'\} written/)
    const ordinaryMarker = submit.indexOf('// An outline already exists for this episode')
    assert.ok(ordinaryMarker >= 0, 'ordinary outline submission block exists')
    const ordinarySubmit = submit.slice(ordinaryMarker)
    const positions = {
      ask: ordinarySubmit.indexOf('await ask('),
      confirm: ordinarySubmit.indexOf('confirmGeneration('),
      begin: ordinarySubmit.indexOf('freshScriptAction.begin(params)'),
      complete: ordinarySubmit.indexOf('freshScriptAction.complete(operationId)'),
      owner: ordinarySubmit.indexOf('ownsOutlineSubmit(submitOwner)'),
      clearForce: ordinarySubmit.indexOf('form.force = false'),
    }
    for (const [name, position] of Object.entries(positions)) {
      assert.ok(position >= 0, `${name} marker exists in ordinary outline submission`)
    }
    assert.ok(positions.ask < positions.begin, 'asks before the paid request')
    assert.ok(positions.confirm < positions.begin, 'confirms the model request before admission')
    assert.ok(positions.complete < positions.clearForce, 'the accepted request clears Force for the next action')
    assert.ok(positions.owner < positions.clearForce, 'a late response cannot clear the current episode’s Force choice')
  })

  test('the automatic opening is keyed to the episode whose outline run armed it', () => {
    assert.doesNotMatch(scripts, /autoIntroAfterScript/)
    assert.doesNotMatch(scripts, /selectedEpisode\.value\?\.episode_id/, 'rows carry episode_code, not episode_id')
    const submit = scripts.slice(scripts.indexOf('async function submitOutline'), scripts.indexOf('function waitForJob'))
    // Armed only after the POST is accepted, never before the confirms.
    assert.ok(submit.indexOf('autoIntroForEpisode.value = ') > submit.indexOf("await post<{ job_id: string }>(`/projects/${slug.value}/generate/outline-only`"))
    assert.match(scripts, /armed === form\.episode_id && selectedEpisode\.value\?\.episode_code === armed/)
  })

  test('importing over existing work asks first and names the episode', () => {
    const imp = scripts.slice(scripts.indexOf('async function importContent'), scripts.indexOf('function onExpansionQueued'))
    assert.match(imp, /scriptGenerated\.value \|\| outlineTotalChapters\.value > 0/)
    assert.match(imp, /Replace \$\{ep\}'s script\?/)
    assert.match(imp, /_trash folder/)
    assert.ok(imp.indexOf('await ask(') < imp.indexOf('byoImporting.value = true'))
  })

  test('Create outline says what is missing instead of a generic disabled state', () => {
    assert.match(scripts, /:generate-status="scriptJobActiveForEpisode \? `Building outline for \$\{form\.episode_id\}…` : submitDisabledReason"/)
    assert.match(scripts, /if \(!form\.episode_id\) return 'Pick an episode first'/)
    assert.match(scripts, /if \(!scriptModelReady\.value\) return 'Pick a writing model'/)
  })
})

describe('Chapters per request (1.4.359)', () => {
  const panel = readFileSync(
    fileURLToPath(new URL('../components/OutlineReviewPanel.vue', import.meta.url)),
    'utf8',
  )

  test('the Script page carries both modes and their values in the form', () => {
    assert.match(scripts, /chapter_batch_mode: 'count' as 'count' \| 'length'/)
    assert.match(scripts, /chapters_per_request: 0/)
    assert.match(scripts, /chapter_batch_words: 1800/)
    assert.match(scripts, /<label>Chapters per request<\/label>/)
    assert.match(scripts, /<option value="count">A fixed number of chapters<\/option>/)
    assert.match(scripts, /<option value="length">By length \(words\)<\/option>/)
    // The owner's one-line hint, verbatim.
    assert.match(scripts, /Fewer chapters per request is safer for long or Khmer chapters\./)
  })

  test('the setting is reusable configuration: preset and last choice', () => {
    // AGENTS.md §5 — a preset restores reusable settings, never episode state.
    // These three keys are reusable configuration, so they belong in the form
    // that the Script preset snapshots wholesale.
    const remembered = scripts.slice(scripts.indexOf("useRememberedForm('scripts'"), scripts.indexOf('})', scripts.indexOf("useRememberedForm('scripts'")))
    for (const key of ['chapter_batch_mode', 'chapters_per_request', 'chapter_batch_words']) {
      assert.match(remembered, new RegExp(key), `${key} is not remembered on this Mac`)
    }
    // And they are not in the preset exclusion list (it REPLACES the default).
    const presets = scripts.slice(scripts.indexOf("configKey: 'script'"), scripts.indexOf('apply: (data)'))
    assert.doesNotMatch(presets, /chapter_batch_mode/)
    assert.doesNotMatch(presets, /chapters_per_request/)
    assert.doesNotMatch(presets, /chapter_batch_words/)
  })

  test('every expansion request sends the setting, so a run honours the page', () => {
    for (const key of ['chapter_batch_mode', 'chapters_per_request', 'chapter_batch_words']) {
      assert.match(panel, new RegExp(`${key}: props\\.form\\?\\.${key}`), `${key} is not sent with an expansion`)
    }
  })

  test('the call estimate follows the chosen number instead of a hardcoded 3', () => {
    assert.doesNotMatch(scripts, /Math\.ceil\(chapters \/ 3\)\s*\n\s*return/)
    assert.match(scripts, /Math\.ceil\(chapters \/ perCall\)/)
  })
})
