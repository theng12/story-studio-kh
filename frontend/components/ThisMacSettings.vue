<template>
  <div class="this-mac-settings">
    <header v-if="!embedded">
      <h3>{{ sectionTitle }}</h3>
      <p>{{ sectionDescription }}</p>
    </header>

    <PerformanceSettings v-if="section === 'all' || section === 'performance'" />
    <!-- Optional, in-app duplicate screening (owner 2026-10-27). Lives with the
         other "this Mac" knobs because the model is installed once per Mac. -->
    <DuplicateScreeningSettings v-if="section === 'all' || section === 'performance'" />
    <CostSettings v-if="section === 'all' || section === 'performance'" />

    <section v-if="section === 'all' || section === 'appearance'" class="panel appearance" data-setting="theme">
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


    <!-- v1.4.12 — one switch for the whole app. "about the emojis. i think to
         make sure we don't generate emojis when we don't have to. it's
         unprofessional" — plus his standing rule that a choice like this is
         his to change later, not a constant in the code. -->
    <section v-if="section === 'all' || section === 'appearance'" class="panel emoji-policy" data-setting="emoji">
      <div>
        <span class="eyebrow">House style</span>
        <h4>Emoji in generated text</h4>
        <p>
          Titles, descriptions, tags and on-screen labels that Story Studio writes for you are
          kept free of emoji. Emoji you type yourself are never touched, and neither are the ones
          in Story Studio's own buttons and menus.
        </p>
      </div>
      <label class="emoji-toggle">
        <input
          type="checkbox"
          :checked="allowEmoji"
          :disabled="emojiBusy"
          @change="saveEmoji($event.target as HTMLInputElement)"
        />
        <span>Let generated text use emoji</span>
      </label>
      <p v-if="emojiResult" :class="['result', emojiResult.kind]">{{ emojiResult.message }}</p>
    </section>

    <AdvancedDisclosure v-if="!embedded && (section === 'all' || section === 'appearance')" label="Advanced: open Story Studio from another computer (Server Mode)" data-setting="server-mode">
      <section class="panel"><ServerModeSettingsPanel /></section>
    </AdvancedDisclosure>

    <section v-if="section === 'all' || section === 'connections'" class="panel connection" data-setting="gateway">
      <div class="connection-copy">
        <span class="eyebrow">Connection</span>
        <h4>Gateway</h4>
        <p>Your GatewayKH on this Mac or network — it runs your free local models, and every writing, voice, image, music, video and subtitle job goes through it.</p>
        <p class="gateway-live" :class="connection.tone" role="status">
          <span class="gateway-live-dot" aria-hidden="true" />
          <strong>{{ connection.label }}</strong>
          <button type="button" class="btn btn-ghost btn-sm" @click="refreshConnection">Check Now</button>
        </p>
        <p v-if="connection.hint" class="gateway-live-hint">{{ connection.hint }}</p>
      </div>

      <div class="fields">
        <label for="genstudio-url">Gateway address</label>
        <div class="field-row">
          <input id="genstudio-url" v-model="url" class="input" type="url" autocomplete="url" spellcheck="false" />
          <button class="btn btn-secondary btn-sm" :disabled="busy === 'url'" @click="saveUrl">{{ busy === 'url' ? 'Saving…' : 'Save URL' }}</button>
        </div>

        <label for="genstudio-key">Gateway API Key</label>
        <p class="masked">Copy it from Gateway → Settings → Gateway API Key and paste it here.</p>
        <div class="field-row">
          <input id="genstudio-key" v-model="keyDraft" class="input" type="password" placeholder="gsk_…" autocomplete="off" spellcheck="false" />
          <button class="btn btn-primary btn-sm" :disabled="busy !== '' || !keyDraft.trim()" @click="saveKey">{{ busy === 'save' ? 'Saving…' : 'Save Key' }}</button>
          <button class="btn btn-secondary btn-sm" :disabled="busy !== '' || (!keyDraft.trim() && !savedKey?.hasKey)" @click="testKey">{{ busy === 'test' ? 'Testing…' : 'Test Connection' }}</button>
          <button v-if="savedKey?.hasKey" class="btn btn-ghost btn-sm" :disabled="busy !== ''" @click="removeKey">Remove</button>
        </div>
        <p v-if="savedKey?.hasKey && !keyDraft" class="masked">Saved key: {{ savedKey.keyMasked || '••••' }}</p>
        <p v-else-if="!savedKey?.hasKey" class="masked">No key saved.</p>
        <p v-if="result" :class="['result', result.kind]">{{ result.message }}</p>
        <p v-if="result?.contentStore" class="masked">
          Studio Library: {{ result.contentStore.readScope === 'verified' ? 'can browse and install packs' : result.contentStore.readScope === 'not_connected' ? 'not connected on this Gateway (generation is unaffected)' : 'not confirmed' }}.
        </p>
      </div>
    </section>

    <p v-if="section === 'all' || section === 'connections'" class="security-note">The key stays hidden after saving and is kept only on this Mac.</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
