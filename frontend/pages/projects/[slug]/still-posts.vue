<!--
  Still Posts — one workspace for a Still Posts channel.

  Owner, 2026-10-27. A post is one short quote burned onto one illustrated picture, written and
  drawn in batches. This page IS the production path: the channel's cast, the batch writer, the
  picture job, and a per-post editor that re-letters a post the moment its words change.

  What the page never does: choose a model, guess whether a post is finished, or draw text with an
  image model. Model lists are live from the Gateway, the "done" verdict comes from the server (which
  reads the files), and every word is drawn by our own renderer.
-->
<template>
  <div class="workspace-page sp">
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Still Posts</h1>
      <p class="page-sub">
        One short line, one illustrated picture, your characters. Write a batch, draw it, then edit
        any post's words — the picture is re-lettered immediately, and the words are never drawn by
        the image model.
      </p>
    </div>

    <p v-if="loadError" class="sp-notice sp-notice-error" role="alert">
      {{ loadError }}
      <button type="button" class="btn btn-sm btn-ghost" :disabled="loading" @click="load">Retry</button>
    </p>

    <template v-if="workspace">
      <!-- 1. The channel's own identity ------------------------------------------------ -->
      <section class="card sp-section">
        <div class="sp-section-head">
          <div>
            <h3 class="sp-h3">Channel</h3>
            <p class="sp-help">
              The cast belongs to this channel, not to a post. Choose up to 10 characters; every
              post may use any of them, and no post may use one from another channel.
            </p>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" :disabled="savingConfig" @click="saveConfig">
            {{ savingConfig ? 'Saving…' : 'Save channel' }}
          </button>
        </div>

        <p v-if="configNote" class="sp-note" :class="{ 'sp-note-error': configError }" role="status">{{ configNote }}</p>

        <h4 class="sp-h4">Characters <span class="sp-count">{{ castDraft.length }}/10</span></h4>
        <p v-if="!workspace.characters.length" class="sp-help">
          This channel has no characters yet. Create one on the
          <NuxtLink :to="{ path: '/character-library', query: { channel: slug, project: slug } }" class="sp-link">Channel Characters</NuxtLink>
          page with at least one reference image, then come back.
        </p>
        <div v-else class="sp-cast">
          <label
            v-for="character in workspace.characters"
            :key="character.id"
            class="sp-cast-item"
            :class="{ 'is-on': castDraft.includes(character.id), 'is-off': !character.has_reference }"
          >
            <input
              type="checkbox"
              :checked="castDraft.includes(character.id)"
              :disabled="!character.has_reference || (!castDraft.includes(character.id) && castDraft.length >= 10)"
              @change="toggleCast(character.id)"
            >
            <img v-if="character.portrait_url" :src="character.portrait_url" :alt="character.name" class="sp-cast-portrait">
            <span v-else class="sp-cast-placeholder" aria-hidden="true">?</span>
            <span class="sp-cast-text">
              <strong>{{ character.name }}</strong>
              <span class="sp-help">{{ character.has_reference ? (character.description || 'No description') : 'No reference image yet — add one on Channel Characters.' }}</span>
            </span>
          </label>
        </div>

        <div class="sp-two">
          <label class="sp-field">
            <span class="sp-label">Handle</span>
            <input v-model="handleDraft" class="input" maxlength="60" :placeholder="workspace.config.handle ? `@${workspace.config.handle}` : 'no handle set on this channel'">
            <span class="sp-help">Blank uses the channel's own handle. Drawn by our renderer, in the post's own language font.</span>
          </label>
          <label class="sp-field">
            <span class="sp-label">Logo file</span>
            <input v-model="logoDraft" class="input" placeholder="Leave empty until you have a logo PNG">
            <span class="sp-help">
              The logo layer is built and simply draws nothing until a file is set.
              <template v-if="workspace.config.logo_ready">A logo is set and found.</template>
              <template v-else>No logo file is in place yet.</template>
            </span>
          </label>
        </div>
      </section>

      <!-- 2. The preset --------------------------------------------------------------- -->
      <section class="card sp-section">
        <div class="sp-section-head">
          <div>
            <h3 class="sp-h3">Preset</h3>
            <p class="sp-help">
              Presets hold the reusable look only: formats, layout, language, export frames, the
              handle and logo placement, and the models you chose. Never a character, never a quote.
            </p>
          </div>
          <div class="sp-row">
            <select v-model="presetId" class="select" @change="applyPreset(presetId)">
              <option v-for="preset in workspace.presets" :key="preset.id" :value="preset.id">
                {{ preset.name }}{{ preset.builtin ? ' (built in)' : '' }}
              </option>
            </select>
            <input v-model="presetName" class="input input-sm" maxlength="60" aria-label="New preset name" placeholder="Preset name">
            <button type="button" class="btn btn-sm btn-secondary" :disabled="savingPreset" @click="savePreset">
              {{ savingPreset ? 'Saving…' : 'Save as new preset' }}
            </button>
          </div>
        </div>

        <p v-if="presetNote" class="sp-note" :class="{ 'sp-note-error': presetError }" role="status">{{ presetNote }}</p>

        <div class="sp-grid">
          <label class="sp-field">
            <span class="sp-label">Format (the look)</span>
            <select v-model="preset.format_id" class="select">
              <option v-for="format in workspace.formats" :key="format.id" :value="format.id">{{ format.name }}</option>
            </select>
            <span class="sp-help">{{ draftFormat?.description }}</span>
          </label>
          <label class="sp-field">
            <span class="sp-label">Option (the layout)</span>
            <select v-model="preset.option_id" class="select">
              <option v-for="option in workspace.options" :key="option.id" :value="option.id">{{ option.name }}</option>
            </select>
            <span class="sp-help">{{ draftOption?.description }}</span>
          </label>
          <label class="sp-field">
            <span class="sp-label">Language</span>
            <select v-model="preset.language" class="select">
              <option v-for="entry in languages" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
            </select>
            <span class="sp-help">{{ letteringFontLabel }}</span>
          </label>
          <div class="sp-field">
            <span class="sp-label">Export frames</span>
            <div class="sp-checks">
              <label v-for="aspect in aspects" :key="aspect" class="sp-check">
                <input v-model="preset.aspects" type="checkbox" :value="aspect"> {{ aspect }}
              </label>
            </div>
            <span class="sp-help">Every chosen frame is rendered for every post before a batch is complete.</span>
          </div>
          <label class="sp-field">
            <span class="sp-label">Writing model</span>
            <select v-model="preset.writing_model" class="select">
              <option :value="null">This Mac's default writing model</option>
              <option v-for="model in writingModels" :key="model.id" :value="model.id" :disabled="!model.available">
                {{ model.label }}{{ model.available ? '' : ' (unavailable)' }}
              </option>
            </select>
          </label>
          <label class="sp-field">
            <span class="sp-label">Image model</span>
            <select v-model="preset.image_model" class="select">
              <option :value="null" disabled>Choose a live Gateway model…</option>
              <option v-for="model in imageModels" :key="model.id" :value="model.id" :disabled="model.available === false">
                {{ model.display_name }}{{ model.supports_reference_images ? ' · references' : '' }}
              </option>
            </select>
            <span class="sp-help">{{ imageModelHelp }}</span>
          </label>
          <label class="sp-field">
            <span class="sp-label">Text size <span class="sp-count">{{ preset.text_scale.toFixed(2) }}×</span></span>
            <input v-model.number="preset.text_scale" class="sp-range" type="range" min="0.6" max="1.6" step="0.05">
          </label>
        </div>

        <h4 class="sp-h4">Handle and logo</h4>
        <div class="sp-grid">
          <label class="sp-check">
            <input v-model="preset.branding.handle_enabled" type="checkbox"> Burn the handle in
          </label>
          <label class="sp-field">
            <span class="sp-label">Handle for this preset</span>
            <input v-model="preset.branding.handle_text" class="input" placeholder="Use the channel's handle">
          </label>
          <label class="sp-check">
            <input v-model="preset.branding.logo_enabled" type="checkbox"> Burn the logo in
          </label>
          <label class="sp-field">
            <span class="sp-label">Position</span>
            <select v-model="preset.branding.position" class="select">
              <option v-for="anchor in anchors" :key="anchor" :value="anchor">{{ anchor }}</option>
            </select>
          </label>
          <label class="sp-field">
            <span class="sp-label">Handle size <span class="sp-count">{{ preset.branding.handle_size_px }}px</span></span>
            <input v-model.number="preset.branding.handle_size_px" class="sp-range" type="range" min="12" max="80" step="1">
          </label>
          <label class="sp-field">
            <span class="sp-label">Logo width <span class="sp-count">{{ preset.branding.logo_width_pct }}%</span></span>
            <input v-model.number="preset.branding.logo_width_pct" class="sp-range" type="range" min="3" max="40" step="1">
          </label>
          <label class="sp-field">
            <span class="sp-label">Margin <span class="sp-count">{{ preset.branding.margin_pct }}%</span></span>
            <input v-model.number="preset.branding.margin_pct" class="sp-range" type="range" min="0" max="12" step="0.5">
          </label>
          <label class="sp-field">
            <span class="sp-label">Opacity <span class="sp-count">{{ Math.round(preset.branding.opacity * 100) }}%</span></span>
            <input v-model.number="preset.branding.opacity" class="sp-range" type="range" min="0.2" max="1" step="0.05">
          </label>
        </div>
      </section>

      <!-- 3. Write a batch ------------------------------------------------------------ -->
      <section class="card sp-section">
        <div class="sp-section-head">
          <div>
            <h3 class="sp-h3">Write a batch</h3>
            <p class="sp-help">One request writes the whole batch in the channel's Formula voice, in the preset's language.</p>
          </div>
        </div>
        <div class="sp-two">
          <label class="sp-field sp-grow">
            <span class="sp-label">What is this batch about?</span>
            <textarea v-model="brief" class="textarea" rows="3" placeholder="Late-night thoughts about leaving a city you love"></textarea>
          </label>
          <label class="sp-field sp-narrow">
            <span class="sp-label">Posts</span>
            <input v-model.number="count" class="input" type="number" min="1" max="40">
          </label>
        </div>
        <div class="sp-row">
          <button type="button" class="btn btn-primary" :disabled="!canWrite || writing" @click="writeBatch">
            {{ writing ? 'Writing…' : `Write ${count} post${count === 1 ? '' : 's'}` }}
          </button>
          <span v-if="writeJob" class="sp-help">{{ activeJobLine(writeJob) }}</span>
        </div>
        <p v-if="writeError" class="sp-notice sp-notice-error" role="alert">{{ writeError }}</p>
      </section>

      <!-- 4. Posts -------------------------------------------------------------------- -->
      <section class="card sp-section">
        <div class="sp-section-head">
          <div>
            <h3 class="sp-h3">Posts <span class="sp-count">{{ workspace.posts.length }}</span></h3>
            <p class="sp-help">
              A batch is complete only when every post has its artwork and a rendered final in every
              chosen frame. Retry draws only what is missing.
            </p>
          </div>
          <div class="sp-row">
            <button type="button" class="btn btn-sm btn-secondary" :disabled="!canDraw" @click="draw(undefined)">
              {{ drawing ? 'Drawing…' : 'Draw everything missing' }}
            </button>
          </div>
        </div>

        <p v-if="drawError" class="sp-notice sp-notice-error" role="alert">{{ drawError }}</p>

        <div v-if="workspace.batches.length" class="sp-batches">
          <div v-for="batch in workspace.batches" :key="batch.batch_id" class="sp-batch">
            <div>
              <strong>{{ batch.batch_id }}</strong>
              <span class="sp-help">
                {{ batch.complete_count }}/{{ batch.total }} complete · {{ batch.aspects.join(', ') }}
              </span>
            </div>
            <span class="sp-pill" :class="batch.complete ? 'is-ok' : 'is-warn'">
              {{ batch.complete ? 'Complete' : `${batch.missing.length} item(s) missing` }}
            </span>
            <button type="button" class="btn btn-sm btn-ghost" :disabled="!canDraw" @click="draw(batch.batch_id)">
              Draw this batch
            </button>
          </div>
        </div>

        <p v-if="!workspace.posts.length" class="sp-help sp-empty">
          No posts yet. Write a batch above — each post arrives with its quote, its scene and a caption.
        </p>

        <div v-else class="sp-posts">
          <button
            v-for="post in workspace.posts"
            :key="post.id"
            type="button"
            class="sp-post"
            :class="{ 'is-selected': selectedId === post.id }"
            @click="selectPost(post)"
          >
            <img
              v-if="postImageUrl(post)"
              :src="postImageUrl(post)"
              :alt="post.panels[0]?.text || post.id"
              class="sp-post-image"
              loading="lazy"
            >
            <span v-else class="sp-post-empty">Not drawn yet</span>
            <span class="sp-post-meta">
              <span class="sp-post-text">{{ post.panels[0]?.text }}</span>
              <span class="sp-help">{{ post.format_id }} · {{ post.option_id }} · {{ post.language }}</span>
            </span>
            <span class="sp-pill" :class="postState(post.id)?.complete ? 'is-ok' : 'is-warn'">
              {{ postState(post.id)?.complete ? 'Complete' : 'Incomplete' }}
            </span>
          </button>
        </div>
      </section>

      <!-- 5. The editor --------------------------------------------------------------- -->
      <section v-if="selected" class="card sp-section sp-editor">
        <div class="sp-section-head">
          <div>
            <h3 class="sp-h3">{{ selected.id }}</h3>
            <p class="sp-help">
              Edit the words and they are re-lettered immediately. The scene text goes to the image
              model and never contains lettering.
            </p>
          </div>
          <div class="sp-row">
            <button type="button" class="btn btn-sm btn-secondary" :disabled="!canDraw" @click="draw(undefined, [selected.id], true)">
              Redraw artwork
            </button>
            <button type="button" class="btn btn-sm btn-danger" @click="deletePost(selected.id)">Remove</button>
          </div>
        </div>

        <p v-if="editorNote" class="sp-note" :class="{ 'sp-note-error': editorError }" role="status">{{ editorNote }}</p>

        <div class="sp-editor-grid">
          <div class="sp-editor-fields">
            <div v-for="(panel, index) in selected.panels" :key="panel.id" class="sp-panel-fields">
              <h4 class="sp-h4">
                {{ selected.panels.length === 1 ? 'The words' : (index === 0 ? 'Setup' : 'Punchline') }}
              </h4>
              <label class="sp-field">
                <span class="sp-label">Burned-in line</span>
                <textarea v-model="editor.panels[index].text" class="textarea" rows="2" />
              </label>
              <label class="sp-field">
                <span class="sp-label">What the picture shows</span>
                <textarea v-model="editor.panels[index].scene_prompt" class="textarea" rows="2" />
                <span class="sp-help">Text-free. Re-draw the artwork to use a changed scene.</span>
              </label>
            </div>

            <label class="sp-field">
              <span class="sp-label">Caption</span>
              <textarea v-model="editor.caption" class="textarea" rows="3" />
            </label>

            <div class="sp-grid">
              <label class="sp-field">
                <span class="sp-label">Format</span>
                <select v-model="editor.format_id" class="select">
                  <option v-for="format in workspace.formats" :key="format.id" :value="format.id">{{ format.name }}</option>
                </select>
              </label>
              <label class="sp-field">
                <span class="sp-label">Option</span>
                <select v-model="editor.option_id" class="select">
                  <option v-for="option in workspace.options" :key="option.id" :value="option.id">{{ option.name }}</option>
                </select>
              </label>
              <label class="sp-field">
                <span class="sp-label">Language</span>
                <select v-model="editor.language" class="select">
                  <option v-for="entry in languages" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
                </select>
              </label>
              <div class="sp-field">
                <span class="sp-label">Frames</span>
                <div class="sp-checks">
                  <label v-for="aspect in aspects" :key="aspect" class="sp-check">
                    <input v-model="editor.aspects" type="checkbox" :value="aspect"> {{ aspect }}
                  </label>
                </div>
              </div>
            </div>

            <div class="sp-field">
              <span class="sp-label">Characters in this post</span>
              <div class="sp-checks">
                <label v-for="character in castCharacters" :key="character.id" class="sp-check">
                  <input v-model="editor.character_ids" type="checkbox" :value="character.id"> {{ character.name }}
                </label>
              </div>
              <span class="sp-help">
                Attached as reference images where the chosen image model publishes reference support.
              </span>
            </div>

            <div class="sp-row">
              <button type="button" class="btn btn-primary" :disabled="savingPost" @click="savePost">
                {{ savingPost ? 'Saving…' : 'Save and re-letter' }}
              </button>
            </div>
          </div>

          <div class="sp-editor-preview">
            <div class="sp-tabs">
              <button
                v-for="aspect in editor.aspects"
                :key="aspect"
                type="button"
                class="sp-tab"
                :class="{ 'is-active': previewAspect === aspect }"
                @click="previewAspect = aspect"
              >
                {{ aspect }}
              </button>
            </div>
            <div v-for="(panel, index) in selected.panels" :key="panel.id" class="sp-preview-panel">
              <p class="sp-help">{{ selected.panels.length === 1 ? 'Final' : (index === 0 ? 'Setup' : 'Punchline') }}</p>
              <img
                v-if="finalUrl(selected, index, previewAspect)"
                :src="finalUrl(selected, index, previewAspect)!"
                :alt="panel.text"
                class="sp-preview-image"
              >
              <p v-else class="sp-help sp-empty">
                {{ finalState(selected, index, previewAspect) === 'stale' ? 'The words changed — save to re-letter.' : 'Not rendered yet.' }}
              </p>
              <a
                v-if="finalUrl(selected, index, previewAspect)"
                :href="`${fileBase(selected)}/${finalName(index, previewAspect)}?download=1`"
                class="sp-link"
              >
                Download {{ previewAspect }}
              </a>
            </div>
            <p class="sp-help">
              The picture is drawn once, then fitted into every chosen frame by our renderer — a
              second frame is never a second paid render.
            </p>
          </div>
        </div>
      </section>
    </template>

    <p v-else-if="loading" class="sp-help">Loading Still Posts…</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useJobs } from '~/composables/useJobs'
