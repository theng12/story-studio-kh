<template>
  <div v-if="modelValue" class="tc-overlay" @click.self="cancel">
    <div class="tc-modal">
      <div class="tc-header">
        <h3>✏️ Compose with text</h3>
        <button type="button" class="btn-icon" aria-label="Close" @click="cancel">✕</button>
      </div>

      <div class="tc-body">
        <!-- Niche-template gate. The compose endpoint refuses without a -->
        <!-- niche.thumbnailTemplate; we surface that state here so the -->
        <!-- user doesn't tap "Compose" only to bounce into a 422. -->
        <div v-if="!nicheLoaded" class="text-muted tc-loading">Checking the project's niche template…</div>
        <div v-else-if="!hasTemplate" class="tc-banner tc-banner-warn">
          ⚠️ This project's niche
          <template v-if="nicheName"><strong>({{ nicheName }})</strong></template>
          does not declare a thumbnail template.
          <NuxtLink :to="`/projects/${projectSlug}/settings#niche`" class="link-btn">Open Settings → Niche</NuxtLink>
          and pick a niche that ships a template, or extend this niche's JSON.
        </div>

        <template v-else>
          <p class="text-muted tc-intro">
            Drops the niche's title shape, subtitle banner, and accent rule onto the source thumbnail.
            The character image stays — only the text overlay is rendered fresh.
          </p>

          <!-- Source thumbnail picker -->
          <div class="form-group">
            <label class="form-label">Source thumbnail</label>
            <select v-model="sourceFilename" class="select" :disabled="composing">
              <option v-for="t in thumbs" :key="t.filename" :value="t.filename">
                {{ t.filename }}{{ t.is_pinned ? ' — 📌 currently pinned' : '' }}
              </option>
            </select>
            <p class="text-muted tc-hint">The character / portrait this composition will layer text over.</p>
          </div>

          <!-- Title override -->
          <div class="form-group">
            <label class="form-label">Title text</label>
            <input
              v-model="titleText"
              type="text"
              class="input"
              :disabled="composing"
              :placeholder="defaultTitle || 'Episode title…'"
            />
            <p class="text-muted tc-hint">
              Leave blank to use the episode title (<strong>{{ defaultTitle || '—' }}</strong>).
              <template v-if="titleZoneSpec">
                Rendered as
                <strong>{{ titleZoneSpec.uppercase ? 'ALL CAPS' : 'sentence case' }}</strong>,
                wrapped to fit a {{ titleZoneSpec.maxWidth }}px column at
                {{ titleZoneSpec.fontSize }}px.
              </template>
            </p>
          </div>

          <!-- Subtitle override -->
          <div class="form-group">
            <label class="form-label">Subtitle banner</label>
            <input
              v-model="subtitleText"
              type="text"
              class="input"
              :disabled="composing"
              :placeholder="defaultSubtitle || 'e.g. NIGHT PRAYER'"
            />
            <p class="text-muted tc-hint">
              Niche default: <strong>{{ defaultSubtitle || '(none)' }}</strong>.
              This is the small banner under the accent rule — usually the channel's recurring tag.
            </p>
          </div>

          <!-- Preview slot — appears after the first successful compose -->
          <div v-if="resultUrl" class="tc-preview">
            <div class="tc-preview-head">
              <strong>Composed</strong>
              <span class="text-muted tc-preview-filename">{{ resultFilename }}</span>
            </div>
            <img :src="resultUrl" :alt="resultFilename" class="tc-preview-img" />
            <div class="tc-preview-actions">
              <button
                type="button"
                class="btn btn-sm btn-primary"
                :disabled="pinning"
                @click="pinResult"
              >
                {{ pinning ? 'Pinning…' : '📌 Pin this for upload' }}
              </button>
              <span v-if="pinned" class="text-success tc-pinned-msg">
                Pinned. It'll be the next upload's thumbnail.
              </span>
            </div>
          </div>

          <div v-if="errorMessage" class="tc-banner tc-banner-error">
            {{ errorMessage }}
          </div>
        </template>
      </div>

      <div class="tc-footer">
        <button type="button" class="btn btn-secondary" @click="cancel">
          {{ resultUrl ? 'Close' : 'Cancel' }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!hasTemplate || composing || !sourceFilename"
          @click="compose"
        >
          {{ composing ? 'Composing…' : (resultUrl ? '🔄 Compose again' : '✨ Compose') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Dialog for niche-templated thumbnail composition (v1.0.104+).
 *
 * Hits POST /api/projects/:slug/episodes/:code/thumbnails/compose with
 * the active source filename + optional title/subtitle overrides. The
 * niche's thumbnailTemplate (loaded once via /effective-niche) drives
 * everything else — layout, fonts, gradient, accent strokes, logo slot.
 *
 * Closed state: `modelValue=false`. Opening it re-runs the niche fetch
 * so a niche change in another tab is picked up without a page reload.
 */
import { ref, watch, computed } from 'vue'
import { useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'

interface ThumbEntry {
  filename: string
  is_pinned?: boolean
}

const props = defineProps<{
  modelValue: boolean
  projectSlug: string
  episodeCode: string
  /** All thumbnails currently in the episode's thumb dir. The dialog
   *  uses these for the source picker — the user composes OVER one of
   *  the existing generated portraits. */
  thumbs: ThumbEntry[]
  /** Default title text shown as the placeholder + tooltip when the
   *  user leaves the title field blank. Usually the idea title. */
  defaultTitle?: string
  /** Initial source filename — defaults to the first thumb. Useful so
   *  the dialog opens with the user's last clicked thumb pre-picked. */
  initialSourceFilename?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** Fired after a successful pin so the parent page can refresh its
   *  pinned-thumbnail label without a separate roundtrip. */
  'pinned': [filename: string]
  /** Fired after a successful compose so the parent can refresh the
   *  thumb-grid (the new composed file is a new entry). */
  'composed': [filename: string]
}>()

const { get, post } = useApi()
const { success: toastSuccess, error: toastError } = useToast()

// ── Niche template state ────────────────────────────────────────────────
const nicheLoaded = ref(false)
const hasTemplate = ref(false)
const nicheName = ref('')
const defaultSubtitle = ref('')
const titleZoneSpec = ref<{ maxWidth: number; fontSize: number; uppercase: boolean } | null>(null)

async function loadNiche() {
  nicheLoaded.value = false
  hasTemplate.value = false
  nicheName.value = ''
  defaultSubtitle.value = ''
  titleZoneSpec.value = null
  try {
    const r = await get<{ niche: any | null }>(`/projects/${props.projectSlug}/effective-niche`)
    nicheLoaded.value = true
    if (!r.niche) return
    nicheName.value = r.niche.name || r.niche.id || ''
    const tmpl = r.niche.thumbnailTemplate
    if (!tmpl) return
    hasTemplate.value = true
    // Pull defaults for the title + subtitle zones so the form hints
    // line up with what the LLM will actually render. The compose
    // endpoint uses the same fields.
    const titleZone = (tmpl.textZones || []).find((z: any) => z.name === 'title')
    if (titleZone) {
      titleZoneSpec.value = {
        maxWidth: titleZone.maxWidth,
        fontSize: titleZone.fontSize,
        uppercase: !!titleZone.uppercase,
      }
    }
    const subtitleZone = (tmpl.textZones || []).find((z: any) => z.name === 'subtitle')
    defaultSubtitle.value = subtitleZone?.defaultText || ''
  } catch (e: any) {
    nicheLoaded.value = true
    toastError(e?.data?.detail || 'Could not load this project\'s niche')
  }
}

// ── Form state ──────────────────────────────────────────────────────────
const sourceFilename = ref('')
const titleText = ref('')
const subtitleText = ref('')

// ── Compose result ──────────────────────────────────────────────────────
const composing = ref(false)
const errorMessage = ref('')
const resultUrl = ref('')
const resultFilename = ref('')
const resultPath = ref('')
const pinning = ref(false)
const pinned = ref(false)

watch(() => props.modelValue, (open) => {
  if (open) {
    // Reset transient state every open so a previous run's result
    // doesn't appear above a fresh compose.
    resultUrl.value = ''
    resultFilename.value = ''
    resultPath.value = ''
    errorMessage.value = ''
    pinned.value = false
    titleText.value = ''
    subtitleText.value = ''
    sourceFilename.value = props.initialSourceFilename
      || props.thumbs[0]?.filename
      || ''
    void loadNiche()
  }
}, { immediate: true })

function cancel() {
  emit('update:modelValue', false)
}

async function compose() {
  if (!sourceFilename.value || composing.value) return
  composing.value = true
  errorMessage.value = ''
  pinned.value = false
  try {
    const r = await post<{ filename: string; path: string; url: string }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeCode}/thumbnails/compose`,
      {
        source_filename: sourceFilename.value,
        title_text: titleText.value || undefined,
        subtitle_text: subtitleText.value || undefined,
      },
    )
    resultFilename.value = r.filename
    resultPath.value = r.path
    // Cache-bust the preview so re-composes don't show a stale image.
    resultUrl.value = `${r.url}&k=${Date.now()}`
    emit('composed', r.filename)
    toastSuccess(`Composed ${r.filename}`)
  } catch (e: any) {
    errorMessage.value = e?.data?.detail || 'Compose failed. Check the dev console for details.'
  } finally {
    composing.value = false
  }
}

async function pinResult() {
  if (!resultFilename.value || pinning.value) return
  pinning.value = true
  try {
    await post(
      `/projects/${props.projectSlug}/episodes/${props.episodeCode}/thumbnails/pin`,
      { filename: resultFilename.value },
    )
    pinned.value = true
    emit('pinned', resultFilename.value)
    toastSuccess('Pinned for upload')
  } catch (e: any) {
    toastError(e?.data?.detail || 'Pin failed')
  } finally {
    pinning.value = false
  }
}

// Re-export for the template — placeholder uses these directly.
const _ = computed(() => ({ thumbs: props.thumbs })) // referenced to silence unused-prop lints if any
void _
</script>

<style scoped>
.tc-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
}
.tc-modal {
  background: var(--surface, #1e1e22);
  color: var(--text, #e8e8ea);
  border-radius: 12px;
  width: min(640px, 100%);
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.tc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}
.tc-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.tc-body {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.tc-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}
.tc-intro {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.tc-loading {
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}
.tc-banner {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}
.tc-banner-warn {
  background: rgba(245, 188, 66, 0.12);
  border: 1px solid rgba(245, 188, 66, 0.4);
  color: #f5bc42;
}
.tc-banner-error {
  background: rgba(225, 74, 74, 0.12);
  border: 1px solid rgba(225, 74, 74, 0.4);
  color: #ff8a8a;
}
.tc-hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.4;
}
.tc-preview {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tc-preview-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.tc-preview-filename {
  font-size: 11px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
}
.tc-preview-img {
  width: 100%;
  border-radius: 6px;
  display: block;
  background: #000;
}
.tc-preview-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tc-pinned-msg {
  font-size: 12px;
}
</style>
