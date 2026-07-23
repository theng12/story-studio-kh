<template>
  <Modal
    :visible="modal.isOpen.value"
    size="lg"
    labelledby="whats-new-title"
    @close="onClose"
  >
    <header class="modal-header">
      <h2 id="whats-new-title">What's New — Story Studio KH</h2>
      <button
        type="button"
        class="modal-close"
        aria-label="Close"
        title="Close"
        @click="onClose"
      >×</button>
    </header>

    <p class="text-muted modal-subhead">
      Recent releases. <strong>You're on v{{ currentVersion }}</strong>.
      Closing this dialog marks v{{ currentVersion }} as seen so it won't auto-show again
      until the next upgrade.
    </p>

    <div v-if="loading" class="modal-loading text-muted">Loading changelog…</div>

    <div v-else-if="error" class="modal-error">
      <p>{{ error }}</p>
      <button class="btn btn-secondary btn-sm" @click="load">↻ Retry</button>
    </div>

    <div v-else-if="!entries.length" class="text-muted modal-loading">
      No changelog entries found.
    </div>

    <div v-else class="wnm-entries">
      <article
        v-for="entry in entries"
        :key="entry.version"
        class="wnm-entry"
        :class="{ 'wnm-entry-current': entry.version === currentVersion }"
      >
        <header class="wnm-entry-head">
          <h3>v{{ entry.version }}</h3>
          <span v-if="entry.date" class="text-muted">{{ entry.date }}</span>
          <span v-if="entry.version === currentVersion" class="state-pill state-current">current</span>
        </header>
        <!-- Markdown body, rendered via tiny inline transformer. The escape-
             then-replace pattern is safe (we only re-introduce explicit tags
             after escaping the input). -->
        <div class="wnm-entry-body" v-html="renderMd(entry.body_markdown)"></div>
      </article>
    </div>

    <footer class="modal-footer">
      <button type="button" class="btn btn-secondary" @click="onClose">Got it</button>
    </footer>
  </Modal>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'

const modal = useWhatsNewModal()
const { get, put } = useApi()

interface ChangelogEntry {
  version: string
  date: string | null
  body_markdown: string
}

const entries = ref<ChangelogEntry[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const { public: pubCfg } = useRuntimeConfig()
const currentVersion = computed(() => (pubCfg.appVersion as string | undefined) || '0.0.0')

async function load() {
  loading.value = true
  error.value = null
  try {
    const r = await get<{ entries: ChangelogEntry[] }>('/changelog')
    entries.value = r.entries || []
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Failed to load changelog'
  } finally {
    loading.value = false
  }
}

// Lazy-load on first open. Subsequent opens reuse the cached list.
watch(modal.isOpen, (now) => {
  if (now && !entries.value.length && !loading.value) void load()
})

async function onClose() {
  // Persist last-seen version BEFORE closing so a refresh-during-close
  // doesn't re-open the modal. Best-effort — failure is non-fatal.
  try {
    await put('/app-settings/last-seen-version', { version: currentVersion.value })
  } catch { /* swallow — user can dismiss again next launch */ }
  modal.close()
}

/**
 * Tiny markdown renderer for changelog bodies. Supports:
 *   - Bullet lists: `- text`
 *   - Bold: `**text**`
 *   - Inline code: `` `code` ``
 *   - Paragraphs (everything else, separated by blank lines)
 *
 * Escapes HTML first, then re-introduces only the safe substitutions.
 */
function renderMd(md: string): string {
  if (!md) return ''
  const lines = md.split(/\r?\n/)
  const html: string[] = []
  let inList = false
  function inline(s: string): string {
    return s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+?)`/g, '<code>$1</code>')
  }
  for (const raw of lines) {
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    if (/^\s*-\s/.test(escaped)) {
      if (!inList) { html.push('<ul class="wnm-bullets">'); inList = true }
      const item = escaped.replace(/^\s*-\s/, '')
      html.push(`<li>${inline(item)}</li>`)
    } else {
      if (inList) { html.push('</ul>'); inList = false }
      if (escaped.trim() === '') continue
      html.push(`<p>${inline(escaped)}</p>`)
    }
  }
  if (inList) html.push('</ul>')
  return html.join('')
}
</script>

<style scoped>
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: -4px 0 4px;
}
.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.modal-close {
  background: transparent;
  border: 0;
  padding: 4px 8px;
  font-size: 22px;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
}
.modal-close:hover { background: var(--bg-hover); color: var(--text-primary); }
.modal-subhead {
  margin: 4px 0 14px;
  font-size: 12px;
  line-height: 1.55;
}
.modal-loading {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
}
.modal-error {
  padding: 14px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 13px;
}
.wnm-entries {
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 6px;
}
.wnm-entry {
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.wnm-entry:last-child { border-bottom: none; }
.wnm-entry-current {
  background: var(--accent-dim);
  border-left: 3px solid var(--accent);
  padding-left: 10px;
  border-radius: 4px;
}
.wnm-entry-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.wnm-entry-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.wnm-entry-head .text-muted { font-size: 12px; }
.state-pill {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 999px;
}
.state-current {
  background: var(--accent);
  color: var(--bg-primary);
  font-weight: 600;
}
.wnm-entry-body {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.wnm-entry-body :deep(p) { margin: 4px 0; }
.wnm-entry-body :deep(ul.wnm-bullets) { margin: 4px 0; padding-left: 22px; }
.wnm-entry-body :deep(li) { margin: 2px 0; }
.wnm-entry-body :deep(strong) { color: var(--text-primary); font-weight: 600; }
.wnm-entry-body :deep(code) {
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-xs);
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
