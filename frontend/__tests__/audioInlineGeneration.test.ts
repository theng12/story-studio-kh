import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const audioPage = source('../pages/projects/[slug]/audio.vue')
const chapterSelector = source('../components/AudioChapterSelector.vue')
const confirmation = source('../composables/useConfirmation.ts')
const confirmationDialog = source('../components/GenerationConfirmationDialog.vue')

describe('Audio one-chapter generation', () => {
  test('exposes an explicit inline action for every chapter row', () => {
    assert.match(chapterSelector, /'generate-section': \[request: SectionAction\]/)
    assert.match(chapterSelector, /emit\('generate-section', \{ slug: s\.slug, mode: inlineActionMode\(s\) \}\)/)
    assert.match(chapterSelector, /Send only .* to the selected TTS provider/)
    assert.doesNotMatch(chapterSelector, /Allow regenerating already-generated sections/)
    assert.doesNotMatch(chapterSelector, /:disabled="!allowDuplicates/)
  })

  test('submits the requested chapter with action-owned overwrite semantics', () => {
    assert.match(audioPage, /@generate-section="submitSection"/)
    assert.match(audioPage, /async function submitSection\(request: SectionAction\)/)
    assert.match(audioPage, /await queueAudio\(\[request\.slug\], request\.mode\)/)
    assert.match(audioPage, /const force = mode !== 'generate'/)
    assert.match(audioPage, /const no_overwrite = mode === 'new_version'/)
    // `controls` is the ONE field the raw form does not supply: it is sent
    // resolved against the selected model's published list, so a value for a
    // control this model does not publish cannot ride along on a section run.
    assert.match(audioPage, /const \{ controls: _controls, \.\.\.rest \} = form/)
    assert.match(audioPage, /const payload: Record<string, any> = \{[\s\S]{0,180}\.\.\.rest,[\s\S]{0,100}sections: targetSections\.join\(','\),[\s\S]{0,80}force: mode !== 'generate',[\s\S]{0,80}no_overwrite: mode === 'new_version',[\s\S]{0,80}controls: resolvedControls\.value/)
  })

  test('shares confirmation and job guards while refusing an empty batch target', () => {
    assert.match(audioPage, /async function queueAudio\(targetSections: string\[\], mode: AudioActionMode\)/)
    assert.match(audioPage, /if \(!targetSections\.length\)/)
    assert.doesNotMatch(audioPage, /: 'all'/)
    assert.match(audioPage, /if \(!await confirmGeneration\(slug\.value, 'audio', payload, \{/)
    assert.match(audioPage, /audioJobActiveForEpisode\.value/)
  })

  test('names the selected action from disk state without narrowing mixed bulk regeneration', () => {
    assert.match(audioPage, /:show-generate="false"/)
    assert.match(audioPage, />Generate missing/)
    assert.match(audioPage, /const selectedAudioIntent = computed\(\(\) => \{[\s\S]{0,900}audioActionLabel\(generate, 'generate', 'Generate selected'\)/)
    assert.match(audioPage, /if \(generate\.length === 0\)[\s\S]{0,500}Regenerate selected/)
    assert.match(audioPage, /targetSections: effectiveSections\.value,[\s\S]{0,120}mode: 'regenerate' as const,[\s\S]{0,180}Generate \/ regenerate selected/)
    assert.match(audioPage, /summary: `Generate creates missing audio for \$\{scopeSummary\(generate\)\} and Regenerate replaces active audio for \$\{scopeSummary\(regenerate\)\}\.`/)
    assert.match(audioPage, /@click="queueSelectedAudio"/)
    assert.match(audioPage, /const \{ targetSections, mode \} = selectedAudioIntent\.value[\s\S]{0,100}await queueAudio\(targetSections, mode\)/)
    assert.match(audioPage, /No sections selected\. Choose rows to generate, regenerate, or create another version\./)
    assert.match(audioPage, /audioActionLabel\(effectiveSections, 'new_version', 'Create another version'\)/)
    assert.match(audioPage, /<details class="audio-advanced">/)
    assert.match(audioPage, /<summary>Delivery and request controls/)
    assert.match(audioPage, /\.audio-action-bar \{[\s\S]{0,160}position: sticky/)
    assert.match(audioPage, /@media \(max-width: 720px\)/)
    assert.doesNotMatch(audioPage, /generation_mode/)
  })

  test('quotes the selected scope and invalidates old responses and mismatched actions', () => {
    assert.match(audioPage, /sections: sections\.join\(','\)/)
    assert.match(audioPage, /const revision = \+\+quoteRevision/)
    assert.match(audioPage, /if \(revision !== quoteRevision\) return/)
    assert.match(audioPage, /if \(quoteScopeKey\.value !== sections\)/)
    assert.match(audioPage, /@click="queueAudio\(missingSections, 'generate'\)"/)
    assert.match(audioPage, /targetSections: effectiveSections\.value,[\s\S]{0,120}mode: 'regenerate' as const/)
    assert.match(audioPage, /quotedCost \? 'Selected quote' : 'Rate'/)
  })

  test('the existing confirmation names the exact action, scope, voice, model, and applicable price', () => {
    assert.match(confirmation, /context\?: GenerationConfirmationContext/)
    assert.match(confirmation, /state\.details = context\?\.details \|\| \[\]/)
    assert.match(confirmationDialog, /state\.action \|\| `Start \$\{state\.typeLabel\}\?`/)
    assert.match(confirmationDialog, /v-for="detail in state\.details"/)
    assert.match(audioPage, /action: `\$\{action\} \$\{scopeSummary\(targetSections\)\}\?`/)
    assert.match(audioPage, /label: 'Model'.*selectedTtsModel\.value\?\.display_name/)
    assert.match(audioPage, /label: 'Voice'.*selectedVoice\.value\?\.display_name/)
    assert.match(audioPage, /label: exactQuote \? 'Exact quote' : 'Published rate'/)
  })

  test('drops old episode targets and ignores late section responses', () => {
    assert.match(audioPage, /effectiveSections\.value = \[\][\s\S]{0,80}missingSections\.value = \[\]/)
    assert.match(chapterSelector, /const revision = \+\+refreshRevision/)
    assert.match(chapterSelector, /if \(revision !== refreshRevision\) return/)
  })

  test('surfaces downstream subtitle freshness supplied by the backend', () => {
    assert.match(chapterSelector, /subtitles_stale\?: boolean/)
    assert.match(chapterSelector, /v-if="s\.subtitles_stale"/)
    assert.match(chapterSelector, /Subtitles need retranscribing/)
  })
})
