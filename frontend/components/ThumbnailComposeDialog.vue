<template>
  <div v-if="modelValue" class="tc-overlay" @click.self="cancel">
    <div class="tc-modal">
      <div class="tc-header">
        <h3>✏️ Compose with text</h3>
        <button type="button" class="btn-icon" aria-label="Close" @click="cancel">✕</button>
      </div>

      <div class="tc-body">
        <!-- Template gallery — top of the dialog. The picker handles -->
        <!-- its own loading state. Selecting a card persists the -->
        <!-- choice to project config (thumbnail_template_id) so the -->
        <!-- next open shows the same pick. -->
        <div class="form-group">
          <div class="tc-section-head">
            <label class="form-label">Template</label>
            <NuxtLink
              :to="`/projects/${projectSlug}/thumbnail-templates`"
              class="link-btn tc-section-link"
            >Browse all →</NuxtLink>
          </div>
          <ThumbnailTemplatePicker
            v-model="templateId"
            :recommended-niche-id="recommendedNicheId"
            :compact="true"
            @change="onTemplateChange"
          />
        </div>

        <div v-if="!templateLoaded" class="text-muted tc-loading">Resolving the active template…</div>

        <div v-else-if="!templateId" class="tc-banner tc-banner-warn">
          ⚠️ Pick a template above to start composing. None is set as the default for this project yet — your first pick will be remembered.
        </div>

        <template v-else>
          <p class="text-muted tc-intro">
            <strong>{{ activeTemplate?.name || templateId }}</strong> —
            {{ activeTemplate?.description || 'Layers text + accents over your source thumbnail.' }}
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
              Template default: <strong>{{ defaultSubtitle || '(none)' }}</strong>.
              This is the small banner under the accent rule — usually the channel's recurring tag.
            </p>
          </div>

          <!-- Channel logo picker. Persists to project config so it -->
          <!-- pre-fills on every future compose for this project. -->
          <div v-if="hasLogoSlot" class="form-group">
            <label class="form-label">Channel logo</label>
            <div class="tc-logo-row">
              <div class="tc-logo-status">
                <template v-if="logoPath">
                  <span class="tc-logo-name" :title="logoPath">📎 {{ logoBasename }}</span>
                </template>
                <template v-else>
                  <span class="text-muted">No logo picked — the template's logo slot stays empty.</span>
                </template>
              </div>
              <div class="tc-logo-actions">
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  :disabled="composing || pickingLogo"
                  @click="chooseLogo"
                >
                  {{ pickingLogo ? 'Opening…' : (logoPath ? 'Change…' : 'Choose…') }}
                </button>
                <button
                  v-if="logoPath"
                  type="button"
                  class="btn btn-sm btn-ghost"
                  :disabled="composing || pickingLogo"
                  @click="clearLogo"
                >
                  Clear
                </button>
              </div>
            </div>
            <p class="text-muted tc-hint">
              Saved on this project, so you only pick it once. PNG with transparency works best —
              the slot is {{ logoSlotSizeHint }}.
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
          :disabled="!templateId || composing || !sourceFilename"
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
 * Dialog for thumbnail composition (v1.0.105+).
 *
 * Hits POST /api/projects/:slug/episodes/:code/thumbnails/compose with
 * the active source filename + selected template + optional text
 * overrides. v1.0.105 decoupled templates from niches: the dialog
 * embeds a gallery picker at the top, and the chosen template id is
 * persisted to project config so the next open shows the same pick.
 *
 * Closed state: `modelValue=false`. Opening it re-fetches both the
 * effective template AND the niche (so the picker's ★ recommendation
 * badges line up with the latest niche pick).
 */