type ThisMacSection = 'all' | 'connections' | 'performance' | 'appearance'
const props = withDefaults(defineProps<{ section?: ThisMacSection; embedded?: boolean }>(), { section: 'all', embedded: false })
const section = computed(() => props.section)
const sectionTitle = computed(() => ({
  all: 'App settings',
  connections: 'Gateway connection',
  performance: 'Performance & recovery',
  appearance: 'Appearance & notifications',
}[section.value]))
const sectionDescription = computed(() => ({
  all: 'Settings stored on this Mac and shared by every project.',
  connections: 'The Gateway address and key this Mac uses for every AI job.',
  performance: 'How much work runs at once, and whether a confirmed failure may buy one replacement.',
  appearance: 'How Story Studio looks and writes generated text.',
}[section.value]))
type ThemeChoice = 'light' | 'dark' | 'system'
interface ProviderRow { providerId: string; hasKey: boolean; keyMasked: string }
interface ContentStoreProbe { read_scope: 'verified' | 'not_connected'; purchase_scope: 'required_unverified' }
interface EmojiSetting { allow_emoji_in_generated_text: boolean }

const { get, put, del, post } = useApi()
const { connection, refresh: refreshConnection } = useConnectionStatus()
const { ask } = useConfirm()
const { mode: themeMode, setMode: setTheme } = useTheme()
const themeChoices: ThemeChoice[] = ['light', 'dark', 'system']
const url = ref('')
const defaultUrl = ref('')
const keyDraft = ref('')
const savedKey = ref<ProviderRow | null>(null)
const busy = ref<'' | 'url' | 'save' | 'test' | 'remove'>('')
const allowEmoji = ref(false)
const emojiBusy = ref(false)
const emojiResult = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
const result = ref<{
  kind: 'ok' | 'warn' | 'err'
  message: string
  contentStore?: { readScope: 'verified' | 'not_connected'; purchaseScope: 'required_unverified' }
} | null>(null)

async function load(): Promise<void> {
  // Each block loads on its own: one failed read used to stop every block below it, leaving the
  // emoji switch on its default for good.
  try {
    const [settings, keys] = await Promise.all([
      get<{ url: string; default_url: string }>('/app-settings/genstudio'),
      get<{ providers: ProviderRow[] }>('/app-settings/api-keys'),
    ])
    url.value = settings.url
    defaultUrl.value = settings.default_url
    savedKey.value = keys.providers.find(row => row.providerId === 'genstudio') || null
  } catch {
    result.value = { kind: 'err', message: 'Could not read the saved Gateway address and key. Close and reopen Settings to try again.' }
  }
  // Best-effort: the emoji switch must never be what stops this panel loading.
  try {
    const emoji = await get<EmojiSetting>('/app-settings/emoji')
    allowEmoji.value = emoji.allow_emoji_in_generated_text
  } catch { /* leave it at the stated default */ }
}

