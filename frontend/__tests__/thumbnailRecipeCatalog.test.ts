import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

type RecipeComponent = 'ThumbnailRecipePicker.vue' | 'ThumbnailRecipeLibraryModal.vue'

const recipes = [
  {
    id: 'real-recipe', name: 'Real Recipe', description: 'Uses finished examples.', category: 'Story',
    tags: ['calm'], previewImages: ['/examples/real-1.webp', '/examples/real-2.webp'], recipe: { layout: 'hero' },
  },
  {
    id: 'placeholder-recipe', name: 'Placeholder Recipe', description: 'Has layout instructions only.', category: 'Story',
    tags: ['sleep'], recipe: { layout: 'hero' },
  },
]

async function loadRecipeComponent(name: RecipeComponent): Promise<Component> {
  const filename = fileURLToPath(new URL(`../components/${name}`, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: `thumbnail-recipe-${name}`, inlineTemplate: true })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, nextTick, onMounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__thumbnailRecipeApi
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
}

function installRecipeStubs(app: ReturnType<typeof createApp>): void {
  app.component('ThumbnailRecipeLibraryModal', defineComponent({ render: () => null }))
  app.component('Modal', defineComponent({
    props: { visible: Boolean },
    setup(props, { slots }) { return () => props.visible ? h('section', { role: 'dialog' }, slots.default?.()) : null },
  }))
}

async function mountPicker(selectedRecipeId: string) {
  ;(globalThis as any).__thumbnailRecipeApi = { get: async () => ({ templates: recipes }) }
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadRecipeComponent('ThumbnailRecipePicker.vue'), { selectedRecipeId })
  installRecipeStubs(app)
  app.mount(host)
  await flush()
  return { host, unmount: () => { app.unmount(); host.remove() } }
}

async function mountLibrary(selectedRecipeId: string) {
  ;(globalThis as any).__thumbnailRecipeApi = { get: async () => ({ templates: recipes }) }
  const Library = await loadRecipeComponent('ThumbnailRecipeLibraryModal.vue')
  const visible = ref(false)
  const Root = defineComponent({ setup: () => () => h(Library, { visible: visible.value, selectedRecipeId }) })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Root)
  installRecipeStubs(app)
  app.mount(host)
  visible.value = true
  await flush()
  return { host, unmount: () => { app.unmount(); host.remove() } }
}

test('thumbnail recipe library scales with searchable classifications, favorites, recents, and generated examples', () => {
  const catalog = source('../components/ThumbnailRecipeLibraryModal.vue')
  const picker = source('../components/ThumbnailRecipePicker.vue')
  assert.match(catalog, /Thumbnail Recipe Library/)
  assert.match(catalog, /previewImages/)
  assert.match(catalog, /Search formats, subjects, layouts, or tags/)
  assert.match(catalog, /Favorites/)
  assert.match(catalog, /Recent/)
  assert.match(catalog, /category:\$\{category\}/)
  assert.match(catalog, /story-studio:thumbnail-recipe-library:favorites/)
  assert.match(catalog, /story-studio:thumbnail-recipe-library:recents/)
  assert.match(catalog, /filter\(template => Boolean\(template\.recipe\)\)/)
  assert.match(picker, /ThumbnailRecipeLibraryModal/)
})

test('recipe previews identify declared examples and synthetic layout placeholders', async () => {
  const realPicker = await mountPicker('real-recipe')
  try {
    const image = realPicker.host.querySelector<HTMLImageElement>('.recipe-picker-current img')!
    assert.equal(image.getAttribute('src'), '/examples/real-1.webp')
    assert.equal(image.getAttribute('alt'), 'Real Recipe generated thumbnail example 1 of 2')
    assert.match(realPicker.host.querySelector('.recipe-picker-hints')!.textContent!, /Generated examples included/)
  } finally { realPicker.unmount() }

  const placeholderPicker = await mountPicker('placeholder-recipe')
  try {
    const image = placeholderPicker.host.querySelector<HTMLImageElement>('.recipe-picker-current img')!
    assert.equal(image.getAttribute('src'), '/api/thumbnail-templates/placeholder-recipe/preview.png')
    assert.equal(image.getAttribute('alt'), 'Placeholder Recipe layout placeholder; no generated example available')
    assert.match(placeholderPicker.host.querySelector('.recipe-picker-hints')!.textContent!, /Layout placeholder · no generated examples yet/)
    assert.doesNotMatch(placeholderPicker.host.querySelector('.recipe-picker-hints')!.textContent!, /Generated examples included/)
  } finally { placeholderPicker.unmount() }

  const library = await mountLibrary('placeholder-recipe')
  try {
    const cards = [...library.host.querySelectorAll<HTMLElement>('.rlm-card')]
    const realCard = cards.find(card => card.textContent?.includes('Real Recipe'))!
    const placeholderCard = cards.find(card => card.textContent?.includes('Placeholder Recipe'))!
    const realImage = realCard.querySelector<HTMLImageElement>('img')!
    const placeholderImage = placeholderCard.querySelector<HTMLImageElement>('img')!

    assert.equal(realImage.getAttribute('src'), '/examples/real-1.webp')
    assert.equal(realImage.getAttribute('alt'), 'Real Recipe generated thumbnail example 1 of 2')
    assert.equal(placeholderImage.getAttribute('src'), '/api/thumbnail-templates/placeholder-recipe/preview.png')
    assert.equal(placeholderImage.getAttribute('alt'), 'Placeholder Recipe layout placeholder; no generated example available')
    assert.equal(placeholderCard.querySelector('.rlm-preview-dots'), null)
    assert.equal(library.host.querySelector<HTMLImageElement>('.rlm-selection img')!.getAttribute('alt'), '')
    assert.match(library.host.querySelector('.rlm-selection')!.textContent!, /Layout placeholder · no generated examples yet/)

    realCard.querySelector<HTMLElement>('.rlm-preview-dots button:nth-child(2)')!.click()
    await flush()
    assert.equal(realImage.getAttribute('src'), '/examples/real-2.webp')
    assert.equal(realImage.getAttribute('alt'), 'Real Recipe generated thumbnail example 2 of 2')

    realCard.click()
    await flush()
    assert.match(library.host.querySelector('.rlm-selection')!.textContent!, /Generated examples included/)
  } finally { library.unmount() }
})

