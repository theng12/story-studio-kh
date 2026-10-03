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
    const checkedStepsOrdered = { value: [] as Array<{ id: StepId }> }
    const stepById = (id: StepId) => ({ label: id })
    ${policyCode()}
    return {
      modelPolicies, setModelPolicyEnabled, setModelPolicyModel,
      setModelPolicyModelMeta, modelPolicyLimits, modelPolicyError, modelPoliciesForRun, setChecked: (ids: StepId[]) => {
        checkedStepsOrdered.value = ids.map(id => ({ id }))
      },
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
    modelPolicies: Record<string, { enabled: boolean; model: string }>
    setModelPolicyEnabled: (id: string, enabled: boolean) => void
    setModelPolicyModel: (id: string, model: string) => void
    setModelPolicyModelMeta: (id: string, model: { id: string, context_window_tokens?: number, max_output_tokens?: number } | null) => void
    modelPolicyLimits: (id: string) => string
    modelPolicyError: (id: string) => string
    modelPoliciesForRun: () => Record<string, { mode: string; models: string[] }>
    setChecked: (ids: string[]) => void
  }
  return { ...page, projectChanged: () => onProjectChange?.() }
}

test('Pipeline sends ONE writing model per selected writing step and never changes presets', () => {
  const page = loadPolicies()
  page.setChecked(['script-only', 'audio', 'scene_review'])
  page.setModelPolicyEnabled('script-only', true)
  page.setModelPolicyModel('script-only', 'pool::gemini-free-all')

  assert.deepEqual(page.modelPoliciesForRun(), {
    'script-only': { mode: 'single', models: ['pool::gemini-free-all'] },
  })
  assert.match(pipeline, /model_policies: modelPoliciesForRun\(\)/)
  assert.doesNotMatch(policyCode(), /settings\/config/)
})

test('the retired LLM lineup is gone from the Pipeline page: no lineup card, no backups, no distribute', () => {
  assert.doesNotMatch(pipeline, /LlmLineupEditor|savedLlmLineup|wait_for_availability|prefer_savings/)
  assert.doesNotMatch(policyCode(), /'backup'|'distribute'|addModelPolicyCandidate|moveModelPolicyCandidate/)
  assert.match(pipeline, /Use a different writing model for this run/)
})

test('an unfinished per-run choice blocks the run instead of reaching the payload', () => {
  const page = loadPolicies()
  page.setChecked(['scene_plan'])
  page.setModelPolicyEnabled('scene_plan', true)
  assert.match(page.modelPolicyError('scene_plan'), /Choose a writing model/)
  assert.deepEqual(page.modelPoliciesForRun(), {}, 'an empty choice must not reach the run payload')
  page.setModelPolicyModel('scene_plan', 'genstudio:planner')
  assert.equal(page.modelPolicyError('scene_plan'), '')
})

test('Pipeline clears per-run model choices on a project change and interactive model controls are outside the stage label', () => {
  const page = loadPolicies()
  page.setModelPolicyEnabled('research', true)
  page.setModelPolicyModel('research', 'genstudio:researcher')
  page.projectChanged()
  assert.deepEqual(page.modelPolicies.research, { enabled: false, model: '' })
  assert.match(pipeline, /clearSelectedSteps\(\)\n  selectedEpisodes\.clear\(\)/)

  const tile = pipeline.slice(pipeline.indexOf('<article\n            v-if="entry.kind === \'step\'"'), pipeline.indexOf('<!-- External node', pipeline.indexOf('<article\n            v-if="entry.kind === \'step\'"')))
  assert.match(tile, /class="step-toggle"/)
  assert.match(tile, /:aria-label="`Run \$\{entry\.label\}`"/)
  assert.match(tile, /class="step-toggle"[\s\S]*?<div class="step-body">/)
})

test('Pipeline shows the chosen model\'s live published limits and clears them on a model switch', () => {
  const page = loadPolicies()
  page.setModelPolicyEnabled('metadata', true)
  page.setModelPolicyModel('metadata', 'genstudio:writer-a')
  page.setModelPolicyModelMeta('metadata', {
    id: 'genstudio:writer-a', context_window_tokens: 128_000, max_output_tokens: 16_000,
  })
  assert.match(page.modelPolicyLimits('metadata'), /Context window: 128,000 tokens/)
  assert.match(page.modelPolicyLimits('metadata'), /Max output: 16,000 tokens/)
  assert.match(page.modelPolicyLimits('metadata'), /Input capacity estimate at this output: 112,000 tokens\. The Gateway validates the exact prompt fit\./)

  page.setModelPolicyModel('metadata', 'genstudio:writer-b')
  assert.equal(page.modelPolicyLimits('metadata'), '')
  assert.match(pipeline, /@model-meta="setModelPolicyModelMeta\(entry\.id, \$event\)"/)
})
