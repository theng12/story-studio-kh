import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveSceneClipCatalogModel } from '../generators/scene-clip.js'
import { resolveScenePlanCatalogModel } from '../generators/scene-plan.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(HERE, '..')

test('scene motion resolves only available GenStudio video catalog entries', () => {
  const catalog = [
    {
      id: 'genstudio-video-veo-31-v1', display_name: 'Veo 3.1 Fast', available: true,
      modes: ['image-to-video'], aspect_ratios: ['16:9'], variants: [],
    },
    {
      id: 'genstudio-video-disabled-v1', display_name: 'Kling 3.0', available: false,
      modes: ['image-to-video'], aspect_ratios: ['16:9'], variants: [],
    },
  ] as any

  assert.equal(
    resolveSceneClipCatalogModel('genstudio-video:genstudio-video-veo-31-v1', catalog),
    'genstudio-video-veo-31-v1',
  )
  assert.equal(resolveSceneClipCatalogModel('fal-veo-3.1-i2v', catalog), 'genstudio-video-veo-31-v1')
  assert.equal(resolveSceneClipCatalogModel('kie-kling-3', catalog), null)
  assert.equal(resolveSceneClipCatalogModel('unmapped-direct-provider-model', catalog), null)
})

test('scene planning accepts only live GenStudio catalog ids', () => {
  const catalog = [
    {
      id: 'genstudio-chat-304c7e5dd2011f75a067-v1', display_name: 'DeepSeek', available: true,
      qualification_only: false, max_output_tokens: 8_192, controls: [], activation_blockers: [],
    },
    {
      id: 'genstudio-chat-disabled-v1', display_name: 'Disabled', available: false,
      qualification_only: false, max_output_tokens: 8_192, controls: [], activation_blockers: [],
    },
  ] as any

  assert.equal(resolveScenePlanCatalogModel('deepseek-v4-flash', catalog), null)
  assert.equal(
    resolveScenePlanCatalogModel('genstudio-chat:genstudio-chat-304c7e5dd2011f75a067-v1', catalog),
    'genstudio-chat-304c7e5dd2011f75a067-v1',
  )
  assert.equal(resolveScenePlanCatalogModel('chatstudio:local-model', catalog), null)
  assert.equal(resolveScenePlanCatalogModel('genstudio-chat-disabled-v1', catalog), null)
})

test('scene motion and planning source contain no executable direct provider or Hub dispatch', () => {
  const clip = readFileSync(path.join(serverRoot, 'generators/scene-clip.ts'), 'utf8')
  const plan = readFileSync(path.join(serverRoot, 'generators/scene-plan.ts'), 'utf8')
  const reviewRoute = readFileSync(path.join(serverRoot, 'routes/scene-review.ts'), 'utf8')
  const planRoute = readFileSync(path.join(serverRoot, 'routes/scene-plan.ts'), 'utf8')

  assert.doesNotMatch(clip, /resolveApiKeyForProvider|resolveVideoStudioModel|getVideoProvider\(/)
  assert.doesNotMatch(plan, /studiohub-client|hubSubmitChatPacks|hubPollChatPacks|getApiKey\(['"](?:openai|anthropic|kie)['"]\)/)
  assert.match(reviewRoute, /requireSceneClipGenStudioModel\(model,\s*requestedVariant\)/)
  assert.match(planRoute, /requireScenePlanGenStudioModel\(model\)/)
  // The error still states that nothing else was tried; it no longer names the
  // retired upstreams, which was private routing detail on the customer's screen.
  assert.match(clip, /no other route was attempted/)
  assert.doesNotMatch(clip, /fal\.ai|Kie\.ai/)
  assert.match(plan, /Scene planning did not call any fallback route/)
})

test('bulk visual and motion repairs use bounded GenStudio packs instead of per-scene generation', () => {
  const plan = readFileSync(path.join(serverRoot, 'generators/scene-plan.ts'), 'utf8')
  const planRoute = readFileSync(path.join(serverRoot, 'routes/scene-plan.ts'), 'utf8')

  assert.match(plan, /const packedRepairStage:[\s\S]*regenerate_empty_motion_prompts[\s\S]*regenerate_empty_prompts/)
  // Both repair paths still go through the bounded pack splitter — that is the
  // invariant this test exists for, and it is what keeps a bulk repair off the
  // retired per-scene generators asserted against below.
  //
  // The SIZE they hand it is deliberately no longer `promptPackSize`. A repair
  // set of `MAX_SCENES_PER_SMALL_REPAIR_PACK` or fewer is split one scene per
  // request, because a compact pack of two to seven is the shape that fails
  // most: 86% at 2 scenes, 70% at 7, 0% at 1, across 3,544 recorded attempts.
  // That is a pack size CHOSEN by `scenePromptRepairPackSize` and still fed to
  // the splitter — not a fan-out around it — so what is asserted here is that
  // the splitter remains the only door.
  assert.match(plan, /const targetPacks = packScenePromptItems\(targets, effectivePackSize\)/)
  assert.match(plan, /scenePromptRepairPackSize\(targets\.length, promptPackSize\)/)
  assert.match(plan, /const repairGroups = packScenePromptItems\(\s*outstanding,\s*scenePromptRepairPackSize\(outstanding\.length, outstanding\.length\),\s*\)/)
  assert.doesNotMatch(plan, /if \(params\.regenerate_empty_prompts\) \{[\s\S]*generatePromptsForScenes/)
  assert.doesNotMatch(plan, /if \(params\.regenerate_empty_motion_prompts\) \{[\s\S]*generateMotionPromptsForScenes/)
  assert.match(planRoute, /regenerate_empty_prompts: true,[\s\S]*prompt_pack_size: promptPackSize/)
  assert.match(planRoute, /regenerate_empty_motion_prompts: true,[\s\S]*prompt_pack_size: promptPackSize/)
})
