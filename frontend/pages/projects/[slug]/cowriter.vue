<!--
  Conversational Co-writer.

  - v1.0.271 — initial implementation: chat → finalize → commit (idea/outline/script)
  - v1.0.282 — chat history persists in localStorage per project
  - v1.0.283 — multimodal (image attachments) + reusable artifacts panel
                (thumbnail-style / scene-style / style-notes / character)

  Architecture:
    Left  = chat thread (with image attachments + capture-from-reply)
    Right = two stacked cards:
              1. "Send to pipeline" — existing one-shot commit (unchanged shape)
              2. "Artifacts" — NEW: reusable descriptive items, capturable
                  from any assistant reply, manually creatable, editable in
                  place, sendable to Character Library where applicable,
                  referenceable into chat input.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Co-writer</h1>
    </div>

    <p class="text-muted mt-1 mb-2">
      Talk through your video with the app's LLM — brainstorm an idea, shape an outline, or draft a full script —
      then <strong>send it into the pipeline</strong>. Independent of the video format: write whatever you want here.
      <strong>v1.0.283+:</strong> attach images for style analysis, and save reusable style notes / character
      descriptions in the Artifacts panel.
    </p>

    <div class="cw-layout">
      <!-- ============ CHAT (left) ============ -->
      <section class="card cw-chat">
        <div class="cw-modelrow">
          <label class="cw-modellabel">Model</label>
          <ModelSelector
            v-model="model"
            :project-slug="slug"
            :require-vision="attachments.length > 0"
          />
          <button v-if="messages.length" class="btn btn-ghost btn-sm" @click="clearChat">Clear chat</button>
        </div>

        <!-- Soft-warn when images are attached and the picked model is a
             local LM Studio one (since we can't verify vision capability
             from the slug alone — assume true, but tell the user). -->
        <div v-if="attachments.length > 0 && isLocalModel" class="cw-vision-note">
          ⚠ Local LM Studio models are assumed vision-capable. If your loaded model is text-only,
          you'll see an error from the server — switch to a vision model in LM Studio and reload here.
        </div>

        <div ref="threadEl" class="cw-thread">
          <div v-if="!messages.length" class="cw-empty">
            <p class="text-muted">Start the conversation — e.g.</p>
            <button class="cw-suggest" @click="useSuggestion('Help me come up with a video idea about deep-sea creatures for a curious-adult audience.')">💡 "Help me brainstorm a video idea about deep-sea creatures…"</button>
            <button class="cw-suggest" @click="useSuggestion('Draft a 6-chapter outline for a documentary on the history of coffee.')">🧱 "Draft a 6-chapter outline for a doc on the history of coffee."</button>
            <button class="cw-suggest" @click="useSuggestion('Write a short 3-chapter narration script about how volcanoes form, calm and wondrous tone.')">📝 "Write a 3-chapter narration script about how volcanoes form."</button>
            <button class="cw-suggest" @click="useSuggestion('Here\'s a thumbnail style I like — analyze its composition, palette, and emotional pitch so I can describe it for future use.')">🖼️ "Analyze this thumbnail's style — composition, palette, mood." <em>(attach an image)</em></button>
          </div>
          <div v-for="(m, i) in messages" :key="i" class="cw-msg" :class="m.role">
            <div class="cw-role">{{ m.role === 'user' ? 'You' : 'Co-writer' }}</div>
            <div v-if="m.images && m.images.length" class="cw-msg-images">
              <img
                v-for="(img, ix) in m.images"
                :key="ix"
                :src="img"
                class="cw-msg-image"
                alt="attached image"
                @click="openImage(img)"
              />
            </div>
            <div v-if="m.content" class="cw-bubble">{{ m.content }}</div>
            <!-- Capture-from-reply only on assistant turns -->
            <div v-if="m.role === 'assistant'" class="cw-capture">
              <button
                class="link-btn cw-capture-btn"
                @click="startCapture(i)"
              >💾 Capture as artifact…</button>
              <div v-if="capturingIndex === i" class="cw-capture-form">
                <select v-model="captureType" class="select select-xs">
                  <option v-for="(meta, key) in ARTIFACT_TYPE_META" :key="key" :value="key">
                    {{ meta.icon }} {{ meta.label.replace(/s$/, '') }}
                  </option>
                </select>
                <input
                  v-model="captureName"
                  class="input input-xs"
                  placeholder="Name (e.g. 'Calm Watercolor')"
                  @keydown.enter.prevent="commitCapture(i, m.content)"
                />
                <button class="btn btn-primary btn-xs" @click="commitCapture(i, m.content)">Save</button>
                <button class="link-btn" @click="cancelCapture">Cancel</button>
              </div>
            </div>
          </div>
          <div v-if="sending" class="cw-msg assistant">
            <div class="cw-role">Co-writer</div>
            <div class="cw-bubble cw-typing"><LoadingSpinner size="sm" /> thinking…</div>
          </div>
        </div>

        <!-- Attachment chips (queued for next send) -->
        <div v-if="attachments.length > 0" class="cw-attachments">
          <div v-for="(att, i) in attachments" :key="att.id" class="cw-attachment">
            <img :src="att.dataUrl" class="cw-att-thumb" :alt="`attachment ${i + 1}`" />
            <button class="cw-att-remove" @click="removeAttachment(att.id)" :title="`Remove attachment ${i + 1}`">×</button>
          </div>
        </div>

        <!-- Input row with drag/drop + paste handlers -->
        <div
          class="cw-inputrow"
          :class="{ 'is-drop-target': isDropping }"
          @dragover.prevent="onDragOver"
          @dragleave="onDragLeave"
          @drop.prevent="onDrop"
        >
          <textarea
            v-model="input"
            class="textarea cw-input"
            rows="3"
            placeholder="Type a message…  (⌘/Ctrl + Enter to send · paste or drag images · @-reference an artifact)"
            @keydown="onKeydown"
            @paste="onPaste"
          />
          <div class="cw-input-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="sending || attachments.length >= MAX_IMAGES_PER_TURN"
              :title="attachments.length >= MAX_IMAGES_PER_TURN
                ? `Maximum ${MAX_IMAGES_PER_TURN} images per turn — remove one to add another`
                : 'Attach an image (drag, paste, or pick)'"
              @click="pickImage"
            >📎</button>
            <button
              class="btn btn-primary"
              :disabled="sending || !model || (!input.trim() && attachments.length === 0)"
              @click="send"
            >
              {{ sending ? 'Sending…' : sendButtonLabel }}
            </button>
          </div>
        </div>
        <input ref="fileInputEl" type="file" accept="image/*" multiple class="cw-file-hidden" @change="onFilePick" />
      </section>

      <!-- ============ RIGHT (stacked: send-to-pipeline + artifacts) ============ -->
      <div class="cw-right">
        <!-- Existing send-to-pipeline panel (unchanged) -->
        <section class="card cw-send">
          <h3>Send to pipeline</h3>
          <p class="text-muted text-xs mt-1">When the conversation has what you need, turn it into a real artifact.</p>

          <div class="form-group mt-2">
            <label>As a…</label>
            <label class="cw-radio"><input type="radio" value="idea" v-model="target" /> <strong>Idea</strong> <span class="text-muted text-xs">→ adds to Ideas</span></label>
            <label class="cw-radio"><input type="radio" value="outline" v-model="target" /> <strong>Outline</strong> <span class="text-muted text-xs">→ approved outline on an episode</span></label>
            <label class="cw-radio"><input type="radio" value="script" v-model="target" /> <strong>Full script</strong> <span class="text-muted text-xs">→ episode's script (Audio-ready)</span></label>
          </div>

          <div v-if="target !== 'idea'" class="form-group">
            <label>Target episode</label>
            <EpisodeSelector
              :model-value="episodeId"
              :project-slug="slug"
              @update:model-value="(v: string) => episodeId = v"
              @episode-selected="(e: any) => episodeTitle = e?.title || ''"
            />
            <span class="text-muted text-xs">The {{ target }} overwrites this episode's existing {{ target }}.</span>
          </div>

          <button
            class="btn btn-secondary btn-sm mt-1"
            :disabled="preparing || !model || !messages.length"
            @click="prepareDraft"
          >
            {{ preparing ? 'Preparing…' : `Prepare ${target} from chat` }}
          </button>

          <!-- Idea preview -->
          <template v-if="prepared && target === 'idea'">
            <div class="form-group mt-2">
              <label>Title</label>
              <input v-model="ideaDraft.title" class="input" />
            </div>
            <div class="form-group">
              <label>Logline</label>
              <textarea v-model="ideaDraft.logline" class="textarea" rows="2" />
            </div>
            <div class="form-group">
              <label>Themes <span class="text-muted text-xs">(comma-separated)</span></label>
              <input v-model="ideaThemes" class="input" placeholder="theme one, theme two" />
            </div>
          </template>

          <!-- Script / outline preview -->
          <div v-else-if="prepared" class="form-group mt-2">
            <label>{{ target === 'script' ? 'Script (editable)' : 'Outline (one chapter per line, editable)' }}</label>
            <textarea v-model="draftText" class="textarea" :rows="target === 'script' ? 14 : 8" />
          </div>

          <button
            v-if="prepared"
            class="btn btn-primary btn-sm mt-1"
            :disabled="committing || !canCommit"
            @click="commit"
          >
            {{ committing ? 'Sending…' : commitLabel }}
          </button>
        </section>

        <!-- v1.0.283 — Artifacts (reusable descriptive items) -->
        <section class="card cw-artifacts">
          <div class="cw-art-head">
            <h3>Artifacts</h3>
            <span class="text-muted text-xs">{{ artifacts.all.value.length }} saved</span>
          </div>
          <p class="text-muted text-xs cw-art-intro">
            Reusable styles + character descriptions that carry across episodes. Capture from any reply
            with the 💾 button, or create one manually. Reference any artifact in chat to feed it back to the model.
          </p>

          <div v-for="(meta, typeKey) in ARTIFACT_TYPE_META" :key="typeKey" class="cw-art-section">
            <div class="cw-art-section-head">
              <span class="cw-art-section-title">{{ meta.icon }} {{ meta.label }}</span>
              <button class="link-btn cw-art-add" @click="manualCreate(typeKey)">+ New</button>
            </div>
            <p v-if="artifacts.byType.value[typeKey].length === 0" class="text-muted text-xs cw-art-empty">
              {{ meta.emptyHint }}
            </p>
            <div v-for="a in artifacts.byType.value[typeKey]" :key="a.id" class="cw-art-item">
              <div class="cw-art-item-head" @click="toggleArtifact(a.id)">
                <span class="cw-art-name">{{ a.name }}</span>
                <span class="cw-art-toggle">{{ expandedArtifact === a.id ? '▾' : '▸' }}</span>
              </div>
              <div v-if="expandedArtifact === a.id" class="cw-art-detail">
                <template v-if="editingArtifactId === a.id">
                  <input v-model="editName" class="input input-sm" placeholder="Name" />
                  <textarea v-model="editBody" class="textarea cw-art-edit-body" rows="6" placeholder="Body" />
                  <div class="cw-art-actions">
                    <button class="btn btn-primary btn-xs" @click="saveEdit(a.id)">Save</button>
                    <button class="link-btn" @click="cancelEdit">Cancel</button>
                  </div>
                </template>
                <template v-else>
                  <div class="cw-art-body">{{ a.body }}</div>
                  <div class="cw-art-actions">
                    <button class="link-btn" @click="referenceArtifact(a)" title="Append this artifact to the chat input">@ Reference in chat</button>
                    <button class="link-btn" @click="startEdit(a)">Edit</button>
                    <button
                      v-if="meta.commitLabel"
                      class="link-btn"
                      :disabled="committingArtifactId === a.id"
                      @click="commitArtifact(a)"
                    >{{ committingArtifactId === a.id ? 'Sending…' : meta.commitLabel }}</button>
                    <button class="link-btn-danger" @click="deleteArtifact(a)">Delete</button>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- Image lightbox (cheap full-screen overlay; click anywhere to close) -->
    <div v-if="viewingImage" class="cw-img-lightbox" @click="viewingImage = ''">
      <img :src="viewingImage" alt="full-size attachment" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { useCowriterHistory } from '~/composables/useCowriterHistory'
