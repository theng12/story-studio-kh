<script setup lang="ts">
/**
 * Branded typography — its own default-off switch (owner condition 2026-11-16).
 *
 * OFF shows one sentence and changes nothing: the image model letters the thumbnail and the
 * channel's YouTube title is untouched. ON shows the accent pool, where each accent sits, the
 * last-N guard and the face the headline is drawn in. Accents are added with the app's one file
 * picker, and retiring one moves its file to Trash — nothing is deleted.
 *
 * Every control here is an in-app control (no confirm/alert/prompt), and every save reports its
 * outcome in words, including the refusals.
 */
import type { BrandedAccent, BrandedTypography } from '@shared/branded-typography'
import { pickFile } from '~/composables/usePathPicker'

const props = defineProps<{
  /** config.branded_typography; undefined = never configured = off. */
  settings?: BrandedTypography
  slug: string
}>()

const { get, put, post } = useApi()
const { refreshConfig } = useProject()

const settings = ref<BrandedTypography | null>(props.settings || null)
const clampReason = ref('')
const saving = ref('')
const message = ref('')
const error = ref('')
const fonts = ref<Array<{ id: string; label: string; weights: number[] }>>([])
const cacheKey = ref(Date.now())

watch(() => props.settings, next => { if (next) settings.value = next })

const enabled = computed(() => settings.value?.enabled === true)
const accents = computed<BrandedAccent[]>(() => settings.value?.accents || [])
const live = computed(() => accents.value.filter(accent => !accent.retired_at))

async function loadFonts() {
  if (fonts.value.length) return
  try {
    // The route answers the bundled catalogue as a bare list.
    const data = await get<Array<{ id?: string; label?: string; weights?: number[] }>>('/thumbnail-text/fonts')
    fonts.value = (Array.isArray(data) ? data : [])
      .filter(font => typeof font.id === 'string' && font.id)
      .map(font => ({ id: String(font.id), label: String(font.label || font.id), weights: font.weights?.length ? font.weights : [400, 700] }))
  } catch { fonts.value = [] }
}
watch(enabled, on => { if (on) void loadFonts() }, { immediate: true })

function setMessage(text: string) { error.value = ''; message.value = text }
function setError(text: string) { message.value = ''; error.value = text }

async function reloadConfig() {
  await refreshConfig(props.slug).catch(() => undefined)
  const fresh = await get<any>(`/projects/${props.slug}/branded-typography`).catch(() => null)
  if (fresh?.settings) settings.value = fresh.settings
}

async function save(next: BrandedTypography, note: string) {
  saving.value = 'save'
  setMessage('Saving…')
  try {
    const result = await put<{ settings: BrandedTypography; clamp_reason: string | null }>(
      `/projects/${props.slug}/branded-typography`, next,
    )
    settings.value = result.settings
    clampReason.value = result.clamp_reason || ''
    await reloadConfig()
    setMessage(note + (result.clamp_reason ? ` ${result.clamp_reason}` : ''))
  } catch (e: any) {
    setError(e?.data?.detail || e?.message || 'That setting could not be saved.')
  } finally { saving.value = '' }
}

function base(): BrandedTypography {
  return settings.value || {
    enabled: false, accents: [], placement: { mode: 'auto', anchor: 'bottom-left' }, randomise: true,
    no_repeat_episodes: 3, title: { source: 'approved-title', font_id: 'kantumruy-pro', weight: 700 },
    presets: [], active_preset: null,
  }
}

function patch(change: Partial<BrandedTypography>, note: string) {
  void save({ ...base(), ...change }, note)
}

function toggle(event: Event) {
  const on = (event.target as HTMLInputElement).checked
  patch({ enabled: on }, on
    ? 'Branded typography is on. New thumbnails are drawn with a headline and an accent; the image model is asked for art without lettering.'
    : 'Branded typography is off. Thumbnails go back to the image model lettering them exactly as before.')
}

async function addAccent() {
  error.value = ''
  const picked = await pickFile({ title: 'Choose a transparent PNG accent', extensions: ['png'] })
  if (!picked) return // cancel writes nothing and says nothing
  saving.value = 'accent'
  setMessage('Adding the accent…')
  try {
    const result = await post<{ settings: BrandedTypography }>(`/projects/${props.slug}/branded-typography/accents`, {
      path: picked, label: '',
    })
    if (result?.settings) settings.value = result.settings
    cacheKey.value = Date.now()
    await reloadConfig()
    setMessage('Accent added.')
  } catch (e: any) {
    setError(e?.data?.detail || e?.message || 'That accent could not be added. Nothing was changed.')
  } finally { saving.value = '' }
}

async function retire(accent: BrandedAccent) {
  saving.value = accent.id
  setMessage(`Retiring “${accent.label}”…`)
  try {
    const result = await post<{ settings: BrandedTypography }>(
      `/projects/${props.slug}/branded-typography/accents/${encodeURIComponent(accent.id)}/retire`, {},
    )
    if (result?.settings) settings.value = result.settings
    await reloadConfig()
    setMessage(`“${accent.label}” retired. Its file is in Trash, not deleted.`)
  } catch (e: any) {
    setError(e?.data?.detail || e?.message || 'That accent could not be retired.')
  } finally { saving.value = '' }
}

function setNoRepeat(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  const ceiling = Math.max(1, live.value.length - 1)
  const n = Math.max(1, Math.min(ceiling, Math.round(value) || 1))
  patch({ no_repeat_episodes: n }, `Don't repeat an accent within the last ${n} episode${n === 1 ? '' : 's'}.`)
}

function setAnchor(event: Event) {
  const anchor = (event.target as HTMLSelectElement).value as BrandedTypography['placement']['anchor']
  patch({ placement: { mode: base().placement.mode, anchor } }, 'Accent placement saved.')
}

