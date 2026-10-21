<template>
  <section class="card settings-panel channel-profile" aria-labelledby="channel-profile-title">
    <header class="channel-profile-head">
      <h3 id="channel-profile-title">Channel profile</h3>
      <p>
        The logo, banner, name and handle this channel is known by. Stored on this Mac — nothing here is
        published to YouTube or anywhere else.
      </p>
    </header>

    <div v-if="loading" class="channel-profile-state" aria-live="polite">Loading channel profile…</div>
    <div v-else-if="loadError" class="channel-profile-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="load">Try again</button>
    </div>

    <template v-else>
      <div class="channel-preview">
        <div class="channel-preview-banner">
          <img v-if="bannerUrl" :src="bannerUrl" alt="" @error="markArtFailed(bannerUrl)" />
        </div>
        <div class="channel-preview-body">
          <span class="channel-preview-logo">
            <img v-if="logoUrl" :src="logoUrl" :alt="`${previewName} logo`" @error="markArtFailed(logoUrl)" />
            <span v-else class="channel-preview-initials" aria-hidden="true">{{ previewInitials }}</span>
          </span>
          <span class="channel-preview-copy">
            <strong>{{ previewName }}</strong>
            <span v-if="previewHandle" class="channel-preview-handle">{{ previewHandle }}</span>
            <span v-if="draft.description" class="channel-preview-description">{{ draft.description }}</span>
          </span>
        </div>
      </div>

      <div class="form-group">
        <label for="channel-profile-name">Channel name</label>
        <input
          id="channel-profile-name"
          v-model="draft.name"
          class="input"
          maxlength="200"
          autocomplete="off"
          :disabled="busy"
        />
        <small class="channel-profile-hint">
          The name the channel is shown under. Changing it never renames the channel folder or its episodes.
        </small>
      </div>

      <div class="form-group">
        <label for="channel-profile-handle">Handle</label>
        <input
          id="channel-profile-handle"
          v-model="draft.handle"
          class="input"
          maxlength="100"
          placeholder="@yourhandle"
          autocomplete="off"
          :disabled="busy"
        />
        <small class="channel-profile-hint">
          Optional. Letters, numbers and <code>.</code> <code>_</code> <code>-</code> — no spaces.
        </small>
      </div>

      <div class="form-group">
        <label for="channel-profile-description">Description</label>
        <textarea
          id="channel-profile-description"
          v-model="draft.description"
          class="textarea"
          rows="3"
          maxlength="10000"
          :disabled="busy"
        />
      </div>

      <div class="channel-profile-assets">
        <div class="channel-asset">
          <label class="channel-asset-label" for="channel-profile-logo-file">Logo</label>
          <input
            id="channel-profile-logo-file"
            class="input file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            :disabled="busy"
            @change="onFileChosen('logo', $event)"
          />
          <button
            v-if="profile?.logo_url"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            @click="removeAsset('logo')"
          >{{ removingKind === 'logo' ? 'Removing…' : 'Remove logo' }}</button>
        </div>

        <div class="channel-asset">
          <label class="channel-asset-label" for="channel-profile-banner-file">Banner</label>
          <input
            id="channel-profile-banner-file"
            class="input file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            :disabled="busy"
            @change="onFileChosen('banner', $event)"
          />
          <button
            v-if="profile?.banner_url"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            @click="removeAsset('banner')"
          >{{ removingKind === 'banner' ? 'Removing…' : 'Remove banner' }}</button>
        </div>
      </div>
      <p class="channel-profile-hint">PNG, JPEG or WebP, up to 5 MiB. Choosing a file replaces the current one.</p>

      <p v-if="uploadError" class="channel-profile-error" role="alert">{{ uploadError }}</p>
      <p v-if="saveError" class="channel-profile-error" role="alert">{{ saveError }}</p>

      <div class="channel-profile-actions">
        <button type="button" class="btn btn-primary" :disabled="busy || !dirty" @click="save">Save profile</button>
        <span class="channel-profile-status" aria-live="polite">{{ statusNote }}</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * Channel profile — logo, banner, name, handle, description.
 *
 * The panel owns the name: the backend writes the name it is given into
 * project.json, the app's one authoritative channel name, so no second rename
 * control exists elsewhere.
 *
 * Asset URLs are app-local paths ("/api/projects/<slug>/channel-profile/asset/
 * <kind>?v=<digest>") and go straight into <img src>. The app and its API share
 * one origin in both desktop and server mode.
 *
 * A project change replaces everything here (AGENTS.md §4), and every request
 * carries a generation so a stale answer can never land on the panel.
 */

interface ChannelProfile {
  name: string
  handle: string
  description: string
  logo_url: string | null
  banner_url: string | null
}

type AssetKind = 'logo' | 'banner'

const props = defineProps<{ slug: string }>()
const emit = defineEmits<{ (e: 'saved', profile: ChannelProfile): void }>()

const { get, post, put, del } = useApi()
const { success, error: showError } = useToast()

const profile = ref<ChannelProfile | null>(null)
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const uploadingKind = ref<AssetKind | null>(null)
const removingKind = ref<AssetKind | null>(null)
const uploadError = ref('')
const savedAt = ref(0)

const draft = reactive({ name: '', handle: '', description: '' })

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']
// Letters and numbers from any alphabet, plus . _ - . The server drops a
// leading "@"; the same shape is checked here so the mistake is caught first.
const HANDLE_PATTERN = /^[\p{L}\p{N}._-]+$/u

let loadSeq = 0
let writeSeq = 0

/**
 * @param text  true when the answer also carries the saved text — a text save
 *               replaces the drafts, an art-only answer must not (an unsaved
 *               edit is still the user's).
 */
function applyProfile(next: ChannelProfile, text: boolean): void {
  profile.value = next
  if (!text) return
  draft.name = next.name ?? ''
  draft.handle = next.handle ?? ''
  draft.description = next.description ?? ''
}

async function load(): Promise<void> {
  const request = ++loadSeq
  const target = props.slug
  profile.value = null
  draft.name = ''
  draft.handle = ''
  draft.description = ''
  loadError.value = ''
  saveError.value = ''
  uploadError.value = ''
  savedAt.value = 0
  if (!target) { loading.value = false; return }
  loading.value = true
  try {
    const next = await get<ChannelProfile>(`/projects/${target}/channel-profile`)
    if (request !== loadSeq) return
    applyProfile(next, true)
  } catch (e: any) {
    if (request !== loadSeq) return
    loadError.value = e?.data?.detail || 'Could not load the channel profile.'
  } finally {
    if (request === loadSeq) loading.value = false
  }
}

const busy = computed(() => saving.value || !!uploadingKind.value || !!removingKind.value)

const dirty = computed(() => {
  const current = profile.value
  if (!current) return false
  return draft.name !== (current.name ?? '')
    || draft.handle !== (current.handle ?? '')
    || draft.description !== (current.description ?? '')
})

const previewName = computed(() => draft.name.trim() || profile.value?.name || 'This channel')
const previewInitials = computed(() => {
  const name = previewName.value.trim() || 'SS'
  return name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || 'SS'
})
const previewHandle = computed(() => {
  const handle = draft.handle.trim()
  if (!handle) return ''
  return handle.startsWith('@') ? handle : `@${handle}`
})

/**
 * Art that cannot be shown — the file behind the reference is gone — must not
 * paint a broken-image icon. The failure is keyed by the URL, so a new piece
 * of art (a new digest) starts clean on its own.
 */
const failedArt = reactive<Record<string, boolean>>({})
function markArtFailed(url: string): void {
  failedArt[url] = true
}
const logoUrl = computed(() => {
  const url = profile.value?.logo_url
  return url && !failedArt[url] ? url : ''
})
const bannerUrl = computed(() => {
  const url = profile.value?.banner_url
  return url && !failedArt[url] ? url : ''
})

const statusNote = computed(() => {
  if (saving.value) return 'Saving…'
  if (uploadingKind.value) return 'Uploading image…'
  if (removingKind.value) return 'Removing image…'
  // Only while there is nothing left to save: an edit after a save must not
  // keep claiming the profile is saved.
  if (savedAt.value && !dirty.value) return 'Saved'
  return ''
})

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const idx = dataUrl.indexOf('base64,')
      resolve(idx >= 0 ? dataUrl.slice(idx + 'base64,'.length) : dataUrl)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

async function save(): Promise<void> {
  const target = props.slug
  const name = draft.name.trim()
  const handle = draft.handle.trim()
  const description = draft.description.trim()
  saveError.value = ''
  if (!name) {
    saveError.value = 'The channel needs a name.'
    return
  }
  if (name.length > 200) {
    saveError.value = 'The channel name must be 200 characters or fewer.'
    return
  }
  if (handle.length > 100) {
    saveError.value = 'The handle must be 100 characters or fewer.'
    return
  }
  if (handle && !HANDLE_PATTERN.test(handle.replace(/^@/, ''))) {
    saveError.value = 'A handle can use letters, numbers, . _ and - — no spaces.'
    return
  }
  if (description.length > 10000) {
    saveError.value = 'The description must be 10,000 characters or fewer.'
    return
  }
  const gen = ++writeSeq
  saving.value = true
  try {
    // Only the three writable fields. The asset URLs are read-only and the
    // server rejects a body carrying anything else.
    const saved = await put<ChannelProfile>(`/projects/${target}/channel-profile`, { name, handle, description })
    if (gen !== writeSeq || props.slug !== target) return
    applyProfile(saved, true)
    savedAt.value = Date.now()
    success('Channel profile saved')
    emit('saved', saved)
  } catch (e: any) {
    if (gen !== writeSeq || props.slug !== target) return
    saveError.value = e?.data?.detail || 'Could not save the channel profile.'
    showError(saveError.value)
  } finally {
    if (gen === writeSeq) saving.value = false
  }
}

async function onFileChosen(kind: AssetKind, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Clear the input so choosing the same file again still fires a change.
  try { input.value = '' } catch { /* not every environment lets a file input be cleared */ }
  if (!file) return
  const target = props.slug
  uploadError.value = ''
  if (!ACCEPTED_TYPES.includes(file.type)) {
    uploadError.value = 'Use a PNG, JPEG or WebP image.'
    showError(uploadError.value)
    return
  }
  if (file.size > MAX_IMAGE_BYTES) {
    uploadError.value = 'That image is larger than 5 MiB.'
    showError(uploadError.value)
    return
  }
  const gen = ++writeSeq
  uploadingKind.value = kind
  try {
    const data_base64 = await fileToBase64(file)
    if (gen !== writeSeq || props.slug !== target) return
    const saved = await post<ChannelProfile>(`/projects/${target}/channel-profile/${kind}`, {
      filename: file.name,
      data_base64,
    })
    if (gen !== writeSeq || props.slug !== target) return
    // Art only — an unsaved edit to the name or description is still the user's.
    applyProfile(saved, false)
    success(kind === 'logo' ? 'Channel logo updated' : 'Channel banner updated')
    emit('saved', saved)
  } catch (e: any) {
    if (gen !== writeSeq || props.slug !== target) return
    uploadError.value = e?.data?.detail || 'Could not upload that image.'
    showError(uploadError.value)
  } finally {
    if (gen === writeSeq) uploadingKind.value = null
  }
}

async function removeAsset(kind: AssetKind): Promise<void> {
  const target = props.slug
  uploadError.value = ''
  const gen = ++writeSeq
  removingKind.value = kind
  try {
    const saved = await del<ChannelProfile>(`/projects/${target}/channel-profile/${kind}`)
    if (gen !== writeSeq || props.slug !== target) return
    applyProfile(saved, false)
    success(kind === 'logo' ? 'Channel logo removed' : 'Channel banner removed')
    emit('saved', saved)
  } catch (e: any) {
    if (gen !== writeSeq || props.slug !== target) return
    uploadError.value = e?.data?.detail || 'Could not remove that image.'
    showError(uploadError.value)
  } finally {
    if (gen === writeSeq) removingKind.value = null
  }
}

watch(() => props.slug, () => {
  // A different channel is on screen: nothing of the last one may stand, and
  // any request still in flight for it is no longer current.
  writeSeq++
  saving.value = false
  uploadingKind.value = null
  removingKind.value = null
  void load()
}, { immediate: true })
</script>

<style scoped>
.channel-profile { display: flex; flex-direction: column; gap: 14px; }
.channel-profile-head h3 { margin: 0 0 4px; font-size: 18px; letter-spacing: -.015em; }
.channel-profile-head p { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.channel-profile-state { color: var(--text-secondary); font-size: 13px; }
.channel-profile-error {
  display: flex; align-items: center; gap: 10px; margin: 0; padding: 10px 12px; border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--error) 11%, transparent); color: var(--error); font-size: 13px;
}
.channel-profile-hint { color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.channel-profile-hint code { font-family: ui-monospace, monospace; }

.channel-preview {
  overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary);
}
.channel-preview-banner {
  height: 92px; background: var(--bg-tertiary, var(--bg-primary));
  background-image: linear-gradient(120deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 60%);
}
.channel-preview-banner img { width: 100%; height: 100%; display: block; object-fit: cover; }
.channel-preview-body { display: flex; align-items: flex-start; gap: 12px; padding: 0 16px 16px; }
.channel-preview-logo {
  display: grid; width: 56px; height: 56px; flex: 0 0 auto; place-items: center; overflow: hidden;
  margin-top: -20px; border: 2px solid var(--bg-secondary); border-radius: 14px;
  background: var(--accent-dim); color: var(--accent); font-weight: 800; letter-spacing: -.02em;
}
.channel-preview-logo img { width: 100%; height: 100%; object-fit: cover; }
.channel-preview-initials { font-size: 18px; }
.channel-preview-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; padding-top: 8px; }
.channel-preview-copy strong { overflow-wrap: anywhere; font-size: var(--font-xl); }
.channel-preview-handle { color: var(--text-secondary); font-size: var(--font-sm); }
.channel-preview-description {
  color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}

.channel-profile-assets { display: flex; flex-wrap: wrap; gap: 18px; }
.channel-asset { display: flex; min-width: 0; flex: 1 1 260px; flex-direction: column; gap: 6px; }
.channel-asset-label { color: var(--text-secondary); font-size: 12px; font-weight: 650; }
.channel-asset .file-input { padding: 8px; }
.channel-asset .btn { align-self: flex-start; }

.channel-profile-actions { display: flex; align-items: center; gap: 12px; }
.channel-profile-status { color: var(--text-secondary); font-size: 12px; }
</style>
