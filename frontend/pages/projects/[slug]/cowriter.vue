<!--
  v1.0.271 — Conversational Co-writer.
  Chat with the app's LLM to develop an idea / outline / full script, then send
  the result into the pipeline via the bring-your-own import endpoints (v1.0.269).
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
    </p>

    <div class="cw-layout">
      <!-- Chat column -->
      <section class="card cw-chat">
        <div class="cw-modelrow">
          <label class="cw-modellabel">Model</label>
          <ModelSelector v-model="model" :project-slug="slug" />
          <button v-if="messages.length" class="btn btn-ghost btn-sm" @click="clearChat">Clear chat</button>
        </div>

        <div ref="threadEl" class="cw-thread">
          <div v-if="!messages.length" class="cw-empty">
            <p class="text-muted">Start the conversation — e.g.</p>
            <button class="cw-suggest" @click="useSuggestion('Help me come up with a video idea about deep-sea creatures for a curious-adult audience.')">💡 “Help me brainstorm a video idea about deep-sea creatures…”</button>
            <button class="cw-suggest" @click="useSuggestion('Draft a 6-chapter outline for a documentary on the history of coffee.')">🧱 “Draft a 6-chapter outline for a doc on the history of coffee.”</button>
            <button class="cw-suggest" @click="useSuggestion('Write a short 3-chapter narration script about how volcanoes form, calm and wondrous tone.')">📝 “Write a 3-chapter narration script about how volcanoes form.”</button>
          </div>
          <div v-for="(m, i) in messages" :key="i" class="cw-msg" :class="m.role">
            <div class="cw-role">{{ m.role === 'user' ? 'You' : 'Co-writer' }}</div>
            <div class="cw-bubble">{{ m.content }}</div>
          </div>
          <div v-if="sending" class="cw-msg assistant">
            <div class="cw-role">Co-writer</div>
            <div class="cw-bubble cw-typing"><LoadingSpinner size="sm" /> thinking…</div>
          </div>
        </div>

        <div class="cw-inputrow">
          <textarea
            v-model="input"
            class="textarea cw-input"
            rows="3"
            placeholder="Type a message…  (⌘/Ctrl + Enter to send)"
            @keydown="onKeydown"
          />
          <button class="btn btn-primary" :disabled="sending || !model || !input.trim()" @click="send">
            {{ sending ? 'Sending…' : 'Send' }}
          </button>
        </div>
      </section>

      <!-- Send-to-pipeline column -->
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { useCowriterHistory } from '~/composables/useCowriterHistory'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Co-writer')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post } = useApi()
const { success, error: showError } = useToast()

// v1.0.282 — chat history + model selection now persist in localStorage,
// keyed per-project. Tab switches and full page reloads no longer wipe
// the conversation. The model ref is wired to the persisted store so
// the user's last pick is restored on remount. See useCowriterHistory.
const thread = useCowriterHistory(slug.value)
const messages = thread.messages
const model = thread.model

const input = ref('')
const sending = ref(false)
const threadEl = ref<HTMLElement | null>(null)

const target = ref<'idea' | 'outline' | 'script'>('script')
const episodeId = ref('')
const episodeTitle = ref('')
const preparing = ref(false)
const prepared = ref(false)
const draftText = ref('')
const ideaDraft = ref<{ title: string; logline: string }>({ title: '', logline: '' })
const ideaThemes = ref('')
const committing = ref(false)

// A new chat turn or a target switch invalidates the prepared draft.
watch([messages, target], () => { prepared.value = false }, { deep: true })

function scrollToBottom() {
  void nextTick(() => { if (threadEl.value) threadEl.value.scrollTop = threadEl.value.scrollHeight })
}
function useSuggestion(s: string) { input.value = s }
function clearChat() {
  // v1.0.282 — also clears the persisted localStorage entry, not just the
  // in-memory ref. Otherwise the cleared chat would resurrect on next mount.
  thread.clear()
  prepared.value = false
}

// v1.0.282 — auto-scroll to the bottom on mount when restoring a non-empty
// thread, so the user sees the most recent reply instead of the conversation
// start. nextTick lets the v-for render before we measure scrollHeight.
onMounted(() => {
  if (messages.value.length > 0) scrollToBottom()
})
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send() }
}

async function send() {
  if (sending.value || !model.value || !input.value.trim()) return
  messages.value.push({ role: 'user', content: input.value.trim() })
  input.value = ''
  scrollToBottom()
  sending.value = true
  try {
    const r = await post<{ reply: string }>(`/projects/${slug.value}/cowriter/chat`, {
      model: model.value,
      messages: messages.value,
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

.cw-thread { flex: 1; overflow-y: auto; max-height: 56vh; display: flex; flex-direction: column; gap: 12px; padding: 4px; }
.cw-empty { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 12px 4px; }
.cw-suggest {
  text-align: left; background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; font-size: 13px; cursor: pointer; color: var(--text-primary);
}
.cw-suggest:hover { border-color: var(--accent); }

.cw-msg { display: flex; flex-direction: column; gap: 3px; max-width: 88%; }
.cw-msg.user { align-self: flex-end; align-items: flex-end; }
.cw-role { font-size: 11px; color: var(--text-muted); font-weight: 600; }
.cw-bubble { white-space: pre-wrap; word-break: break-word; border-radius: 10px; padding: 9px 12px; font-size: 14px; line-height: 1.5; }
.cw-msg.user .cw-bubble { background: var(--accent, #6c8fff); color: #fff; }
.cw-msg.assistant .cw-bubble { background: var(--bg-secondary); border: 1px solid var(--border); }
.cw-typing { display: flex; align-items: center; gap: 8px; color: var(--text-muted); }

.cw-inputrow { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
.cw-input { flex: 1; resize: vertical; }

.cw-send h3 { margin: 0; }
.cw-radio { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; margin-top: 4px; }
</style>
