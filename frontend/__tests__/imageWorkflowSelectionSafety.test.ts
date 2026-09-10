import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const images = source('../pages/projects/[slug]/images.vue')
const imagePrompts = source('../pages/projects/[slug]/image-prompts.vue')
const characterSheet = source('../pages/projects/[slug]/character-sheet.vue')
const sceneReview = source('../pages/projects/[slug]/scene-review.vue')
const imagePool = source('../pages/projects/[slug]/image-pool.vue')
const referencesCard = source('../components/Img2ImgReferencesCard.vue')

test('retired scene-generator handoffs lead to Scene Plan instead of a canonicalized thumbnail route', () => {
  assert.doesNotMatch(images, /image-prompts\?tab=scenes/)
  assert.match(images, /projects\/\$\{slug\}\/scene-plan/)
  assert.doesNotMatch(referencesCard, /image-prompts\?tab=scenes/)
  assert.match(referencesCard, /projects\/\$\{projectSlug\}\/scene-plan/)
})

test('Thumbnail Prompts ignores a completed job after the selected episode or run changes', () => {
  assert.match(
    imagePrompts,
    /async function runGenerate\(mode: PromptMode\) \{[\s\S]*?const ep = form\.episode_id[\s\S]*?const requestSequence = \+\+promptGenerationSequence[\s\S]*?waitForJob\(generationSlug, job\.job_id\)[\s\S]*?form\.episode_id !== ep[\s\S]*?episodes\/\$\{ep\}\/image-prompts[\s\S]*?form\.episode_id !== ep/,
  )
  assert.match(
    imagePrompts,
    /finally \{[\s\S]*?requestSequence === promptGenerationSequence[\s\S]*?generating\.value = false/,
    'an old job must not clear the busy state of a newer run',
  )
})

test('Character Sheet ignores stale episode reads and keeps file uploads on their initiating episode', () => {
  for (const loader of ['loadCharacters', 'loadConfig', 'loadRefs']) {
    assert.match(
      characterSheet,
      new RegExp(`async function ${loader}\\([\\s\\S]*?const ep = episodeId\\.value[\\s\\S]*?const project = slug\\.value[\\s\\S]*?const scope = characterScopeSequence[\\s\\S]*?const current = \\(\\) => scope === characterScopeSequence && project === slug\\.value && ep === episodeId\\.value[\\s\\S]*?if \\(!current\\(\\)\\) return`),
      `${loader} must reject stale project and episode responses`,
    )
  }
  assert.match(characterSheet, /async function onSheetFiles[\s\S]*?const ep = episodeId\.value[\s\S]*?await fileToBase64[\s\S]*?episodes\/\$\{ep\}\/img2img-references\/master/)
  assert.match(characterSheet, /async function onCompositionFiles[\s\S]*?const ep = episodeId\.value[\s\S]*?await fileToBase64[\s\S]*?episodes\/\$\{ep\}\/img2img-references\/composition/)
})

test('image pages ignore stale selected-pool and episode responses', () => {
  assert.match(imagePool, /async function loadPoolCount[\s\S]*?const requestedPoolId = poolId\.value[\s\S]*?poolId\.value === requestedPoolId[\s\S]*?if \(!current\(\)\) return/)
  for (const loader of ['loadPrompts', 'refreshImageStatus', 'loadEditScan', 'loadThumbnailPinState', 'loadOutlineChapterCount']) {
    assert.match(
      images,
      new RegExp(`async function ${loader}\\([\\s\\S]*?const ep = form\\.episode_id[\\s\\S]*?const project = slug\\.value[\\s\\S]*?const scope = imageScopeSequence[\\s\\S]*?const current = \\(\\) => scope === imageScopeSequence && project === slug\\.value && ep === form\\.episode_id[\\s\\S]*?if \\(!current\\(\\)\\) return`),
      `${loader} must reject stale project and episode responses`,
    )
  }
})

test('Scene Review uploads retain the episode selected when the file was chosen', () => {
  assert.match(sceneReview, /async function uploadOne[\s\S]*?const ep = episodeId\.value[\s\S]*?await fileToBase64[\s\S]*?scene-review\/\$\{ep\}\/upload-image/)
  assert.match(sceneReview, /async function uploadClipOne[\s\S]*?const ep = episodeId\.value[\s\S]*?scene-review\/\$\{ep\}\/upload-clip/)
})

test('image workflows pin project scope as well as episode scope across same-code project switches', () => {
  assert.match(characterSheet, /let characterScopeSequence = 0[\s\S]*?watch\(\[slug, episodeId\][\s\S]*?characterScopeSequence\+\+/)
  for (const loader of ['loadCharacters', 'loadConfig', 'loadRefs']) {
    assert.match(
      characterSheet,
      new RegExp(`async function ${loader}\\([\\s\\S]*?const project = slug\\.value[\\s\\S]*?scope === characterScopeSequence[\\s\\S]*?project === slug\\.value`),
    )
  }
  assert.match(characterSheet, /async function onSheetFiles[\s\S]*?const project = slug\.value[\s\S]*?await fileToBase64[\s\S]*?if \(!current\(\)\) return[\s\S]*?projects\/\$\{project\}\/episodes\/\$\{ep\}/)
  assert.match(characterSheet, /async function onCompositionFiles[\s\S]*?const project = slug\.value[\s\S]*?projects\/\$\{project\}\/episodes\/\$\{ep\}/)
  assert.match(images, /let imageScopeSequence = 0[\s\S]*?watch\(\[slug, \(\) => form\.episode_id\][\s\S]*?imageScopeSequence\+\+/)
  assert.match(images, /async function refreshImageStatus[\s\S]*?const project = slug\.value[\s\S]*?scope === imageScopeSequence[\s\S]*?projects\/\$\{project\}/)
  assert.match(imagePrompts, /let promptScopeSequence = 0[\s\S]*?watch\(\[slug, \(\) => form\.episode_id\][\s\S]*?promptScopeSequence\+\+[\s\S]*?async function runGenerate[\s\S]*?const scope = promptScopeSequence/)
  assert.match(sceneReview, /let reviewScopeSequence = 0[\s\S]*?watch\(\[slug, episodeId\][\s\S]*?reviewScopeSequence\+\+/)
  assert.match(sceneReview, /async function uploadOne[\s\S]*?const project = slug\.value[\s\S]*?await fileToBase64[\s\S]*?projects\/\$\{project\}\/scene-review\/\$\{ep\}/)
  assert.match(sceneReview, /async function loadContinuityFlag[\s\S]*?const project = slug\.value[\s\S]*?scope === reviewScopeSequence[\s\S]*?projects\/\$\{project\}\/effective-format[\s\S]*?projects\/\$\{project\}\/continuity\/\$\{ep\}/)
  assert.match(sceneReview, /async function pollUntilImageReady\(sceneId: string, ep: string, project: string, scope: number\)[\s\S]*?scope === reviewScopeSequence/)
  assert.match(sceneReview, /async function pollUntilAllPresent\(ep: string, project: string, scope: number\)[\s\S]*?scope === reviewScopeSequence/)
  assert.match(imagePool, /let imagePoolScopeSequence = 0[\s\S]*?watch\(\[slug, episodeId\][\s\S]*?imagePoolScopeSequence\+\+/)
})