import {
  useCowriterArtifacts,
  ARTIFACT_TYPE_META,
  type CowriterArtifact,
  type CowriterArtifactType,
} from '~/composables/useCowriterArtifacts'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Co-writer')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post } = useApi()
const { success, error: showError } = useToast()

// v1.0.282 — chat history + model selection persist in localStorage, per project.
const thread = useCowriterHistory(slug.value)
const messages = thread.messages
const model = thread.model

// v1.0.283 — reusable artifacts (separate store from chat history).
const artifacts = useCowriterArtifacts(slug.value)

const input = ref('')
const sending = ref(false)
const threadEl = ref<HTMLElement | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)

// Send-to-pipeline (existing flow, unchanged shape).
const target = ref<'idea' | 'outline' | 'script'>('script')
const episodeId = ref('')
const episodeTitle = ref('')
const preparing = ref(false)
const prepared = ref(false)
const draftText = ref('')
const ideaDraft = ref<{ title: string; logline: string }>({ title: '', logline: '' })
const ideaThemes = ref('')
const committing = ref(false)

// v1.0.283 — image attachment state (queued for the NEXT user turn; cleared
// on send). Each attachment has a client-side id so removeAttachment can
// target a specific one even if duplicates were dropped.
interface PendingAttachment { id: string; dataUrl: string }
const attachments = ref<PendingAttachment[]>([])
const isDropping = ref(false)
const MAX_IMAGES_PER_TURN = 6
const IMAGE_LONG_EDGE_PX = 512   // downscale target — keeps storage tiny + vision cost predictable