import { useConfirm } from '~/composables/useConfirm'
import { projectSlug } from '~/utils/project-slug'
import type { Job } from '~/composables/useJobs'

definePageMeta({ layout: 'dashboard' })

interface StillPostBranding {
  handle_enabled: boolean
  handle_text: string | null
  logo_enabled: boolean
  position: string
  handle_size_px: number
  logo_width_pct: number
  margin_pct: number
  opacity: number
}

interface StillPostPresetData {
  writing_model: string | null
  image_model: string | null
  format_id: string
  option_id: string
  language: 'en' | 'km' | 'zh'
  aspects: string[]
  text_scale: number
  branding: StillPostBranding
}

interface StillPostPanelState { panel_id: string, image: string, finals: Record<string, string>, problems: string[] }
interface StillPostState { id: string, complete: boolean, panels: StillPostPanelState[], problems: string[] }
interface StillPost {
  id: string
  batch_id: string
  format_id: string
  option_id: string
  language: 'en' | 'km' | 'zh'
  character_ids: string[]
  caption: string
  panels: Array<{ id: string, role: string, text: string, scene_prompt: string }>
  finals: Array<{ aspect: string, panel_id: string, filename: string, text: string }>
  aspects: string[]
  updated_at: string
}
interface Workspace {
  config: { character_ids: string[], logo_path: string | null, handle: string | null, logo_ready: boolean }
  characters: Array<{ id: string, name: string, description: string, has_reference: boolean, reference_count: number, portrait_url: string | null }>
  formats: Array<{ id: string, name: string, description: string, lettering: { fonts: Record<string, string> } }>
  options: Array<{ id: string, name: string, description: string, panels: 1 | 2 }>
  presets: Array<{ id: string, name: string, builtin: boolean, data: StillPostPresetData }>
  last_preset_id: string | null
  posts: StillPost[]
  batches: Array<{ batch_id: string, aspects: string[], total: number, complete_count: number, complete: boolean, posts: StillPostState[], missing: string[] }>
}