test('thumbnail prompts can choose a catalog recipe without replacing visual art style', () => {
  const page = source('../pages/projects/[slug]/image-prompts.vue')
  assert.match(page, /ThumbnailRecipePicker/)
  assert.match(page, /thumbnail_template_id/)
  assert.match(page, /<label>Visual art style<\/label>/)
  assert.match(page, /thumb_title_mode: 'ai'/)
  assert.match(page, /The episode title is drawn directly into every thumbnail/i)
  assert.match(page, /its own short text, written to suit it/i)
  assert.match(page, /thumbnailHeadlineMode/)
  assert.match(page, /id: 'bottom-left', label: 'Bottom left'/)
})

test('curiosity-question cartoon ships original examples and recipe-owned short-hook rules', () => {
  const recipe = JSON.parse(source('../../electron/server/thumbnail-templates/curiosity-question-cartoon.json'))
  assert.equal(recipe.recipe.headlineMode, 'curiosity-hook')
  assert.match(recipe.recipe.headlineGuidance, /truthful 1–4 word hook/i)
  assert.equal(recipe.previewImages.length, 3)
  for (const preview of recipe.previewImages) {
    const previewPath = fileURLToPath(new URL(`../public${preview}`, import.meta.url))
    assert.equal(existsSync(previewPath), true, `${preview} exists`)
  }
})

test('Animals defaults to the curiosity recipe without making art style a niche lock', () => {
  const animals = JSON.parse(source('../../electron/server/niches/animals.json'))
  assert.equal(animals.defaultThumbnailTemplateId, 'curiosity-question-cartoon')
})

test('deep-time documentary recipe is browseable, AI-rendered, and profile-aware', () => {
  const recipe = JSON.parse(source('../../electron/server/thumbnail-templates/documentary-label-tableau.json'))
  assert.equal(recipe.category, 'Documentary')
  assert.equal(recipe.recipe.titleMode, 'ai')
  assert.match(recipe.recipe.headlineGuidance, /Deep Rest episode/i)
  assert.match(recipe.recipe.headlineGuidance, /2–5 word factual label/i)
  assert.equal(recipe.previewImages.length, 3)
  for (const preview of recipe.previewImages) {
    const previewPath = fileURLToPath(new URL(`../public${preview}`, import.meta.url))
    assert.equal(existsSync(previewPath), true, `${preview} exists`)
  }

  const formula = JSON.parse(source('../../electron/server/niches/deep-time-documentary.json'))
  assert.equal(formula.defaultThumbnailTemplateId, recipe.id)
  // A Formula binds its recipe, never a visual style — the look is chosen.
  assert.equal(formula.productionKit.recommendedVisualStyleId, undefined)
})

test('archival map investigation is discoverable as an original history recipe', () => {
  const recipe = JSON.parse(source('../../electron/server/thumbnail-templates/archival-map-investigation.json'))
  assert.equal(recipe.category, 'History')
  assert.ok(recipe.tags.includes('archival'))
  assert.equal(recipe.recipe.titleMode, 'ai')
  assert.match(recipe.recipe.compositionRules.join('\n'), /parchment map/i)
  assert.match(recipe.recipe.compositionRules.join('\n'), /exact episode title/i)
  assert.match(recipe.recipe.avoid.join('\n'), /copied creator trade dress/i)
  assert.deepEqual(recipe.previewImages, [
    '/builtin-thumbnail-previews/archival-map-investigation-1.webp',
    '/builtin-thumbnail-previews/archival-map-investigation-2.webp',
    '/builtin-thumbnail-previews/archival-map-investigation-3.webp',
  ])
})