// v1.0.283 — image lightbox state.
const viewingImage = ref<string>('')
function openImage(src: string) { viewingImage.value = src }

// v1.0.283 — capture-from-reply state.
const capturingIndex = ref<number | null>(null)
const captureType = ref<CowriterArtifactType>('thumbnail-style')
const captureName = ref('')
function startCapture(i: number) {
  capturingIndex.value = i
  captureName.value = ''
}
function cancelCapture() { capturingIndex.value = null; captureName.value = '' }
function commitCapture(_i: number, content: string) {
  const name = captureName.value.trim()
  if (!name) { showError('Give the artifact a short name.'); return }
  artifacts.add({ type: captureType.value, name, body: content })
  success(`Saved as ${ARTIFACT_TYPE_META[captureType.value].label.toLowerCase().replace(/s$/, '')}: "${name}"`)
  cancelCapture()
}

// v1.0.283 — artifact edit/expand state.
const expandedArtifact = ref<string>('')
const editingArtifactId = ref<string>('')
const editName = ref('')
const editBody = ref('')
const committingArtifactId = ref<string>('')

function toggleArtifact(id: string) {
  if (expandedArtifact.value === id) {
    expandedArtifact.value = ''
    editingArtifactId.value = ''
  } else {
    expandedArtifact.value = id
  }
}
function manualCreate(type: CowriterArtifactType) {
  const created = artifacts.add({ type, name: 'Untitled', body: '' })
  expandedArtifact.value = created.id
  // Immediately enter edit mode — manual create is meaningless without naming.
  startEdit(created)
}
function startEdit(a: CowriterArtifact) {
  editingArtifactId.value = a.id
  editName.value = a.name === 'Untitled' ? '' : a.name
  editBody.value = a.body
}
function cancelEdit() {
  editingArtifactId.value = ''
  editName.value = ''
  editBody.value = ''
}
function saveEdit(id: string) {
  const name = editName.value.trim() || 'Untitled'
  artifacts.update(id, { name, body: editBody.value })
  editingArtifactId.value = ''
}
function deleteArtifact(a: CowriterArtifact) {
  if (!confirm(`Delete artifact "${a.name}"?`)) return
  artifacts.remove(a.id)
  if (expandedArtifact.value === a.id) expandedArtifact.value = ''
}
function referenceArtifact(a: CowriterArtifact) {
  // Append a clear reference block to the chat input so the LLM sees the
  // actual content but the user can tell at-a-glance what was referenced.
  const meta = ARTIFACT_TYPE_META[a.type]
  const block = `\n\n--- Reference: ${meta.label.replace(/s$/, '')} "${a.name}" ---\n${a.body}\n--- End reference ---\n`
  input.value = (input.value || '') + block
  success(`Referenced "${a.name}" in chat input.`)
}
async function commitArtifact(a: CowriterArtifact) {
  if (a.type !== 'character') return
  committingArtifactId.value = a.id
  try {
    await post(`/projects/${slug.value}/characters`, {
      name: a.name,
      description: a.body,
    })
    success(`"${a.name}" sent to Character Library.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to send character to library')
  } finally {
    committingArtifactId.value = ''
  }
}

// v1.0.283 — model awareness for vision soft-warn.
const isLocalModel = computed(() => model.value.startsWith('lmstudio:'))

// v1.0.283 — cost estimate for the next Send. Per-image USD; LM Studio free.
// Numbers are approximate (true cost varies with image dimensions); good
// enough for an order-of-magnitude hint on the Send button. Updates reactively
// when model or attachments change.
const VISION_COST_PER_IMAGE_USD: Record<string, number> = {
  'gpt-4o': 0.00765,
  'gpt-4o-mini': 0.0012,
  'gpt-4-turbo': 0.00765,
  // gpt-4.1 family — guess; OpenAI hasn't published exact image pricing as of v1.0.283
  'gpt-4.1': 0.005,
  'gpt-4.1-mini': 0.0015,
  'gpt-4.1-nano': 0.0008,
  'gpt-5': 0.008,
  'gpt-5-mini': 0.002,
}
function estimateImageCost(modelId: string, count: number): number {
  if (!count) return 0
  if (modelId.startsWith('lmstudio:')) return 0
  const base = modelId.toLowerCase()
  for (const prefix in VISION_COST_PER_IMAGE_USD) {
    if (base === prefix || base.startsWith(prefix + '-')) {
      return (VISION_COST_PER_IMAGE_USD[prefix] || 0) * count
    }
  }
  // Unknown cloud model — assume ~$0.005 per image as a conservative midpoint.
  return 0.005 * count
}
const sendButtonLabel = computed(() => {
  if (attachments.value.length === 0) return 'Send'
  if (isLocalModel.value) return `Send (${attachments.value.length} img · local — free)`
  const cost = estimateImageCost(model.value, attachments.value.length)
  if (cost < 0.001) return `Send (${attachments.value.length} img · ~free)`
  if (cost < 0.01) return `Send (${attachments.value.length} img · ~$${cost.toFixed(4)})`
  return `Send (${attachments.value.length} img · ~$${cost.toFixed(3)})`
})

// A new chat turn or a target switch invalidates the prepared draft.
watch([messages, target], () => { prepared.value = false }, { deep: true })

function scrollToBottom() {
  void nextTick(() => { if (threadEl.value) threadEl.value.scrollTop = threadEl.value.scrollHeight })
}
function useSuggestion(s: string) { input.value = s }
function clearChat() {
  thread.clear()
  prepared.value = false
}

onMounted(() => {
  if (messages.value.length > 0) scrollToBottom()
})
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send() }
}

// ──────────────── v1.0.283 — image attachment handling ────────────────

/** Cheap unique id for an attachment chip — only used client-side. */
let _attCounter = 0
function newAttachmentId(): string {
  _attCounter++
  return `att-${_attCounter}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Downscale an image to MAX_LONG_EDGE_PX on the long edge and return a base64
 * data URL. JPEG at 85% quality — good vision input quality, ~30-50KB per
 * image, predictable token cost. Why client-side: keeps the network payload
 * small AND localStorage tiny, both matter for an in-browser chat history.
 */
async function downscaleImage(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const ratio = Math.min(IMAGE_LONG_EDGE_PX / img.width, IMAGE_LONG_EDGE_PX / img.height, 1)
        const w = Math.round(img.width * ratio)
        const h = Math.round(img.height * ratio)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) { URL.revokeObjectURL(url); reject(new Error('No 2D canvas context')); return }
        ctx.drawImage(img, 0, 0, w, h)
        URL.revokeObjectURL(url)
        // JPEG over PNG because the vision LLMs treat them equivalently and
        // JPEG at 85% is 5-10x smaller than PNG for typical photos/thumbnails.
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch (e) {
        URL.revokeObjectURL(url)
        reject(e)
      }
    }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

async function addImage(blob: Blob) {
  if (attachments.value.length >= MAX_IMAGES_PER_TURN) {
    showError(`Maximum ${MAX_IMAGES_PER_TURN} images per turn. Send first or remove one.`)
    return
  }
  try {
    const dataUrl = await downscaleImage(blob)
    attachments.value.push({ id: newAttachmentId(), dataUrl })
  } catch (e: any) {
    showError(`Couldn't read image: ${e?.message || 'unknown error'}`)
  }
}
function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((a) => a.id !== id)
}
function pickImage() { fileInputEl.value?.click() }
async function onFilePick(e: Event) {
  const target = e.target as HTMLInputElement
  if (!target.files) return
  for (const file of Array.from(target.files)) {
    if (file.type.startsWith('image/')) await addImage(file)
  }
  target.value = '' // allow re-picking the same file
}
async function onPaste(e: ClipboardEvent) {
  if (!e.clipboardData) return
  let pastedImage = false
  for (const item of Array.from(e.clipboardData.items)) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile()
      if (blob) { await addImage(blob); pastedImage = true }
    }
  }
  if (pastedImage) e.preventDefault()
}
function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('Files')) isDropping.value = true
}
function onDragLeave() { isDropping.value = false }
async function onDrop(e: DragEvent) {
  isDropping.value = false
  if (!e.dataTransfer?.files) return
  for (const file of Array.from(e.dataTransfer.files)) {
    if (file.type.startsWith('image/')) await addImage(file)
  }
}

