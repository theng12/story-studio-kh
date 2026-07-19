<template>
  <div class="this-mac-settings">
    <header class="tms-overview">
      <div>
        <span class="tms-eyebrow">This Mac</span>
        <h3>App &amp; connections</h3>
      </div>
      <p>
        Appearance, remote access, and provider keys stay on this machine.
        API keys are stored locally with restricted file permissions and never sync with projects.
      </p>
    </header>

    <nav class="tms-jump-nav" aria-label="App settings sections">
      <a href="#appearance-settings">Appearance</a>
      <a href="#server-mode-settings">Server mode</a>
      <a href="#genstudio-settings">GenStudio</a>
      <a href="#api-key-settings">API connections</a>
    </nav>

    <section id="appearance-settings" class="tms-section appearance-section">
      <div class="tms-section-copy">
        <span class="tms-section-kicker">Display</span>
        <h4>Appearance</h4>
        <p>System follows your Mac and changes automatically when macOS switches themes.</p>
      </div>
      <div class="theme-picker" role="radiogroup" aria-label="Theme">
        <button
          type="button"
          role="radio"
          :aria-checked="themeMode === 'light'"
          :class="['theme-option', { active: themeMode === 'light' }]"
          @click="setTheme('light')"
        >
          <span class="theme-glyph" aria-hidden="true">☀︎</span>
          <span class="theme-label">Light</span>
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="themeMode === 'dark'"
          :class="['theme-option', { active: themeMode === 'dark' }]"
          @click="setTheme('dark')"
        >
          <span class="theme-glyph" aria-hidden="true">☾</span>
          <span class="theme-label">Dark</span>
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="themeMode === 'system'"
          :class="['theme-option', { active: themeMode === 'system' }]"
          @click="setTheme('system')"
          :title="`System currently resolves to ${themeResolved}`"
        >
          <span class="theme-glyph" aria-hidden="true">⌘</span>
          <span class="theme-label">System</span>
          <span v-if="themeMode === 'system'" class="theme-resolved">
            → {{ themeResolved }}
          </span>
        </button>
      </div>
    </section>

    <section id="server-mode-settings" class="tms-section server-section">
      <ServerModeSettingsPanel />
    </section>

    <section id="genstudio-settings" class="tms-section genstudio-section">
      <div class="tms-section-copy">
        <span class="tms-section-kicker">Parallel migration</span>
        <h4>GenStudio KH API</h4>
        <p>
          Optional staged route for the GenStudio Qwen3 voices. It uses the GenStudio API key below;
          your existing direct Studio Hub and Voice Studio routes remain unchanged.
        </p>
      </div>
      <div class="genstudio-controls">
        <label class="sr-only" for="genstudio-api-url">GenStudio API URL</label>
        <input
          id="genstudio-api-url"
          v-model="genstudioUrl"
          class="input"
          type="url"
          placeholder="https://api.genstudiokh.com"
          autocomplete="url"
          spellcheck="false"
          @keyup.enter="saveGenStudioUrl"
        />
        <button class="btn btn-primary btn-sm" :disabled="genstudioSaving" @click="saveGenStudioUrl">
          {{ genstudioSaving ? 'Saving…' : 'Save URL' }}
        </button>
        <p v-if="genstudioResult" :class="['genstudio-result', genstudioResult.kind]">{{ genstudioResult.message }}</p>
        <p v-else class="genstudio-default">Default for local qualification: {{ genstudioDefaultUrl }}</p>
      </div>
    </section>

    <section id="api-key-settings" class="tms-section api-section">
      <header class="api-section-head">
        <div class="tms-section-copy">
          <span class="tms-section-kicker">Providers</span>
          <h4>API connections</h4>
          <p>One key per provider, shared by every project on this Mac.</p>
        </div>
        <span class="api-total">{{ configuredProviderCount }}/{{ API_PROVIDER_META.length }} configured</span>
      </header>

      <div class="provider-category-tabs" role="tablist" aria-label="API provider category">
        <button
          v-for="group in API_PROVIDER_GROUPS"
          :key="group.id"
          :id="`provider-tab-${group.id}`"
          type="button"
          role="tab"
          :aria-selected="activeProviderCategory === group.id"
          :aria-controls="`provider-panel-${group.id}`"
          :tabindex="activeProviderCategory === group.id ? 0 : -1"
          :class="['provider-category-tab', { active: activeProviderCategory === group.id }]"
          @click="activeProviderCategory = group.id"
          @keydown.left.prevent="selectAdjacentProviderCategory(group.id, -1)"
          @keydown.right.prevent="selectAdjacentProviderCategory(group.id, 1)"
        >
          <span>{{ group.label }}</span>
          <span class="provider-category-count">{{ configuredCountFor(group.id) }}/{{ providersFor(group.id).length }}</span>
        </button>
      </div>

      <div
        :id="`provider-panel-${activeProviderCategory}`"
        class="provider-category-panel"
        role="tabpanel"
        :aria-labelledby="`provider-tab-${activeProviderCategory}`"
      >
        <div class="provider-group-summary">
          <div>
            <strong>{{ activeProviderGroup.label }}</strong>
            <span>{{ activeProviderGroup.description }}</span>
          </div>
          <span>{{ providersFor(activeProviderCategory).length }} provider{{ providersFor(activeProviderCategory).length === 1 ? '' : 's' }}</span>
        </div>

        <div v-if="loading" class="text-muted modal-loading">Loading connections…</div>
        <div v-else class="provider-grid">
          <article
            v-for="p in providersFor(activeProviderCategory)"
            :key="p.id"
            :class="['provider-card', { configured: byId[p.id]?.hasKey }]"
          >
          <header class="provider-head">
            <div>
              <h5>{{ p.name }}</h5>
              <p v-if="p.helpText" class="provider-help">{{ p.helpText }}</p>
            </div>
            <span v-if="byId[p.id]?.hasKey" class="state-pill state-set">configured</span>
            <span v-else class="state-pill state-empty">not set</span>
          </header>

          <div class="provider-key-line">
          <input
            type="password"
            :placeholder="p.placeholder || 'sk-…'"
            v-model="drafts[p.id]"
            class="input input-key"
            autocomplete="off"
            spellcheck="false"
            @keyup.enter="onSave(p.id)"
          />
            <span v-if="byId[p.id]?.hasKey && !drafts[p.id]" class="current-key">
              Saved {{ byId[p.id]?.keyMasked || '••••' }}
            </span>
          </div>

          <div class="provider-actions">
          <button
            class="btn btn-primary btn-sm"
            :disabled="!!busy[p.id] || !drafts[p.id]?.trim()"
            @click="onSave(p.id)"
          >
            {{ busy[p.id] === 'saving' ? 'Saving…' : 'Save' }}
          </button>
          <button
            class="btn btn-secondary btn-sm"
            :disabled="!!busy[p.id] || (!drafts[p.id]?.trim() && !byId[p.id]?.hasKey)"
            :title="drafts[p.id]?.trim() ? 'Test the key in the input box (without saving)' : 'Test the currently-saved key'"
            @click="onTest(p.id)"
          >
            {{ busy[p.id] === 'testing' ? 'Testing…' : 'Test' }}
          </button>
          <button
            v-if="byId[p.id]?.hasKey"
            class="btn btn-ghost btn-sm"
            :disabled="!!busy[p.id]"
            title="Remove this provider's key from this Mac"
            @click="onClear(p.id)"
          >
            {{ busy[p.id] === 'clearing' ? 'Clearing…' : 'Remove' }}
          </button>
            <a
              v-if="p.affiliateUrl"
              :href="p.affiliateUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="affiliate-link"
            >Get key ↗</a>
          </div>

          <div v-if="results[p.id]" :class="['test-result', results[p.id]?.kind]">
            {{ results[p.id]?.message }}
          </div>
          </article>
        </div>
      </div>
    </section>

    <footer class="tms-security-note">
      <span aria-hidden="true">◇</span>
      <span>
        Keys are stored in <code>~/Library/Application Support/Story Studio KH/app-secrets.json</code>
        with mode 0600.
      </span>
    </footer>
  </div>
