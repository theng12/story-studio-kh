<template>
  <div class="workspace-page channel-characters-page">
    <WorkspaceHero
      eyebrow="Library · Channel identity"
      title="Channel Characters"
      description="Keep one shared character record, label the channels that use it, and give each channel its own voice profile. Scripts, visuals, and narration all read this same source."
      :breadcrumb="false"
    >
      <template #aside>
        <button class="btn btn-primary" @click="openCreate">+ New channel character</button>
      </template>
    </WorkspaceHero>

    <WorkspaceSection
      eyebrow="01 · Find"
      title="Character roster"
      description="Filter by channel without creating duplicate character copies."
    >
      <template #actions>
        <button class="btn btn-sm btn-secondary" :disabled="loading" @click="load">
          {{ loading ? 'Refreshing…' : 'Refresh' }}
        </button>
      </template>
      <div class="roster-toolbar">
        <input v-model="search" class="input roster-search" type="search" placeholder="Search names, roles, or descriptions…" />
        <select v-model="channelFilter" class="select roster-filter">
          <option value="">All channels</option>
          <option value="__unassigned">Not assigned yet</option>
          <option v-for="channel in channels" :key="channel.slug" :value="channel.slug">{{ channel.name }}</option>
        </select>
        <div class="roster-count"><strong>{{ filteredCharacters.length }}</strong><span>shown</span></div>
      </div>
    </WorkspaceSection>

    <WorkspaceNotice
      v-if="loadError"
      tone="error"
      title="Channel characters could not be loaded"
    >{{ loadError }}</WorkspaceNotice>

    <EmptyState
      v-else-if="!loading && !filteredCharacters.length"
      icon="&#127917;"
      :title="characters.length ? 'No characters match this filter' : 'Create your first channel character'"
      :message="characters.length ? 'Try another channel or clear the search.' : 'One character can serve several channels while keeping a different voice profile for each.'"
    >
      <template #action>
        <button v-if="!characters.length" class="btn btn-primary mt-2" @click="openCreate">+ New channel character</button>
      </template>
    </EmptyState>

    <div v-else class="character-grid">
      <article v-for="character in filteredCharacters" :key="character.id" class="character-tile">
        <button class="portrait" type="button" @click="openEdit(character)">
          <img v-if="firstReference(character)" :src="referenceUrl(character, firstReference(character)!)" :alt="character.name" />
          <span v-else>{{ initials(character.name) }}</span>
        </button>
        <div class="character-copy">
          <div class="character-heading">
            <div>
              <span class="character-kicker">{{ character.archetype || 'Recurring character' }}</span>
              <h2>{{ character.name }}</h2>
            </div>
            <button class="btn btn-sm btn-secondary" @click="openEdit(character)">Edit</button>
          </div>
          <p>{{ character.description }}</p>
          <div class="channel-chip-row">
            <span v-if="!character.projects?.length" class="channel-chip is-muted">Not assigned</span>
            <span v-for="slug in character.projects || []" :key="slug" class="channel-chip">
              {{ channelName(slug) }}
              <span v-if="character.channel_profiles?.[slug]?.speech?.voiceId" class="voice-dot" title="Channel voice saved">voice</span>
            </span>
          </div>
        </div>
      </article>
    </div>

    <div v-if="editorOpen" class="editor-backdrop" @click.self="closeEditor">
      <form class="character-editor" @submit.prevent="saveCharacter">
        <header class="editor-header">
          <div>
            <span class="workspace-section-eyebrow">{{ editing ? 'Edit shared record' : 'Create shared record' }}</span>
            <h2>{{ editing ? editing.name : 'New channel character' }}</h2>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" @click="closeEditor">Close</button>
        </header>

        <div class="editor-scroll">
          <section class="editor-section">
            <div class="section-number">01</div>
            <div class="section-body">
              <h3>Identity</h3>
              <div class="field-grid">
                <label class="form-group">
                  <span>Name *</span>
                  <input v-model.trim="draft.name" class="input" placeholder="Aria the Knight" />
                </label>
                <label class="form-group">
                  <span>Role</span>
                  <select v-model="draft.archetype" class="select">
                    <option value="">Recurring character</option>
                    <option>protagonist</option><option>antagonist</option><option>mentor</option>
                    <option>narrator</option><option>supporting</option><option>mascot</option>
                  </select>
                </label>
              </div>
              <label class="form-group">
                <span>Description *</span>
                <small>Concrete appearance and personality details flow into every script and visual prompt.</small>
                <textarea v-model.trim="draft.description" class="input" rows="5" />
              </label>
              <label class="form-group">
                <span>Reference image</span>
                <small>Stored with the shared character and reused by every assigned channel.</small>
                <input class="input file-input" type="file" accept="image/*" @change="onReferencePicked" />
              </label>
              <div v-if="editing?.references?.images?.length" class="reference-strip">
                <div v-for="filename in editing.references.images" :key="filename" class="reference-card">
                  <img :src="referenceUrl(editing, filename)" :alt="filename" />
                  <button type="button" class="btn btn-sm btn-secondary" :disabled="describingFrom === filename" @click="describeFromImage(filename)">
                    {{ describingFrom === filename ? 'Describing…' : 'Describe image' }}
                  </button>
                </div>
              </div>
              <div v-if="editing?.references?.images?.length" class="vision-control">
                <label>Vision model</label>
                <ModelMenu
                  v-model="visionModel"
                  :options="visionModelMenuOptions"
                  media-type="llm"
                  title="Character vision model"
                  search-placeholder="Search vision models…"
                  :loading="visionModelsLoading"
                />
              </div>
            </div>
          </section>

          <section class="editor-section">
            <div class="section-number">02</div>
            <div class="section-body">
              <h3>Channel labels</h3>
              <p class="section-help">Select every channel where this character should appear. This controls availability; it does not make copies.</p>
              <div class="channel-options">
                <label v-for="channel in channels" :key="channel.slug" :class="['channel-option', { selected: selectedChannels.has(channel.slug) }]">
                  <input type="checkbox" :checked="selectedChannels.has(channel.slug)" @change="toggleChannel(channel.slug)" />
                  <span><strong>{{ channel.name }}</strong><small>{{ channel.slug }}</small></span>
                </label>
              </div>
            </div>
          </section>

          <section v-if="selectedChannels.size" class="editor-section">
            <div class="section-number">03</div>
            <div class="section-body">
              <h3>Channel voice profiles</h3>
              <p class="section-help">Each channel may use a different provider, saved voice, and delivery note for this same character.</p>
              <div class="voice-profile-list">
                <div v-for="slug in [...selectedChannels]" :key="slug" class="voice-profile-card">
                  <div class="voice-profile-title">
                    <div><strong>{{ channelName(slug) }}</strong><span>{{ slug }}</span></div>
                    <span :class="['profile-state', { ready: profileFor(slug).voiceId }]">{{ profileFor(slug).voiceId ? 'Voice set' : 'Uses default' }}</span>
                  </div>
                  <div class="voice-fields">
                    <label class="form-group">
                      <span>Provider</span>
                      <select v-model="profileFor(slug).voiceProvider" class="select">
                        <option value="">Project default</option>
                        <option value="elevenlabs">ElevenLabs</option>
                        <option value="fishaudio">Fish Audio</option>
                        <option value="genaipro">GenAIPro</option>
                        <option value="fal">fal.ai</option>
                        <option value="voicestudio">Voice Studio</option>
                        <option value="macos">macOS voices</option>
                      </select>
                    </label>
                    <label class="form-group voice-picker-field">
                      <span>Voice</span>
                      <VoicePicker
                        :model-value="profileFor(slug).voiceId || null"
                        :project-slug="slug"
                        :custom-voices="channelConfigs[slug]?.voice_presets || []"
                        :custom-voices-loaded="!!channelConfigs[slug]"
                        :audio-model-provider="profileFor(slug).voiceProvider || ''"
                        :audio-model-id="voiceModelId(profileFor(slug).voiceProvider)"
                        default-label="Use channel default"
                        @update:model-value="profileFor(slug).voiceId = $event || undefined"
                      />
                    </label>
                  </div>
                  <label class="form-group">
                    <span>Delivery note</span>
                    <input v-model.trim="profileFor(slug).tonation" class="input" placeholder="soft, slow, reassuring" />
                  </label>
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer class="editor-footer">
          <button v-if="editing" type="button" class="btn btn-danger" @click="deleteCharacter">Delete character</button>
          <span class="editor-spacer" />
          <button type="button" class="btn btn-secondary" @click="closeEditor">Cancel</button>
          <button class="btn btn-primary" :disabled="saving || !canSave">{{ saving ? 'Saving…' : 'Save character' }}</button>
        </footer>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Character, CharacterSpeech } from '../composables/useCharacters.js'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Channel Characters')

