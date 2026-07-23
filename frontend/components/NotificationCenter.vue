<template>
  <div ref="rootEl" class="nc-root">
    <!-- Bell trigger -->
    <button
      type="button"
      class="nc-bell"
      :class="{ active: isOpen }"
      :aria-label="bellLabel"
      :title="bellLabel"
      aria-haspopup="dialog"
      :aria-expanded="isOpen"
      @click="toggle(slug)"
    >
      <span class="nc-bell-icon" aria-hidden="true">&#128276;</span>
      <span
        v-if="total > 0"
        class="nc-badge"
        :class="{ 'nc-badge-blocking': hasBlocking }"
      >{{ total > 99 ? '99+' : total }}</span>
    </button>

    <!-- Dropdown panel -->
    <transition name="nc-fade">
      <div v-if="isOpen" class="nc-panel" role="dialog" aria-label="Notifications">
        <div class="nc-tabs">
          <button
            type="button"
            class="nc-tab"
            :class="{ active: activeTab === 'action' }"
            @click="activeTab = 'action'"
          >
            Action needed
            <span v-if="actionCount > 0" class="nc-tab-count" :class="{ blocking: hasBlocking }">{{ actionCount }}</span>
          </button>
          <button
            type="button"
            class="nc-tab"
            :class="{ active: activeTab === 'activity' }"
            @click="activeTab = 'activity'"
          >
            Activity
            <span v-if="activityCount > 0" class="nc-tab-count">{{ activityCount }}</span>
          </button>
        </div>

        <!-- Action needed tab -->
        <div v-show="activeTab === 'action'" class="nc-list">
          <div v-if="actions.length === 0" class="nc-empty">
            <span class="nc-empty-icon" aria-hidden="true">&#9989;</span>
            <p>You're all set. Nothing needs attention before generating.</p>
          </div>
          <ul v-else class="nc-items">
            <li
              v-for="it in actions"
              :key="it.key"
              class="nc-item"
              :class="`sev-${it.severity}`"
            >
              <span class="nc-item-dot" aria-hidden="true" />
              <div class="nc-item-body">
                <div class="nc-item-title">
                  {{ it.title }}
                  <span v-if="it.severity === 'blocking'" class="nc-pill blocking">blocks generation</span>
                </div>
                <p class="nc-item-detail">{{ it.detail }}</p>
                <div class="nc-item-actions">
                  <NuxtLink v-if="it.to" :to="it.to" class="nc-action-link" @click="close()">Fix &rarr;</NuxtLink>
                  <button
                    v-if="it.onClick"
                    type="button"
                    class="nc-action-btn"
                    @click="runAction(it)"
                  >{{ it.actionLabel || 'Retry' }}</button>
                </div>
              </div>
              <button
                v-if="it.dismissible !== false"
                type="button"
                class="nc-dismiss"
                title="Dismiss until next launch"
                aria-label="Dismiss"
                @click="dismiss(slug, it.key)"
              >&times;</button>
            </li>
          </ul>
        </div>

        <!-- Activity tab -->
        <div v-show="activeTab === 'activity'" class="nc-list">
          <div v-if="activity.length === 0" class="nc-empty">
            <span class="nc-empty-icon" aria-hidden="true">&#128338;</span>
            <p>No finished jobs yet. Renders, generations and uploads show up here as they complete.</p>
          </div>
          <ul v-else class="nc-items">
            <li
              v-for="ev in activity"
              :key="ev.id"
              class="nc-item nc-activity"
              :class="{ unread: isActivityUnread(slug, ev.ts) }"
            >
              <span class="nc-act-icon" :class="ev.status" aria-hidden="true">
                {{ ev.status === 'done' ? '✓' : '✗' }}
              </span>
              <div class="nc-item-body">
                <div class="nc-item-title">
                  {{ ev.kind }}
                  <span class="nc-act-target">{{ ev.title }}</span>
                </div>
                <p v-if="ev.status === 'error' && ev.error" class="nc-item-detail nc-err">{{ ev.error }}</p>
                <p class="nc-item-time">{{ relTime(ev.ts) }}</p>
              </div>
            </li>
          </ul>
        </div>

        <!-- Footer -->
        <div class="nc-footer">
          <template v-if="activeTab === 'action'">
            <button type="button" class="nc-foot-btn" @click="recheck">{{ rechecking ? 'Checking…' : 'Re-check' }}</button>
          </template>
          <template v-else>
            <button type="button" class="nc-foot-btn" :disabled="activity.length === 0" @click="markActivityRead(slug)">Mark all read</button>
            <NuxtLink :to="`/projects/${slug}/jobs`" class="nc-foot-link" @click="close()">Open Jobs &rarr;</NuxtLink>
          </template>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import type { ActionItem } from '~/composables/useNotifications'

const props = defineProps<{ slug: string }>()

const {
  isOpen, activeTab,
  actionItems, activityItems,
  actionBadge, activityBadge, totalBadge,
  dismiss, refreshReadiness, markActivityRead, isActivityUnread,
  close, toggle,
} = useNotifications()

const slug = computed(() => props.slug)