</template>

<script setup lang="ts">
/**
 * v1.0.185 (S2) — extracted from AppSettingsModal. Self-contained per-machine
 * settings: appearance, API keys, server mode. Owns its own data lifecycle —
 * loads the provider-key list on mount (works whether embedded in the page or
 * shown in the modal). No props; no modal coupling.
 */
import { ref, reactive, computed, onMounted } from 'vue'
import {
  API_PROVIDER_GROUPS,
  API_PROVIDER_META,
  apiProvidersFor,
  type ApiProviderCategory,
  type ApiProviderMeta,
} from '../utils/api-provider-groups'

const { get, put, del, post } = useApi()
const { ask } = useConfirm()
const { mode: themeMode, resolved: themeResolved, setMode: setTheme } = useTheme()

interface ProviderRow {
  providerId: string
  hasKey: boolean
  keyMasked: string
}

const loading = ref(false)
const providers = ref<ProviderRow[]>([])
const drafts = reactive<Record<string, string>>({})
const busy = reactive<Record<string, '' | 'saving' | 'testing' | 'clearing'>>({})
const results = reactive<Record<string, { kind: 'ok' | 'warn' | 'err'; message: string } | null>>({})
const activeProviderCategory = ref<ApiProviderCategory>('llm')
const genstudioUrl = ref('')
const genstudioDefaultUrl = ref('')
const genstudioSaving = ref(false)
const genstudioResult = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)