const route = useRoute()
const router = useRouter()
const cl = useCharacterLibrary()
const { get, post } = useApi()
const { ask } = useConfirm()
const { success, error: showError } = useToast()

const characters = ref<Character[]>([])
const channels = ref<Array<{ slug: string; name: string }>>([])
const channelConfigs = reactive<Record<string, any>>({})
const loading = ref(false)
const loadError = ref('')
const search = ref('')
const channelFilter = ref(typeof route.query.channel === 'string' ? route.query.channel : '')

const filteredCharacters = computed(() => {
  const q = search.value.trim().toLowerCase()
  return characters.value.filter(character => {
    if (channelFilter.value === '__unassigned' && character.projects?.length) return false
    if (channelFilter.value && channelFilter.value !== '__unassigned' && !character.projects?.includes(channelFilter.value)) return false
    return !q || `${character.name} ${character.archetype || ''} ${character.description}`.toLowerCase().includes(q)
  })
})

watch(channelFilter, value => {
  const query = { ...route.query }
  if (value) query.channel = value
  else delete query.channel
  void router.replace({ query })
})

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const [records, projects] = await Promise.all([
      cl.list(),
      get<Array<{ slug: string; name: string }>>('/projects'),
    ])
    characters.value = records
    channels.value = projects
  } catch (e: any) {
    loadError.value = e?.data?.detail || e?.message || 'Unknown loading error'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const editorOpen = ref(false)
const editing = ref<Character | null>(null)
const saving = ref(false)
const draft = reactive({ name: '', archetype: '', description: '' })
const selectedChannels = ref(new Set<string>())
const voiceProfiles = reactive<Record<string, CharacterSpeech>>({})
const pendingReference = ref<File | null>(null)
const canSave = computed(() => !!draft.name.trim() && !!draft.description.trim())

function resetEditor() {
  draft.name = ''
  draft.archetype = ''
  draft.description = ''
  selectedChannels.value = new Set()
  for (const key of Object.keys(voiceProfiles)) delete voiceProfiles[key]
  pendingReference.value = null
}

function openCreate() {
  resetEditor()
  editing.value = null
  if (channelFilter.value && channelFilter.value !== '__unassigned') toggleChannel(channelFilter.value)
  editorOpen.value = true
}

function openEdit(character: Character) {
  resetEditor()
  editing.value = character
  draft.name = character.name
  draft.archetype = character.archetype || ''
  draft.description = character.description
  selectedChannels.value = new Set(character.projects || [])
  for (const slug of selectedChannels.value) {
    voiceProfiles[slug] = { ...(character.channel_profiles?.[slug]?.speech || {}) }
    void loadChannelConfig(slug)
  }
  editorOpen.value = true
  void loadVisionCaps()
}

function closeEditor() {
  editorOpen.value = false
  editing.value = null
  resetEditor()
}

function toggleChannel(slug: string) {
  const next = new Set(selectedChannels.value)
  if (next.has(slug)) {
    next.delete(slug)
    delete voiceProfiles[slug]
  } else {
    next.add(slug)
    voiceProfiles[slug] ||= {}
    void loadChannelConfig(slug)
  }
  selectedChannels.value = next
}

function profileFor(slug: string): CharacterSpeech {
  return (voiceProfiles[slug] ||= {})
}

async function loadChannelConfig(slug: string) {
  if (channelConfigs[slug]) return
  try { channelConfigs[slug] = await get<any>(`/projects/${encodeURIComponent(slug)}/settings/config`) }
  catch { channelConfigs[slug] = {} }
}

function voiceModelId(provider?: string): string {
  if (provider === 'voicestudio') return 'voicestudio-qwen3-tts'
  if (provider === 'macos') return 'macos-say'
  return provider || ''
}

async function saveCharacter() {
  if (!canSave.value) return
  saving.value = true
  try {
    const profiles: NonNullable<Character['channel_profiles']> = {}
    for (const slug of selectedChannels.value) {
      const speech = voiceProfiles[slug]
      if (speech && Object.values(speech).some(Boolean)) profiles[slug] = { speech: { ...speech } }
    }
    const payload: Partial<Character> & Pick<Character, 'name' | 'description'> = {
      name: draft.name.trim(),
      archetype: draft.archetype || undefined,
      description: draft.description.trim(),
      projects: [...selectedChannels.value],
      channel_profiles: profiles,
      scope: 'project',
    }
    let saved = editing.value
      ? await cl.update(editing.value.id, payload)
      : await cl.create(payload)
    if (pendingReference.value) {
      await cl.uploadReferenceImage(saved.id, pendingReference.value)
      saved = await cl.getOne(saved.id)
    }
    const index = characters.value.findIndex(character => character.id === saved.id)
    if (index >= 0) characters.value.splice(index, 1, saved)
    else characters.value.unshift(saved)
    success(`Saved "${saved.name}"`)
    closeEditor()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Character could not be saved')
  } finally {
    saving.value = false
  }
}

async function deleteCharacter() {
  if (!editing.value) return
  const target = editing.value
  const ok = await ask({
    title: `Delete "${target.name}"?`,
    body: `This removes the shared character from every assigned channel. Existing rendered files remain, but future scripts and generation cannot resolve it.`,
    confirmLabel: 'Delete character',
    danger: true,
  })
  if (!ok) return
  try {
    await cl.remove(target.id)
    characters.value = characters.value.filter(character => character.id !== target.id)
    success(`Deleted "${target.name}"`)
    closeEditor()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}

function onReferencePicked(event: Event) {
  pendingReference.value = (event.target as HTMLInputElement).files?.[0] || null
}

function channelName(slug: string): string {
  return channels.value.find(channel => channel.slug === slug)?.name || slug
}

function firstReference(character: Character): string | undefined {
  return character.references?.images?.[0]
}

function referenceUrl(character: Character, filename: string): string {
  return `/api/character-library/${encodeURIComponent(character.id)}/reference-image/${encodeURIComponent(filename)}`
}

interface VisionModelOption { id: string; provider: string; has_key: boolean; label: string }
const visionModel = ref(typeof localStorage !== 'undefined' ? localStorage.getItem('storyStudio:visionModel') || '' : '')
const visionModelsLoading = ref(false)
const visionModelOptions = ref<VisionModelOption[]>([])
const describingFrom = ref<string | null>(null)
const visionChannelSlug = computed(() => [...selectedChannels.value][0] || (channelFilter.value !== '__unassigned' ? channelFilter.value : '') || channels.value[0]?.slug || '')
const visionModelMenuOptions = computed(() => [
  { id: '', label: 'Auto-pick an available vision model', group: 'Automatic', meta: 'Uses an available provider configured on this Mac.' },
  ...visionModelOptions.value.map(model => ({
    id: model.id,
    label: model.label || model.id,
    group: model.provider || 'Vision models',
    provider: model.provider,
    disabled: !model.has_key,
    disabledReason: model.has_key ? undefined : 'No API key configured for this provider.',
  })),
])

async function loadVisionCaps() {
  if (!visionChannelSlug.value || visionModelsLoading.value) return
  visionModelsLoading.value = true
  try {
    const caps = await get<{ models: VisionModelOption[] }>(`/projects/${encodeURIComponent(visionChannelSlug.value)}/vision/caps`)
    visionModelOptions.value = caps.models || []
    if (visionModel.value && !visionModelOptions.value.some(model => model.id === visionModel.value && model.has_key)) visionModel.value = ''
  } catch { visionModelOptions.value = [] }
  finally { visionModelsLoading.value = false }
}

watch(visionModel, value => {
  if (typeof localStorage === 'undefined') return
  if (value) localStorage.setItem('storyStudio:visionModel', value)
  else localStorage.removeItem('storyStudio:visionModel')
})

async function describeFromImage(filename: string) {
  if (!editing.value || !visionChannelSlug.value || describingFrom.value) return
  if (draft.description.trim()) {
    const ok = await ask({
      title: 'Replace the current description?',
      body: 'Vision analysis replaces the description in this editor. Nothing is permanent until you save the character.',
      confirmLabel: 'Replace description',
    })
    if (!ok) return
  }
  describingFrom.value = filename
  try {
    const result = await post<{ description: string; model_used: string }>(
      `/projects/${encodeURIComponent(visionChannelSlug.value)}/characters/${encodeURIComponent(editing.value.id)}/describe-from-image`,
      { filename, ...(visionModel.value ? { model: visionModel.value } : {}) },
    )
    draft.description = result.description
    success(`Description created with ${result.model_used}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Image description failed')
  } finally { describingFrom.value = null }
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'
}
</script>

<style scoped>
.channel-characters-page { display: flex; flex-direction: column; gap: 18px; }
.roster-toolbar { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(220px, .45fr) auto; gap: 12px; align-items: center; }
.roster-count { min-width: 74px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 10px; text-align: center; background: var(--bg-secondary); }
.roster-count strong, .roster-count span { display: block; }.roster-count span { color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; }
.character-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(390px, 1fr)); gap: 14px; }
.character-tile { display: grid; grid-template-columns: 122px 1fr; min-height: 190px; overflow: hidden; border: 1px solid var(--border); border-radius: 16px; background: linear-gradient(145deg, var(--bg-secondary), var(--bg-primary)); box-shadow: 0 14px 35px rgba(0,0,0,.12); }
.portrait { border: 0; border-right: 1px solid var(--border); background: radial-gradient(circle at 30% 20%, rgba(245,193,88,.24), transparent 45%), #111722; color: var(--accent); font: 700 34px Georgia, serif; cursor: pointer; overflow: hidden; }
.portrait img { width: 100%; height: 100%; object-fit: cover; }.character-copy { padding: 18px; min-width: 0; }
.character-heading { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }.character-heading h2 { margin: 3px 0 0; font-size: 19px; }
.character-kicker { color: var(--accent); font-size: 10px; text-transform: uppercase; letter-spacing: .12em; }.character-copy p { color: var(--text-muted); line-height: 1.55; font-size: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.channel-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }.channel-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(245,193,88,.3); border-radius: 999px; padding: 4px 8px; font-size: 10px; color: var(--text); background: rgba(245,193,88,.07); }.channel-chip.is-muted { color: var(--text-muted); border-color: var(--border); }.voice-dot { color: #63d995; font-size: 8px; text-transform: uppercase; letter-spacing: .08em; }
.editor-backdrop { position: fixed; inset: 0; z-index: 300; padding: 28px; display: flex; align-items: center; justify-content: center; background: rgba(3,6,12,.78); backdrop-filter: blur(10px); }
.character-editor { width: min(980px, 100%); max-height: calc(100vh - 56px); display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 18px; overflow: hidden; background: var(--bg-primary); box-shadow: 0 30px 90px rgba(0,0,0,.5); }
.editor-header, .editor-footer { display: flex; align-items: center; gap: 10px; padding: 18px 22px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); }.editor-header { justify-content: space-between; }.editor-header h2 { margin: 3px 0 0; }.editor-footer { border-top: 1px solid var(--border); border-bottom: 0; }.editor-spacer { flex: 1; }
.editor-scroll { overflow-y: auto; padding: 4px 22px 22px; }.editor-section { display: grid; grid-template-columns: 46px 1fr; gap: 14px; padding: 24px 0; border-bottom: 1px solid var(--border); }.editor-section:last-child { border-bottom: 0; }.section-number { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; color: var(--accent); background: rgba(245,193,88,.11); font: 700 11px monospace; }.section-body h3 { margin: 3px 0 5px; }.section-help, .form-group small { color: var(--text-muted); font-size: 11px; line-height: 1.5; }.field-grid, .voice-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.form-group { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; font-size: 12px; }.file-input { padding: 8px; }
.channel-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; margin-top: 14px; }.channel-option { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; background: var(--bg-secondary); }.channel-option.selected { border-color: var(--accent); background: rgba(245,193,88,.08); }.channel-option span, .channel-option small { display: block; }.channel-option small { color: var(--text-muted); margin-top: 2px; }
.voice-profile-list { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }.voice-profile-card { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }.voice-profile-title { display: flex; justify-content: space-between; gap: 10px; }.voice-profile-title div span { display: block; color: var(--text-muted); font-size: 10px; margin-top: 2px; }.profile-state { color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .09em; }.profile-state.ready { color: #63d995; }.voice-picker-field :deep(.voice-picker) { width: 100%; }.reference-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }.reference-card { display: flex; flex-direction: column; gap: 6px; }.reference-strip img { width: 100px; height: 100px; object-fit: cover; border-radius: 10px; border: 1px solid var(--border); }.vision-control { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 10px; align-items: center; margin-top: 12px; }.vision-control label { font-size: 12px; color: var(--text-muted); }
@media (max-width: 760px) { .roster-toolbar, .field-grid, .voice-fields { grid-template-columns: 1fr; }.character-grid { grid-template-columns: 1fr; }.character-tile { grid-template-columns: 90px 1fr; }.editor-backdrop { padding: 8px; }.editor-section { grid-template-columns: 1fr; } }
</style>
