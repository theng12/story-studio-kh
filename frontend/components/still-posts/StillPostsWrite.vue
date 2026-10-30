<!--
  Step 2 — Write. One request writes the batch in the channel's Formula voice, in the preset's
  language. The batch is then a LIST you can read, edit, add to and remove from — all before a single
  picture is paid for. The writing model is a live choice; the Settings default is only the last link.
-->
<template>
  <div class="sp-step">
    <StillPostsStepHead tab="write" />

    <section class="card sp-section">
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
      <div class="sp-model">
        <ModelSelector v-model="writingModelChoice" :project-slug="slug" label="Writing model" writing-step />
      </div>
      <div class="sp-row">
        <button type="button" class="btn btn-primary" :disabled="!canWrite || writing" @click="writeBatch">
          {{ writing ? 'Writing…' : `Write ${count} post${count === 1 ? '' : 's'}` }}
        </button>
        <span v-if="writeJob" class="sp-help">{{ activeJobLine(writeJob) }}</span>
      </div>
      <p v-if="writeError" class="sp-notice sp-notice-error" role="alert">{{ writeError }}</p>
    </section>

    <section class="card sp-section">
      <div class="sp-section-head">
        <div>
          <h3 class="sp-h3">The batch <span class="sp-count">{{ drafts.length }}</span></h3>
          <p class="sp-help">
            Edit any line, remove one, or add your own before drawing. Nothing is drawn until you start
            the Draw step, so changes here cost nothing.
          </p>
        </div>
        <div class="sp-row">
          <button type="button" class="btn btn-sm btn-secondary" @click="addRow">Add a quote</button>
          <button type="button" class="btn btn-sm btn-primary" :disabled="saving || !dirtyCount" @click="saveChanges">
            {{ saving ? 'Saving…' : `Save ${dirtyCount || ''} change${dirtyCount === 1 ? '' : 's'}`.replace('  ', ' ') }}
          </button>
        </div>
      </div>

      <p v-if="listNote" class="sp-note" :class="{ 'sp-note-error': listError }" role="status">{{ listNote }}</p>

      <div v-if="!drafts.length" class="sp-empty-state">
        <p class="sp-help">No posts yet. Describe a batch above and write it, or add a quote by hand.</p>
        <button type="button" class="btn btn-sm btn-secondary" @click="addRow">Add a quote</button>
      </div>

      <ol v-else class="sp-batch-list">
        <li v-for="(row, index) in drafts" :key="row.key" class="sp-batch-row">
          <span class="sp-batch-number" aria-hidden="true">{{ index + 1 }}</span>
          <textarea v-model="row.text" class="textarea sp-batch-text" rows="2" :aria-label="`Quote ${index + 1}`" @input="row.dirty = true" />
          <span class="sp-batch-state">
            <span v-if="row.postId && row.drawn" class="sp-pill is-done">Drawn</span>
            <span v-else class="sp-pill is-not-started">Not drawn</span>
          </span>
          <button type="button" class="btn btn-sm btn-ghost" :aria-label="`Remove quote ${index + 1}`" @click="removeRow(row)">Remove</button>
        </li>
      </ol>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const {
  slug, posts, writing, writeError, writeJob, writeBatch, canWrite, activeJobLine, writingModelChoice,
  brief, count, saveQuote, deletePost, postState,
} = useStillPosts()

interface DraftRow { key: number, postId: string | null, text: string, drawn: boolean, dirty: boolean }
let nextKey = 1
const drafts = reactive<DraftRow[]>([])
const saving = ref(false)
const listNote = ref('')
const listError = ref(false)

/** The batch as a list: every saved post plus rows typed here that are not saved yet. */
function hydrate(): void {
  // A row being edited keeps the customer's text; a reload must never overwrite typing in progress.
  const existing = new Map(drafts.filter(row => row.postId).map(row => [row.postId!, row]))
  const rows: DraftRow[] = posts.value.map(entry => {
    const row = existing.get(entry.id)
    const drawn = !!postState(entry.id)?.panels?.[0]?.image && postState(entry.id)?.panels?.[0]?.image !== 'missing'
    if (row?.dirty) return { ...row, drawn }
    return { key: row?.key ?? nextKey++, postId: entry.id, text: entry.panels[0]?.text || '', drawn, dirty: false }
  })
  const unsaved = drafts.filter(row => !row.postId)
  drafts.splice(0, drafts.length, ...rows, ...unsaved)
}
watch(() => posts.value.map(entry => `${entry.id}:${entry.updated_at}`).join('|'), hydrate, { immediate: true })

const dirtyCount = computed(() => drafts.filter(row => row.dirty || !row.postId).length)

function addRow(): void {
  drafts.push({ key: nextKey++, postId: null, text: '', drawn: false, dirty: true })
}

async function removeRow(row: DraftRow): Promise<void> {
  if (!row.postId) {
    drafts.splice(drafts.indexOf(row), 1)
    return
  }
  const result = await deletePost(row.postId)
  if (!result.ok) {
    listError.value = true
    listNote.value = result.message || 'Could not remove that post.'
    return
  }
  drafts.splice(drafts.indexOf(row), 1)
  listNote.value = 'Removed. It is in the channel’s Trash, not gone for good.'
  listError.value = false
}

async function saveChanges(): Promise<void> {
  saving.value = true
  listNote.value = ''
  const failures: string[] = []
  let saved = 0
  try {
    for (const row of [...drafts]) {
      if (!row.dirty && row.postId) continue
      const result = await saveQuote(row.postId, row.text)
      if (!result.ok) {
        failures.push(`${row.postId || `quote ${drafts.indexOf(row) + 1}`}: ${result.message}`)
        continue
      }
      if (result.post) {
        row.postId = result.post.id
        row.drawn = !!result.post.panels?.[0]?.image
      }
      row.dirty = false
      saved += 1
    }
    listError.value = failures.length > 0
    listNote.value = [saved ? `${saved} saved.` : '', ...failures].filter(Boolean).join(' ')
  } finally {
    saving.value = false
  }
}
</script>
