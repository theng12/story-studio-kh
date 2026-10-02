import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { computed, reactive } from 'vue'

const pipeline = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)),
  'utf8',
)

function policyCode(): string {
  const start = pipeline.indexOf('type EligibleModelPolicyStep =')
  const end = pipeline.indexOf('\nconst channelIntroEnabled', start)
  assert.ok(start >= 0 && end > start, 'Pipeline model-policy state must remain a self-contained block')
  return pipeline.slice(start, end)
}

function loadPolicies() {
  let onProjectChange: (() => void) | undefined
  const source = `
    type StepId = 'research' | 'broll' | 'script-only' | 'introduction-only' | 'image_prompts' | 'thumb_images' | 'metadata' | 'scene_plan' | 'contextual_cues' | 'scene_review' | 'motion_review' | 'character_sheet' | 'video_assembly' | 'audio' | 'audio_merge' | 'subtitles'
    const slug = {}
    const ref = (value: any) => ({ value })
    const savedLlmLineup = ref({ enabled: false, models: [], prefer_savings: true })
    const checkedStepsOrdered = { value: [] as Array<{ id: StepId }> }
    const stepById = (id: StepId) => ({ label: id })
    ${policyCode()}
    return {
      modelPolicies, setModelPolicyEnabled, setModelPolicyMode, setModelPolicyModel,
      addModelPolicyCandidate, removeModelPolicyCandidate, moveModelPolicyCandidate,
      setModelPolicyModelMeta, modelPolicyLimits, modelPolicyError, modelPoliciesForRun, setChecked: (ids: StepId[]) => {
        checkedStepsOrdered.value = ids.map(id => ({ id }))
      }, setLineup: (lineup: typeof savedLlmLineup.value) => { savedLlmLineup.value = lineup },
    }
  `
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  const page = new Function('reactive', 'computed', 'watch', `${js}`)(
    reactive,
    computed,
    (_source: unknown, callback: () => void) => { onProjectChange = callback },
  ) as {
    modelPolicies: Record<string, { enabled: boolean; mode: string; models: string[] }>
    setModelPolicyEnabled: (id: string, enabled: boolean) => void
    setModelPolicyMode: (id: string, mode: 'single' | 'distribute' | 'backup') => void
    setModelPolicyModel: (id: string, index: number, model: string) => void
    addModelPolicyCandidate: (id: string) => void
    removeModelPolicyCandidate: (id: string, index: number) => void
    moveModelPolicyCandidate: (id: string, index: number, direction: -1 | 1) => void
    setModelPolicyModelMeta: (id: string, index: number, model: { id: string, context_window_tokens?: number, max_output_tokens?: number } | null) => void
    modelPolicyLimits: (id: string, index: number) => string
    modelPolicyError: (id: string) => string
    modelPoliciesForRun: () => Record<string, { mode: string; models: string[] }>
    setChecked: (ids: string[]) => void
    setLineup: (lineup: { enabled: boolean; models: string[]; prefer_savings: boolean }) => void
  }
  return { ...page, projectChanged: () => onProjectChange?.() }
}

test('Pipeline submits only valid explicit policies for selected stages and never changes presets', () => {
  const page = loadPolicies()
  page.setChecked(['script-only', 'audio'])
  page.setModelPolicyEnabled('script-only', true)
  page.setModelPolicyModel('script-only', 0, 'genstudio:writer-a')

  assert.deepEqual(page.modelPoliciesForRun(), {
    'script-only': { mode: 'single', models: ['genstudio:writer-a'] },
  })
  assert.match(pipeline, /model_policies: modelPoliciesForRun\(\)/)
  assert.doesNotMatch(policyCode(), /settings\/config/)
})

test('Pipeline omits the shared lineup for a Scene Review-only run', () => {
  const page = loadPolicies()
  page.setChecked(['scene_review'])
  page.setLineup({ enabled: true, models: ['genstudio:writer-a'], prefer_savings: true })

  assert.deepEqual(page.modelPoliciesForRun(), {})
})

