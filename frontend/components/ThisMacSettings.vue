<template>
  <!-- v1.0.185 (S2) — "This Mac" settings body, extracted from AppSettingsModal
       so it can render BOTH inside the modal (opened from the all-projects
       index, where no project is selected) AND embedded in the project
       Settings page's "This Mac" zone. One implementation, two mount points —
       the merge the user asked for, without losing pre-project reachability.
       Everything here is per-machine: API keys, appearance, server mode. -->
  <div class="this-mac-settings">
    <p class="text-muted tms-scope-note">
      These apply to <strong>this Mac only</strong> — they're never synced
      across machines. Keys live at
      <code>~/Library/Application&nbsp;Support/Story Studio KH/app-secrets.json</code>
      (mode 0600) and never leave your machine.
    </p>

    <!-- Appearance -->
    <section class="appearance-section">
      <div class="appearance-head">
        <h4>Appearance</h4>
        <p class="text-muted appearance-help">
          Choose how the app looks. <strong>System</strong> follows your
          Mac's appearance and flips automatically at sunset if you have
          macOS set to <em>Auto</em>.
        </p>
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

    <!-- API keys -->
    <h4 class="tms-section-title">API Keys</h4>
    <p class="text-muted tms-section-help">One key per provider, used by every project on this Mac.</p>
    <div v-if="loading" class="text-muted modal-loading">Loading…</div>
    <div v-else class="provider-list">
      <div
        v-for="p in PROVIDER_META"
        :key="p.id"
        class="provider-row"
      >
        <div class="provider-head">
          <h4>
            {{ p.name }}
            <span v-if="byId[p.id]?.hasKey" class="state-pill state-set">configured</span>
            <span v-else class="state-pill state-empty">not set</span>
          </h4>
          <p v-if="p.helpText" class="provider-help">{{ p.helpText }}</p>
          <p v-if="p.affiliateUrl" class="provider-affiliate">
            <a :href="p.affiliateUrl" target="_blank" rel="noopener noreferrer" class="affiliate-link">
              Get API key →
            </a>
          </p>
        </div>

        <div class="provider-row-controls">
          <input
            type="password"
            :placeholder="p.placeholder || 'sk-…'"
            v-model="drafts[p.id]"
            class="input input-key"
            autocomplete="off"
            spellcheck="false"
            @keyup.enter="onSave(p.id)"
          />
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
        </div>

        <div v-if="byId[p.id]?.hasKey && !drafts[p.id]" class="text-muted current-key">
          Currently saved: <code>{{ byId[p.id]?.keyMasked || '••••' }}</code>
        </div>

        <div v-if="results[p.id]" :class="['test-result', results[p.id]?.kind]">
          {{ results[p.id]?.message }}
        </div>
      </div>
    </div>

    <!-- Server Mode — collapsed; lazily mounts the panel when expanded. -->
    <details class="ssm-section">
      <summary>Server Mode (advanced — headless web UI)</summary>
      <ServerModeSettingsPanel />
    </details>
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

const { get, put, del, post } = useApi()
const { ask } = useConfirm()
const { mode: themeMode, resolved: themeResolved, setMode: setTheme } = useTheme()

interface ProviderRow {
  providerId: string
  hasKey: boolean
  keyMasked: string
}

