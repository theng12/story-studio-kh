<!--
  Step 4 — Review. The batch's posts, and the one in focus: its words, its scene and its finished frames.
  Editing the words re-letters the picture at once. (Part 2 turns this into the full review board.)
-->
<template>
  <div class="sp-step">
    <StillPostsStepHead tab="review" />

    <section class="card sp-section">
      <StillPostsPostGrid />
    </section>

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
          <button type="button" class="btn btn-sm btn-secondary" :disabled="!canDraw || drawing" @click="draw(undefined, [selected.id], true)">
            Redraw artwork
          </button>
          <button type="button" class="btn btn-sm btn-danger" @click="removeSelected">Remove</button>
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
                <option v-for="format in workspace?.formats" :key="format.id" :value="format.id">{{ format.name }}</option>
              </select>
            </label>
            <label class="sp-field">
              <span class="sp-label">Option</span>
              <select v-model="editor.option_id" class="select">
                <option v-for="option in workspace?.options" :key="option.id" :value="option.id">{{ option.name }}</option>
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
          <div class="sp-tabs" role="tablist" aria-label="Export frame">
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
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useStillPosts, type StillPost, type StillPostState } from '../../composables/useStillPostsWorkspace'

const { put } = useApi()
const {
  slug, workspace, selected, selectedId, aspects, languages, castCharacters, canDraw, drawing, draw,
  finalUrl, finalState, deletePost, preset,
} = useStillPosts()

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

/** The editor shows the saved post; it is refilled only when a different post is put in focus. */
function fillEditor(entry: StillPost): void {
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

watch(selectedId, () => {
  if (selected.value) fillEditor(selected.value)
}, { immediate: true })

async function savePost(): Promise<void> {
  const entry = selected.value
  if (!entry) return
  savingPost.value = true
  editorNote.value = ''
  try {
    const response = await put<{ post: StillPost, state: StillPostState, render_error: string | null, font_note?: string | null }>(
      `/projects/${slug.value}/still-posts/posts/${entry.id}`,
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
    const current = workspace.value
    if (current) {
      const index = current.posts.findIndex(item => item.id === response.post.id)
      if (index >= 0) current.posts.splice(index, 1, response.post)
    }
    fillEditor(response.post)
    // A cleared recorded face (the language moved to another script) is announced beside the
    // render result, never swapped in silence.
    editorNote.value = [response.render_error
      ? `Saved. Nothing was re-lettered: ${response.render_error}`
      : 'Saved and re-lettered.', response.font_note].filter(Boolean).join(' ')
    editorError.value = !!response.render_error
  } catch (error: any) {
    editorNote.value = error?.data?.detail || error?.message || 'Could not save this post.'
    editorError.value = true
  } finally {
    savingPost.value = false
  }
}

async function removeSelected(): Promise<void> {
  const entry = selected.value
  if (!entry) return
  const result = await deletePost(entry.id)
  if (!result.ok && result.message) {
    editorNote.value = result.message
    editorError.value = true
  }
}
</script>
