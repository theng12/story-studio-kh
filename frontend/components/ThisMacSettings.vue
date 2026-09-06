<template>
  <div class="this-mac-settings">
    <header>
      <h3>{{ sectionTitle }}</h3>
      <p>{{ sectionDescription }}</p>
    </header>

    <!-- v1.4.28 — the two queues that can stampede. App-wide, not
         per-channel: they describe how much work this app takes on at once. -->
    <section v-if="section === 'all' || section === 'performance'" class="panel concurrency">
      <div>
        <span class="eyebrow">Throughput</span>
        <h4>How much runs at once</h4>
        <p class="hint">
          Every number here was fixed in the program until it appeared on this screen. Raise them when
          there is spare capacity; lower them if work starts getting refused.
        </p>
      </div>

      <div v-if="concurrencyLoaded" class="concurrency-fields">
        <label v-for="field in throughputFields" :key="field.key">
          <span>{{ field.label }}</span>
          <select :value="presetValueFor(field)" @change="onPreset(field, $event)">
            <option v-for="choice in field.choices" :key="String(choice.value)" :value="String(choice.value)">
              {{ choice.label }}
            </option>
            <option value="__custom">Custom…</option>
          </select>
          <input
            v-if="customFields[field.key]"
            :value="String(models[field.key])"
            class="custom-value"
            :aria-label="`Custom value for ${field.label}`"
            type="number"
            :min="field.input.min"
            :max="field.input.max"
            :step="field.input.step"
            @input="onCustom(field, $event)"
          />
          <small>{{ field.help }}</small>
        </label>
      </div>

      <p v-if="concurrencyError" class="error-box">{{ concurrencyError }}</p>
      <p v-if="concurrencySaved" class="saved-box">{{ concurrencySaved }}</p>

      <div class="concurrency-actions">
        <button class="btn btn-sm btn-primary" type="button" :disabled="concurrencySaving" @click="saveConcurrency">
          {{ concurrencySaving ? 'Saving…' : 'Save' }}
        </button>
        <button class="btn btn-sm" type="button" :disabled="concurrencySaving" @click="restoreDefaults">
          Use recommended
        </button>
      </div>
    </section>

    <section v-if="section === 'all' || section === 'performance'" class="panel paid-image-replacement">
      <div>
        <h4>Automatically buy one replacement for a confirmed failed image</h4>
        <p>
          Off by default. Story Studio reconnects to the original GenStudio task first. After GenStudio confirms that task failed,
          Story Studio waits 30 minutes, checks the image is still missing, refreshes the exact current price, and may buy one
          replacement within your per-Story-job credit limit. Time alone never proves a task stopped.
        </p>
      </div>
      <label class="paid-image-replacement-choice">
        <span>Automatic replacement</span>
        <select name="paid-image-replacement-enabled" :value="paidImageReplacementLoaded ? (paidImageReplacementEnabled ? 'true' : 'false') : '__unknown'" :disabled="!paidImageReplacementLoaded || paidImageReplacementSaving" @change="setPaidImageReplacementEnabled">
          <option v-if="!paidImageReplacementLoaded" value="__unknown" disabled>{{ paidImageReplacementResult ? 'Saved state unavailable' : 'Loading saved setting…' }}</option>
          <option value="false">Off</option>
          <option value="true">On</option>
        </select>
      </label>
      <label v-if="paidImageReplacementEnabled" class="paid-image-replacement-ceiling">
        <span>Maximum additional credits per Story job</span>
        <input
          v-model="paidImageReplacementCeiling"
          name="paid-image-replacement-ceiling"
          type="number"
          min="1"
          step="1"
          required
          inputmode="numeric"
          :disabled="!paidImageReplacementLoaded || paidImageReplacementSaving"
          aria-describedby="paid-image-replacement-limits"
        />
      </label>
      <p id="paid-image-replacement-limits" class="hint">30-minute wait · Maximum 1 replacement per image</p>
      <p v-if="!paidImageReplacementLoaded && !paidImageReplacementResult" class="hint" aria-live="polite">Loading saved paid image replacement setting…</p>
      <p v-if="paidImageReplacementResult" :class="['result', paidImageReplacementResult.kind]" aria-live="polite">{{ paidImageReplacementResult.message }}</p>
      <div class="paid-image-replacement-actions">
        <button class="btn btn-sm btn-primary" type="button" :disabled="!paidImageReplacementLoaded || paidImageReplacementSaving" @click="savePaidImageReplacement">
          {{ paidImageReplacementSaving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </section>

    <section v-if="section === 'all' || section === 'performance'" class="panel paid-subtitle-replacement">
      <div>
        <h4>Automatically buy one replacement for a confirmed failed subtitle section</h4>
        <p>
          Off by default. Story Studio always reconnects to accepted transcription tasks and retries safe download or stitch work for free.
          Only after GenStudio confirms an eligible failed section may it buy one replacement, within this separate per-Story-job subtitle credit limit.
        </p>
      </div>
      <label class="paid-subtitle-replacement-choice">
        <span>Automatic replacement</span>
        <select name="paid-subtitle-replacement-enabled" :value="paidSubtitleReplacementLoaded ? (paidSubtitleReplacementEnabled ? 'true' : 'false') : '__unknown'" :disabled="!paidSubtitleReplacementLoaded || paidSubtitleReplacementSaving" @change="setPaidSubtitleReplacementEnabled">
          <option v-if="!paidSubtitleReplacementLoaded" value="__unknown" disabled>{{ paidSubtitleReplacementResult ? 'Saved state unavailable' : 'Loading saved setting…' }}</option>
          <option value="false">Off</option>
          <option value="true">On</option>
        </select>
      </label>
      <label v-if="paidSubtitleReplacementEnabled" class="paid-subtitle-replacement-ceiling">
        <span>Maximum additional credits per Story job</span>
        <input
          v-model="paidSubtitleReplacementCeiling"
          name="paid-subtitle-replacement-ceiling"
          type="number"
          min="1"
          step="1"
          required
          inputmode="numeric"
          :disabled="!paidSubtitleReplacementLoaded || paidSubtitleReplacementSaving"
          aria-describedby="paid-subtitle-replacement-limits"
        />
      </label>
      <p id="paid-subtitle-replacement-limits" class="hint">Maximum 1 replacement per confirmed failed subtitle section</p>
      <p v-if="!paidSubtitleReplacementLoaded && !paidSubtitleReplacementResult" class="hint" aria-live="polite">Loading saved paid subtitle replacement setting…</p>
      <p v-if="paidSubtitleReplacementResult" :class="['result', paidSubtitleReplacementResult.kind]" aria-live="polite">{{ paidSubtitleReplacementResult.message }}</p>
      <div class="paid-subtitle-replacement-actions">
        <button class="btn btn-sm btn-primary" type="button" :disabled="!paidSubtitleReplacementLoaded || paidSubtitleReplacementSaving" @click="savePaidSubtitleReplacement">
          {{ paidSubtitleReplacementSaving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </section>

    <section v-if="section === 'all' || section === 'appearance'" class="panel appearance">
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

    <section v-if="section === 'all' || section === 'appearance'" class="panel"><ServerModeSettingsPanel /></section>

    <!-- v1.4.12 — one switch for the whole app. "about the emojis. i think to
         make sure we don't generate emojis when we don't have to. it's
         unprofessional" — plus his standing rule that a choice like this is
         his to change later, not a constant in the code. -->
    <section v-if="section === 'all' || section === 'appearance'" class="panel emoji-policy">
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
          @change="saveEmoji(($event.target as HTMLInputElement).checked)"
        />
        <span>Let generated text use emoji</span>
      </label>
      <p v-if="emojiResult" :class="['result', emojiResult.kind]">{{ emojiResult.message }}</p>
    </section>

    <section v-if="section === 'all' || section === 'connections'" class="panel connection">
      <div class="connection-copy">
        <span class="eyebrow">Sole AI boundary</span>
        <h4>GenStudio KH</h4>
        <p>
          Required scopes: <code>models:read</code>, <code>voices:read</code>, <code>voices:use</code>,
          <code>tts:generate</code>, <code>audio:transcribe</code>, <code>images:generate</code>,
          <code>chat:generate</code>, <code>videos:generate</code>, <code>music:generate</code>,
          <code>usage:read</code>, <code>content:read</code>, and <code>content:purchase</code>.
        </p>
      </div>

      <div class="fields">
        <label for="genstudio-url">Base URL</label>
        <div class="field-row">
          <input id="genstudio-url" v-model="url" class="input" type="url" autocomplete="url" spellcheck="false" />
          <button class="btn btn-secondary btn-sm" :disabled="busy === 'url'" @click="saveUrl">{{ busy === 'url' ? 'Saving…' : 'Save URL' }}</button>
        </div>

        <label for="genstudio-key">GenStudio API key</label>
        <div class="field-row">
          <input id="genstudio-key" v-model="keyDraft" class="input" type="password" placeholder="gsk_…" autocomplete="off" spellcheck="false" />
          <button class="btn btn-primary btn-sm" :disabled="busy !== '' || !keyDraft.trim()" @click="saveKey">{{ busy === 'save' ? 'Saving…' : 'Save key' }}</button>
          <button class="btn btn-secondary btn-sm" :disabled="busy !== '' || (!keyDraft.trim() && !savedKey?.hasKey)" @click="testKey">{{ busy === 'test' ? 'Testing…' : 'Test scopes' }}</button>
          <button v-if="savedKey?.hasKey" class="btn btn-ghost btn-sm" :disabled="busy !== ''" @click="removeKey">Remove</button>
        </div>
        <p v-if="savedKey?.hasKey && !keyDraft" class="masked">Saved key: {{ savedKey.keyMasked || '••••' }}</p>
        <p v-else-if="!savedKey?.hasKey" class="masked">No key saved.</p>
        <p v-if="result" :class="['result', result.kind]">{{ result.message }}</p>
        <dl v-if="result?.contentStore" class="scope-results" aria-label="Content Store scope test result">
          <div>
            <dt><code>content:read</code></dt>
            <dd :data-state="result.contentStore.readScope">{{ result.contentStore.readScope === 'verified' ? 'Read scope verified' : 'Read scope not verified' }}</dd>
          </div>
          <div>
            <dt><code>content:purchase</code></dt>
            <dd>Purchase scope required · not safely testable without buying</dd>
          </div>
        </dl>
        <p v-else class="scope-guidance">
          Content Store key tests can verify <code>content:read</code>. The required <code>content:purchase</code>
          scope is not safely testable without an explicit real purchase.
        </p>
      </div>
    </section>

    <p v-if="section === 'all' || section === 'connections'" class="security-note">The key remains masked after save and is stored only in this Mac’s restricted app-secrets file.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
type ThisMacSection = 'all' | 'connections' | 'performance' | 'appearance'
const props = withDefaults(defineProps<{ section?: ThisMacSection }>(), { section: 'all' })
const section = computed(() => props.section)
const sectionTitle = computed(() => ({
  all: 'App settings',
  connections: 'GenStudio connection',
  performance: 'Performance & recovery',
  appearance: 'Appearance & app behavior',
}[section.value]))
const sectionDescription = computed(() => ({
  all: 'Settings stored on this Mac and shared by every project.',
  connections: 'One GenStudio URL and API key serve every AI catalog, job, and credit event on this Mac. The key may be all-access or scoped.',
  performance: 'Control local staging and the explicit recovery choices used after confirmed failures.',
  appearance: 'Choose how Story Studio looks, listens on the network, and writes generated text.',
}[section.value]))
type ThemeChoice = 'light' | 'dark' | 'system'
interface ProviderRow { providerId: string; hasKey: boolean; keyMasked: string }
interface ContentStoreProbe { read_scope: 'verified'; purchase_scope: 'required_unverified' }
interface EmojiSetting { allow_emoji_in_generated_text: boolean }
interface PaidImageReplacementSetting { enabled: boolean; additional_credit_ceiling: number | null }

const { get, put, del, post } = useApi()
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
const paidImageReplacementEnabled = ref(false)
const paidImageReplacementCeiling = ref('')
const paidImageReplacementLoaded = ref(false)
const paidImageReplacementSaving = ref(false)
const paidImageReplacementResult = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
const paidSubtitleReplacementEnabled = ref(false)
const paidSubtitleReplacementCeiling = ref('')
const paidSubtitleReplacementLoaded = ref(false)
const paidSubtitleReplacementSaving = ref(false)
const paidSubtitleReplacementResult = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
const result = ref<{
  kind: 'ok' | 'warn' | 'err'
  message: string
  contentStore?: { readScope: 'verified'; purchaseScope: 'required_unverified' }
} | null>(null)

async function load(): Promise<void> {
  const [settings, keys] = await Promise.all([
    get<{ url: string; default_url: string }>('/app-settings/genstudio'),
    get<{ providers: ProviderRow[] }>('/app-settings/api-keys'),
  ])
  url.value = settings.url
  defaultUrl.value = settings.default_url
  savedKey.value = keys.providers.find(row => row.providerId === 'genstudio') || null
  try {
    const paidImageReplacement = await get<PaidImageReplacementSetting>('/app-settings/paid-image-replacement')
    if (!isPaidImageReplacementSetting(paidImageReplacement)) throw new Error('Saved setting was invalid.')
    applyPaidImageReplacementSetting(paidImageReplacement)
    paidImageReplacementLoaded.value = true
  } catch {
    paidImageReplacementResult.value = { kind: 'err', message: 'Could not load the paid image replacement setting. It remains unavailable until its saved state is confirmed.' }
  }
  try {
    const paidSubtitleReplacement = await get<PaidImageReplacementSetting>('/app-settings/paid-subtitle-replacement')
    if (!isPaidImageReplacementSetting(paidSubtitleReplacement)) throw new Error('Saved setting was invalid.')
    applyPaidSubtitleReplacementSetting(paidSubtitleReplacement)
    paidSubtitleReplacementLoaded.value = true
  } catch {
    paidSubtitleReplacementResult.value = { kind: 'err', message: 'Could not load the paid subtitle replacement setting. It remains unavailable until its saved state is confirmed.' }
  }
  // Best-effort: the emoji switch must never be what stops this panel loading.
  try {
    const emoji = await get<EmojiSetting>('/app-settings/emoji')
    allowEmoji.value = emoji.allow_emoji_in_generated_text
  } catch { /* leave it at the stated default */ }
}

function isPaidImageReplacementSetting(setting: PaidImageReplacementSetting): boolean {
  return typeof setting.enabled === 'boolean'
    && (setting.enabled
      ? Number.isSafeInteger(setting.additional_credit_ceiling) && setting.additional_credit_ceiling > 0
      : setting.additional_credit_ceiling === null)
}

function applyPaidImageReplacementSetting(setting: PaidImageReplacementSetting): void {
  paidImageReplacementEnabled.value = setting.enabled
  paidImageReplacementCeiling.value = setting.enabled ? String(setting.additional_credit_ceiling) : ''
}

function setPaidImageReplacementEnabled(event: Event): void {
  paidImageReplacementEnabled.value = (event.target as HTMLSelectElement).value === 'true'
  paidImageReplacementResult.value = null
}

function paidImageReplacementCeilingValue(): number | null {
  const value = Number(paidImageReplacementCeiling.value)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

async function savePaidImageReplacement(): Promise<void> {
  if (!paidImageReplacementLoaded.value) return
  const ceiling = paidImageReplacementCeilingValue()
  paidImageReplacementResult.value = null
  if (paidImageReplacementEnabled.value && ceiling === null) {
    paidImageReplacementResult.value = { kind: 'err', message: 'Enter a positive whole number of additional credits.' }
    return
  }
  paidImageReplacementSaving.value = true
  try {
    const saved = await put<PaidImageReplacementSetting>('/app-settings/paid-image-replacement', {
      enabled: paidImageReplacementEnabled.value,
      additional_credit_ceiling: paidImageReplacementEnabled.value ? ceiling : null,
    })
    if (!isPaidImageReplacementSetting(saved)) throw new Error('The saved setting was invalid.')
    applyPaidImageReplacementSetting(saved)
    paidImageReplacementResult.value = { kind: 'ok', message: 'Paid image replacement setting saved.' }
  } catch (error: any) {
    paidImageReplacementResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save that.' }
  } finally {
    paidImageReplacementSaving.value = false
  }
}

function applyPaidSubtitleReplacementSetting(setting: PaidImageReplacementSetting): void {
  paidSubtitleReplacementEnabled.value = setting.enabled
  paidSubtitleReplacementCeiling.value = setting.enabled ? String(setting.additional_credit_ceiling) : ''
}

function setPaidSubtitleReplacementEnabled(event: Event): void {
  paidSubtitleReplacementEnabled.value = (event.target as HTMLSelectElement).value === 'true'
  paidSubtitleReplacementResult.value = null
}

function paidSubtitleReplacementCeilingValue(): number | null {
  const value = Number(paidSubtitleReplacementCeiling.value)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

async function savePaidSubtitleReplacement(): Promise<void> {
  if (!paidSubtitleReplacementLoaded.value) return
  const ceiling = paidSubtitleReplacementCeilingValue()
  paidSubtitleReplacementResult.value = null
  if (paidSubtitleReplacementEnabled.value && ceiling === null) {
    paidSubtitleReplacementResult.value = { kind: 'err', message: 'Enter a positive whole number of additional credits.' }
    return
  }
  paidSubtitleReplacementSaving.value = true
  try {
    const saved = await put<PaidImageReplacementSetting>('/app-settings/paid-subtitle-replacement', {
      enabled: paidSubtitleReplacementEnabled.value,
      additional_credit_ceiling: paidSubtitleReplacementEnabled.value ? ceiling : null,
    })
    if (!isPaidImageReplacementSetting(saved)) throw new Error('The saved setting was invalid.')
    applyPaidSubtitleReplacementSetting(saved)
    paidSubtitleReplacementResult.value = { kind: 'ok', message: 'Paid subtitle replacement setting saved.' }
  } catch (error: any) {
    paidSubtitleReplacementResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save that.' }
  } finally {
    paidSubtitleReplacementSaving.value = false
  }
}

async function saveEmoji(checked: boolean): Promise<void> {
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
    allowEmoji.value = !checked
    emojiResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save that.' }
  } finally { emojiBusy.value = false }
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
    result.value = { kind: 'ok', message: 'GenStudio key saved and masked.' }
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
      : { kind: response.reachable ? 'warn' : 'err', message: response.message || 'GenStudio rejected the key.' }
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Scope test failed.' }
  } finally { busy.value = '' }
}

async function removeKey(): Promise<void> {
  if (!await ask({ title: 'Remove GenStudio key?', message: 'All AI generation will remain unavailable until a GenStudio key is saved.', confirmLabel: 'Remove key', danger: true })) return
  busy.value = 'remove'; result.value = null
  try {
    await del('/app-settings/api-keys/genstudio')
    await load()
    result.value = { kind: 'ok', message: 'GenStudio key removed.' }
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not remove the key.' }
  } finally { busy.value = '' }
}

// v1.4.28 — the two throughput numbers, finally reachable.
//
// Both became settings (1.4.23, 1.4.27) and neither had a screen: they lived in
// app-settings.json, read once at boot, with no route and no control. The owner
// asked where to change them and the answer was nowhere. A number moved out of
// the code into a file he cannot reach is half a fix.
const concurrencyLoaded = ref(false)
const concurrencySaving = ref(false)
const concurrencyError = ref('')
/** What was ACTUALLY applied, echoed back from the route. */
const concurrencySaved = ref('')

/**
 * v1.4.42 — every throughput number is a pick-list with a Custom escape.
 *
 * THE OWNER, on the first version: "i changed and saved. no update or feedback
 * and also there's no dropdown for the auto so i won't know to use auto."
 *
 * Both were real. The save was silent — it discarded the route's response, so a
 * value the server clamped looked exactly like one it accepted. And "auto" was
 * a magic word you had to be told existed; a bare text box cannot teach it.
 *
 * The recommendations carry the reasoning that is otherwise only in a commit
 * message: which number caused the flood and which left local capacity idle.
 */
interface ThroughputChoice { value: string | number; label: string }
interface ThroughputField {
  key: 'subtitleEpisodes' | 'llmJobs' | 'imageEpisodes' | 'thumbnailEpisodes' | 'imageFanout'
    | 'outlineHeadroom' | 'languageTimeoutMinutes' | 'languageFloorTps' | 'languagePreferredTps'
  label: string
  help: string
  choices: ThroughputChoice[]
  input: { min: number; max: number; step: number }
}

const models = reactive<Record<ThroughputField['key'], string | number>>({
  subtitleEpisodes: 2,
  llmJobs: 8,
  imageEpisodes: 2,
  imageFanout: 'auto',
  thumbnailEpisodes: 3,
  outlineHeadroom: 2,
  languageTimeoutMinutes: 30,
  languageFloorTps: 25,
  languagePreferredTps: 50,
})

// This is selection state, not a derived property of the numeric value: a
// user who chooses Custom while their current value is a named preset still
// expects to edit that value.
const customFields = reactive<Record<ThroughputField['key'], boolean>>({
  subtitleEpisodes: false,
  llmJobs: false,
  imageEpisodes: false,
  thumbnailEpisodes: false,
  imageFanout: false,
  outlineHeadroom: false,
  languageTimeoutMinutes: false,
  languageFloorTps: false,
  languagePreferredTps: false,
})

const throughputFields: ThroughputField[] = [
  {
    key: 'subtitleEpisodes',
    label: 'Episodes transcribing at once',
    help: 'Each episode still transcribes all its chapters together — this is how many EPISODES '
      + 'start at the same time. Thirty at once overwhelmed the available capacity and lost a third of the work.',
    choices: [
      { value: 1, label: '1 — one at a time' },
      { value: 2, label: '2 — recommended' },
      { value: 3, label: '3' },
      { value: 5, label: '5 — plenty of capacity' },
      { value: 10, label: '10 — aggressive' },
    ],
    input: { min: 1, max: 50, step: 1 },
  },
  {
    key: 'llmJobs',
    label: 'Writing jobs at once',
    help: 'Ideas, research, outlines, chapters, metadata, image prompts and scene plans share this. '
      + 'This is a local staging preference; GenStudio still admits each request from your live account limits.',
    choices: [
      { value: 4, label: '4 — cautious' },
      { value: 8, label: '8 — recommended' },
      { value: 12, label: '12 — higher local preset' },
      { value: 20, label: '20' },
    ],
    input: { min: 1, max: 50, step: 1 },
  },
  {
    key: 'imageEpisodes',
    label: 'Episodes making scene images at once',
    help: 'Scene Review and Image Pool share this — the work that runs on locally hosted models. '
      + 'Thumbnails have their own number below, so a few cloud thumbnails can never hold up '
      + 'this queue.',
    choices: [
      { value: 1, label: '1 — one at a time' },
      { value: 2, label: '2 — recommended' },
      { value: 3, label: '3' },
      { value: 5, label: '5 — plenty of capacity' },
      { value: 8, label: '8' },
      { value: 12, label: '12 — aggressive' },
    ],
    input: { min: 1, max: 50, step: 1 },
  },
  {
    key: 'thumbnailEpisodes',
    label: 'Episodes making thumbnails at once',
    help: 'Separate from scene images because thumbnails usually run on a cloud model while '
      + 'Scene Review runs on a locally hosted one. They no longer compete: raising this cannot '
      + 'slow that queue down, and a thumbnail batch cannot stall it.',
    choices: [
      { value: 1, label: '1 — one at a time' },
      { value: 3, label: '3 — recommended' },
      { value: 5, label: '5' },
      { value: 8, label: '8 — a lot of cloud calls at once' },
    ],
    input: { min: 1, max: 50, step: 1 },
  },
  {
    key: 'imageFanout',
    label: 'Cloud requests per episode at once',
    help: 'Covers image fan-out inside ONE episode, including Scene Review and thumbnails. Auto '
      + 'follows the keyed GenStudio burst publication, so it rises by itself as your capacity '
      + 'grows. A number is a local staging preference; GenStudio still owns remote admission. '
      + 'Other cloud generation types keep their own live capacity.',
    choices: [
      { value: 'auto', label: 'Auto — follows your account (recommended)' },
      { value: 25, label: '25 — gentle' },
      { value: 50, label: '50 — the old fixed value' },
      { value: 100, label: '100' },
      { value: 200, label: '200' },
    ],
    input: { min: 1, max: 500, step: 1 },
  },
  {
    key: 'outlineHeadroom',
    label: 'Extra chapters allowed',
    help: 'How far past the target an outline may go. A longer outline is kept — more runtime — and '
      + 'it is never allowed to come back SHORT.',
    choices: [
      { value: 1, label: '1 — exactly the target' },
      { value: 1.5, label: '1.5×' },
      { value: 2, label: '2× — recommended' },
      { value: 3, label: '3×' },
    ],
    input: { min: 1, max: 10, step: 0.1 },
  },
  {
    key: 'languageTimeoutMinutes',
    label: 'How long one writing request may run',
    help: 'A big scene-plan batch or a long chapter is written while the request is still open, so '
      + 'this is how long the app waits before giving up on it. Longer is safer — a request cut off '
      + 'part-way is still charged for, and the writing is lost — but a genuinely stuck request '
      + 'takes this long to notice. Anything from 5 to 240 minutes.',
    choices: [
      { value: 10, label: '10 minutes — small batches only' },
      { value: 20, label: '20 minutes — what it used to be' },
      { value: 30, label: '30 minutes — recommended' },
      { value: 45, label: '45 minutes' },
      { value: 60, label: '60 minutes — very large batches' },
    ],
    input: { min: 5, max: 240, step: 1 },
  },
  {
    key: 'languageFloorTps',
    label: 'Slowest provider speed you accept',
    help: 'In tokens a second. Nothing is refused or rerouted because of this — it is only used to '
      + 'warn you, on the Scene Plan page, when a batch looks too big to come back in time even from '
      + 'the slowest provider you would accept.',
    choices: [
      { value: 10, label: '10 tok/s — very cautious warnings' },
      { value: 25, label: '25 tok/s — recommended' },
      { value: 50, label: '50 tok/s — warn unless it is fast' },
      { value: 100, label: '100 tok/s' },
    ],
    input: { min: 1, max: 10_000, step: 0.1 },
  },
  {
    key: 'languagePreferredTps',
    label: 'Provider speed you prefer',
    help: 'Also tokens a second, and also only used in that warning: it is the speed the message '
      + 'says most providers actually manage, so you can see how much of the worry is worst case.',
    choices: [
      { value: 25, label: '25 tok/s' },
      { value: 50, label: '50 tok/s — recommended' },
      { value: 100, label: '100 tok/s' },
      { value: 200, label: '200 tok/s' },
    ],
    input: { min: 1, max: 10_000, step: 0.1 },
  },
]

/** The select shows a preset when the value matches one, otherwise "Custom…". */
function presetValueFor(field: ThroughputField): string {
  if (customFields[field.key]) return '__custom'
  const current = String(models[field.key])
  return field.choices.some(c => String(c.value) === current) ? current : '__custom'
}

function onPreset(field: ThroughputField, event: Event) {
  const chosen = (event.target as HTMLSelectElement).value
  concurrencySaved.value = ''
  if (chosen === '__custom') {
    // Seed the custom box with what is showing, so switching to Custom never
    // blanks a value the owner has to retype.
    models[field.key] = field.key === 'imageFanout' && models[field.key] === 'auto'
      ? 128 : models[field.key]
    customFields[field.key] = true
    return
  }
  customFields[field.key] = false
  models[field.key] = chosen === 'auto' ? 'auto' : Number(chosen)
}

function onCustom(field: ThroughputField, event: Event) {
  const raw = (event.target as HTMLInputElement).value.trim()
  concurrencySaved.value = ''
  models[field.key] = field.key === 'imageFanout' && raw.toLowerCase() === 'auto'
    ? 'auto' : (raw === '' ? '' : Number(raw))
}

function restoreDefaults() {
  models.subtitleEpisodes = 2
  models.llmJobs = 8
  models.imageEpisodes = 2
  models.imageFanout = 'auto'
  models.thumbnailEpisodes = 3
  models.outlineHeadroom = 2
  models.languageTimeoutMinutes = 30
  models.languageFloorTps = 25
  models.languagePreferredTps = 50
  for (const field of throughputFields) customFields[field.key] = false
  concurrencySaved.value = ''
}

async function loadConcurrency() {
  try {
    const r: any = await get('/app-settings/concurrency')
    models.subtitleEpisodes = r?.subtitle_episode_concurrency ?? 2
    models.llmJobs = r?.llm_concurrency ?? 8
    models.imageEpisodes = r?.image_episode_concurrency ?? 2
    models.imageFanout = r?.image_fanout_per_episode ?? 'auto'
    models.thumbnailEpisodes = r?.thumbnail_episode_concurrency ?? 3
    models.outlineHeadroom = r?.outline_chapter_headroom ?? 2
    models.languageTimeoutMinutes = r?.genstudio_language_timeout_minutes ?? 30
    models.languageFloorTps = r?.language_floor_tokens_per_second ?? 25
    models.languagePreferredTps = r?.language_preferred_tokens_per_second ?? 50
    for (const field of throughputFields) {
      customFields[field.key] = !field.choices.some(choice => String(choice.value) === String(models[field.key]))
    }
  } catch { /* an unreachable setting must not break the whole page */ }
  concurrencyLoaded.value = true
}

async function saveConcurrency() {
  concurrencySaving.value = true
  concurrencyError.value = ''
  concurrencySaved.value = ''
  try {
    const applied: any = await put('/app-settings/concurrency', {
      subtitle_episode_concurrency: Number(models.subtitleEpisodes),
      llm_concurrency: Number(models.llmJobs),
      image_episode_concurrency: Number(models.imageEpisodes),
      image_fanout_per_episode: models.imageFanout === 'auto' ? 'auto' : Number(models.imageFanout),
      thumbnail_episode_concurrency: Number(models.thumbnailEpisodes),
      outline_chapter_headroom: Number(models.outlineHeadroom),
      genstudio_language_timeout_minutes: Number(models.languageTimeoutMinutes),
      language_floor_tokens_per_second: Number(models.languageFloorTps),
      language_preferred_tokens_per_second: Number(models.languagePreferredTps),
    })
    // Show what was ACTUALLY applied, not what was typed. The server clamps,
    // and a clamped value that looks accepted is a lie the owner acts on.
    if (applied?.subtitle_episode_concurrency !== undefined) models.subtitleEpisodes = applied.subtitle_episode_concurrency
    if (applied?.llm_concurrency !== undefined) models.llmJobs = applied.llm_concurrency
    if (applied?.image_episode_concurrency !== undefined) models.imageEpisodes = applied.image_episode_concurrency
    if (applied?.image_fanout_per_episode !== undefined) models.imageFanout = applied.image_fanout_per_episode
    if (applied?.thumbnail_episode_concurrency !== undefined) models.thumbnailEpisodes = applied.thumbnail_episode_concurrency
    if (applied?.outline_chapter_headroom !== undefined) models.outlineHeadroom = applied.outline_chapter_headroom
    if (applied?.genstudio_language_timeout_minutes !== undefined) {
      models.languageTimeoutMinutes = applied.genstudio_language_timeout_minutes
    }
    if (applied?.language_floor_tokens_per_second !== undefined) {
      models.languageFloorTps = applied.language_floor_tokens_per_second
    }
    if (applied?.language_preferred_tokens_per_second !== undefined) {
      models.languagePreferredTps = applied.language_preferred_tokens_per_second
    }
    for (const field of throughputFields) customFields[field.key] = false
    concurrencySaved.value = `Saved and already in effect: ${models.imageEpisodes} image episode(s) at once, `
      + `${models.imageFanout === 'auto' ? 'auto' : models.imageFanout} images per episode, `
      + `${models.subtitleEpisodes} transcribing, ${models.llmJobs} writing, `
      + `${models.languageTimeoutMinutes} minutes per writing request.`
  } catch (e: any) {
    concurrencyError.value = e?.data?.detail || e?.message || 'Could not save'
  } finally {
    concurrencySaving.value = false
  }
}

onMounted(() => { void load(); void loadConcurrency() })
</script>

<style scoped>
/* v1.4.28 — the throughput panel. */
.concurrency-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: 12px; }
.concurrency-fields label { display: flex; flex-direction: column; gap: 4px; }
.concurrency-fields label > span { font-size: 13px; opacity: 0.85; }
.concurrency-fields label > small { opacity: 0.6; line-height: 1.4; }
.concurrency-actions { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.paid-image-replacement { display: grid; gap: 10px; }
.paid-image-replacement-choice, .paid-image-replacement-ceiling { display: grid; gap: 4px; max-width: 360px; }
.paid-image-replacement-choice > span, .paid-image-replacement-ceiling > span { font-size: 13px; color: var(--text-secondary); }
.paid-image-replacement-actions { display: flex; gap: 12px; }
.paid-subtitle-replacement { display: grid; gap: 10px; }
.paid-subtitle-replacement-choice, .paid-subtitle-replacement-ceiling { display: grid; gap: 4px; max-width: 360px; }
.paid-subtitle-replacement-choice > span, .paid-subtitle-replacement-ceiling > span { font-size: 13px; color: var(--text-secondary); }
.paid-subtitle-replacement-actions { display: flex; gap: 12px; }

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
.field-row { display: flex; gap: 7px; }
.field-row .input { min-width: 0; flex: 1; }
.masked, .security-note { color: var(--text-muted); font-size: var(--font-xs); }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }
.scope-results { display: grid; gap: 6px; margin-top: 5px; }
.scope-results div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.scope-results dt, .scope-results dd { font-size: var(--font-xs); }
.scope-results dd { color: var(--text-secondary); text-align: right; }
.scope-results dd[data-state='verified'] { color: var(--success); }
.scope-guidance { padding-top: 5px; }
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

.concurrency-fields select { width: 100%; }
.custom-value { width: 100%; margin-top: 6px; }
.saved-box {
  margin-top: 8px; padding: 8px 12px; border-radius: 4px; font-size: 13px;
  background: rgba(80, 160, 120, .14); color: #3f8f68;
}
</style>