const route = useRoute()
const { get, put, post, del } = useApi()
// The dashboard layout already keeps this channel's job stream open; this page only reads it.
const { jobs } = useJobs()
const { ask } = useConfirm()

const slug = computed(() => projectSlug(route.params.slug) || '')
// model-drift-allow: the export frames Story composes itself after drawing, chosen by the owner for Still Posts; not a model aspect list
const aspects = ['1:1', '9:16', '16:9'] as const
const anchors = ['bottom', 'bottom-left', 'bottom-right', 'top', 'top-left', 'top-right', 'center']
const languages = [
  { id: 'en', label: 'English' },
  { id: 'km', label: 'Khmer' },
  { id: 'zh', label: 'Mandarin (Simplified Chinese)' },
]

const workspace = ref<Workspace | null>(null)
const loading = ref(true)
const loadError = ref('')

const castDraft = ref<string[]>([])
const handleDraft = ref('')
const logoDraft = ref('')
const savingConfig = ref(false)
const configNote = ref('')
const configError = ref(false)

const presetId = ref('clean-handle')
const preset = reactive<StillPostPresetData>({
  writing_model: null,
  image_model: null,
  format_id: 'night-painterly',
  option_id: 'quote-top',
  language: 'en',
  aspects: ['1:1'],
  text_scale: 1,
  branding: {
    handle_enabled: true,
    handle_text: null,
    logo_enabled: true,
    position: 'bottom',
    handle_size_px: 30,
    logo_width_pct: 12,
    margin_pct: 4,
    opacity: 0.9,
  },
})
const savingPreset = ref(false)
const presetNote = ref('')
const presetError = ref(false)