const byId = computed(() => {
  const out: Record<string, ProviderRow> = {}
  for (const r of providers.value) out[r.providerId] = r
  return out
})

const configuredProviderCount = computed(() => (
  API_PROVIDER_META.filter(provider => byId.value[provider.id]?.hasKey).length
))

const activeProviderGroup = computed(() => (
  API_PROVIDER_GROUPS.find(group => group.id === activeProviderCategory.value) || API_PROVIDER_GROUPS[0]
))

function providersFor(category: ApiProviderCategory): ApiProviderMeta[] {
  return apiProvidersFor(category)
}

function configuredCountFor(category: ApiProviderCategory): number {
  return providersFor(category).filter(provider => byId.value[provider.id]?.hasKey).length
}

function selectAdjacentProviderCategory(current: ApiProviderCategory, direction: -1 | 1): void {
  const index = API_PROVIDER_GROUPS.findIndex(group => group.id === current)
  const nextIndex = (index + direction + API_PROVIDER_GROUPS.length) % API_PROVIDER_GROUPS.length
  const nextCategory = API_PROVIDER_GROUPS[nextIndex].id
  activeProviderCategory.value = nextCategory
  requestAnimationFrame(() => document.getElementById(`provider-tab-${nextCategory}`)?.focus())
}

async function load() {
  loading.value = true
  try {
    const [res, genstudio] = await Promise.all([
      get<{ providers: ProviderRow[] }>('/app-settings/api-keys'),
      get<{ url: string; default_url: string }>('/app-settings/genstudio'),
    ])
    providers.value = res.providers
    genstudioUrl.value = genstudio.url
    genstudioDefaultUrl.value = genstudio.default_url
  } finally {
    loading.value = false
  }
}

async function saveGenStudioUrl() {
  genstudioSaving.value = true
  genstudioResult.value = null
  try {
    const result = await put<{ url: string; default_url: string }>('/app-settings/genstudio', {
      url: genstudioUrl.value.trim(),
    })
    genstudioUrl.value = result.url
    genstudioDefaultUrl.value = result.default_url
    genstudioResult.value = { kind: 'ok', message: 'GenStudio API URL saved.' }
  } catch (e: any) {
    genstudioResult.value = { kind: 'err', message: e?.data?.detail || e?.message || 'Could not save the GenStudio API URL.' }
  } finally {
    genstudioSaving.value = false
  }
}

onMounted(load)

async function onSave(providerId: string) {
  const apiKey = (drafts[providerId] || '').trim()
  if (!apiKey) return
  busy[providerId] = 'saving'
  results[providerId] = null
  try {
    await put(`/app-settings/api-keys/${providerId}`, { apiKey })
    drafts[providerId] = ''
    await load()
    results[providerId] = { kind: 'ok', message: 'Saved.' }
  } catch (e: any) {
    results[providerId] = { kind: 'err', message: e?.data?.detail || e?.message || 'Save failed' }
  } finally {
    busy[providerId] = ''
  }
}

async function onClear(providerId: string) {
  if (!await ask({ title: 'Remove API key?', message: `Remove the ${providerId} API key from this Mac? Generators using it will stop working.`, confirmLabel: 'Remove key', danger: true })) return
  busy[providerId] = 'clearing'
  results[providerId] = null
  try {
    await del(`/app-settings/api-keys/${providerId}`)
    await load()
    results[providerId] = { kind: 'ok', message: 'Cleared.' }
  } catch (e: any) {
    results[providerId] = { kind: 'err', message: e?.data?.detail || e?.message || 'Clear failed' }
  } finally {
    busy[providerId] = ''
  }
}

async function onTest(providerId: string) {
  const apiKey = (drafts[providerId] || '').trim()
  busy[providerId] = 'testing'
  results[providerId] = null
  try {
    const r = await post<{ valid: boolean; reachable: boolean; message?: string }>(
      `/app-settings/api-keys/${providerId}/test`,
      apiKey ? { apiKey } : {},
    )
    if (r.valid) {
      results[providerId] = { kind: 'ok', message: r.message || 'Key works.' }
    } else if (r.reachable) {
      results[providerId] = { kind: 'warn', message: r.message || 'Reached provider, but the key was rejected.' }
    } else {
      results[providerId] = { kind: 'err', message: r.message || 'Could not reach provider.' }
    }
  } catch (e: any) {
    results[providerId] = { kind: 'err', message: e?.data?.detail || e?.message || 'Test failed' }
  } finally {
    busy[providerId] = ''
  }
}
</script>

