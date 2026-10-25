<template>
  <Modal :visible="visible" size="xxl" dialog-class="thumbnail-text-dialog modal-flush" labelledby="thumbnail-text-title" @close="emit('close')">
    <header class="tte-header">
      <div><h2 id="thumbnail-text-title">Thumbnail text</h2><p class="text-muted">{{ episodeCode }} · Add a headline to a copy of your artwork.</p></div>
      <button type="button" class="btn btn-secondary" @click="emit('close')">Close</button>
    </header>
    <div class="tte-body">
      <WorkspaceNotice v-if="notice" title="Thumbnail text updated">{{ notice }}</WorkspaceNotice>
      <WorkspaceNotice v-if="error" tone="error" title="Could not finish">{{ error }} <button class="btn btn-sm btn-secondary" @click="initialize">Reload editor</button></WorkspaceNotice>
      <p v-if="loading" role="status">Loading fonts, looks and variants…</p>
      <div class="tte-layout">
        <section class="tte-preview-column" aria-label="Headline and previews">
          <label class="form-group">Source artwork
            <select v-model="source" class="select" :disabled="applying">
              <option value="">Choose this episode’s text-free artwork</option>
              <option v-for="image in sources" :key="image.filename" :value="image.filename">{{ image.filename }}</option>
            </select>
          </label>
          <!-- Headline language: defaults to the channel's own language and says so. An override
               applies to THIS episode's thumbnail text only and never changes the channel. -->
          <label class="form-group">Headline language
            <select data-testid="thumbnail-text-language" :value="languageOverride ?? ''" class="select" :disabled="applying" @change="onLanguageChange">
              <option value="">Follow channel language</option>
              <option v-for="option in languageOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <span class="text-muted text-xs" data-testid="thumbnail-text-language-status">{{ languageStatus }}</span>
          </label>
          <div class="tte-suggestions-head"><strong>Headline ideas</strong><button type="button" class="btn btn-sm btn-secondary" :disabled="suggesting || !episodeCode" @click="moreSuggestions">{{ suggesting ? 'Finding ideas…' : suggestions ? 'More suggestions' : 'Get suggestions' }}</button></div>
          <p class="text-muted text-xs">Suggestions use the writing model in this channel’s Thumbnail Prompts preset, written in the headline language above.</p>
          <p v-if="suggestionError" class="text-danger" role="alert">{{ suggestionError }} Set the writing model in <NuxtLink :to="`/projects/${projectSlug}/image-prompts?tab=thumbnails`">Thumbnail Prompts → preset</NuxtLink>, then try again.</p>
          <div v-if="suggestions" class="tte-chips">
            <button v-for="(idea, i) in suggestions.suggestions" :key="i" type="button" class="btn btn-sm btn-secondary" @click="chooseSuggestion(idea.text)">{{ idea.text }}</button>
          </div>
          <label class="form-group">Headline
            <textarea v-model="text" data-testid="thumbnail-headline" class="input" rows="3" placeholder="Write your own headline, or choose an idea above" />
            <span class="text-muted text-xs">Enter starts a new line. Any language is welcome.</span>
          </label>
          <WorkspaceNotice v-if="text.trim() && !availableFonts.length && !loading" tone="warning" title="No installed font covers this text">Choose text supported by an installed font, or install a font covering its writing system. Apply is unavailable until the font covers the whole headline.</WorkspaceNotice>
          <div class="tte-preview-heading"><h3>Exact preview</h3><span class="text-muted">{{ rendering ? 'Updating…' : 'The PNG that will be saved' }}</span></div>
          <div class="tte-frame">
            <img v-if="exactUrl" :src="exactUrl" alt="Exact rendered thumbnail with headline" />
            <p v-else class="tte-empty">{{ source && text.trim() ? 'Waiting for the exact render…' : 'Choose artwork and enter a headline.' }}</p>
          </div>
          <div v-if="report" class="tte-report" aria-live="polite">
            <span>{{ report.font_px }} px · {{ report.lines }} line{{ report.lines === 1 ? '' : 's' }}</span>
            <strong v-if="report.overflow" class="text-danger">Text overflows. Enlarge the box, lower the minimum size, allow more lines, or shorten the headline.</strong>
            <strong v-if="!report.glyphs_complete || report.missing_characters?.length" class="text-danger">Missing glyphs{{ report.missing_characters?.length ? `: ${report.missing_characters.join(' ')}` : '' }}. Choose another font or edit the headline.</strong>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" :disabled="!source || !text.trim() || !selectedFont || rendering" @click="renderExact">Retry exact preview</button>
          <details class="tte-live" open>
            <summary>Live sketch · approximate, updates as you edit</summary>
            <div ref="liveFrame" class="tte-frame">
              <img v-if="sourceImage" :src="sourceImage.url" alt="Source artwork" />
              <div v-if="style && sourceImage" class="tte-canvas" :style="{ transform: `scale(${previewScale})` }">
                <div class="tte-live-box" :style="liveBoxStyle"><span :style="liveTextStyle">{{ style.uppercase ? text.toUpperCase() : text }}</span></div>
              </div>
            </div>
            <p class="text-muted text-xs">Browser fonts, wrapping and effects are approximate. Judge the exact preview before applying.</p>
          </details>
        </section>
        <section class="tte-controls" aria-label="Text look">
          <h3>Look</h3>
          <div class="tte-look-gallery">
            <button v-for="look in builtins" :key="look.id" type="button" :class="['btn btn-secondary', { 'is-active': presets.activeId.value === look.id }]" @click="selectPreset(look.id)">{{ look.name }}</button>
          </div>
          <PresetPicker :presets="presets.presets.value" :active-id="presets.activeId.value" :active-preset-is-built-in="presets.activePresetIsBuiltIn.value" label="Saved looks" hint="Saves the look only. Headline words and source artwork stay with this episode."
            @update:active-id="selectPreset" @apply="presets.applyActive()" @save-as="name => presetAction(() => presets.saveAs(name))" @overwrite="presetAction(presets.overwrite)" @rename="name => presetAction(() => presets.rename(name))" @delete="presetAction(presets.remove)" />
          <p v-if="!style && !loading" class="text-muted">No built-in look is available. Reload the editor when the thumbnail text service is available.</p>
          <template v-if="style">
            <details class="tte-group" open><summary>Font</summary><div class="tte-fields">
              <label class="form-group">Font<select v-model="style.font_id" class="select"><option v-for="font in availableFonts" :key="font.id" :value="font.id">{{ font.label }}</option></select></label>
              <label class="form-group">Weight<select v-model.number="style.weight" class="select"><option v-for="weight in selectedFont?.weights || []" :key="weight" :value="weight">{{ weight }}</option></select></label>
            </div></details>
            <details class="tte-group" open><summary>Size &amp; typography</summary><div class="tte-fields">
              <label class="form-group">Sizing<select v-model="style.size.mode" class="select"><option value="fit">Fit to box</option><option value="fixed">Fixed px</option></select></label>
              <SubtitleSliderField v-if="style.size.mode === 'fixed'" label="Fixed size" unit="px" :min="1" :max="720" :value="style.size.px ?? style.size.max_px" @change="v => style!.size.px = v" />
              <template v-else>
                <SubtitleSliderField label="Minimum size" unit="px" :min="1" :max="720" :value="style.size.min_px" @change="v => { style!.size.min_px = v; style!.size.max_px = Math.max(v, style!.size.max_px) }" />
                <SubtitleSliderField label="Maximum size" unit="px" :min="style.size.min_px" :max="720" :value="style.size.max_px" @change="v => style!.size.max_px = v" />
              </template>
              <SubtitleSliderField label="Maximum lines" :min="1" :max="20" :value="style.max_lines" @change="v => style!.max_lines = v" />
              <label class="form-group">Align<select v-model="style.align" class="select"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
              <SubtitleSliderField label="Line height" :min="0.5" :max="3" :step="0.05" :value="style.line_height" @change="v => style!.line_height = v" />
              <SubtitleSliderField label="Letter spacing" unit="px" :min="-10" :max="50" :value="style.letter_spacing" @change="v => style!.letter_spacing = v" />
              <label v-if="textHasCase(text)" class="tte-check"><input v-model="style.uppercase" type="checkbox" /> Uppercase</label>
            </div></details>
            <details class="tte-group" open><summary>Fill</summary><div class="tte-fields">
              <label class="form-group">Fill<select v-model="style.fill.type" class="select"><option value="solid">Solid</option><option value="gradient">Gradient</option></select></label>
              <SubtitleColorField label="Text colour" :hex="style.fill.color" :opacity="style.opacity" @hex="v => style!.fill.color = v" @opacity="v => style!.opacity = v" />
              <template v-if="style.fill.type === 'gradient'">
                <label class="form-group">Second colour<input v-model="style.fill.color2" type="color" /></label>
                <SubtitleSliderField label="Gradient angle" unit="°" :min="0" :max="360" :value="style.fill.angle ?? 0" @change="v => style!.fill.angle = v" />
              </template>
            </div></details>
            <details class="tte-group"><summary>Outline</summary><div class="tte-fields">
              <label class="tte-check"><input v-model="style.outline.enabled" type="checkbox" /> Outline on</label>
              <label class="form-group">Colour<input v-model="style.outline.color" type="color" /></label>
              <SubtitleSliderField label="Outline width" unit="px" :min="0" :max="40" :value="style.outline.width_px" @change="v => style!.outline.width_px = v" />
            </div></details>
            <details class="tte-group"><summary>Shadow</summary><div class="tte-fields">
              <label class="tte-check"><input v-model="style.shadow.enabled" type="checkbox" /> Shadow on</label>
              <SubtitleColorField label="Shadow colour" :hex="style.shadow.color" :opacity="style.shadow.opacity" @hex="v => style!.shadow.color = v" @opacity="v => style!.shadow.opacity = v" />
              <SubtitleSliderField label="Horizontal offset" unit="px" :min="-100" :max="100" :value="style.shadow.dx" @change="v => style!.shadow.dx = v" />
              <SubtitleSliderField label="Vertical offset" unit="px" :min="-100" :max="100" :value="style.shadow.dy" @change="v => style!.shadow.dy = v" />
              <SubtitleSliderField label="Blur" unit="px" :min="0" :max="100" :value="style.shadow.blur_px" @change="v => style!.shadow.blur_px = v" />
            </div></details>
            <details class="tte-group"><summary>Background box</summary><div class="tte-fields">
              <label class="tte-check"><input v-model="style.background.enabled" type="checkbox" /> Background on</label>
              <SubtitleColorField label="Box colour" :hex="style.background.color" :opacity="style.background.opacity" @hex="v => style!.background.color = v" @opacity="v => style!.background.opacity = v" />
              <SubtitleSliderField label="Padding" unit="px" :min="0" :max="100" :value="style.background.padding_px" @change="v => style!.background.padding_px = v" />
              <SubtitleSliderField label="Corner radius" unit="px" :min="0" :max="100" :value="style.background.radius_px" @change="v => style!.background.radius_px = v" />
            </div></details>
            <details class="tte-group" open><summary>Placement</summary><div class="tte-fields">
              <div class="form-group"><label>Anchor</label><div class="tte-anchor-grid" role="group" aria-label="Text anchor">
                <button v-for="anchor in anchors" :key="anchor" type="button" :aria-label="anchor" :aria-pressed="style.placement.anchor === anchor" :class="['btn btn-sm', style.placement.anchor === anchor ? 'btn-primary' : 'btn-secondary']" @click="setAnchor(anchor)">{{ anchor.replaceAll('-', ' ') }}</button>
              </div></div>
              <SubtitleSliderField label="X" unit="%" :min="0" :max="100" :value="style.placement.x_pct" @change="v => style!.placement.x_pct = v" />
              <SubtitleSliderField label="Y" unit="%" :min="0" :max="100" :value="style.placement.y_pct" @change="v => style!.placement.y_pct = v" />
              <SubtitleSliderField label="Width" unit="%" :min="1" :max="100" :value="style.placement.width_pct" @change="v => style!.placement.width_pct = v" />
              <SubtitleSliderField label="Height" unit="%" :min="1" :max="100" :value="style.placement.height_pct" @change="v => style!.placement.height_pct = v" />
            </div></details>
          </template>
        </section>
      </div>
      <section class="tte-variants" aria-label="Episode text variants">
        <h3>Text variants for {{ episodeCode }}</h3>
        <p v-if="!variants.length" class="text-muted">No text variants saved for this episode yet.</p>
        <div v-for="variant in variants" :key="variant.filename" class="tte-variant">
          <div><strong>{{ variant.filename }}</strong><span v-if="variant.stale" class="tte-stale">STALE</span><p>{{ variant.text }}</p><small v-if="variant.stale">{{ variant.stale_reason || 'Source artwork changed.' }}</small></div>
          <button v-if="variant.stale" type="button" class="btn btn-sm btn-secondary" @click="reapply(variant, sources.map(s => s.filename))">Re-apply</button>
          <button v-else type="button" class="btn btn-sm btn-secondary" @click="pinExisting(variant)">Use for upload</button>
        </div>
      </section>
    </div>
    <footer class="tte-footer">
      <span class="text-muted">{{ saved ? `${saved.filename} saved` : 'Apply saves a separate PNG. Original artwork is kept.' }}</span>
      <div class="tte-footer-actions">
        <button v-if="saved" type="button" class="btn btn-secondary" @click="pinExisting(saved)">Use for upload</button>
        <label class="tte-check"><input v-model="pinOnApply" type="checkbox" /> Use for upload</label>
        <button type="button" data-testid="thumbnail-text-apply" class="btn btn-primary" :disabled="!canApply" @click="applyText">{{ applying ? 'Applying…' : 'Apply text' }}</button>
      </div>
    </footer>
  </Modal>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch, onBeforeUnmount, type CSSProperties } from 'vue'