test('Pipeline applies the shared lineup only to eligible writing stages', () => {
  const page = loadPolicies()
  page.setChecked(['script-only', 'image_prompts', 'broll', 'thumb_images', 'audio', 'audio_merge', 'subtitles', 'scene_review', 'motion_review', 'character_sheet', 'video_assembly'])
  page.setLineup({ enabled: true, models: ['genstudio:writer-a'], prefer_savings: true })
  page.setModelPolicyEnabled('script-only', true)
  page.setModelPolicyModel('script-only', 0, 'genstudio:explicit-writer')

  assert.deepEqual(page.modelPoliciesForRun(), {
    'script-only': { mode: 'single', models: ['genstudio:explicit-writer'] },
    image_prompts: {
      mode: 'single',
      models: ['genstudio:writer-a'],
      wait_for_availability: true,
      prefer_savings: true,
    },
  })
})

test('Pipeline can reorder or remove explicit backups and blocks incomplete or duplicate selections', () => {
  const page = loadPolicies()
  page.setChecked(['scene_plan'])
  page.setModelPolicyEnabled('scene_plan', true)
  page.setModelPolicyMode('scene_plan', 'backup')
  page.setModelPolicyModel('scene_plan', 0, 'genstudio:primary')
  page.setModelPolicyModel('scene_plan', 1, 'genstudio:backup-a')
  page.addModelPolicyCandidate('scene_plan')
  page.setModelPolicyModel('scene_plan', 2, 'genstudio:backup-b')
  page.moveModelPolicyCandidate('scene_plan', 2, -1)
  page.removeModelPolicyCandidate('scene_plan', 2)

  assert.deepEqual(page.modelPolicies.scene_plan.models, ['genstudio:primary', 'genstudio:backup-b'])
  assert.equal(page.modelPolicyError('scene_plan'), '')

  page.setModelPolicyModel('scene_plan', 1, 'genstudio:primary')
  assert.match(page.modelPolicyError('scene_plan'), /each product once/i)
  assert.deepEqual(page.modelPoliciesForRun(), {}, 'invalid policies must not reach the run payload')
})

test('Pipeline clears per-run model choices on a project change and interactive model controls are outside the stage label', () => {
  const page = loadPolicies()
  page.setModelPolicyEnabled('research', true)
  page.setModelPolicyModel('research', 0, 'genstudio:researcher')
  page.projectChanged()
  assert.deepEqual(page.modelPolicies.research, { enabled: false, mode: 'single', models: [''] })
  assert.match(pipeline, /clearSelectedSteps\(\)\n  selectedEpisodes\.clear\(\)/)

  const tile = pipeline.slice(pipeline.indexOf('<article\n            v-if="entry.kind === \'step\'"'), pipeline.indexOf('<!-- External node', pipeline.indexOf('<article\n            v-if="entry.kind === \'step\'"')))
  assert.match(tile, /class="step-toggle"/)
  assert.match(tile, /:aria-label="`Run \$\{entry\.label\}`"/)
  assert.match(tile, /class="step-toggle"[\s\S]*?<div class="step-body">/)
})

test('Pipeline shows the exact candidate’s live published limits and clears them on a model switch', () => {
  const page = loadPolicies()
  page.setModelPolicyEnabled('metadata', true)
  page.setModelPolicyModel('metadata', 0, 'genstudio:writer-a')
  page.setModelPolicyModelMeta('metadata', 0, {
    id: 'genstudio:writer-a', context_window_tokens: 128_000, max_output_tokens: 16_000,
  })
  assert.match(page.modelPolicyLimits('metadata', 0), /Context window: 128,000 tokens/)
  assert.match(page.modelPolicyLimits('metadata', 0), /Max output: 16,000 tokens/)
  assert.match(page.modelPolicyLimits('metadata', 0), /Input capacity estimate at this output: 112,000 tokens\. The Gateway validates the exact prompt fit\./)

  page.setModelPolicyModel('metadata', 0, 'genstudio:writer-b')
  assert.equal(page.modelPolicyLimits('metadata', 0), '')
  assert.match(pipeline, /@model-meta="setModelPolicyModelMeta\(entry\.id, index, \$event\)"/)
})