const PROVIDER_META: Array<{
  id: string
  name: string
  helpText?: string
  placeholder?: string
  affiliateUrl?: string
}> = [
  { id: 'openai', name: 'OpenAI', helpText: 'Used for script and metadata text generation (GPT models) and image vision fallback.', placeholder: 'sk-proj-…' },
  { id: 'deepseek', name: 'DeepSeek', helpText: 'Official DeepSeek API — text generation (V4 Flash is the default model; V4 Pro).', placeholder: 'sk-…', affiliateUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', name: 'OpenRouter', helpText: 'OpenAI-compatible gateway — currently DeepSeek V4 Flash. One key, many models.', placeholder: 'sk-or-…', affiliateUrl: 'https://openrouter.ai/keys' },
  { id: 'kie', name: 'Kie.ai', helpText: 'Text (Claude / GPT / Gemini), image, and video generation gateway.', placeholder: 'kie-…' },
  { id: 'fal', name: 'Fal.ai', helpText: 'Image and audio generation (Flux LoRA, voice cloning).', placeholder: 'fal-…' },
  { id: 'genaipro', name: 'GenAI Pro', helpText: 'Veo video and audio generation gateway.', placeholder: '…' },
  { id: 'elevenlabs', name: 'ElevenLabs', helpText: 'Voice synthesis for narration.', placeholder: 'xi-…' },
  { id: 'fishaudio', name: 'Fish Audio', helpText: 'Affordable cloud voice synthesis (~$0.015/1k chars). Supports your cloned voices via reference ID — paste it in the Audio Generator’s Voice field.', placeholder: '…', affiliateUrl: 'https://fish.audio/go-api/' },
  { id: 'google', name: 'Google', helpText: 'Used for selected Google AI Studio endpoints.', placeholder: '…' },
  { id: 'pexels', name: 'Pexels', helpText: 'Free CC-licensed stock video. Get a key at pexels.com/api — 200 req/hr free tier.', placeholder: '…', affiliateUrl: 'https://www.pexels.com/api/new/' },
  { id: 'pixabay', name: 'Pixabay', helpText: 'Free CC-licensed stock video. Get a key at pixabay.com/api/docs — free tier.', placeholder: '…', affiliateUrl: 'https://pixabay.com/api/docs/' },
  { id: 'perplexity', name: 'Perplexity', helpText: 'Optional. Powers the live-web-search source of the Research phase. The LLM-only research source works without it.', placeholder: 'pplx-…', affiliateUrl: 'https://www.perplexity.ai/settings/api' },
]

const loading = ref(false)
const providers = ref<ProviderRow[]>([])
const drafts = reactive<Record<string, string>>({})
const busy = reactive<Record<string, '' | 'saving' | 'testing' | 'clearing'>>({})
const results = reactive<Record<string, { kind: 'ok' | 'warn' | 'err'; message: string } | null>>({})

const byId = computed(() => {
  const out: Record<string, ProviderRow> = {}
  for (const r of providers.value) out[r.providerId] = r
  return out
})

async function load() {
  loading.value = true
  try {
    const res = await get<{ providers: ProviderRow[] }>('/app-settings/api-keys')
    providers.value = res.providers
  } finally {
    loading.value = false
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
.tms-scope-note { margin: 0 0 12px; font-size: 12px; line-height: 1.55; }
.tms-section-title { margin: 8px 0 2px; font-size: 14px; font-weight: 600; }
.tms-section-help { margin: 0 0 4px; font-size: 12px; }
.modal-loading { padding: 32px 0; text-align: center; }

.provider-list { margin-top: 12px; }
.provider-row {
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.provider-row:last-child { border-bottom: none; }
.provider-head h4 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.provider-help { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; }
.provider-affiliate { margin: 4px 0 0; font-size: 12px; }
.affiliate-link { color: var(--accent); text-decoration: none; }
.affiliate-link:hover { text-decoration: underline; }
.provider-row-controls {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.input-key {
  flex: 1;
  min-width: 240px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}
.current-key { margin-top: 6px; font-size: 12px; }
.test-result { margin-top: 8px; padding: 8px 10px; border-radius: 6px; font-size: 12px; }
.test-result.ok { background: var(--success-bg, rgba(34, 197, 94, 0.12)); color: var(--success, #16a34a); }
.test-result.warn { background: var(--warning-bg, rgba(234, 179, 8, 0.12)); color: var(--warning, #ca8a04); }
.test-result.err { background: var(--danger-bg, rgba(239, 68, 68, 0.12)); color: var(--danger, #dc2626); }
.state-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 500; }
.state-set { background: var(--success-bg, rgba(34, 197, 94, 0.12)); color: var(--success, #16a34a); }
.state-empty { background: var(--bg-tertiary); color: var(--text-muted); }

.ssm-section {
  margin-top: 20px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
}
.ssm-section summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  user-select: none;
}
.ssm-section[open] summary { margin-bottom: 8px; }

/* Appearance picker */
.appearance-section {
  margin: 10px 0 14px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
}
.appearance-head { margin-bottom: 10px; }
.appearance-head h4 { margin: 0; font-size: 14px; font-weight: 600; }
.appearance-help { margin: 4px 0 0; font-size: 12px; line-height: 1.55; }
.theme-picker {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.theme-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.theme-option:hover:not(.active) { background: var(--bg-hover); color: var(--text-primary); }
.theme-option.active { background: var(--accent); color: var(--accent-on); }
.theme-glyph { font-size: 14px; line-height: 1; }
.theme-resolved { font-size: 11px; opacity: 0.8; text-transform: capitalize; }
</style>