const brief = ref('')
const count = ref(6)
const writing = ref(false)
const writeError = ref('')
const writeJobId = ref<string | null>(null)
const presetName = ref('My still posts preset')

const drawing = ref(false)
const drawError = ref('')

const selectedId = ref<string | null>(null)
const editor = reactive<{
  panels: Array<{ text: string, scene_prompt: string }>
  caption: string
  format_id: string
  option_id: string
  language: 'en' | 'km' | 'zh'
  aspects: string[]
  character_ids: string[]
}>({ panels: [], caption: '', format_id: '', option_id: '', language: 'en', aspects: ['1:1'], character_ids: [] })
const previewAspect = ref('1:1')
const savingPost = ref(false)
const editorNote = ref('')
const editorError = ref(false)

const writingModels = ref<Array<{ id: string, label: string, available: boolean }>>([])
const imageModels = ref<Array<{ id: string, display_name: string, available?: boolean, supports_reference_images?: boolean, max_reference_images?: number }>>([])

const draftFormat = computed(() => workspace.value?.formats.find(format => format.id === preset.format_id) || null)
const draftOption = computed(() => workspace.value?.options.find(option => option.id === preset.option_id) || null)
const letteringFontLabel = computed(() => {
  const script = preset.language === 'km' ? 'khmr' : preset.language === 'zh' ? 'hani' : 'latn'
  const font = draftFormat.value?.lettering.fonts[script]
  return font ? `Lettering: ${font}` : 'This format has no font for that language yet.'
})
const imageModelHelp = computed(() => {
  const model = imageModels.value.find(entry => entry.id === preset.image_model)
  if (!preset.image_model) return 'Pick a live Gateway model. Nothing is chosen for you.'
  if (!model) return 'That model is not in the live catalogue right now.'
  return model.supports_reference_images
    ? `References: up to ${model.max_reference_images ?? '?'} character portrait(s).`
    : 'This model publishes no reference support, so your characters cannot be attached to it.'
})
const castCharacters = computed(() => (workspace.value?.characters || []).filter(character => castDraft.value.includes(character.id)))
const canWrite = computed(() => !!workspace.value && brief.value.trim().length > 0)
const canDraw = computed(() => !!preset.image_model)
const selected = computed(() => workspace.value?.posts.find(entry => entry.id === selectedId.value) || null)
const writeJob = computed(() => jobs.value.find(job => job.job_id === writeJobId.value) || null)

