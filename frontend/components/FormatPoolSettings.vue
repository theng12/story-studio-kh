<script setup lang="ts">
/**
 * The format pool — owner 2026-11-15: "randomize from a pool of 1-10 formats
 * so each episode doesn't have the style 'type' ... default off."
 *
 * One switch, easy to spot in the channel's thumbnail settings. Off (the
 * default, and every channel saved before this feature) shows one sentence
 * and changes nothing. The editor only exists once the switch is on. Every
 * value is editable here; the format actually in force on an episode is
 * shown (and overridable) on the YouTube Finalizer page.
 */
import { FORMAT_POOL_MAX_MEMBERS, type FormatPool, type FormatPoolMember } from '@shared/format-pool'

const props = defineProps<{
  /** The channel's saved pool (config.format_pool); undefined = never configured = off. */
  pool?: FormatPool
  slug: string
}>()

const { put } = useApi()
const { refreshConfig } = useProject()

const enabled = computed(() => props.pool?.enabled === true)
const members = computed<FormatPoolMember[]>(() => (enabled.value ? props.pool?.members || [] : []))
const saving = ref(false)
const message = ref('')
const templates = ref<Array<{ id: string; name: string }>>([])
let templatesLoaded = false

async function loadTemplates() {
  if (templatesLoaded) return
  templatesLoaded = true
  try {
    const data = await useApi().get<{ templates?: Array<{ id?: string; name?: string }> }>('/thumbnail-templates')
    templates.value = (data?.templates || [])
      .filter(t => typeof t.id === 'string' && t.id)
      .map(t => ({ id: String(t.id), name: String(t.name || t.id) }))
  } catch { templates.value = [] } // live catalogue unavailable → plain text entry still works
}

watch(enabled, on => { if (on) void loadTemplates() }, { immediate: true })

async function save(next: FormatPool) {
  saving.value = true
  message.value = 'Saving…'
  try {
    await put(`/projects/${props.slug}/settings/config`, { format_pool: next })
    await refreshConfig(props.slug)
    message.value = 'Saved.'
    setTimeout(() => { if (message.value === 'Saved.') message.value = '' }, 2000)
  } catch (e: any) {
    message.value = e?.data?.detail || e?.message || 'Failed to save the format pool'
  } finally {
    saving.value = false
  }
}

function blankMember(n: number): FormatPoolMember {
  return { id: `fmt${Date.now().toString(36)}${n}`, label: `Format ${n}` }
}

function current(): FormatPool {
  return { enabled: enabled.value, members: enabled.value && props.pool?.members?.length ? props.pool.members : [blankMember(1)] }
}

function toggle(event: Event) {
  const on = (event.target as HTMLInputElement).checked
  const base = props.pool?.members?.length ? props.pool.members : [blankMember(1)]
  void save({ enabled: on, members: base })
}

function setField(index: number, field: keyof FormatPoolMember, value: string) {
  const next = current().members.map((m, i) => (i === index ? { ...m, [field]: value || undefined } : m))
  // An empty optional field is removed, not stored as '' — absent keeps the
  // channel's own fallback, which is what "empty box" means to the owner.
  if (value === '') delete (next[index] as Record<string, any>)[field]
  void save({ enabled: true, members: next as FormatPoolMember[] })
}

function addMember() {
  const list = current().members
  if (list.length >= FORMAT_POOL_MAX_MEMBERS) return
  void save({ enabled: true, members: [...list, blankMember(list.length + 1)] })
}

function removeMember(index: number) {
  const list = current().members.filter((_, i) => i !== index)
  // A pool of zero is not a pool: keep one member so the switch stays honest.
  void save({ enabled: true, members: list.length ? list : [blankMember(1)] })
}
</script>

