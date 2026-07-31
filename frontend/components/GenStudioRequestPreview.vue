<template>
  <section v-if="requests.length" class="gs-req" aria-label="Request sent to GenStudio">
    <button type="button" class="gs-req-toggle" :aria-expanded="open" @click="open = !open">
      <span class="gs-req-caret" :class="{ open }">&#9656;</span>
      {{ open ? 'Hide request' : 'Show request' }} sent to GenStudio
      <span class="gs-req-count">({{ requests.length.toLocaleString() }} call{{ requests.length === 1 ? '' : 's' }})</span>
    </button>

    <div v-if="open" class="gs-req-body">
      <p class="gs-req-note">
        Exactly what Story Studio submitted, minus credentials — the API key and the
        Authorization header are never captured.
      </p>

      <article v-for="entry in pageItems" :key="entry.id" class="gs-req-card">
        <header class="gs-req-head">
          <code class="gs-req-endpoint">{{ entry.request!.method }} {{ entry.request!.path }}</code>
          <span class="gs-req-op">{{ entry.operation }}</span>
          <span class="gs-req-state" :class="stateClass(entry)">{{ displayState(entry) }}</span>
        </header>

        <dl class="gs-req-facts">
          <template v-if="entry.request!.model_id">
            <dt>Product / model submitted</dt>
            <dd><code>{{ entry.request!.model_id }}</code></dd>
          </template>
          <template v-if="entry.request!.response_format">
            <dt>response_format</dt>
            <dd><code class="gs-req-wrap">{{ entry.request!.response_format }}</code></dd>
          </template>
          <template v-for="limit in tokenLimits(entry)" :key="limit.label">
            <dt>{{ limit.label }}</dt>
            <dd>{{ limit.value }}</dd>
          </template>
          <template v-for="field in entry.request!.fields || []" :key="field.label">
            <dt>{{ field.label }}</dt>
            <dd><code class="gs-req-wrap">{{ field.value }}</code></dd>
          </template>
          <template v-if="entry.request!.idempotency_key">
            <dt>Idempotency-Key</dt>
            <dd><code class="gs-req-wrap">{{ entry.request!.idempotency_key }}</code></dd>
          </template>
          <template v-if="entry.request!.captured_at">
            <dt>Captured</dt>
            <dd>{{ formatTime(entry.request!.captured_at) }}</dd>
          </template>
        </dl>

        <div v-for="(message, index) in entry.request!.messages || []" :key="index" class="gs-req-message">
          <div class="gs-req-message-head">
            <strong>{{ message.role }}</strong>
            <span>{{ message.length.toLocaleString() }} characters</span>
            <span v-if="message.truncated" class="gs-req-truncated">preview truncated</span>
          </div>
          <pre class="gs-req-text">{{ message.text }}</pre>
        </div>
      </article>

      <div v-if="pageCount > 1" class="gs-req-pagination">
        <button type="button" class="btn btn-xs btn-secondary" :disabled="page === 1" @click="page -= 1">Previous</button>
        <span>Call {{ page }} / {{ pageCount }}</span>
        <button type="button" class="btn btn-xs btn-secondary" :disabled="page === pageCount" @click="page += 1">Next</button>
      </div>
      <p v-if="omittedCount > 0" class="gs-req-note">
        Only the {{ requests.length.toLocaleString() }} most recent calls of this job keep a stored
        request preview; {{ omittedCount.toLocaleString() }} earlier call{{ omittedCount === 1 ? '' : 's' }}
        {{ omittedCount === 1 ? 'has' : 'have' }} been dropped to keep the job record small.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

/**
 * Renders the redacted request preview captured by
 * `electron/server/lib/genstudio-request-preview.ts`.
 *
 * This component is display-only and receives whatever the server persisted.
 * It never reconstructs headers and has no notion of an api key — the capture
 * side guarantees no credential is present in this data.
 */
type RequestPreview = {
  method: string
  path: string
  model_id?: string
  response_format?: string
  token_limits?: Readonly<Record<string, number>>
  idempotency_key?: string
  messages?: readonly { role: string; text: string; length: number; truncated: boolean }[]
  fields?: readonly { label: string; value: string }[]
  captured_at: string
}

type RemoteJob = {
  id: string
  operation: string
  state: string
  queue_state?: string
  failure_code?: string | null
  request?: RequestPreview
}

const props = defineProps<{ remoteJobs: readonly RemoteJob[] }>()

const open = ref(false)
const page = ref(1)