function postState(id: string): StillPostState | undefined {
  for (const batch of workspace.value?.batches || []) {
    const hit = batch.posts.find(entry => entry.id === id)
    if (hit) return hit
  }
  return undefined
}

function finalName(index: number, aspect: string): string {
  return `final-p${index}-${String(aspect).replace(':', 'x')}.png`
}

function fileBase(entry: StillPost): string {
  return `/api/projects/${slug.value}/still-posts/posts/${entry.id}/file`
}

function postImageUrl(entry: StillPost): string | null {
  const final = entry.finals.find(item => item.aspect === (entry.aspects[0] || '1:1'))
  const name = final?.filename || 'p0.png'
  return `${fileBase(entry)}/${name}?v=${encodeURIComponent(entry.updated_at || '')}`
}

function finalUrl(entry: StillPost, index: number, aspect: string): string | null {
  const state = postState(entry.id)
  const panelId = entry.panels[index]?.id
  const stateOf = state?.panels.find(panel => panel.panel_id === panelId)?.finals?.[aspect]
  if (stateOf === 'ok' || stateOf === 'stale') {
    return `${fileBase(entry)}/${finalName(index, aspect)}?v=${encodeURIComponent(entry.updated_at || '')}`
  }
  return null
}

function finalState(entry: StillPost, index: number, aspect: string): string {
  const panelId = entry.panels[index]?.id
  return postState(entry.id)?.panels.find(panel => panel.panel_id === panelId)?.finals?.[aspect] || 'missing'
}