import type { TextAnchor, ThumbnailTextLanguage, ThumbnailTextVariant } from '@shared/thumbnail-text'
import { useThumbnailText } from '../composables/useThumbnailText'
import { textHasCase } from '../utils/thumbnail-text'
import { CONTENT_LANGUAGE_OPTIONS, contentLanguageLabel } from '../utils/content-language'

const props = defineProps<{ visible: boolean; projectSlug: string; episodeCode: string; initialSource?: string; sources: Array<{ filename: string; url: string }> }>()
const emit = defineEmits<{ close: []; applied: [variant: ThumbnailTextVariant]; pinned: [variant: ThumbnailTextVariant] }>()
const editor = useThumbnailText({ slug: props.projectSlug, episode: toRef(props, 'episodeCode'), visible: toRef(props, 'visible'), sources: toRef(props, 'sources'), initialSource: computed(() => props.initialSource || '') })
const { text, source, style, availableFonts, selectedFont, builtins, presets, variants, suggestions, exactUrl, report, error, suggestionError, notice, loading, rendering, applying, suggesting, saved, canApply, initialize, renderExact, moreSuggestions, chooseSuggestion, reapply, presetAction, languageOverride, effectiveLanguage, followsChannel, setLanguageOverride } = editor
const languageOptions = CONTENT_LANGUAGE_OPTIONS
/** Which language is in effect and why, so the owner can see whether the channel or this episode decides. */
const languageStatus = computed(() => {
  const effective = contentLanguageLabel(effectiveLanguage.value)
  if (!followsChannel.value) return `${effective} — set for this episode's thumbnail text only. The channel language is unchanged.`
  if (effective) return `${effective} — follows channel language`
  return 'Follows the channel language. This channel has none set, so suggestions use the script or the title.'
})
function onLanguageChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  void setLanguageOverride(value === '' ? null : (value as ThumbnailTextLanguage))
}
const pinOnApply = ref(false)
watch(() => [props.episodeCode, props.visible], () => { pinOnApply.value = false })
const sourceImage = computed(() => props.sources.find(image => image.filename === source.value))
const anchors: TextAnchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']
function setAnchor(anchor: TextAnchor) {
  if (!style.value) return
  const p = style.value.placement
  p.anchor = anchor
  p.x_pct = anchor.includes('left') ? 5 : anchor.includes('right') ? 95 : 50
  p.y_pct = anchor.includes('top') ? 5 : anchor.includes('bottom') ? 95 : 50
}
async function selectPreset(id: string) { await presetAction(async () => { await presets.setActive(id); presets.applyActive() }) }
async function applyText() { const result = await editor.apply(pinOnApply.value); if (result) { emit('applied', result); if (pinOnApply.value) emit('pinned', result) } }
async function pinExisting(variant: ThumbnailTextVariant) { const result = await editor.pinVariant(variant); if (result) emit('pinned', result) }
const liveFrame = ref<HTMLElement | null>(null)
const previewScale = ref(0.4)
let observer: ResizeObserver | undefined
watch(liveFrame, element => {
  observer?.disconnect()
  if (!element || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(entries => {
    // A collapsed frame measures 0; scaling by that would blank the sketch.
    const width = entries[0].contentRect.width
    if (width > 0) previewScale.value = width / 1280
  })
  observer.observe(element)
})
onBeforeUnmount(() => observer?.disconnect())
const rgba = (hex: string, alpha: number) => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
const liveBoxStyle = computed<CSSProperties>(() => {
  if (!style.value) return {}
  const p = style.value.placement
  return { left: `${p.x_pct}%`, top: `${p.y_pct}%`, width: `${p.width_pct}%`, height: `${p.height_pct}%`,
    transform: `translate(${p.anchor.includes('left') ? 0 : p.anchor.includes('right') ? -100 : -50}%, ${p.anchor.includes('top') ? 0 : p.anchor.includes('bottom') ? -100 : -50}%)`,
    textAlign: style.value.align, alignItems: p.anchor.includes('top') ? 'flex-start' : p.anchor.includes('bottom') ? 'flex-end' : 'center' }
})
const liveTextStyle = computed<CSSProperties>(() => {
  const s = style.value
  if (!s) return {}
  return { fontFamily: selectedFont.value?.label, fontWeight: s.weight, fontSize: `${s.size.mode === 'fixed' ? s.size.px ?? s.size.max_px : s.size.max_px}px`, lineHeight: s.line_height,
    letterSpacing: `${s.letter_spacing}px`, color: s.fill.color, opacity: s.opacity,
    ...(s.fill.type === 'gradient' ? { backgroundImage: `linear-gradient(${90 + (s.fill.angle ?? 0)}deg, ${s.fill.color}, ${s.fill.color2 || s.fill.color})`, backgroundClip: 'text', color: 'transparent' } : {}),
    WebkitTextStroke: s.outline.enabled ? `${s.outline.width_px}px ${s.outline.color}` : undefined, paintOrder: 'stroke fill',
    textShadow: s.shadow.enabled ? `${s.shadow.dx}px ${s.shadow.dy}px ${s.shadow.blur_px}px ${rgba(s.shadow.color, s.shadow.opacity)}` : undefined,
    backgroundColor: s.background.enabled ? rgba(s.background.color, s.background.opacity) : undefined,
    padding: s.background.enabled ? `${s.background.padding_px}px` : undefined, borderRadius: `${s.background.radius_px}px`, width: '100%' }
})
</script>

<style>
/* Modal teleports: the dialog override must be unscoped. */
.thumbnail-text-dialog { display: flex; flex-direction: column; max-height: calc(100dvh - 32px); overflow: hidden; }
</style>
<style scoped>
.tte-header, .tte-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; flex: 0 0 auto; background: var(--bg-secondary); }
.tte-header { border-bottom: 1px solid var(--border); }
.tte-header h2 { margin: 0; font-size: 20px; }
.tte-header p { margin: 4px 0 0; font-size: var(--font-sm); }
.tte-body { padding: 20px; overflow-y: auto; min-height: 0; overscroll-behavior: contain; }
.tte-layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 24px; margin-top: 12px; }
.tte-preview-column, .tte-controls { min-width: 0; }
.tte-preview-column { display: flex; flex-direction: column; gap: 10px; }
.tte-preview-column .form-group { margin: 0; display: grid; gap: 6px; }
.tte-preview-column textarea { width: 100%; resize: vertical; min-height: 76px; max-height: 220px; }
.tte-suggestions-head, .tte-preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.tte-preview-heading { margin-top: 8px; }
.tte-preview-heading h3 { margin: 0; }
.tte-preview-heading span, .tte-report { font-size: var(--font-xs); }
.tte-frame { aspect-ratio: 16 / 9; width: 100%; position: relative; overflow: hidden; border-radius: var(--radius-sm); background: var(--bg-primary); }
.tte-frame > img { width: 100%; height: 100%; object-fit: contain; display: block; }
.tte-empty { display: grid; place-content: center; height: 100%; margin: 0; padding: 20px; text-align: center; color: var(--text-muted); }
.tte-canvas { width: 1280px; height: 720px; position: absolute; top: 0; left: 0; transform-origin: top left; pointer-events: none; }
.tte-live-box { position: absolute; display: flex; border: 2px dashed var(--text-muted); }
.tte-live-box span { white-space: pre-wrap; overflow-wrap: anywhere; }
.tte-live summary { cursor: pointer; margin: 8px 0; font-size: var(--font-sm); }
.tte-report { display: grid; gap: 6px; }
.tte-chips, .tte-look-gallery { display: flex; flex-wrap: wrap; gap: 6px; }
.tte-chips .btn { white-space: normal; text-align: start; overflow-wrap: anywhere; }
.tte-look-gallery .is-active { outline: 2px solid var(--accent); outline-offset: 1px; }
.tte-group { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 12px; }
.tte-group summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
.tte-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding-top: 12px; }
.tte-fields .form-group { min-width: 0; margin-bottom: 0; }
.tte-fields label.form-group { display: grid; gap: 6px; }
.tte-fields select, .tte-preview-column select { width: 100%; min-width: 0; }
.tte-check { display: flex; align-items: center; gap: 6px; font-size: var(--font-sm); }
.tte-anchor-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; }
.tte-anchor-grid .btn { min-width: 0; white-space: normal; padding: 6px 3px; font-size: var(--font-xs); }
.tte-variants { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px; }
.tte-variant { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); padding: 12px 0; }
.tte-variant > div { min-width: 0; overflow-wrap: anywhere; }
.tte-variant p { margin: 4px 0; white-space: pre-wrap; }
.tte-stale { margin-left: 8px; font-size: var(--font-xs); color: var(--warning); font-weight: 700; }
.tte-footer { border-top: 1px solid var(--border); flex-wrap: wrap; }
.tte-footer > span { min-width: 0; overflow-wrap: anywhere; font-size: var(--font-xs); flex: 1; }
.tte-footer-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
@media (max-width: 760px) {
  .tte-layout { grid-template-columns: minmax(0, 1fr); }
  .tte-body { padding: 14px; }
  .tte-header, .tte-footer { padding: 12px 14px; }
  .tte-footer-actions { width: 100%; justify-content: flex-end; }
}
@media (max-width: 400px) { .tte-fields { grid-template-columns: minmax(0, 1fr); } .tte-variant { flex-wrap: wrap; } }
</style>