const requests = computed(() => props.remoteJobs.filter(entry => !!entry.request))
/** Calls whose preview the server dropped to keep `jobs.json` bounded. */
const omittedCount = computed(() => Math.max(0, props.remoteJobs.length - requests.value.length))
const pageCount = computed(() => Math.max(1, requests.value.length))
const pageItems = computed(() => requests.value.slice(page.value - 1, page.value))

watch(pageCount, () => {
  if (page.value > pageCount.value) page.value = pageCount.value
})

function tokenLimits(entry: RemoteJob) {
  return Object.entries(entry.request?.token_limits || {}).map(([label, value]) => ({
    label,
    value: Number(value).toLocaleString(),
  }))
}

const QUEUE_LABELS: Record<string, string> = {
  waiting_local: 'Waiting locally',
  submitting: 'Submitted — no response recorded',
  accepted: 'Accepted',
  waiting_account_capacity: 'Waiting for account capacity',
  running: 'Running',
  completing: 'Completing',
  succeeded: 'Succeeded',
  failed: 'Failed',
  waiting_credits: 'Waiting for credits',
  cancelled: 'Cancelled',
}

function effectiveState(entry: RemoteJob): string {
  return String(entry.queue_state || entry.state || '').toLowerCase()
}

function displayState(entry: RemoteJob): string {
  const state = effectiveState(entry) || 'unknown'
  return QUEUE_LABELS[state] || state.replace(/_/g, ' ')
}

function stateClass(entry: RemoteJob): string {
  const state = effectiveState(entry)
  if (entry.failure_code || /fail|error|cancel|reject/.test(state)) return 'is-failed'
  if (/success|succeed|complete|done|settled/.test(state)) return 'is-ok'
  return 'is-active'
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<style scoped>
.gs-req { margin-top: 6px; }
.gs-req-toggle {
  display: inline-flex; align-items: center; gap: 5px;
  border: 0; padding: 0; background: transparent;
  color: var(--accent); font: inherit; font-size: var(--font-xs); cursor: pointer;
}
.gs-req-toggle:hover { text-decoration: underline; }
.gs-req-caret { display: inline-block; transition: transform .12s ease; }
.gs-req-caret.open { transform: rotate(90deg); }
.gs-req-count { color: var(--text-muted); }
.gs-req-body { margin-top: 6px; }
.gs-req-note { margin: 0 0 6px; color: var(--text-muted); font-size: var(--font-xs); }
.gs-req-card {
  margin-bottom: 8px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-primary);
}
.gs-req-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--font-xs); }
.gs-req-endpoint {
  max-width: 100%; overflow-wrap: anywhere;
  color: var(--text-primary); font-family: 'SF Mono', Monaco, monospace; font-weight: 600;
}
.gs-req-op { color: var(--text-muted); }
.gs-req-state.is-ok { color: var(--success, #3fb950); }
.gs-req-state.is-failed { color: var(--danger, #f85149); }
.gs-req-state.is-active { color: var(--accent); }
.gs-req-facts {
  display: grid; grid-template-columns: minmax(120px, max-content) minmax(0, 1fr);
  gap: 3px 10px; margin: 7px 0 0; font-size: var(--font-xs);
}
.gs-req-facts dt { color: var(--text-muted); }
.gs-req-facts dd { margin: 0; min-width: 0; color: var(--text-secondary); }
.gs-req-facts code { font-family: 'SF Mono', Monaco, monospace; }
.gs-req-wrap { display: block; max-height: 88px; overflow: auto; overflow-wrap: anywhere; }
.gs-req-message { margin-top: 8px; }
.gs-req-message-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-bottom: 3px; color: var(--text-muted); font-size: var(--font-xs);
}
.gs-req-message-head strong { color: var(--text-secondary); text-transform: uppercase; letter-spacing: .04em; }
.gs-req-truncated { color: var(--accent); }
.gs-req-text {
  max-height: 220px; margin: 0; padding: 8px; overflow: auto;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-secondary, var(--bg-primary));
  color: var(--text-secondary); font-family: 'SF Mono', Monaco, monospace;
  font-size: var(--font-xs); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
}
.gs-req-pagination {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  color: var(--text-muted); font-size: var(--font-xs);
}
@media (max-width: 620px) {
  .gs-req-facts { grid-template-columns: minmax(0, 1fr); gap: 1px 0; }
  .gs-req-facts dd { margin-bottom: 5px; }
}
</style>
