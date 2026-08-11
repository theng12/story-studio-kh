<template>
  <div class="this-mac-settings">
    <header>
      <span class="eyebrow">This Mac</span>
      <h3>App &amp; GenStudio connection</h3>
      <p>Story Studio uses one GenStudio API URL and one scoped key for every AI catalog, job, and credit event.</p>
    </header>

    <section class="panel appearance">
      <div>
        <span class="eyebrow">Display</span>
        <h4>Appearance</h4>
      </div>
      <div class="theme-picker">
        <button v-for="choice in themeChoices" :key="choice" type="button" :class="{ active: themeMode === choice }" @click="setTheme(choice)">
          {{ choice }}
        </button>
      </div>
    </section>

    <section class="panel"><ServerModeSettingsPanel /></section>

    <section class="panel connection">
      <div class="connection-copy">
        <span class="eyebrow">Sole AI boundary</span>
        <h4>GenStudio KH</h4>
        <p>
          Required scopes: <code>models:read</code>, <code>voices:read</code>, <code>voices:use</code>,
          <code>tts:generate</code>, <code>audio:transcribe</code>, <code>images:generate</code>,
          <code>chat:generate</code>, <code>videos:generate</code>, <code>music:generate</code>,
          and <code>usage:read</code>.
        </p>
      </div>

      <div class="fields">
        <label for="genstudio-url">Base URL</label>
        <div class="field-row">
          <input id="genstudio-url" v-model="url" class="input" type="url" autocomplete="url" spellcheck="false" />
          <button class="btn btn-secondary btn-sm" :disabled="busy === 'url'" @click="saveUrl">{{ busy === 'url' ? 'Saving…' : 'Save URL' }}</button>
        </div>

        <label for="genstudio-key">Scoped API key</label>
        <div class="field-row">
          <input id="genstudio-key" v-model="keyDraft" class="input" type="password" placeholder="gsk_…" autocomplete="off" spellcheck="false" />
          <button class="btn btn-primary btn-sm" :disabled="busy !== '' || !keyDraft.trim()" @click="saveKey">{{ busy === 'save' ? 'Saving…' : 'Save key' }}</button>
          <button class="btn btn-secondary btn-sm" :disabled="busy !== '' || (!keyDraft.trim() && !savedKey?.hasKey)" @click="testKey">{{ busy === 'test' ? 'Testing…' : 'Test scopes' }}</button>
          <button v-if="savedKey?.hasKey" class="btn btn-ghost btn-sm" :disabled="busy !== ''" @click="removeKey">Remove</button>
        </div>
        <p v-if="savedKey?.hasKey && !keyDraft" class="masked">Saved key: {{ savedKey.keyMasked || '••••' }}</p>
        <p v-else-if="!savedKey?.hasKey" class="masked">No key saved.</p>
        <p v-if="result" :class="['result', result.kind]">{{ result.message }}</p>
      </div>
    </section>

    <p class="security-note">The key remains masked after save and is stored only in this Mac’s restricted app-secrets file.</p>
  </div>
</template>

<script setup lang="ts">
type ThemeChoice = 'light' | 'dark' | 'system'
interface ProviderRow { providerId: string; hasKey: boolean; keyMasked: string }

const { get, put, del, post } = useApi()
const { ask } = useConfirm()
const { mode: themeMode, setMode: setTheme } = useTheme()
const themeChoices: ThemeChoice[] = ['light', 'dark', 'system']
const url = ref('')
const defaultUrl = ref('')
const keyDraft = ref('')
const savedKey = ref<ProviderRow | null>(null)
const busy = ref<'' | 'url' | 'save' | 'test' | 'remove'>('')
const result = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)

async function load(): Promise<void> {
  const [settings, keys] = await Promise.all([
    get<{ url: string; default_url: string }>('/app-settings/genstudio'),
    get<{ providers: ProviderRow[] }>('/app-settings/api-keys'),
  ])
  url.value = settings.url
  defaultUrl.value = settings.default_url
  savedKey.value = keys.providers.find(row => row.providerId === 'genstudio') || null
}

async function saveUrl(): Promise<void> {
  busy.value = 'url'; result.value = null
  try {
    const saved = await put<{ url: string; default_url: string }>('/app-settings/genstudio', { url: url.value.trim() })
    url.value = saved.url
    defaultUrl.value = saved.default_url
    result.value = { kind: 'ok', message: 'GenStudio base URL saved.' }
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save the URL.' }
  } finally { busy.value = '' }
}

async function saveKey(): Promise<void> {
  const apiKey = keyDraft.value.trim()
  if (!apiKey) return
  busy.value = 'save'; result.value = null
  try {
    await put('/app-settings/api-keys/genstudio', { apiKey })
    keyDraft.value = ''
    await load()
    result.value = { kind: 'ok', message: 'Scoped GenStudio key saved and masked.' }
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save the key.' }
  } finally { busy.value = '' }
}

async function testKey(): Promise<void> {
  busy.value = 'test'; result.value = null
  try {
    const response = await post<{ valid: boolean; reachable: boolean; message?: string; warning?: string | null }>(
      '/app-settings/api-keys/genstudio/test', keyDraft.value.trim() ? { apiKey: keyDraft.value.trim() } : {},
    )
    result.value = response.valid
      ? { kind: response.warning ? 'warn' : 'ok', message: [response.message, response.warning].filter(Boolean).join(' ') }
      : { kind: response.reachable ? 'warn' : 'err', message: response.message || 'GenStudio rejected the key.' }
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Scope test failed.' }
  } finally { busy.value = '' }
}

async function removeKey(): Promise<void> {
  if (!await ask({ title: 'Remove GenStudio key?', message: 'All AI generation will remain unavailable until a scoped GenStudio key is saved.', confirmLabel: 'Remove key', danger: true })) return
  busy.value = 'remove'; result.value = null
  try {
    await del('/app-settings/api-keys/genstudio')
    await load()
    result.value = { kind: 'ok', message: 'GenStudio key removed.' }
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not remove the key.' }
  } finally { busy.value = '' }
}

onMounted(() => { void load() })
</script>

<style scoped>
.this-mac-settings {
  container-name: this-mac-settings;
  container-type: inline-size;
  display: grid;
  min-width: 0;
  gap: 14px;
}
header h3, .panel h4 { margin: 3px 0; }
header p, .panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.panel { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.appearance { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.theme-picker { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-tertiary); }
.theme-picker button { border: 0; border-radius: 6px; padding: 6px 11px; background: transparent; color: var(--text-secondary); text-transform: capitalize; cursor: pointer; }
.theme-picker button.active { background: var(--accent); color: var(--accent-on); }
.connection { display: grid; grid-template-columns: minmax(220px, .8fr) minmax(360px, 1.2fr); gap: 24px; }
.connection > * { min-width: 0; }
.fields { display: grid; gap: 7px; }
.fields label { margin-top: 4px; font-size: var(--font-xs); font-weight: 700; color: var(--text-secondary); }
.field-row { display: flex; gap: 7px; }
.field-row .input { min-width: 0; flex: 1; }
.masked, .security-note { color: var(--text-muted); font-size: var(--font-xs); }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }
.security-note { margin: 0; }
@container this-mac-settings (max-width: 760px) {
  .connection { grid-template-columns: 1fr; }
  .field-row { flex-wrap: wrap; }
}
@container this-mac-settings (max-width: 520px) {
  .appearance { align-items: stretch; flex-direction: column; }
  .theme-picker { align-self: flex-start; }
  .field-row .btn { flex: 1 1 auto; }
}
</style>