// ──────────────── send + finalize (extended for images) ────────────────

async function send() {
  if (sending.value || !model.value) return
  const text = input.value.trim()
  if (!text && attachments.value.length === 0) return

  // Snapshot attachments BEFORE clearing — included on this turn only.
  const images = attachments.value.map((a) => a.dataUrl)
  messages.value.push({
    role: 'user',
    content: text,
    ...(images.length > 0 ? { images } : {}),
  })
  input.value = ''
  attachments.value = []
  scrollToBottom()
  sending.value = true
  try {
    const r = await post<{ reply: string }>(`/projects/${slug.value}/cowriter/chat`, {
      model: model.value,
      messages: messages.value,
      // Backend extracts images from the latest user turn. We also send them
      // explicitly as a top-level array so future server-side rendering
      // changes (e.g. sending past images too) don't depend on parsing
      // messages.
      images: images.length > 0 ? images : undefined,
    })
    messages.value.push({ role: 'assistant', content: r.reply || '(no reply)' })
    scrollToBottom()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Co-writer failed to reply')
  } finally {
    sending.value = false
  }
}

async function prepareDraft() {
  if (!model.value || !messages.value.length) return
  preparing.value = true
  try {
    const r = await post<{ target: string; text?: string; idea?: { title: string; logline: string; themes: string[] } }>(
      `/projects/${slug.value}/cowriter/finalize`,
      { model: model.value, messages: messages.value, target: target.value },
    )
    if (target.value === 'idea') {
      ideaDraft.value = { title: r.idea?.title || '', logline: r.idea?.logline || '' }
      ideaThemes.value = (r.idea?.themes || []).join(', ')
    } else {
      draftText.value = r.text || ''
    }
    prepared.value = true
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to prepare draft')
  } finally {
    preparing.value = false
  }
}