import { ref, watch, computed } from 'vue'
import { useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { pickFile } from '~/composables/usePathPicker'

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

const { get, put, post } = useApi()
const { success: toastSuccess, error: toastError } = useToast()
const projectOutputRoot = ref('')

// ── Template + niche state (v1.0.105+) ──────────────────────────────────
// Templates live in the library and are picked via the embedded gallery.
// The dialog persists the user's pick to project.config.thumbnail_template_id
// so it sticks across opens.
const templateLoaded = ref(false)
const templateId = ref('')
const activeTemplate = ref<any | null>(null)
const recommendedNicheId = ref('')
const defaultSubtitle = ref('')
const titleZoneSpec = ref<{ maxWidth: number; fontSize: number; uppercase: boolean } | null>(null)
const hasLogoSlot = ref(false)
const logoSlotSizeHint = ref('120px wide')

async function loadEffectiveTemplate() {
  templateLoaded.value = false
  templateId.value = ''
  activeTemplate.value = null
  recommendedNicheId.value = ''
  defaultSubtitle.value = ''
  titleZoneSpec.value = null
  hasLogoSlot.value = false
  try {
    // Niche fetch fuels the picker's ★ recommendation badge — advisory
    // only; the gallery shows every template either way.
    const [tplRes, nicheRes] = await Promise.all([
      get<{ template: any | null }>(`/projects/${props.projectSlug}/effective-thumbnail-template`),
      get<{ niche: any | null }>(`/projects/${props.projectSlug}/effective-niche`),
    ])
    recommendedNicheId.value = nicheRes?.niche?.id || ''
    if (tplRes?.template) {
      templateId.value = tplRes.template.id
      applyTemplate(tplRes.template)
    }
    templateLoaded.value = true
  } catch (e: any) {
    templateLoaded.value = true
    toastError(e?.data?.detail || 'Could not resolve the active template')
  }
}

/** Compute the title / subtitle / logo-slot derived state from a
 *  freshly-resolved template. Called both on initial load and when
 *  the user picks a different card in the gallery. */
function applyTemplate(t: any) {
  activeTemplate.value = t
  const titleZone = (t.textZones || []).find((z: any) => z.name === 'title')
  titleZoneSpec.value = titleZone
    ? {
      maxWidth: titleZone.maxWidth,
      fontSize: titleZone.fontSize,
      uppercase: !!titleZone.uppercase,
    }
    : null
  const subtitleZone = (t.textZones || []).find((z: any) => z.name === 'subtitle')
  defaultSubtitle.value = subtitleZone?.defaultText || ''
  if (t.logoSlot) {
    hasLogoSlot.value = true
    logoSlotSizeHint.value = `${t.logoSlot.width || 120}px wide, anchored ${t.logoSlot.y || 'top'}-${t.logoSlot.x || 'left'}`
  } else {
    hasLogoSlot.value = false
  }
}

/** Picker @change handler — gets the lite-shape template object plus
 *  the new id. Persists the id to project config so the next dialog
 *  open shows the same pick, then fetches the FULL template (with
 *  textZones) so the form hints update. */
async function onTemplateChange(_lite: { id: string; name: string }) {
  // Persist the choice. Fire-and-forget — toast on error only.
  put(`/projects/${props.projectSlug}/settings/config`, {
    thumbnail_template_id: templateId.value,
  }).catch((e: any) => {
    toastError(e?.data?.detail || 'Could not save template choice to project config')
  })
  // Re-fetch the full template payload so the hint UI reflects the new
  // picker selection (zones, logoSlot, etc).
  try {
    const t = await get<any>(`/thumbnail-templates/${encodeURIComponent(templateId.value)}`)
    applyTemplate(t)
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not load picked template')
  }
}

// ── Channel logo state ──────────────────────────────────────────────────
// Saved on the project config so the user only picks it once.
const CHANNEL_LOGO_KEY = 'channel_logo_path'
const logoPath = ref('')
const pickingLogo = ref(false)
const logoBasename = computed(() => {
  const p = logoPath.value
  if (!p) return ''
  const m = /[^/\\]+$/.exec(p)
  return m ? m[0] : p
})

async function loadLogoPath() {
  try {
    const [cfg, project] = await Promise.all([
      get<Record<string, any>>(`/projects/${props.projectSlug}/settings/config`),
      get<Record<string, any>>(`/projects/${props.projectSlug}`),
    ])
    const stored = typeof cfg?.[CHANNEL_LOGO_KEY] === 'string' ? cfg[CHANNEL_LOGO_KEY] : ''
    projectOutputRoot.value = typeof project?.output_root === 'string' ? project.output_root : ''
    logoPath.value = stored || ''
  } catch {
    // Config fetch can fail (no project, no config yet) — non-fatal.
    projectOutputRoot.value = ''
    logoPath.value = ''
  }
}

async function collapseToPortablePath(input: string): Promise<string> {
  const raw = String(input || '').trim()
  if (!raw) return ''
  try {
    const r = await post<{ output: string }>(`/system/resolve-asset-path`, {
      path: raw,
      output_root: projectOutputRoot.value || undefined,
      mode: 'portable',
    })
    return String(r?.output || raw)
  } catch {
    return raw
  }
}

async function persistLogoPath(p: string) {
  try {
    await put(`/projects/${props.projectSlug}/settings/config`, { [CHANNEL_LOGO_KEY]: p })
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not save logo path to project config')
  }
}

async function chooseLogo() {
  if (pickingLogo.value) return
  pickingLogo.value = true
  try {
    const picked = await pickFile({
      title: 'Choose a channel logo (PNG preferred)',
      extensions: ['png', 'jpg', 'jpeg', 'webp'],
      initial_path: logoPath.value || undefined,
    })
    if (!picked) return
    const portable = await collapseToPortablePath(picked)
    logoPath.value = portable
    await persistLogoPath(portable)
    toastSuccess('Logo saved for this project')
  } finally {
    pickingLogo.value = false
  }
}

async function clearLogo() {
  logoPath.value = ''
  await persistLogoPath('')
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
    void loadEffectiveTemplate()
    void loadLogoPath()
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
        // Per-compose template id from the gallery picker. The server's
        // resolution chain (project override → niche default → legacy
        // inline) is bypassed when this is set, so the user can preview
        // a different template without changing the saved override.
        template_id: templateId.value || undefined,
        title_text: titleText.value || undefined,
        subtitle_text: subtitleText.value || undefined,
        // Only send a logo_path when the template declares a logoSlot
        // AND the user has a saved path. The compose route 404s on a
        // missing file, so an empty / stale entry would surface a
        // confusing error.
        logo_path: hasLogoSlot.value && logoPath.value ? logoPath.value : undefined,
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
.tc-logo-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
}
.tc-logo-status {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}
.tc-logo-name {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
}
.tc-logo-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.tc-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}
.tc-section-link {
  font-size: var(--font-xs);
}
</style>