function activeJobLine(job: { status: string, error?: string | null, progress?: number }): string {
  if (job.status === 'done') return 'Done.'
  if (job.status === 'error') return job.error || 'Failed.'
  return `${job.status}${typeof job.progress === 'number' ? ` · ${job.progress}%` : ''}`
}

function toggleCast(id: string): void {
  const index = castDraft.value.indexOf(id)
  if (index >= 0) castDraft.value.splice(index, 1)
  else if (castDraft.value.length < 10) castDraft.value.push(id)
}

function applyPreset(id: string): void {
  const found = workspace.value?.presets.find(entry => entry.id === id)
  if (!found) return
  preset.writing_model = found.data.writing_model ?? null
  preset.image_model = found.data.image_model ?? null
  preset.format_id = found.data.format_id
  preset.option_id = found.data.option_id
  preset.language = found.data.language
  preset.aspects = [...(found.data.aspects || ['1:1'])]
  preset.text_scale = Number(found.data.text_scale) || 1
  Object.assign(preset.branding, found.data.branding)
  presetNote.value = found.builtin
    ? 'Built-in preset. Save it under a new name to change it.'
    : `Loaded "${found.name}".`
  presetError.value = false
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const data = await get<Workspace>(`/projects/${slug.value}/still-posts`)
    workspace.value = data
    castDraft.value = [...data.config.character_ids]
    handleDraft.value = data.config.handle && data.config.handle !== '' ? `@${data.config.handle}` : ''
    logoDraft.value = data.config.logo_path || ''
    presetId.value = data.last_preset_id && data.presets.some(entry => entry.id === data.last_preset_id)
      ? data.last_preset_id
      : data.presets[0]?.id || 'clean-handle'
    applyPreset(presetId.value)
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load Still Posts.'
  } finally {
    loading.value = false
  }
}

async function loadModels(): Promise<void> {
  try {
    const chat = await get<Array<{ id: string, label: string, available: boolean }>>(`/models?project=${slug.value}`)
    writingModels.value = chat.map(model => ({ id: model.id, label: model.label, available: model.available !== false }))
  } catch { writingModels.value = [] }
  try {
    const response = await get<{ models: any[] }>('/app-settings/genstudio/image-models')
    imageModels.value = response.models.map(model => ({
      id: model.id,
      display_name: model.display_name,
      available: model.available,
      supports_reference_images: model.supports_reference_images,
      max_reference_images: model.max_reference_images,
    }))
  } catch { imageModels.value = [] }
}