const canCommit = computed(() => {
  if (target.value === 'idea') return !!ideaDraft.value.title.trim()
  return !!episodeId.value && !!draftText.value.trim()
})
const commitLabel = computed(() => {
  if (target.value === 'idea') return 'Add idea'
  return `Send ${target.value} to ${episodeId.value || 'episode'}`
})

async function commit() {
  if (!canCommit.value || committing.value) return
  committing.value = true
  try {
    if (target.value === 'idea') {
      await post(`/projects/${slug.value}/ideas`, {
        title: ideaDraft.value.title.trim(),
        logline: ideaDraft.value.logline.trim(),
        themes: ideaThemes.value.split(',').map(t => t.trim()).filter(Boolean),
      })
      success('Idea added — accept it on the Ideas page to create an episode.')
    } else if (target.value === 'outline') {
      const r = await post<{ chapters: number }>(`/projects/${slug.value}/episodes/${episodeId.value}/import-outline`, {
        title: episodeTitle.value, text: draftText.value,
      })
      success(`Outline imported (${r.chapters} chapters) → ${episodeId.value}. Use Expand Chapters on the Script page.`)
    } else {
      const r = await post<{ chapters: number; introduction: boolean }>(`/projects/${slug.value}/episodes/${episodeId.value}/import-script`, {
        title: episodeTitle.value, text: draftText.value,
      })
      success(`Script imported (${r.chapters} chapters${r.introduction ? ' + intro' : ''}) → ${episodeId.value}. Ready for Audio → Subtitles → Scene Plan.`)
    }
    prepared.value = false
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to send to pipeline')
  } finally {
    committing.value = false
  }
}
</script>

