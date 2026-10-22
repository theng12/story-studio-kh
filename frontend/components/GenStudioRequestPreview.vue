<template>
  <div class="gs-req">
    <!-- What Story Studio actually sent, item by item. The facts are shown
         flat: the endpoint, the product, the token limits and the fields that
         went on the wire are the answer to "what did you ask for?", and an
         answer behind an expander is an answer nobody opens. -->
    <dl v-if="entry.request" class="gs-req-facts">
      <template v-if="entry.request.method || entry.request.path">
        <dt>Request sent</dt>
        <dd><code>{{ entry.request.method }} {{ entry.request.path }}</code></dd>
      </template>
      <template v-if="entry.request.model_id">
        <dt>Product / model submitted</dt>
        <dd><code>{{ entry.request.model_id }}</code></dd>
      </template>
      <template v-if="entry.request.response_format">
        <dt>response_format</dt>
        <dd><code class="gs-req-wrap">{{ entry.request.response_format }}</code></dd>
      </template>
      <template v-for="limit in tokenLimits(entry)" :key="limit.label">
        <dt>{{ limit.label }}</dt>
        <dd>{{ limit.value }}</dd>
      </template>
      <template v-for="field in entry.request.fields || []" :key="field.label">
        <dt>{{ field.label }}</dt>
        <dd><code class="gs-req-wrap">{{ field.value }}</code></dd>
      </template>
      <template v-if="entry.request.captured_at">
        <dt>Captured</dt>
        <dd>{{ formatTime(entry.request.captured_at) }}</dd>
      </template>
    </dl>

    <!--
      No preview for this request.

      The server keeps only the newest previews of a job's requests and strips
      the rest without leaving a marker, so the reason a preview is missing is
      not knowable from here: it may have been dropped to keep the job record
      small, or the request may never have had one. The line therefore states
      the one fact that is knowable — there is no stored preview — and does
      not guess at the rest.
    -->
    <p v-if="!entry.request" class="gs-req-missing">No request preview is stored for this request.</p>

    <!-- The raw payload is the diagnostic, and it is the one thing here big
         enough to earn an expander of its own. ONE expander, for the whole
         request — not one per message, and not one per request inside another
         one. -->
    <details v-if="entry.request?.messages?.length" class="gs-req-raw">
      <summary>Show the raw request ({{ rawCharacterCount.toLocaleString() }} characters)</summary>
      <div v-for="(message, index) in entry.request.messages" :key="index" class="gs-req-message">
        <div class="gs-req-message-head">
          <strong>{{ message.role }}</strong>
          <span>{{ message.length.toLocaleString() }} characters</span>
          <span v-if="message.truncated" class="gs-req-truncated">
            truncated —
            {{ storedCharacterCount(message) !== null ? `${storedCharacterCount(message)!.toLocaleString()} of ${message.length.toLocaleString()} stored` : 'preview truncated' }}
          </span>
          <span v-else class="gs-req-complete">stored in full</span>
          <span class="gs-req-message-actions">
            <button
              type="button"
              class="gs-req-action"
              @click="copyMessage(messageKey(index), message.text)"
            >{{ copiedKey === messageKey(index) ? 'Copied' : 'Copy' }}</button>
          </span>
        </div>
        <pre class="gs-req-text">{{ message.text }}</pre>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * Renders the redacted request preview captured by
 * `electron/server/lib/genstudio-request-preview.ts`.
 *
 * This component is display-only and receives whatever the server persisted.
 * It never reconstructs headers and has no notion of an api key — the capture
 * side guarantees no credential is present in this data.
 *
 * ONE entry at a time: the request preview belongs to the item it was sent
 * for, so it is rendered inside that item's row rather than as a second list
 * of the same items.
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

const props = defineProps<{ entry: RemoteJob }>()

/** Key of the message whose "Copy" button most recently succeeded, for transient "Copied" feedback. */
const copiedKey = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

// Mirrors the marker appended by `scrubAndClamp` in
// electron/server/lib/genstudio-request-preview.ts:
//   `\n… [truncated — showing ${limit} of ${length} characters]`
// Parsed rather than duplicated so the displayed "stored" count can never
// drift from whatever the backend actually clamped to.
const TRUNCATION_MARKER_RE = /showing ([\d,]+) of ([\d,]+) characters\]\s*$/

function storedCharacterCount(message: { text: string; truncated: boolean }): number | null {
  if (!message.truncated) return null
  const match = message.text.match(TRUNCATION_MARKER_RE)
  if (!match) return null
  return Number(match[1]!.replace(/,/g, ''))
}

function messageKey(index: number): string {
  return `${props.entry.id}:${index}`
}

/** How much raw text the expander is about to reveal. */
const rawCharacterCount = computed(() => (props.entry.request?.messages || [])
  .reduce((total, message) => total + (message.length || 0), 0))

async function copyMessage(key: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedKey.value = null }, 1500)
  } catch {
    // Clipboard access can be denied by the embedding context; the button
    // simply stays labelled "Copy" so the failure is silent but harmless.
  }
}

function tokenLimits(entry: RemoteJob) {
  return Object.entries(entry.request?.token_limits || {}).map(([label, value]) => ({
    label,
    value: Number(value).toLocaleString(),
  }))
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<style scoped>
.gs-req { margin-top: 6px; }
.gs-req-missing { margin: 0; color: var(--text-muted); font-size: var(--font-xs); }
.gs-req-facts {
  display: grid; grid-template-columns: minmax(120px, max-content) minmax(0, 1fr);
  gap: 3px 10px; margin: 6px 0 0; font-size: var(--font-xs);
}
.gs-req-facts dt { color: var(--text-muted); }
.gs-req-facts dd { margin: 0; min-width: 0; color: var(--text-secondary); }
.gs-req-facts code { font-family: 'SF Mono', Monaco, monospace; }
.gs-req-wrap { display: block; max-height: 88px; overflow: auto; overflow-wrap: anywhere; }
.gs-req-raw { margin-top: 6px; }
.gs-req-raw > summary { color: var(--accent); font-size: var(--font-xs); cursor: pointer; }
.gs-req-raw > summary:hover { text-decoration: underline; }
.gs-req-message { margin-top: 8px; }
.gs-req-message-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-bottom: 3px; color: var(--text-muted); font-size: var(--font-xs);
}
.gs-req-message-head strong { color: var(--text-secondary); text-transform: uppercase; letter-spacing: .04em; }
.gs-req-truncated { color: var(--accent); }
.gs-req-complete { color: var(--text-muted); }
.gs-req-message-actions { display: inline-flex; gap: 6px; margin-left: auto; }
.gs-req-action {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 1px 7px; background: var(--bg-primary); color: var(--text-secondary);
  font: inherit; font-size: var(--font-xs); line-height: 1.5; cursor: pointer;
}
.gs-req-action:hover { color: var(--accent); border-color: var(--accent); }
.gs-req-text {
  max-height: 260px; margin: 0; padding: 8px; overflow: auto;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-secondary, var(--bg-primary));
  color: var(--text-secondary); font-family: 'SF Mono', Monaco, monospace;
  font-size: var(--font-xs); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
}
@media (max-width: 620px) {
  .gs-req-facts { grid-template-columns: minmax(0, 1fr); gap: 1px 0; }
  .gs-req-facts dd { margin-bottom: 5px; }
}
</style>