<style scoped>
.this-mac-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tms-overview {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(320px, 1.2fr);
  align-items: end;
  gap: 28px;
  padding: 4px 2px 10px;
}
.tms-overview h3 { margin: 2px 0 0; font-size: 20px; }
.tms-overview p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
}
.tms-eyebrow,
.tms-section-kicker {
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.tms-jump-nav {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-secondary) 94%, transparent);
  backdrop-filter: blur(12px);
}
.tms-jump-nav a {
  padding: 6px 11px;
  border-radius: 7px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
.tms-jump-nav a:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.tms-section {
  scroll-margin-top: 58px;
  padding: 15px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--bg-secondary) 96%, var(--accent) 4%), var(--bg-secondary));
}
.tms-section-copy h4 { margin: 2px 0 0; font-size: 15px; }
.tms-section-copy p { margin: 3px 0 0; color: var(--text-muted); font-size: 11.5px; line-height: 1.45; }
.modal-loading { padding: 34px 0; text-align: center; }

.appearance-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 72px;
}
.theme-picker {
  display: inline-flex;
  flex-shrink: 0;
  gap: 3px;
  padding: 3px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 9px;
}
.theme-option {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 11px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.theme-option:hover:not(.active) { background: var(--bg-hover); color: var(--text-primary); }
.theme-option.active { background: var(--accent); color: var(--accent-on); }
.theme-glyph { font-size: 13px; line-height: 1; }
.theme-resolved { font-size: 10px; opacity: 0.78; text-transform: capitalize; }

.server-section { padding: 16px; }
.genstudio-section {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(320px, 1.2fr);
  align-items: center;
  gap: 20px;
}
.genstudio-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.genstudio-result, .genstudio-default { grid-column: 1 / -1; margin: 0; font-size: 11px; }
.genstudio-default { color: var(--text-muted); }
.genstudio-result.ok { color: var(--success); }
.genstudio-result.err { color: var(--danger); }
.api-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.api-total {
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 999px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 700;
  white-space: nowrap;
}
.provider-category-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 5px;
  margin-top: 14px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-primary);
}
.provider-category-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  padding: 6px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
}
.provider-category-tab:hover { color: var(--text-primary); background: var(--bg-tertiary); }
.provider-category-tab.active { color: var(--accent-on); background: var(--accent); }
.provider-category-count {
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  font-size: 9.5px;
  line-height: 1.4;
}
.provider-group-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 11px 2px 9px;
  color: var(--text-muted);
  font-size: 10.5px;
}
.provider-group-summary > div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.provider-group-summary strong { color: var(--text-secondary); font-size: 11px; }
.provider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.provider-card {
  position: relative;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-primary);
}
.provider-card.configured { border-color: color-mix(in srgb, #22c55e 30%, var(--border)); }
.provider-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  min-height: 43px;
}
.provider-head > div { min-width: 0; }
.provider-head h5 { margin: 0; font-size: 13px; }
.provider-help {
  margin: 3px 0 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10.5px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-key-line { position: relative; margin-top: 8px; }
.input-key {
  width: 100%;
  padding-right: 112px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}
.current-key {
  position: absolute;
  top: 50%;
  right: 9px;
  max-width: 100px;
  overflow: hidden;
  transform: translateY(-50%);
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
.provider-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  margin-top: 7px;
}
.provider-actions .btn { min-height: 26px; padding: 4px 9px; font-size: 10.5px; }
.affiliate-link { margin-left: auto; color: var(--accent); font-size: 10.5px; text-decoration: none; }
.affiliate-link:hover { text-decoration: underline; }
.test-result { margin-top: 7px; padding: 6px 8px; border-radius: 6px; font-size: 10.5px; }
.test-result.ok { background: var(--success-bg, rgba(34, 197, 94, 0.12)); color: var(--success, #16a34a); }
.test-result.warn { background: var(--warning-bg, rgba(234, 179, 8, 0.12)); color: var(--warning, #ca8a04); }
.test-result.err { background: var(--danger-bg, rgba(239, 68, 68, 0.12)); color: var(--danger, #dc2626); }
.state-pill { flex-shrink: 0; padding: 2px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 700; }
.state-set { background: var(--success-bg, rgba(34, 197, 94, 0.12)); color: var(--success, #16a34a); }
.state-empty { background: var(--bg-tertiary); color: var(--text-muted); }
.tms-security-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 3px;
  color: var(--text-muted);
  font-size: 10px;
}
.tms-security-note code { font-size: 9.5px; }

@media (max-width: 820px) {
  .tms-overview { grid-template-columns: 1fr; gap: 7px; }
  .appearance-section { align-items: flex-start; flex-direction: column; gap: 12px; }
  .provider-grid { grid-template-columns: 1fr; }
  .provider-category-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 560px) {
  .tms-jump-nav { position: static; }
  .tms-jump-nav a { flex: 1; padding-inline: 6px; text-align: center; }
  .provider-category-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .theme-picker { width: 100%; }
  .theme-option { flex: 1; justify-content: center; padding-inline: 7px; }
  .theme-resolved { display: none; }
  .provider-group-summary > div { align-items: flex-start; flex-direction: column; gap: 2px; }
}
</style>
