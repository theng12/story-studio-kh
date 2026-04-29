<template>
  <div class="app-settings-page">
    <header class="page-header">
      <h1>App Settings</h1>
      <p class="text-muted mt-1">
        These settings apply to <strong>this Mac</strong>. They aren't shared
        across machines via iCloud.
      </p>
    </header>

    <section class="card mt-3">
      <h3>API Keys</h3>
      <p class="text-muted mt-1 mb-2">
        One key per provider, used by every project on this Mac. Keys live at
        <code>~/Library/Application&nbsp;Support/Story Studio KH/app-secrets.json</code>
        (mode 0600) and never leave your machine.
      </p>

      <div v-if="loading" class="text-muted">Loading…</div>

      <div v-else>
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
              :disabled="busy[p.id] || !drafts[p.id]?.trim()"
              @click="onSave(p.id)"
            >
              {{ busy[p.id] === 'saving' ? 'Saving…' : 'Save' }}
            </button>
            <button
              class="btn btn-secondary btn-sm"
              :disabled="busy[p.id] || (!drafts[p.id]?.trim() && !byId[p.id]?.hasKey)"
              :title="drafts[p.id]?.trim() ? 'Test the key in the input box (without saving)' : 'Test the currently-saved key'"
              @click="onTest(p.id)"
            >
              {{ busy[p.id] === 'testing' ? 'Testing…' : 'Test' }}
            </button>
            <button
              v-if="byId[p.id]?.hasKey"
              class="btn btn-ghost btn-sm"
              :disabled="busy[p.id]"
              title="Remove this provider's key from this Mac"
              @click="onClear(p.id)"
            >
              {{ busy[p.id] === 'clearing' ? 'Clearing…' : 'Remove' }}
            </button>
          </div>

          <div v-if="byId[p.id]?.hasKey && !drafts[p.id]" class="text-muted current-key">
            Currently saved: <code>{{ byId[p.id]?.keyMasked || '••••' }}</code>
          </div>

          <div v-if="results[p.id]" :class="['test-result', results[p.id].kind]">
            {{ results[p.id].message }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

const { get, put, del, post } = useApi()

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
  { id: 'openai', name: 'OpenAI', helpText: 'Used for script and metadata text generation (GPT models).', placeholder: 'sk-proj-…' },
  { id: 'anthropic', name: 'Anthropic', helpText: 'Used for script generation (Claude models).', placeholder: 'sk-ant-…' },
  { id: 'kie', name: 'Kie.ai', helpText: 'Image and video generation gateway (Flux, Veo, etc.).', placeholder: 'kie-…' },
  { id: 'fal', name: 'Fal.ai', helpText: 'Image and audio generation (Flux LoRA, voice cloning).', placeholder: 'fal-…' },
  { id: 'genaipro', name: 'GenAI Pro', helpText: 'Veo video and audio generation gateway.', placeholder: '…' },
  { id: 'elevenlabs', name: 'ElevenLabs', helpText: 'Voice synthesis for narration.', placeholder: 'xi-…' },
  { id: 'google', name: 'Google', helpText: 'Used for selected Google AI Studio endpoints.', placeholder: '…' },
]

const loading = ref(true)
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
  if (!confirm(`Remove the ${providerId} API key from this Mac?`)) return
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

onMounted(load)
</script>

<style scoped>
.app-settings-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
}

.page-header h1 {
  margin: 0;
}

.provider-row {
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.provider-row:last-child {
  border-bottom: none;
}
.provider-head h4 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.provider-help {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}
.provider-affiliate {
  margin: 4px 0 0;
  font-size: 12px;
}
.affiliate-link {
  color: var(--accent);
  text-decoration: none;
}
.affiliate-link:hover {
  text-decoration: underline;
}
.provider-row-controls {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.input-key {
  flex: 1;
  min-width: 280px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}
.current-key {
  margin-top: 6px;
  font-size: 12px;
}
.test-result {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
}
.test-result.ok {
  background: var(--success-bg, rgba(34, 197, 94, 0.12));
  color: var(--success, #16a34a);
}
.test-result.warn {
  background: var(--warning-bg, rgba(234, 179, 8, 0.12));
  color: var(--warning, #ca8a04);
}
.test-result.err {
  background: var(--danger-bg, rgba(239, 68, 68, 0.12));
  color: var(--danger, #dc2626);
}
.state-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
}
.state-set {
  background: var(--success-bg, rgba(34, 197, 94, 0.12));
  color: var(--success, #16a34a);
}
.state-empty {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
</style>