async function saveConfig(): Promise<void> {
  savingConfig.value = true
  configNote.value = ''
  try {
    await put(`/projects/${slug.value}/still-posts/config`, {
      character_ids: castDraft.value,
      handle: handleDraft.value.trim() || null,
      logo_path: logoDraft.value.trim() || null,
    })
    configNote.value = `Saved: ${castDraft.value.length} character(s) in this channel's cast.`
    configError.value = false
    await load()
  } catch (error: any) {
    configNote.value = error?.data?.detail || error?.message || 'Could not save the channel settings.'
    configError.value = true
  } finally {
    savingConfig.value = false
  }
}

async function savePreset(): Promise<void> {
  if (!workspace.value) return
  savingPreset.value = true
  presetNote.value = ''
  const name = presetName.value.trim() || 'Untitled preset'
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset'}-${Date.now().toString(36).slice(-4)}`
  const entry = {
    id,
    name,
    data: JSON.parse(JSON.stringify({ ...preset, branding: { ...preset.branding } })),
  }
  const saved = (workspace.value.presets || []).filter(item => !item.builtin)
  try {
    const response = await put<{ presets: Workspace['presets'] }>(`/projects/${slug.value}/still-posts/presets`, {
      presets: [...saved.map(item => ({ id: item.id, name: item.name, data: item.data })), entry],
      last_preset_id: id,
    })
    workspace.value.presets = response.presets
    presetId.value = id
    presetNote.value = `Saved "${name}".`
    presetError.value = false
  } catch (error: any) {
    presetNote.value = error?.data?.detail || error?.message || 'Could not save the preset.'
    presetError.value = true
  } finally {
    savingPreset.value = false
  }
}

async function writeBatch(): Promise<void> {
  if (!workspace.value) return
  writing.value = true
  writeError.value = ''
  writeJobId.value = null
  try {
    const response = await post<{ job: Job, batch_id: string }>(`/projects/${slug.value}/still-posts/batches`, {
      brief: brief.value.trim(),
      count: count.value,
      format_id: preset.format_id,
      option_id: preset.option_id,
      language: preset.language,
      aspects: preset.aspects,
      character_ids: castDraft.value,
      writing_model: preset.writing_model,
    })
    writeJobId.value = response.job.job_id
  } catch (error: any) {
    writeError.value = error?.data?.detail || error?.message || 'Could not start writing.'
  } finally {
    writing.value = false
  }
}

async function draw(batchId?: string, postIds?: string[], redraw = false): Promise<void> {
  drawing.value = true
  drawError.value = ''
  try {
    await post(`/projects/${slug.value}/still-posts/render`, {
      ...(batchId ? { batch_id: batchId } : {}),
      ...(postIds?.length ? { post_ids: postIds } : {}),
      image_model: preset.image_model,
      redraw,
      preset: { branding: preset.branding, text_scale: preset.text_scale },
    })
  } catch (error: any) {
    drawError.value = error?.data?.detail || error?.message || 'Could not start drawing.'
  } finally {
    drawing.value = false
  }
}

function selectPost(entry: StillPost): void {
  selectedId.value = entry.id
  editor.panels = entry.panels.map(panel => ({ text: panel.text, scene_prompt: panel.scene_prompt }))
  editor.caption = entry.caption
  editor.format_id = entry.format_id
  editor.option_id = entry.option_id
  editor.language = entry.language
  editor.aspects = [...(entry.aspects.length ? entry.aspects : ['1:1'])]
  editor.character_ids = [...entry.character_ids]
  previewAspect.value = editor.aspects[0] || '1:1'
  editorNote.value = ''
  editorError.value = false
}

async function savePost(): Promise<void> {
  if (!selected.value) return
  savingPost.value = true
  editorNote.value = ''
  try {
    const response = await put<{ post: StillPost, state: StillPostState, render_error: string | null }>(
      `/projects/${slug.value}/still-posts/posts/${selected.value.id}`,
      {
        panels: editor.panels,
        caption: editor.caption,
        format_id: editor.format_id,
        option_id: editor.option_id,
        language: editor.language,
        aspects: editor.aspects,
        character_ids: editor.character_ids,
        preset: { branding: preset.branding, text_scale: preset.text_scale },
      },
    )
    const index = workspace.value?.posts.findIndex(entry => entry.id === response.post.id) ?? -1
    if (workspace.value && index >= 0) workspace.value.posts.splice(index, 1, response.post)
    editorNote.value = response.render_error
      ? `Saved. Nothing was re-lettered: ${response.render_error}`
      : 'Saved and re-lettered.'
    editorError.value = !!response.render_error
    selectPost(response.post)
    editorNote.value = response.render_error
      ? `Saved. Nothing was re-lettered: ${response.render_error}`
      : 'Saved and re-lettered.'
    editorError.value = !!response.render_error
  } catch (error: any) {
    editorNote.value = error?.data?.detail || error?.message || 'Could not save this post.'
    editorError.value = true
  } finally {
    savingPost.value = false
  }
}