<style scoped>
.cw-layout { display: grid; grid-template-columns: 1fr 360px; gap: 16px; align-items: start; }
@media (max-width: 980px) { .cw-layout { grid-template-columns: 1fr; } }

.cw-chat { display: flex; flex-direction: column; min-height: 520px; }
.cw-modelrow { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.cw-modellabel { font-size: 13px; font-weight: 600; }

/* v1.0.283 — vision soft-warn for local models */
.cw-vision-note {
  background: rgba(255, 200, 50, 0.08);
  border: 1px solid rgba(255, 200, 50, 0.3);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary, #ccc);
  margin-bottom: 10px;
}

.cw-thread { flex: 1; overflow-y: auto; max-height: 56vh; display: flex; flex-direction: column; gap: 12px; padding: 4px; }
.cw-empty { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 12px 4px; }
.cw-suggest {
  text-align: left; background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; font-size: 13px; cursor: pointer; color: var(--text-primary);
}
.cw-suggest em { font-style: normal; color: var(--text-muted); font-size: 12px; margin-left: 4px; }
.cw-suggest:hover { border-color: var(--accent); }

.cw-msg { display: flex; flex-direction: column; gap: 3px; max-width: 88%; }
.cw-msg.user { align-self: flex-end; align-items: flex-end; }
.cw-role { font-size: 11px; color: var(--text-muted); font-weight: 600; }
.cw-bubble { white-space: pre-wrap; word-break: break-word; border-radius: 10px; padding: 9px 12px; font-size: 14px; line-height: 1.5; }
.cw-msg.user .cw-bubble { background: var(--accent, #6c8fff); color: #fff; }
.cw-msg.assistant .cw-bubble { background: var(--bg-secondary); border: 1px solid var(--border); }
.cw-typing { display: flex; align-items: center; gap: 8px; color: var(--text-muted); }

/* v1.0.283 — image attachments in message bubbles */
.cw-msg-images { display: flex; flex-wrap: wrap; gap: 6px; }
.cw-msg-image {
  max-width: 150px; max-height: 150px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border, #444); object-fit: cover;
}
.cw-msg-image:hover { border-color: var(--accent, #6c8fff); }

/* Capture-from-reply */
.cw-capture { margin-top: 4px; }
.cw-capture-btn { font-size: 11px; color: var(--text-muted); }
.cw-capture-form {
  display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;
  padding: 6px; background: var(--bg-secondary); border-radius: 6px;
}
.select-xs, .input-xs { font-size: 12px; padding: 4px 6px; }
.btn-xs { font-size: 12px; padding: 4px 10px; }

/* Pending attachment chips */
.cw-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.cw-attachment { position: relative; }
.cw-att-thumb {
  width: 56px; height: 56px; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--border, #444);
}
.cw-att-remove {
  position: absolute; top: -6px; right: -6px; width: 18px; height: 18px;
  border-radius: 50%; border: none; background: #d4564a; color: #fff;
  font-size: 14px; line-height: 1; cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
}

/* Input row + drop zone */
.cw-inputrow {
  display: flex; gap: 8px; align-items: flex-end; margin-top: 10px;
  padding: 4px; border-radius: 8px; transition: background 0.15s;
}
.cw-inputrow.is-drop-target {
  background: rgba(108, 143, 255, 0.12);
  outline: 2px dashed var(--accent, #6c8fff);
  outline-offset: -4px;
}
.cw-input { flex: 1; resize: vertical; }
.cw-input-actions { display: flex; flex-direction: column; gap: 6px; }
.cw-file-hidden { display: none; }

/* Image lightbox */
.cw-img-lightbox {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex; align-items: center; justify-content: center;
  cursor: zoom-out; padding: 24px;
}
.cw-img-lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; }

/* Right column stack */
.cw-right { display: flex; flex-direction: column; gap: 16px; }

.cw-send h3 { margin: 0; }
.cw-radio { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; margin-top: 4px; }

/* v1.0.283 — Artifacts panel */
.cw-artifacts h3 { margin: 0; }
.cw-art-head { display: flex; align-items: center; justify-content: space-between; }
.cw-art-intro { margin: 6px 0 12px; line-height: 1.45; }
.cw-art-section { margin-top: 14px; }
.cw-art-section-head {
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--border, #333);
  padding-bottom: 4px;
}
.cw-art-section-title { font-size: 13px; font-weight: 600; }
.cw-art-add { font-size: 11px; }
.cw-art-empty { margin: 6px 0 0; font-size: 11px; line-height: 1.4; }
.cw-art-item {
  margin-top: 6px; border: 1px solid var(--border, #333);
  border-radius: 6px; background: var(--bg-secondary);
}
.cw-art-item-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; cursor: pointer; user-select: none; gap: 8px;
}
.cw-art-item-head:hover { background: var(--bg-tertiary, rgba(255,255,255,0.04)); }
.cw-art-name { font-size: 13px; font-weight: 500; }
.cw-art-toggle { font-size: 10px; color: var(--text-muted); }
.cw-art-detail { padding: 6px 10px 10px; border-top: 1px solid var(--border, #333); }
.cw-art-body {
  font-size: 12px; line-height: 1.5; white-space: pre-wrap;
  word-break: break-word; color: var(--text-secondary, #ccc);
  max-height: 200px; overflow-y: auto;
  padding: 6px 0;
}
.cw-art-edit-body { font-size: 12px; margin-top: 6px; }
.cw-art-actions {
  display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px;
  align-items: center; font-size: 11px;
}
.link-btn-danger {
  background: none; border: none; color: #d4564a; cursor: pointer;
  padding: 0; font-size: inherit;
}
.link-btn-danger:hover { text-decoration: underline; }
</style>
