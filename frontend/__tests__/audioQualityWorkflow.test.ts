import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { audioQualityLabel, type AudioQualityEvidence } from '../types/audio-quality.js'
import { useGenStudioImageModels } from '../composables/useGenStudioImageModels.js'
import { useGenStudioTranscriptionModels } from '../composables/useGenStudioTranscription.js'
import { waitFor } from '../../electron/server/__tests__/_timing.js'

const selectorPath = fileURLToPath(new URL('../components/AudioChapterSelector.vue', import.meta.url))
const selectorSource = readFileSync(selectorPath, 'utf8')
const audioSource = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/audio.vue', import.meta.url)), 'utf8')
const settingsSource = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url)), 'utf8')
const pipelineSource = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)), 'utf8')
const imagePickerSource = readFileSync(fileURLToPath(new URL('../components/ImageModelPicker.vue', import.meta.url)), 'utf8')
const catalogSettingsSource = readFileSync(fileURLToPath(new URL('../components/GenStudioCatalogSettings.vue', import.meta.url)), 'utf8')

async function loadSelector(): Promise<Component> {
  const { descriptor } = parse(selectorSource, { filename: selectorPath })
  const script = compileScript(descriptor, { id: 'audio-quality-selector' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: selectorPath,
    id: 'audio-quality-selector',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const qualityUrl = await import.meta.resolve('../types/audio-quality.ts')
  const support = `
    import { computed, defineComponent as _defineComponent, onBeforeUnmount, onMounted, ref, watch } from ${JSON.stringify(vueUrl)}
    import { audioQualityLabel, audioQualityTone } from ${JSON.stringify(qualityUrl)}
    const useApi = () => globalThis.__audioQualityApi
    const useJobs = () => ({ jobs: ref([]) })
    const useToast = () => ({ error: message => globalThis.__audioQualityErrors.push(message) })
  `
  const code = `${support}\n${script.content
    .replace(/^import type \{ Job \} from '.+?'\n/m, '')
    .replace(/^import \{[\s\S]*?\} from '~\/types\/audio-quality'\n/m, '')
    .replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const built = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const NuxtLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) },
})
const LoadingSpinner = defineComponent({ setup: () => () => h('span', 'Loading') })

async function mountSelector(
  qualityMode: 'off' | 'flag_issues' | 'check_and_repair',
  quality?: AudioQualityEvidence,
) {
  const Component = await loadSelector()
  const actions: Array<{ slug: string; mode: string }> = []
  const checks: string[] = []
  const approvals: Array<{ slug: string; quality: AudioQualityEvidence }> = []
  const doubleChecks: Array<{ slug: string; quality: AudioQualityEvidence }> = []
  ;(globalThis as any).__audioQualityErrors = []
  ;(globalThis as any).__audioQualityApi = {
    get: async () => ({
      sections: [{
        label: 'Chapter 01', slug: 'Chapter_01', total_chunks: 1, present_chunks: 1,
        word_count: 850, character_count: 4_600, status: 'generated', subtitles_stale: false,
        quality: quality || {
          state: 'review_needed', reason: 'The raw transcript could not be aligned confidently with the saved script.',
          reason_code: 'raw_alignment_inconclusive', inspected_at: '2026-09-08T01:02:03.000Z', transcript_fresh: true, provenance: 'known',
          review: { start_sec: 37, end_sec: 43, excerpt: 'the saved transcript excerpt', script_excerpt: 'the current script excerpt' },
          receipt: { model_id: 'published-tts', provider_name: 'Published Provider', voice_id: 'voice-one' },
        },
      }],
    }),
  }
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    setup: () => () => h(Component as any, {
      projectSlug: 'quality-project', episodeId: 'EP0001', selected: 'Chapter_01', qualityMode,
      onGenerateSection: (action: { slug: string; mode: string }) => actions.push(action),
      onCheckQuality: (slug: string) => checks.push(slug),
      onApproveQuality: (request: { slug: string; quality: AudioQualityEvidence }) => approvals.push(request),
      onDoubleCheckQuality: (request: { slug: string; quality: AudioQualityEvidence }) => doubleChecks.push(request),
    }),
  }))
  app.component('NuxtLink', NuxtLink)
  app.component('LoadingSpinner', LoadingSpinner)
  app.mount(host)
  await waitFor(() => /Chapter 01/.test(host.textContent || ''), { label: 'the audio section row to render' })
  return { host, actions, checks, approvals, doubleChecks, destroy: () => { app.unmount(); host.remove() } }
}

describe('Audio quality workflow', () => {
  test('keeps the small approved status vocabulary', () => {
    assert.equal(audioQualityLabel('not_checked'), 'Not yet verified')
    assert.equal(audioQualityLabel('no_issue_detected'), 'No issue detected')
    assert.equal(audioQualityLabel('still_needs_review'), 'Still needs review')
  })

  test('renders scoped evidence and self-contained chapter actions', async () => {
    const mounted = await mountSelector('check_and_repair')
    try {
      const text = mounted.host.textContent || ''
      assert.match(text, /Review needed/)
      assert.match(text, /raw transcript could not be aligned confidently/i)
      assert.match(text, /0:37–0:43/)
      assert.match(text, /the saved transcript excerpt/)
      assert.match(text, /the current script excerpt/)
      assert.match(text, /published-tts · Published Provider · voice-one/)
      assert.equal(mounted.host.querySelector('a[href="/projects/quality-project/scripts?episode_id=EP0001"]')?.textContent, 'View script')
      assert.equal(mounted.host.querySelector('a[href*="/subtitles?episode_id=EP0001&section=Chapter_01"]')?.textContent, 'Re-transcribe')

      const buttons = [...mounted.host.querySelectorAll('button')]
      buttons.find(button => button.textContent === 'Regenerate audio')!.click()
      buttons.find(button => button.textContent === 'Check & repair')!.click()
      buttons.find(button => button.textContent?.includes('Double-check transcript'))!.click()
      await nextTick()
      assert.deepEqual(mounted.actions.at(-1), { slug: 'Chapter_01', mode: 'regenerate' })
      assert.deepEqual(mounted.checks, ['Chapter_01'])
      assert.equal(mounted.doubleChecks[0]?.slug, 'Chapter_01')
    } finally { mounted.destroy() }
  })

  test('keeps quality evidence out of the ordinary Off workflow', async () => {
    const mounted = await mountSelector('off')
    try {
      assert.doesNotMatch(mounted.host.textContent || '', /Review needed|Review evidence|Check & repair/)
      assert.match(mounted.host.textContent || '', /Regenerate/)
    } finally { mounted.destroy() }
  })

  test('shows an exact held verification quote and resumes the durable candidate action', async () => {
    const quality: AudioQualityEvidence = {
      state: 'review_needed', reason: 'The candidate needs a higher verification allowance.',
      transcript_fresh: true, provenance: 'known',
      repair: {
        action_id: 'held-action', source_fingerprint: 'source-hash', sections: ['Chapter_01'], state: 'needs_approval',
        candidate: { model_id: 'tts-current', voice_id: 'voice-current' },
        verification: { quoted_credit_cost: 5, price_version: 'price-v2', committed_credits: 2, credit_ceiling: 3 },
      },
    }
    const mounted = await mountSelector('check_and_repair', quality)
    try {
      const text = mounted.host.textContent || ''
      assert.match(text, /Verification is quoted at 5 credits and needs approval/)
      assert.match(text, /tts-current · voice-current/)
      assert.match(text, /5 credits quoted · 2 of 3 committed/)
      assert.match(text, /saved candidate audio is saved|candidate audio is saved/i)
      const approve = [...mounted.host.querySelectorAll('button')]
        .find(button => button.textContent?.includes('Approve verification')) as HTMLButtonElement
      assert.equal(approve.disabled, false)
      approve.click()
      await nextTick()
      assert.equal(mounted.approvals[0]?.slug, 'Chapter_01')
      assert.equal(mounted.approvals[0]?.quality.repair?.action_id, 'held-action')
      assert.doesNotMatch(text, /Check & repair/)
    } finally { mounted.destroy() }
  })

  test('renders terminal two-model evidence without offering a repeat paid check', async () => {
    const quality: AudioQualityEvidence = {
      state: 'review_needed', reason: 'The original raw alignment was inconclusive.',
      inspected_at: '2026-09-08T01:02:03.000Z', transcript_fresh: true, provenance: 'known',
      active_check: {
        action_id: 'active-check-action', source_fingerprint: 'active-source-hash', state: 'no_issue_detected', sections: ['Chapter_01'],
        model_id: 'alternate-asr',
        verification: { credit_ceiling: 4, committed_credits: 4, quotes: {} },
      },
    }
    const mounted = await mountSelector('check_and_repair', quality)
    try {
      const text = mounted.host.textContent || ''
      assert.match(text, /No issue detected/)
      assert.match(text, /two-model transcript check/i)
      assert.match(text, /No issue detected by alternate-asr/)
      assert.doesNotMatch(text, /Double-check transcript|Review double-check quote/)
      assert.match(text, /Regenerate audio/)
    } finally { mounted.destroy() }
  })

  test('uses one project setting and a plan-before-confirm repair boundary', () => {
    assert.match(settingsSource, /v-model="audioQualityMode"/)
    assert.match(settingsSource, /Recommended during calibration/)
    assert.match(settingsSource, /advisory because the current TTS contract has no hard aggregate credit ceiling/i)
    assert.match(settingsSource, /action-specific verification credit ceiling/i)
    assert.match(settingsSource, /await put\(`\/projects\/\$\{targetSlug\}\/settings\/config`, \{ audio_quality: payload \}\)/)
    assert.doesNotMatch(settingsSource, /audioQuality.*usePresets|usePresets.*audioQuality/)

    const action = audioSource.match(/async function runAudioQualityCheck[\s\S]*?(?=\n\/\/ ── Quote)/)?.[0] || audioSource
    assert.match(action, /\/audio-quality\/check/)
    assert.match(action, /candidate_audio: qualityCandidateAudio\.value/)
    assert.match(action, /candidateTtsQuoteLabel\(repair\.candidate_tts\.advisory_quote\)/)
    assert.match(action, /Narration estimate:/)
    assert.match(action, /if \(audioQualityMode\.value === 'flag_issues' \|\| !plan\.repair\?\.eligible\)/)
    assert.match(action, /await ask\(/)
    assert.match(action, /\/audio-quality\/confirm/)
    assert.match(action, /confirm_repair: true/)
    assert.match(action, /verification_credit_ceiling: Number\(qualityVerificationCreditCeiling\.value\)/)
    assert.match(action, /candidate_audio: qualityCandidateAudio\.value/)
    assert.match(action, /quoted after candidate audio is ready/i)
    assert.match(action, /freshQualityAction\.begin\(scope, 'quality'\)/)
    assert.match(action, /freshQualityAction\.complete\(operationId\)/)
    assert.match(audioSource, /async function approveHeldQualityRepair/)
    assert.match(audioSource, /:visible="heldQualityApproval !== null"/)
    assert.match(audioSource, /v-model\.number="heldQualityApprovalCeiling"/)
    assert.match(audioSource, /At least \{\{ heldQualityRequiredCeiling\.toLocaleString\(\) \}\} credits/)
    assert.match(audioSource, /The candidate audio is reused\. Approving verification does not generate the narration again\./)
    assert.match(audioSource, /operation_id: approval\.actionId/)
    assert.match(audioSource, /source_fingerprint: approval\.sourceFingerprint/)
    assert.match(audioSource, /qualityHeldApprovalKey\.value = approvalKey/)
    assert.match(audioSource, /return 'Retry \(same request\)'/)
    assert.doesNotMatch(selectorSource, /qualityVerificationCreditCeiling|Set the verification credit ceiling above/)
    assert.match(audioSource, /Normal generation and chapter regeneration remain available/)
    assert.match(audioSource, /\/audio-quality\/active-check\/quote/)
    assert.match(audioSource, /\/audio-quality\/active-check\/confirm/)
    assert.match(audioSource, /\['quoted', 'needs_approval'\]\.includes\(existing\.state\)/)
    assert.match(audioSource, /verification_credit_ceiling: Number\(activeCheckApprovalCeiling\.value\)/)
    assert.match(audioSource, /Active audio and subtitles stay unchanged\./)
    const activeCheck = audioSource.match(/async function quoteActiveAudioCheck[\s\S]*?(?=\nfunction closeActiveCheckApproval)/)?.[0] || ''
    assert.match(activeCheck, /operation_id: operationId, sections/)
    assert.doesNotMatch(activeCheck, /candidate_audio|voice:|model:/)
  })

  test('keeps evidence usable at narrow widths', () => {
    assert.match(selectorSource, /@media \(max-width: 560px\)/)
    assert.match(selectorSource, /\.cs-quality-evidence dl \{ grid-template-columns: 1fr; \}/)
    assert.match(selectorSource, /\.cs-quality-actions \.btn \{ flex: 1 1 132px;/)
  })

  test('keeps backlog checks explicit and outside ordinary Pipeline runs', () => {
    const action = pipelineSource.match(/async function checkSelectedAudioQuality[\s\S]*?(?=\n\/\/ Page-scoped variants)/)?.[0]
    assert.ok(action)
    assert.match(action, /\/audio-sections/)
    assert.match(action, /section\.status === 'generated'/)
    assert.match(action, /\/audio-quality\/check/)
    assert.match(action, /analysis_only: true/)
    assert.match(action, /pipelineQualityAction\.begin\(scope, actionTarget\)/)
    assert.match(action, /pipelineQualityAction\.complete\(operationId\)/)
    assert.doesNotMatch(action, /candidate_audio|\/audio-quality\/confirm|\/pipeline\/run-batch/)
    assert.match(pipelineSource, /\{\{ pipelineQualityActionLabel \}\}/)
    assert.match(pipelineSource, /'Check selected episodes'/)
    assert.match(pipelineSource, /never blocks an ordinary pipeline run/)
    assert.match(pipelineSource, /\/audio\?episode_id=/)
  })

  test('refreshes the scoped transcription catalog and never authorizes stale or retired selections', async () => {
    const loadedAt = Date.now() - 120_000
    const loadedAtIso = new Date(loadedAt).toISOString()
    const responses = [
      { models: [{ id: 'model-a', display_name: 'Model A', provider: 'Provider A', language: 'en', available: true, available_workers: 1, qualification_only: false }], freshness: { stale: false, ageMs: 0, loadedAt: Date.now() } },
      { models: [{ id: 'model-a', display_name: 'Model A', provider: 'Provider A', language: 'en', available: true, available_workers: 1, qualification_only: false }], freshness: { stale: true, ageMs: 120_000, loadedAt: loadedAtIso } },
      { models: [{ id: 'model-b', display_name: 'Model B', provider: 'Provider B', language: 'en', available: true, available_workers: 1, qualification_only: false }], freshness: { stale: false, ageMs: 0, loadedAt: Date.now() } },
    ]
    let calls = 0
    ;(globalThis as any).$fetch = async (path: string) => {
      assert.equal(path, '/api/app-settings/genstudio/transcription-models')
      return responses[calls++]
    }
    const catalog = useGenStudioTranscriptionModels()

    await catalog.load()
    catalog.modelId.value = 'model-a'
    assert.equal(catalog.ready.value, true)

    await catalog.load()
    assert.equal(calls, 2, 'an explicit load bypasses the client TTL after an account or base-URL change')
    assert.equal(catalog.sourceFreshness.value?.loadedAt, Date.parse(loadedAtIso))
    assert.equal(catalog.isUsable.value, false)
    assert.equal(catalog.options.value[0]?.disabled, true)

    await catalog.load()
    assert.equal(calls, 3)
    assert.equal(catalog.modelId.value, 'model-a', 'a retired saved id is not replaced by an unrelated live model')
    assert.equal(catalog.selectedModel.value, undefined)
    assert.equal(catalog.ready.value, false)
    assert.deepEqual(catalog.options.value.map(option => option.id), ['model-b'])
  })

  test('keeps the last-known image catalog visible but unusable after a Scene Review outage', async () => {
    const loadedAt = Date.now() - 180_000
    const loadedAtIso = new Date(loadedAt).toISOString()
    let response = {
      models: [{
        id: 'image-a', display_name: 'Image A', available: true, qualification_only: false,
        aspect_ratios: ['16:9'], default_aspect_ratio: '16:9', supports_reference_images: false,
        max_reference_images: 0, reference_strength_mode: 'none', supported_reference_strengths: [],
      }],
      freshness: { stale: false, ageMs: 0, loadedAt: new Date().toISOString() },
    }
    ;(globalThis as any).$fetch = async (path: string) => {
      assert.equal(path, '/api/app-settings/genstudio/image-models')
      return response
    }
    const catalog = useGenStudioImageModels()
    await catalog.refresh(true)
    assert.equal(catalog.isUsable.value, true)
    assert.equal(catalog.find('image-a')?.display_name, 'Image A')

    response = { ...response, freshness: { stale: true, ageMs: 180_000, loadedAt: loadedAtIso } }
    await catalog.refresh(true)
    assert.equal(catalog.isStale.value, true)
    assert.equal(catalog.isUsable.value, false)
    assert.equal(catalog.lastFetchedAt.value, Date.parse(loadedAtIso))
    assert.equal(catalog.find('image-a')?.display_name, 'Image A', 'last-known row remains available for display')

    assert.match(imagePickerSource, /\{\{ catalogStaleNote \}\} · display only/)
    assert.match(imagePickerSource, /@click="refresh\(true\)">Retry/)
    assert.match(imagePickerSource, /disabled: !isUsable\.value/)
    assert.match(imagePickerSource, /if \(!isUsable\.value\) return/)
    assert.match(catalogSettingsSource, /last-known rows/)
    assert.match(catalogSettingsSource, /status-last-known/)
    assert.match(catalogSettingsSource, /showing last-known catalog data/)
  })
})