async function deletePost(id: string): Promise<void> {
  const confirmed = await ask({
    title: 'Remove this post?',
    message: 'It moves to the channel’s recycle bin (_trash), so it is not gone for good.',
    confirmLabel: 'Remove',
    danger: true,
  })
  if (!confirmed) return
  try {
    await del(`/projects/${slug.value}/still-posts/posts/${id}`)
    if (selectedId.value === id) selectedId.value = null
    await load()
  } catch (error: any) {
    editorNote.value = error?.data?.detail || error?.message || 'Could not remove the post.'
    editorError.value = true
  }
}

// A finished Still Posts job changes the files on disk, so the workspace is re-read rather than
// patched from the job payload.
watch(() => jobs.value.map(job => `${job.job_id}:${job.status}`).join('|'), () => {
  const finished = jobs.value.some(job =>
    (job.type === 'still_post_write' || job.type === 'still_post_render') && job.status === 'done')
  if (finished) void load()
})

onMounted(() => {
  void load()
  void loadModels()
})
</script>

<style scoped>
.sp { display: flex; flex-direction: column; gap: 14px; }
.page-sub { margin: 6px 0 0; color: var(--text-secondary); font-size: 13px; max-width: 78ch; }
.sp-section { padding: 16px 18px; }
.sp-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.sp-h3 { margin: 0; font-size: 16px; }
.sp-h4 { margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-secondary); }
.sp-count { color: var(--text-secondary); font-weight: 500; }
.sp-help { display: block; margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.sp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sp-two { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
.sp-grow { flex: 1 1 320px; }
.sp-narrow { flex: 0 0 120px; }
.sp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 10px; }
.sp-field { display: flex; flex-direction: column; gap: 4px; }
.sp-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.sp-checks { display: flex; gap: 12px; flex-wrap: wrap; }
.sp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.sp-range { width: 100%; }
.sp-note { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--accent) 12%, transparent); font-size: 13px; }
.sp-notice-error, .sp-note-error { background: color-mix(in srgb, #c0392b 16%, transparent); }
.sp-notice { margin: 8px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
.sp-link { color: var(--accent); text-decoration: underline; font-size: 12px; }
.sp-cast { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin-top: 8px; }
.sp-cast-item { display: flex; gap: 10px; align-items: center; padding: 8px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; }
.sp-cast-item.is-on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.sp-cast-item.is-off { opacity: 0.55; cursor: not-allowed; }
.sp-cast-portrait { width: 38px; height: 38px; object-fit: cover; border-radius: 8px; }
.sp-cast-placeholder { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 8px; background: var(--bg-tertiary); }
.sp-cast-text { display: flex; flex-direction: column; min-width: 0; }
.sp-batches { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.sp-batch { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; }
.sp-posts { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-top: 12px; }
.sp-post { display: flex; flex-direction: column; gap: 6px; padding: 8px; text-align: left; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; }
.sp-post.is-selected { border-color: var(--accent); box-shadow: var(--focus-ring); }
.sp-post-image { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; display: block; }
.sp-post-empty { display: grid; place-items: center; aspect-ratio: 1; border-radius: 8px; background: var(--bg-tertiary); font-size: 12px; color: var(--text-secondary); }
.sp-post-meta { display: flex; flex-direction: column; gap: 2px; }
.sp-post-text { font-size: 13px; line-height: 1.35; }
.sp-pill { align-self: flex-start; padding: 2px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 600; }
.sp-pill.is-ok { background: color-mix(in srgb, #2e7d32 22%, transparent); }
.sp-pill.is-warn { background: color-mix(in srgb, #b26a00 24%, transparent); }
.sp-empty { padding: 10px 0; }
.sp-editor-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 18px; margin-top: 12px; }
.sp-editor-fields { display: flex; flex-direction: column; gap: 10px; }
.sp-panel-fields { display: flex; flex-direction: column; gap: 8px; }
.sp-editor-preview { display: flex; flex-direction: column; gap: 10px; }
.sp-tabs { display: flex; gap: 6px; }
.sp-tab { padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 12px; }
.sp-tab.is-active { border-color: var(--accent); color: var(--text-primary); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sp-preview-panel { display: flex; flex-direction: column; gap: 4px; }
.sp-preview-image { width: 100%; border-radius: 10px; display: block; }
@media (max-width: 1100px) { .sp-editor-grid { grid-template-columns: 1fr; } }
</style>