function setFont(event: Event) {
  const fontId = (event.target as HTMLSelectElement).value
  const font = fonts.value.find(entry => entry.id === fontId)
  const weight = font && !font.weights.includes(base().title.weight) ? (font.weights.at(-1) || 700) : base().title.weight
  patch({ title: { ...base().title, font_id: fontId, weight } }, 'Headline face saved.')
}

function accentUrl(accent: BrandedAccent): string {
  return `/api/projects/${encodeURIComponent(props.slug)}/branded-typography/accents/${encodeURIComponent(accent.id)}/file?v=${cacheKey.value}`
}
</script>

<template>
  <div class="branded-typography">
    <label class="thumbnail-text-toggle">
      <input type="checkbox" :checked="enabled" :disabled="saving !== ''" @change="toggle" />
      Draw the thumbnail headline and accent myself
    </label>
    <p class="settings-hint">
      <strong>Off (default):</strong> the image model letters each thumbnail exactly as before, and
      your YouTube title is untouched. <strong>On:</strong> the model is asked for art without
      lettering; Story Studio draws your approved headline in the face you choose and places one of
      your own transparent accent PNGs on the corner you pick. Every episode's accent is recorded, so
      the last-N guard can keep it from repeating.
    </p>
    <span v-if="message" class="text-muted" style="font-size: var(--font-xs)">{{ message }}</span>
    <p v-if="error" class="result err" role="status">{{ error }}</p>

    <div v-if="enabled" class="branded-editor">
      <div class="branded-accents">
        <div class="branded-head">
          <strong>Accents</strong>
          <button type="button" class="btn btn-sm" :disabled="saving !== ''" @click="addAccent">Add accent PNG…</button>
        </div>
        <p v-if="!live.length" class="settings-hint">
          No accents yet. Add a transparent PNG (a badge, tag or banner) — until one is added, a
          thumbnail is left unbranded and the upload says so rather than sending a picture nobody composed.
        </p>
        <ul v-else class="branded-accent-list">
          <li v-for="accent in live" :key="accent.id" class="branded-accent">
            <img :src="accentUrl(accent)" :alt="accent.label" class="branded-accent-image" />
            <div class="branded-accent-body">
              <strong>{{ accent.label }}</strong>
              <span class="settings-hint">{{ accent.width }}×{{ accent.height }} px · transparent PNG</span>
            </div>
            <button type="button" class="btn btn-link btn-xs" :disabled="saving !== ''" @click="retire(accent)">Retire</button>
          </li>
        </ul>
      </div>

      <div class="branded-row">
        <label class="branded-field">
          <span>Where the accent sits</span>
          <select :value="settings?.placement.anchor || 'bottom-left'" :disabled="saving !== ''" @change="setAnchor">
            <option value="top-left">Top left</option>
            <option value="top">Top centre</option>
            <option value="top-right">Top right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="bottom">Bottom centre</option>
            <option value="bottom-right">Bottom right</option>
          </select>
        </label>
        <label class="branded-field">
          <span>Don't repeat an accent within the last</span>
          <input
            type="number" min="1" max="100" step="1" inputmode="numeric"
            :value="settings?.no_repeat_episodes ?? 3" :disabled="saving !== ''"
            @change="setNoRepeat"
          />
        </label>
        <p class="settings-hint">
          {{ live.length }} accent{{ live.length === 1 ? '' : 's' }} in the pool. The guard never empties
          the pool: with {{ live.length }} accent{{ live.length === 1 ? '' : 's' }} it can avoid at most
          {{ Math.max(1, live.length - 1) }}.
        </p>
      </div>

      <div class="branded-row">
        <label class="branded-field">
          <span>Headline words</span>
          <select
            :value="settings?.title.source || 'approved-title'"
            :disabled="saving !== ''"
            @change="patch({ title: { ...base().title, source: ($event.target as HTMLSelectElement).value as 'approved-title' | 'separate-hook' } }, 'Headline source saved.')"
          >
            <option value="approved-title">The episode's approved title</option>
            <option value="separate-hook">The thumbnail prompt's own hook</option>
          </select>
        </label>
        <label class="branded-field">
          <span>Headline face</span>
          <select :value="settings?.title.font_id || 'kantumruy-pro'" :disabled="saving !== ''" @change="setFont">
            <option v-if="!fonts.length" :value="settings?.title.font_id || 'kantumruy-pro'">
              {{ settings?.title.font_id || 'kantumruy-pro' }}
            </option>
            <option v-for="font in fonts" :key="font.id" :value="font.id">{{ font.label }}</option>
          </select>
        </label>
      </div>
      <p class="settings-hint">
        The headline's place on the picture comes from the episode's own thumbnail layout (its Shell or
        template), so it sits where the model was told to leave room. The same format that shapes this
        thumbnail styles the uploaded title.
      </p>
      <span v-if="clampReason" class="text-muted" style="font-size: var(--font-xs)">{{ clampReason }}</span>
    </div>
  </div>
</template>

<style scoped>
.branded-typography { display: grid; gap: 10px; }
.branded-editor { display: grid; gap: 14px; }
.branded-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.branded-accent-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.branded-accent { display: flex; align-items: center; gap: 10px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.branded-accent-image { max-width: 96px; max-height: 48px; object-fit: contain; background: repeating-conic-gradient(var(--bg-tertiary) 0% 25%, var(--bg-secondary) 0% 50%) 50% / 12px 12px; }
.branded-accent-body { display: grid; gap: 2px; min-width: 0; flex: 1; }
.branded-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: start; }
.branded-field { display: grid; gap: 5px; color: var(--text-secondary); font-size: var(--font-xs); }
.result.err { color: var(--danger); font-size: var(--font-xs); margin: 0; }
</style>