const actions = computed(() => actionItems(slug.value).value)
const activity = computed(() => activityItems().value)
const actionCount = computed(() => actions.value.length)
const activityCount = computed(() => activity.value.length)
const total = computed(() => totalBadge(slug.value).value)
const hasBlocking = computed(() => actions.value.some(a => a.severity === 'blocking'))

const bellLabel = computed(() =>
  total.value > 0 ? `Notifications — ${total.value} need${total.value === 1 ? 's' : ''} attention` : 'Notifications',
)

const rechecking = ref(false)
async function recheck() {
  if (rechecking.value) return
  rechecking.value = true
  try {
    await refreshReadiness(slug.value)
  } finally {
    rechecking.value = false
  }
}

async function runAction(it: ActionItem) {
  try {
    await it.onClick?.()
  } catch { /* the action's own error handling surfaces failures */ }
}

function relTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Close on outside click + Escape while the panel is open.
const rootEl = ref<HTMLElement | null>(null)
function onDocMouseDown(e: MouseEvent) {
  if (!isOpen.value) return
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) close()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen.value) close()
}
onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.nc-root {
  position: relative;
  display: flex;
  align-items: center;
}

/* ── Bell trigger ───────────────────────────────────────────── */
.nc-bell {
  position: relative;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.nc-bell:hover { background: var(--bg-hover); color: var(--text-primary); }
.nc-bell.active { background: var(--bg-hover); border-color: var(--border); color: var(--text-primary); }
.nc-bell-icon { filter: grayscale(0.2); }

.nc-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--accent-on, #0f1117);
  font-size: var(--font-xs);
  font-weight: 700;
  line-height: 1;
  border-radius: 999px;
  border: 1.5px solid var(--bg-secondary);
}
.nc-badge-blocking { background: #ef4444; color: #fff; }

/* ── Panel ──────────────────────────────────────────────────── */
.nc-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 380px;
  max-width: 92vw;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  z-index: 1000;
  overflow: hidden;
}

.nc-tabs {
  display: flex;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}
.nc-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 11px 8px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.nc-tab:hover { color: var(--text-secondary); }
.nc-tab.active { color: var(--text-primary); border-bottom-color: var(--accent); }
.nc-tab-count {
  min-width: 16px;
  padding: 0 5px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 700;
  border-radius: 999px;
}
.nc-tab-count.blocking { background: #ef4444; color: #fff; }

.nc-list {
  overflow-y: auto;
  flex: 1;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.nc-list::-webkit-scrollbar { width: 8px; }
.nc-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

.nc-items { list-style: none; margin: 0; padding: 4px; }

.nc-item {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 10px 10px 10px 12px;
  border-radius: var(--radius-sm);
}
.nc-item + .nc-item { border-top: 1px solid var(--border); }
.nc-item:hover { background: var(--bg-hover); }

.nc-item-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--text-muted);
}
.sev-blocking .nc-item-dot { background: #ef4444; }
.sev-warning .nc-item-dot { background: #f59e0b; }
.sev-info .nc-item-dot { background: #38bdf8; }

.nc-item-body { flex: 1; min-width: 0; }
.nc-item-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
}
.nc-item-detail {
  margin: 3px 0 0;
  font-size: var(--font-xs);
  line-height: 1.45;
  color: var(--text-muted);
}
.nc-item-detail.nc-err { color: #f87171; }

.nc-pill {
  font-size: var(--font-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 999px;
}
.nc-pill.blocking { background: rgba(239, 68, 68, 0.16); color: #f87171; }

.nc-item-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
}
.nc-action-link {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
}
.nc-action-link:hover { text-decoration: underline; }
.nc-action-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-family: inherit;
  padding: 3px 9px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.nc-action-btn:hover { color: var(--accent); border-color: var(--accent); }

.nc-dismiss {
  flex-shrink: 0;
  align-self: flex-start;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.nc-dismiss:hover { color: var(--text-primary); }

/* Activity rows */
.nc-act-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: var(--font-xs);
  font-weight: 700;
}
.nc-act-icon.done { background: rgba(34, 197, 94, 0.16); color: #4ade80; }
.nc-act-icon.error { background: rgba(239, 68, 68, 0.16); color: #f87171; }
.nc-act-target { font-weight: 500; color: var(--text-secondary); }
.nc-item-time { margin: 3px 0 0; font-size: var(--font-xs); color: var(--text-muted); }
.nc-activity.unread { background: var(--accent-dim); }
.nc-activity.unread:hover { background: var(--accent-dim); }

.nc-empty {
  padding: 32px 24px;
  text-align: center;
  color: var(--text-muted);
}
.nc-empty-icon { font-size: 26px; display: block; margin-bottom: 8px; opacity: 0.8; }
.nc-empty p { margin: 0; font-size: 12px; line-height: 1.5; }

.nc-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}
.nc-foot-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-family: inherit;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.nc-foot-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.nc-foot-btn:disabled { opacity: 0.5; cursor: default; }
.nc-foot-link {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
}
.nc-foot-link:hover { text-decoration: underline; }

/* Fade/slide */
.nc-fade-enter-active, .nc-fade-leave-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.nc-fade-enter-from, .nc-fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