<template>
  <div class="format-pool">
    <label class="thumbnail-text-toggle">
      <input type="checkbox" :checked="enabled" :disabled="saving" @change="toggle" />
      Vary thumbnail and title formats per episode
    </label>
    <p class="settings-hint">
      <strong>Off (default):</strong> every episode uses this channel's one thumbnail format and one
      title style, exactly as before. <strong>On:</strong> each episode gets one format from the pool
      below — the same format shapes its thumbnail lettering and its YouTube title — and you can
      change any episode's format on the YouTube Finalizer page before upload.
    </p>
    <span v-if="message" class="text-muted" style="font-size: var(--font-xs)">{{ message }}</span>

    <div v-if="enabled" class="format-pool-editor">
      <p class="settings-hint">
        <template v-if="members.length === 1">
          One format in the pool — every episode uses it, exactly like the switch being off. Add more
          formats so episodes differ.
        </template>
        <template v-else>
          {{ members.length }} formats in the pool (maximum {{ FORMAT_POOL_MAX_MEMBERS }}). Each
          episode is assigned one from its episode id, so its format never changes afterwards.
        </template>
      </p>

      <div v-for="(member, index) in members" :key="member.id" class="format-pool-member">
        <div class="format-pool-member-head">
          <strong>{{ member.label || member.id }}</strong>
          <button
            v-if="members.length > 1"
            type="button"
            class="btn btn-link btn-xs"
            :disabled="saving"
            @click="removeMember(index)"
          >Remove</button>
        </div>

        <label class="format-pool-field">
          <span>Name</span>
          <input
            type="text"
            :value="member.label || ''"
            :disabled="saving"
            maxlength="80"
            placeholder="Bold red headlines"
            @change="setField(index, 'label', ($event.target as HTMLInputElement).value.trim())"
          />
        </label>

        <label class="format-pool-field">
          <span>Thumbnail Shell id</span>
          <input
            type="text"
            :value="member.thumbnail_shell_id || ''"
            :disabled="saving"
            maxlength="300"
            list="format-pool-templates"
            placeholder="Channel default"
            @change="setField(index, 'thumbnail_shell_id', ($event.target as HTMLInputElement).value.trim())"
          />
        </label>

        <label class="format-pool-field">
          <span>Thumbnail template id</span>
          <input
            type="text"
            :value="member.thumbnail_template_id || ''"
            :disabled="saving"
            maxlength="200"
            list="format-pool-templates"
            placeholder="Channel default"
            @change="setField(index, 'thumbnail_template_id', ($event.target as HTMLInputElement).value.trim())"
          />
        </label>
        <datalist id="format-pool-templates">
          <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
        </datalist>

        <div class="format-pool-row">
          <label class="format-pool-field">
            <span>Font style</span>
            <input
              type="text"
              :value="member.thumb_font_style || ''"
              :disabled="saving"
              maxlength="200"
              placeholder="auto"
              @change="setField(index, 'thumb_font_style', ($event.target as HTMLInputElement).value.trim())"
            />
          </label>
          <label class="format-pool-field">
            <span>Text style</span>
            <input
              type="text"
              :value="member.thumb_text_style || ''"
              :disabled="saving"
              maxlength="200"
              placeholder="auto"
              @change="setField(index, 'thumb_text_style', ($event.target as HTMLInputElement).value.trim())"
            />
          </label>
          <label class="format-pool-field">
            <span>Text position</span>
            <input
              type="text"
              :value="member.thumb_text_position || ''"
              :disabled="saving"
              maxlength="50"
              placeholder="auto"
              @change="setField(index, 'thumb_text_position', ($event.target as HTMLInputElement).value.trim())"
            />
          </label>
        </div>
        <p class="settings-hint">
          Lettering ids are the same ones the Thumbnail Prompts page uses; leave a box empty (or
          “auto”) to keep the channel's own choice.
        </p>

        <div class="format-pool-row">
          <label class="format-pool-field">
            <span>Title style</span>
            <select
              :value="member.title_mode || ''"
              :disabled="saving"
              @change="setField(index, 'title_mode', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Channel default</option>
              <option value="use_idea_title">Use the idea title</option>
              <option value="paraphrase">Paraphrase into SEO variants</option>
              <option value="manual">One manual title</option>
            </select>
          </label>
          <label class="format-pool-field">
            <span>Title prefix</span>
            <input
              type="text"
              :value="member.title_prefix || ''"
              :disabled="saving"
              maxlength="200"
              placeholder="none"
              @change="setField(index, 'title_prefix', ($event.target as HTMLInputElement).value.trim())"
            />
          </label>
          <label class="format-pool-field">
            <span>Title suffix</span>
            <input
              type="text"
              :value="member.title_suffix || ''"
              :disabled="saving"
              maxlength="200"
              placeholder="none"
              @change="setField(index, 'title_suffix', ($event.target as HTMLInputElement).value.trim())"
            />
          </label>
        </div>
        <label class="format-pool-field">
          <span>Title tone guidance</span>
          <input
            type="text"
            :value="member.title_guidance || ''"
            :disabled="saving"
            maxlength="500"
            placeholder="The channel format's own tone"
            @change="setField(index, 'title_guidance', ($event.target as HTMLInputElement).value.trim())"
          />
        </label>
      </div>

      <button
        v-if="members.length < FORMAT_POOL_MAX_MEMBERS"
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="saving"
        @click="addMember"
      >Add format</button>
      <p v-else class="settings-hint">Maximum of {{ FORMAT_POOL_MAX_MEMBERS }} formats — the owner's stated range.</p>
    </div>
  </div>
</template>
