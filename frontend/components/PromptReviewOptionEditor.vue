<!--
  Per-OPTION metadata editor for one thumbnail row inside PromptReviewPanel.

  Edits the five independent selections stored beside the episode's prompts
  (recipe, visual style, font, text style, placement) plus the prompt approval
  and the Duplicate action. Every choice comes from the same live catalogues
  the Image Prompts page uses (ThumbnailRecipePicker / StylePicker /
  LetteringSwatchPicker) — nothing here holds a list of its own.

  Presentational on purpose: drafts live here, every write is emitted to
  PromptReviewPanel, which owns the episode, the request and the saved state.
  A draft is compared against what the server has for THIS thumbnail, so Save
  only ever sends the fields the customer actually moved — an episode with no
  sidecar is never backfilled by opening or saving something else.
-->
<template>
  <div class="proe">
    <div class="proe-fields">
      <div class="proe-field">
        <div class="proe-label-row">
          <span class="proe-label">Recipe</span>
          <span class="proe-state" :class="isSaved('thumbnail_template_id') ? 'is-saved' : 'is-unset'">
            {{ isSaved('thumbnail_template_id') ? 'Saved for this thumbnail' : 'Not set' }}
          </span>
        </div>
        <ThumbnailRecipePicker
          :selected-recipe-id="drafts.template"
          @select="drafts.template = $event.id"
        />
      </div>

      <div class="proe-field">
        <div class="proe-label-row">
          <label class="proe-label" :for="`proe-style-${number}`">Visual art style</label>
          <span class="proe-state" :class="isSaved('style_tag') ? 'is-saved' : 'is-unset'">
            {{ isSaved('style_tag') ? 'Saved for this thumbnail' : 'Not set' }}
          </span>
        </div>
        <StylePicker
          :slug="projectSlug"
          :active-style-bible="drafts.style"
          :show-custom-styles="false"
          @apply="drafts.style = $event.style_bible"
        />
        <textarea
          :id="`proe-style-${number}`"
          v-model="drafts.style"
          class="textarea proe-textarea"
          rows="3"
          maxlength="1000"
          placeholder="Describe the look of this thumbnail…"
        />
      </div>

      <div class="proe-field">
        <div class="proe-label-row">
          <span class="proe-label">Font</span>
          <span class="proe-state" :class="isSaved('thumb_font_style') ? 'is-saved' : 'is-unset'">
            {{ isSaved('thumb_font_style') ? 'Saved for this thumbnail' : 'Page setting' }}
          </span>
        </div>
        <LetteringSwatchPicker
          v-model="drafts.font"
          kind="font"
          title="Choose a font"
          caption="Same word in every swatch, so only the letterform differs"
        />
      </div>

      <div class="proe-field">
        <div class="proe-label-row">
          <span class="proe-label">Text style</span>
          <span class="proe-state" :class="isSaved('thumb_text_style') ? 'is-saved' : 'is-unset'">
            {{ isSaved('thumb_text_style') ? 'Saved for this thumbnail' : 'Page setting' }}
          </span>
        </div>
        <LetteringSwatchPicker
          v-model="drafts.text"
          kind="text"
          title="Choose a text style"
          caption="Same word and same letterform, so only the finish differs"
        />
      </div>

      <div class="proe-field">
        <div class="proe-label-row">
          <span class="proe-label">Title location</span>
          <span class="proe-state" :class="isSaved('thumb_text_position') ? 'is-saved' : 'is-unset'">
            {{ isSaved('thumb_text_position') ? 'Saved for this thumbnail' : 'Not set' }}
          </span>
        </div>
        <div class="proe-positions" role="radiogroup" aria-label="Title location for this thumbnail">
          <button
            v-for="option in POSITIONS" :key="option.id" type="button" role="radio"
            :aria-checked="drafts.position === option.id"
            :class="['proe-chip', { selected: drafts.position === option.id }]"
            @click="drafts.position = option.id"
          >{{ option.label }}</button>
        </div>
      </div>
    </div>

    <div class="proe-actions">
      <button
        type="button"
        class="btn btn-sm btn-primary"
        :disabled="saving || duplicating || !dirty"
        :title="dirty ? 'Save these selections for this thumbnail only.' : 'Nothing changed yet.'"
        @click="emitSave"
      >
        <LoadingSpinner v-if="saving" size="sm" />
        {{ saving ? 'Saving…' : 'Save Selections' }}
      </button>
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        :disabled="saving || duplicating || !dirty"
        @click="resetDrafts"
      >
        Reset
      </button>
      <button
        type="button"
        class="btn btn-sm"
        :class="approved ? 'btn-secondary' : 'btn-primary'"
        :disabled="saving || duplicating || autoApprove"
        :title="autoApprove
          ? 'Automatic prompt approval is on for this episode, so every prompt already reads as approved.'
          : approved
            ? 'Withdraw the approval given to this prompt as it stands.'
            : 'Approve this prompt exactly as it stands. Editing it clears the approval again.'"
        @click="emit('approve', !approved)"
      >
        {{ approved ? '✓ Approved' : 'Approve Prompt' }}
      </button>
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        :disabled="saving || duplicating"
        title="Create another thumbnail from this one — its selections are copied, and the new prompt starts unapproved."
        @click="emit('duplicate')"
      >
        <LoadingSpinner v-if="duplicating" size="sm" />
        {{ duplicating ? 'Duplicating…' : 'Duplicate' }}
      </button>
      <span v-if="dirty" class="proe-state is-unsaved">Unsaved changes</span>
    </div>

    <p class="text-muted text-xs">
      Selections apply to this thumbnail only. Regenerating it sends these five saved choices;
      approving matches the prompt as it stands, and any later edit to the prompt clears it.
      <span v-if="autoApprove"> Automatic approval is on for this episode, so approval cannot be changed here.</span>
    </p>
    <p v-if="error" class="proe-error" :title="error">⚠ {{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import ThumbnailRecipePicker from './ThumbnailRecipePicker.vue'
import StylePicker from './StylePicker.vue'
import LetteringSwatchPicker from './LetteringSwatchPicker.vue'

/** One option's stored selections as GET/PUT /image-prompts/options presents them. */
interface ThumbnailOptionEntry {
  thumbnail_template_id?: string
  style_tag?: string
  thumb_font_style?: string
  thumb_text_style?: string
  thumb_text_position?: string
  approved?: boolean
}

/**
 * The title locations the Image Prompts page offers (its own fixed set of
 * layout labels — positions are copy, not a catalogue; recipes, styles and
 * lettering all come from their live endpoints).
 */
const POSITIONS = [
  { id: 'auto', label: 'Let the model decide' },
  { id: 'top', label: 'Top' },
  { id: 'center', label: 'Centre' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'bottom-left', label: 'Bottom left' },
]

const props = defineProps<{
  number: number
  /** This thumbnail's saved selections. Null = nothing stored yet (legacy sidecar-free episode). */
  entry: ThumbnailOptionEntry | null
  projectSlug: string
  /** The page's own font/text choices, shown while this thumbnail has no override of its own. */
  pageFontStyle?: string
  pageTextStyle?: string
  /** Episode-level automatic approval. When on, per-prompt approval is the server's, not a choice here. */
  autoApprove: boolean
  /** The server's honest verdict for THIS prompt right now (hash-matched, auto-approve resolved). */
  approved: boolean
  saving: boolean
  duplicating: boolean
  error: string | null
}>()
const emit = defineEmits<{
  (e: 'save', fields: Record<string, string>): void
  (e: 'approve', approve: boolean): void
  (e: 'duplicate'): void
}>()

/** What the server holds for this option, as defaults — never invented. */
const saved = computed<ThumbnailOptionEntry>(() => props.entry ?? {})
const initial = computed(() => ({
  template: saved.value.thumbnail_template_id || '',
  style: (saved.value.style_tag || '').trim(),
  font: saved.value.thumb_font_style || props.pageFontStyle || 'auto',
  text: saved.value.thumb_text_style || props.pageTextStyle || 'auto',
  position: saved.value.thumb_text_position || '',
}))

const drafts = reactive({ template: '', style: '', font: 'auto', text: 'auto', position: '' })

/** Replace drafts when the SAVED fields change (episode swap, reload, another
 *  write) — but not when only `approved` moves, so a prompt edit never wipes
 *  selections the customer is still editing. Compared as JSON so a refresh
 *  that changes nothing does not reset work in progress either. */
watch(() => JSON.stringify(initial.value), (next, prev) => {
  if (next === prev) return
  Object.assign(drafts, initial.value)
}, { immediate: true })

function isSaved(field: keyof ThumbnailOptionEntry): boolean {
  return Boolean(saved.value[field])
}

/** Only the fields the customer actually moved — an untouched option never
 *  writes itself into a sidecar that did not exist. */
function changedFields(): Record<string, string> {
  const out: Record<string, string> = {}
  const base = initial.value
  if (drafts.template !== base.template) out.thumbnail_template_id = drafts.template
  if (drafts.style.trim() !== base.style) out.style_tag = drafts.style.trim()
  if (drafts.font !== base.font) out.thumb_font_style = drafts.font
  if (drafts.text !== base.text) out.thumb_text_style = drafts.text
  if (drafts.position !== base.position) out.thumb_text_position = drafts.position
  return out
}

const dirty = computed(() => Object.keys(changedFields()).length > 0)

function resetDrafts(): void {
  Object.assign(drafts, initial.value)
}

function emitSave(): void {
  const fields = changedFields()
  if (!Object.keys(fields).length) return
  emit('save', fields)
}
</script>

<style scoped>
.proe {
  margin-top: 8px;
  display: grid;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
}
.proe-fields { display: grid; gap: 12px; }
.proe-field { display: grid; gap: 5px; }
.proe-label-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; flex-wrap: wrap;
}
.proe-label {
  font-size: var(--font-xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-muted);
}
.proe-state {
  font-size: var(--font-xs);
  padding: 1px 7px; border-radius: 10px;
  border: 1px solid var(--border);
}
.proe-state.is-saved { color: rgb(21,128,61); border-color: rgba(34,197,94,0.35); background: rgba(34,197,94,0.10); }
.proe-state.is-unset { color: var(--text-muted); background: var(--bg-tertiary); }
.proe-state.is-unsaved {
  color: rgb(161,98,7); border-color: rgba(234,179,8,0.45);
  background: rgba(234,179,8,0.12);
}
.proe-textarea { font-size: 12px; line-height: 1.5; width: 100%; }
.proe-positions { display: flex; gap: 6px; flex-wrap: wrap; }
.proe-chip {
  min-height: var(--control-height-sm, 30px);
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer; font: inherit; font-size: var(--font-sm);
}
.proe-chip:hover { border-color: var(--border-light); color: var(--text-primary); }
.proe-chip.selected {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  background: var(--accent-dim); color: var(--accent);
}
.proe-chip:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.proe-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.proe-error { margin: 0; font-size: var(--font-xs); color: rgb(220, 38, 38); cursor: help; }
</style>