async function saveEmoji(box: HTMLInputElement): Promise<void> {
  const checked = box.checked
  emojiBusy.value = true; emojiResult.value = null
  try {
    const saved = await put<EmojiSetting>('/app-settings/emoji', { allow_emoji_in_generated_text: checked })
    allowEmoji.value = saved.allow_emoji_in_generated_text
    emojiResult.value = {
      kind: 'ok',
      message: saved.allow_emoji_in_generated_text
        ? 'Generated text may use emoji.'
        : 'Generated text will be kept free of emoji.',
    }
  } catch (error: any) {
    // Put the switch back where it really is, rather than leaving it showing a
    // setting that was never saved.
    // `allowEmoji` never changed, so Vue would not touch the box: set it back by hand.
    allowEmoji.value = !checked
    box.checked = !checked
    emojiResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save that.' }
  } finally { emojiBusy.value = false }
}

async function saveUrl(): Promise<void> {
  busy.value = 'url'; result.value = null
  try {
    const saved = await put<{ url: string; default_url: string }>('/app-settings/genstudio', { url: url.value.trim() })
    url.value = saved.url
    defaultUrl.value = saved.default_url
    result.value = { kind: 'ok', message: 'Gateway address saved.' }
    void refreshConnection()
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
    result.value = { kind: 'ok', message: 'Gateway API Key saved.' }
    // A failed re-read is not a failed save: it must not turn this into "Could not save the key."
    await load().catch(() => undefined)
    void refreshConnection()
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save the key.' }
  } finally { busy.value = '' }
}

async function testKey(): Promise<void> {
  busy.value = 'test'; result.value = null
  try {
    const response = await post<{
      valid: boolean
      reachable: boolean
      message?: string
      warning?: string | null
      content_store?: ContentStoreProbe
    }>(
      '/app-settings/api-keys/genstudio/test', keyDraft.value.trim() ? { apiKey: keyDraft.value.trim() } : {},
    )
    result.value = response.valid
      ? {
          kind: response.warning ? 'warn' : 'ok',
          message: [response.message, response.warning].filter(Boolean).join(' '),
          ...(response.content_store ? {
            contentStore: {
              readScope: response.content_store.read_scope,
              purchaseScope: response.content_store.purchase_scope,
            },
          } : {}),
        }
      : { kind: response.reachable ? 'warn' : 'err', message: response.message || 'The Gateway did not accept this key.' }
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Scope test failed.' }
  } finally { busy.value = '' }
}

async function removeKey(): Promise<void> {
  if (!await ask({ title: 'Remove the Gateway API Key?', message: 'Nothing can be generated until a Gateway API Key is saved again.', confirmLabel: 'Remove Key', danger: true })) return
  busy.value = 'remove'; result.value = null
  try {
    await del('/app-settings/api-keys/genstudio')
    result.value = { kind: 'ok', message: 'Gateway API Key removed.' }
    await load().catch(() => undefined)
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not remove the key.' }
  } finally { busy.value = '' }
}

onMounted(() => { void load() })
</script>

<style scoped>
.emoji-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
  cursor: pointer;
}
.emoji-toggle input { cursor: pointer; }

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
/* Wraps: the key box sits beside three buttons and was squeezed to ~100 px in a 760 px panel. */
.field-row { display: flex; flex-wrap: wrap; gap: 7px; }
.field-row .input { min-width: 220px; flex: 1 1 220px; }
.masked, .security-note { color: var(--text-muted); font-size: var(--font-xs); }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }
.gateway-live { display: flex; align-items: center; gap: 8px; margin-top: 10px !important; color: var(--text-primary) !important; }
.gateway-live-dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--text-muted); }
.gateway-live.online .gateway-live-dot { background: var(--success); }
.gateway-live.offline .gateway-live-dot { background: var(--error); }
.gateway-live.offline strong { color: var(--error); }
.gateway-live-hint { color: var(--text-secondary) !important; }
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
