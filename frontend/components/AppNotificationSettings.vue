<template>
  <div class="app-notification-settings card settings-panel notification-panel" data-setting="notifications">
    <header class="settings-section-head">
      <div>
        <h3>Notifications</h3>
        <p>Choose what deserves your attention, where it should reach you, and when the daily production brief arrives.</p>
      </div>
      <span class="settings-section-count">{{ notificationReadinessLabel }}</span>
    </header>

    <section class="notification-status-grid" aria-label="Notification channel status">
      <article :class="['notification-status-card', { active: notifSettings.enabled }]">
        <span class="notification-status-icon" aria-hidden="true">▣</span>
        <div><strong>Desktop</strong><small>{{ notifSettings.enabled ? 'Active on this Mac' : 'Muted' }}</small></div>
        <span :class="['notification-state', notifSettings.enabled ? 'ready' : 'off']">{{ notifSettings.enabled ? 'ON' : 'OFF' }}</span>
      </article>
      <article :class="['notification-status-card', { active: telegramReady }]">
        <span class="notification-status-icon" aria-hidden="true">↗</span>
        <div><strong>Telegram</strong><small>{{ telegramStatusText }}</small></div>
        <span :class="['notification-state', telegramReady ? 'ready' : notifSettings.telegram.enabled ? 'warn' : 'off']">{{ telegramReady ? 'READY' : notifSettings.telegram.enabled ? 'SETUP' : 'OFF' }}</span>
      </article>
      <article :class="['notification-status-card', { active: digestReady }]">
        <span class="notification-status-icon" aria-hidden="true">◷</span>
        <div><strong>Daily brief</strong><small>{{ digestStatusText }}</small></div>
        <span :class="['notification-state', digestReady ? 'ready' : notifSettings.digest.enabled ? 'warn' : 'off']">{{ digestReady ? 'SET' : notifSettings.digest.enabled ? 'CHECK' : 'OFF' }}</span>
      </article>
    </section>

    <div class="notification-layout">
      <section class="notification-section notification-section--events">
        <div class="notification-section-head">
          <div><span class="settings-section-kicker">What reaches you</span><h4>Alert events</h4></div>
          <span>{{ enabledNotificationEventCount }}/3 selected</span>
        </div>
        <div class="notification-event-grid">
          <label :class="['notification-event-card', { active: notifSettings.events.failures }]">
            <input v-model="notifSettings.events.failures" type="checkbox" />
            <span class="notification-event-mark" aria-hidden="true">!</span>
            <span><strong>Job needs attention</strong><small>Send immediately when any generation or assembly job fails.</small></span>
          </label>
          <label :class="['notification-event-card', { active: notifSettings.events.pipeline_finished }]">
            <input v-model="notifSettings.events.pipeline_finished" type="checkbox" />
            <span class="notification-event-mark" aria-hidden="true">✓</span>
            <span><strong>Pipeline run complete</strong><small>Send one result summary after every episode in the batch settles.</small></span>
          </label>
          <label :class="['notification-event-card', { active: notifSettings.events.long_job }]">
            <input v-model="notifSettings.events.long_job" type="checkbox" />
            <span class="notification-event-mark" aria-hidden="true">◷</span>
            <span><strong>Long job complete</strong><small>Notify for standalone jobs that ran longer than your threshold.</small></span>
          </label>
        </div>
      </section>

      <section class="notification-section notification-section--desktop">
        <div class="notification-channel-head">
          <span class="notification-channel-icon" aria-hidden="true">▣</span>
          <div><h4>Desktop alerts</h4><p>Native macOS or Windows alerts. Clicking one opens the matching channel’s Jobs page.</p></div>
          <label class="notification-switch">
            <input v-model="notifSettings.enabled" type="checkbox" />
            <span aria-hidden="true" />
          </label>
        </div>
        <div :class="['notification-threshold', { disabled: !notifSettings.events.long_job }]">
          <div><strong>Long-job threshold</strong><small>Fast jobs stay quiet. Failures ignore this threshold and alert immediately.</small></div>
          <span class="notification-threshold-value">{{ notifMinDurationMinutes }} min</span>
          <SliderWithNumber v-model="notifMinDurationMinutes" :min="1" :max="60" :step="1" />
        </div>
      </section>

      <section class="notification-section notification-section--telegram" data-setting="telegram">
        <div class="notification-channel-head">
          <span class="notification-channel-icon" aria-hidden="true">↗</span>
          <div><h4>Telegram</h4><p>Receive the same alerts on your phone when you are away from this Mac.</p></div>
          <label class="notification-switch">
            <input v-model="notifSettings.telegram.enabled" type="checkbox" />
            <span aria-hidden="true" />
          </label>
        </div>

        <details class="notification-setup" :open="notifSettings.telegram.enabled && !telegramReady">
          <summary>
            <span><strong>{{ telegramReady ? 'Connection settings' : 'Set up Telegram' }}</strong><small>{{ telegramReady ? 'Bot token and chat are configured.' : 'Three short steps. No JSON or command line needed.' }}</small></span>
            <span :class="['notification-state', telegramReady ? 'ready' : 'warn']">{{ telegramReady ? 'CONNECTED' : '3 STEPS' }}</span>
          </summary>
          <div class="notification-setup-body">
            <article class="notification-setup-step">
              <span>1</span>
              <div><strong>Create a Telegram bot</strong><p>Open BotFather, send <code>/newbot</code>, and follow its prompts. Copy the token it gives you.</p></div>
              <button type="button" class="btn btn-sm btn-secondary" @click="openExternal('https://t.me/BotFather')">Open BotFather ↗</button>
            </article>
            <article class="notification-setup-step">
              <span>2</span>
              <div class="notification-setup-fields">
                <strong>Connect your bot</strong>
                <p>Paste the token, then message your new bot with <code>/start</code>. Story Studio can detect that chat automatically.</p>
                <label>Bot token</label>
                <div class="notification-secret-row">
                  <input v-model="notifSettings.telegram.bot_token" :type="showTelegramToken ? 'text' : 'password'" class="input" placeholder="1234567890:ABCdef..." spellcheck="false" autocomplete="off" />
                  <button type="button" class="btn btn-sm btn-ghost" @click="showTelegramToken = !showTelegramToken">{{ showTelegramToken ? 'Hide' : 'Show' }}</button>
                </div>
                <div class="notification-connect-row">
                  <button type="button" class="btn btn-sm btn-secondary" :disabled="telegramDetectBusy || !notifSettings.telegram.bot_token" @click="detectTelegramChatId">
                    {{ telegramDetectBusy ? 'Looking for Your Chat...' : 'Detect My Chat' }}
                  </button>
                  <input v-model="notifSettings.telegram.chat_id" type="text" class="input" placeholder="Chat ID (detected or pasted)" spellcheck="false" autocomplete="off" />
                </div>
                <p v-if="telegramDetectResult" :class="['notification-inline-result', telegramDetectResult.ok && telegramDetectResult.chat_id ? 'ok' : 'error']">
                  {{ telegramDetectResult.ok && telegramDetectResult.chat_id
                    ? `Chat connected${telegramDetectResult.chat_label ? `: ${telegramDetectResult.chat_label}` : ''}.`
                    : telegramDetectResult.error || 'No recent chat found. Send /start to the bot, then try again.' }}
                </p>
              </div>
            </article>
            <article class="notification-setup-step">
              <span>3</span>
              <div><strong>Verify delivery</strong><p>Send one test before relying on Telegram for unattended overnight work.</p></div>
              <div class="notification-test-action">
                <button type="button" class="btn btn-sm btn-primary" :disabled="telegramTestBusy || !telegramReady" @click="testTelegram">
                  {{ telegramTestBusy ? 'Sending Test...' : 'Send Test Message' }}
                </button>
                <small v-if="telegramTestResult" :class="telegramTestResult.ok ? 'ok' : 'error'">{{ telegramTestResult.ok ? 'Delivered. Check Telegram.' : telegramTestResult.error || 'Delivery failed.' }}</small>
              </div>
            </article>
          </div>
        </details>
      </section>

      <section class="notification-section notification-section--digest" data-setting="daily-brief">
        <div class="notification-channel-head">
          <span class="notification-channel-icon" aria-hidden="true">◷</span>
          <div><h4>Daily production brief</h4><p>A once-daily view of publishing today, scheduled inventory, and episodes awaiting upload across every channel.</p></div>
          <label class="notification-switch">
            <input v-model="notifSettings.digest.enabled" type="checkbox" />
            <span aria-hidden="true" />
          </label>
        </div>
        <div :class="['notification-digest-controls', { disabled: !notifSettings.digest.enabled }]">
          <label class="notification-time-control"><span>Send at</span><input v-model="notifSettings.digest.time_local" type="time" class="input" :disabled="!notifSettings.digest.enabled" /><small>Local time. The app must be running.</small></label>
          <div class="notification-route-control">
            <span>Deliver to</span>
            <label><input v-model="notifSettings.digest.desktop_enabled" type="checkbox" :disabled="!notifSettings.digest.enabled" /> Desktop</label>
            <label><input v-model="notifSettings.digest.telegram_enabled" type="checkbox" :disabled="!notifSettings.digest.enabled || !telegramReady" /> Telegram</label>
            <small v-if="notifSettings.digest.telegram_enabled && !telegramReady">Finish Telegram setup before using it for the brief.</small>
          </div>
          <label class="notification-quiet-control"><input v-model="notifSettings.digest.quiet_when_empty" type="checkbox" :disabled="!notifSettings.digest.enabled" /><span><strong>Skip quiet days</strong><small>Do not send when nothing is scheduled to publish today.</small></span></label>
          <div class="notification-last-fired"><span>Last scheduled delivery</span><strong>{{ formattedDigestLastFired }}</strong></div>
        </div>
        <div class="notification-digest-actions">
          <button type="button" class="btn btn-sm btn-secondary" :disabled="digestPreviewBusy" @click="loadDigestPreview">{{ digestPreviewBusy ? 'Building Preview...' : 'Preview Brief' }}</button>
          <button type="button" class="btn btn-sm btn-primary" :disabled="digestSendNowBusy || !digestHasReadyDestination" @click="sendDigestNow">{{ digestSendNowBusy ? 'Sending Now...' : 'Send Now' }}</button>
          <span v-if="digestSendResult" :class="['notification-inline-result', digestSendResult.ok ? 'ok' : 'error']">{{ digestSendResult.ok ? 'Brief sent.' : digestSendResult.reason || 'Send failed.' }}</span>
        </div>
        <div v-if="digestPreview" class="notification-preview">
          <span class="settings-section-kicker">Preview</span>
          <strong>{{ digestPreview.title }}</strong>
          <pre>{{ digestPreview.body }}</pre>
        </div>
      </section>
    </div>

    <div class="notification-save-bar">
      <div>
        <strong>{{ notificationsDirty ? 'Unsaved notification changes' : 'Notification settings are saved' }}</strong>
        <span>Applies to every channel on this Mac.</span>
        <span v-if="notifSaveStatus === 'error'" class="error">{{ notifSaveError }}</span>
      </div>
      <button type="button" class="btn btn-sm btn-ghost" @click="applyRecommendedNotifications">Use Recommended Alerts</button>
      <button type="button" class="btn btn-sm btn-secondary" :disabled="!notificationsDirty || notifSaveStatus === 'saving'" @click="discardNotificationChanges">Revert</button>
      <SaveIndicator v-bind="savedHintProps('notifications')" />
      <button type="button" class="btn btn-primary" :disabled="!notificationsDirty || notifSaveStatus === 'saving'" @click="saveNotifSettings">{{ notifSaveStatus === 'saving' ? 'Saving...' : 'Save Notifications' }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
// App-wide Notifications settings panel. Extracted verbatim from
// pages/projects/[slug]/settings.vue so the same panel can mount on the
// app-level settings home. Endpoint, keys, defaults and error handling are
// unchanged.
import type { AutoSaveState } from '~/composables/useAutoSave'

const { get, post, put } = useApi()

// ── Notifications (app-level, not per-project) ─────────────────────
// Backed by `/api/app-settings/notifications`. Edits are staged locally and
// committed together so a quick series of toggles cannot race overlapping
// PUT responses and restore an older value.
interface TelegramConfigUI { enabled: boolean; bot_token: string; chat_id: string }
interface EventsConfigUI { pipeline_finished: boolean; failures: boolean; long_job: boolean }
interface DigestConfigUI {
  enabled: boolean
  time_local: string
  desktop_enabled: boolean
  telegram_enabled: boolean
  quiet_when_empty?: boolean
  last_fired_date?: string
}
interface NotifSettings {
  enabled: boolean
  min_duration_ms: number
  events: EventsConfigUI
  telegram: TelegramConfigUI
  digest: DigestConfigUI
}
function defaultEvents(): EventsConfigUI { return { pipeline_finished: true, failures: true, long_job: true } }
const notifSettings = ref<NotifSettings>({
  enabled: true,
  min_duration_ms: 300_000,
  events: defaultEvents(),
  telegram: { enabled: false, bot_token: '', chat_id: '' },
  digest: { enabled: false, time_local: '09:00', desktop_enabled: true, telegram_enabled: true, quiet_when_empty: false },
})
const savedNotifSettings = ref<NotifSettings | null>(null)
const showTelegramToken = ref(false)
const notifSaveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const notifSaveError = ref('')
function cloneNotifSettings(value: NotifSettings): NotifSettings {
  return JSON.parse(JSON.stringify(value)) as NotifSettings
}
function normalizeNotifSettings(raw: Partial<NotifSettings> | null | undefined): NotifSettings {
  return {
    enabled: !!raw?.enabled,
    min_duration_ms: typeof raw?.min_duration_ms === 'number' ? raw.min_duration_ms : 300_000,
    events: raw?.events
      ? {
          pipeline_finished: raw.events.pipeline_finished !== false,
          failures: raw.events.failures !== false,
          long_job: raw.events.long_job !== false,
        }
      : defaultEvents(),
    telegram: raw?.telegram
      ? {
          enabled: !!raw.telegram.enabled,
          bot_token: raw.telegram.bot_token || '',
          chat_id: raw.telegram.chat_id || '',
        }
      : { enabled: false, bot_token: '', chat_id: '' },
    digest: raw?.digest
      ? {
          enabled: !!raw.digest.enabled,
          time_local: raw.digest.time_local || '09:00',
          desktop_enabled: raw.digest.desktop_enabled !== false,
          telegram_enabled: raw.digest.telegram_enabled !== false,
          quiet_when_empty: !!raw.digest.quiet_when_empty,
          last_fired_date: raw.digest.last_fired_date,
        }
      : { enabled: false, time_local: '09:00', desktop_enabled: true, telegram_enabled: true, quiet_when_empty: false },
  }
}
const notificationsDirty = computed(() =>
  !!savedNotifSettings.value
  && JSON.stringify(notifSettings.value) !== JSON.stringify(savedNotifSettings.value),
)
const telegramConfigured = computed(() =>
  !!notifSettings.value.telegram.bot_token.trim() && !!notifSettings.value.telegram.chat_id.trim(),
)
const telegramReady = computed(() => notifSettings.value.telegram.enabled && telegramConfigured.value)
const telegramStatusText = computed(() => {
  if (!notifSettings.value.telegram.enabled) return 'Not enabled'
  if (!notifSettings.value.telegram.bot_token.trim()) return 'Bot token needed'
  if (!notifSettings.value.telegram.chat_id.trim()) return 'Chat connection needed'
  return 'Connected for remote alerts'
})
const digestHasReadyDestination = computed(() =>
  (notifSettings.value.digest.desktop_enabled && notifSettings.value.enabled)
  || (notifSettings.value.digest.telegram_enabled && telegramReady.value),
)
const digestReady = computed(() => notifSettings.value.digest.enabled && digestHasReadyDestination.value)
const digestStatusText = computed(() => {
  if (!notifSettings.value.digest.enabled) return 'Not scheduled'
  if (!digestHasReadyDestination.value) return 'Choose an active destination'
  return `Daily at ${notifSettings.value.digest.time_local || '09:00'}`
})
const notificationReadinessLabel = computed(() => {
  const count = Number(notifSettings.value.enabled) + Number(telegramReady.value)
  return count === 0 ? 'Alerts muted' : `${count} channel${count === 1 ? '' : 's'} active`
})
const enabledNotificationEventCount = computed(() =>
  Object.values(notifSettings.value.events).filter(Boolean).length,
)
const formattedDigestLastFired = computed(() => {
  const raw = notifSettings.value.digest.last_fired_date
  if (!raw) return 'Never'
  const date = new Date(`${raw}T00:00:00`)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : raw
})
const notifMinDurationMinutes = computed({
  get: () => Math.max(1, Math.round(notifSettings.value.min_duration_ms / 60_000)),
  set: (v: number) => {
    const m = Math.max(1, Math.min(60, Math.round(Number(v) || 1)))
    notifSettings.value.min_duration_ms = m * 60_000
  },
})
async function loadNotifSettings() {
  try {
    const r = await get<NotifSettings>('/app-settings/notifications')
    notifSettings.value = normalizeNotifSettings(r)
    savedNotifSettings.value = cloneNotifSettings(notifSettings.value)
    notifSaveStatus.value = 'idle'
    notifSaveError.value = ''
  } catch { /* leave defaults */ }
}
function discardNotificationChanges() {
  if (!savedNotifSettings.value) return
  notifSettings.value = cloneNotifSettings(savedNotifSettings.value)
  notifSaveStatus.value = 'idle'
  notifSaveError.value = ''
  telegramDetectResult.value = null
  telegramTestResult.value = null
  digestSendResult.value = null
}
function applyRecommendedNotifications() {
  notifSettings.value.enabled = true
  notifSettings.value.min_duration_ms = 5 * 60_000
  notifSettings.value.events = defaultEvents()
}
async function saveNotifSettings(): Promise<boolean> {
  notifSaveStatus.value = 'saving'
  notifSaveError.value = ''
  try {
    const saved = await put<NotifSettings>('/app-settings/notifications', {
      enabled: notifSettings.value.enabled,
      min_duration_ms: notifSettings.value.min_duration_ms,
      events: {
        pipeline_finished: notifSettings.value.events.pipeline_finished,
        failures: notifSettings.value.events.failures,
        long_job: notifSettings.value.events.long_job,
      },
      telegram: {
        enabled: notifSettings.value.telegram.enabled,
        bot_token: notifSettings.value.telegram.bot_token,
        chat_id: notifSettings.value.telegram.chat_id,
      },
      digest: {
        enabled: notifSettings.value.digest.enabled,
        time_local: notifSettings.value.digest.time_local,
        desktop_enabled: notifSettings.value.digest.desktop_enabled,
        telegram_enabled: notifSettings.value.digest.telegram_enabled,
        quiet_when_empty: notifSettings.value.digest.quiet_when_empty,
      },
    })
    notifSettings.value = normalizeNotifSettings(saved)
    savedNotifSettings.value = cloneNotifSettings(notifSettings.value)
    notifSaveStatus.value = 'saved'
    stampSaved('notifications')
    return true
  } catch (e: any) {
    notifSaveError.value = e?.data?.detail || e?.message || 'Unknown error'
    notifSaveStatus.value = 'error'
    return false
  }
}

// Telegram test-message round-trip. Sends with the values currently
// in the form (NOT the saved values) so the user can verify a token
// before committing it. Result is shown inline next to the button.
const telegramTestBusy = ref(false)
const telegramTestResult = ref<{ ok: boolean; error?: string } | null>(null)
async function testTelegram() {
  telegramTestBusy.value = true
  telegramTestResult.value = null
  try {
    const r = await post<{ ok: boolean; status: number; error?: string }>(
      '/app-settings/notifications/telegram-test',
      {
        bot_token: notifSettings.value.telegram.bot_token,
        chat_id: notifSettings.value.telegram.chat_id,
      },
    )
    telegramTestResult.value = { ok: !!r.ok, error: r.error }
  } catch (e: any) {
    telegramTestResult.value = {
      ok: false,
      error: e?.data?.detail || e?.data?.error || e?.message || 'Send failed',
    }
  } finally {
    telegramTestBusy.value = false
  }
}

// Daily digest preview + manual send-now (v1.0.62+). Preview hits a
// read-only endpoint that builds the digest body without dispatching;
// Send Now actually fires through whichever channels are routed on.
const digestPreviewBusy = ref(false)
const digestPreview = ref<{ title: string; body: string } | null>(null)
const digestSendNowBusy = ref(false)
const digestSendResult = ref<{ ok: boolean; reason?: string } | null>(null)
async function loadDigestPreview() {
  digestPreviewBusy.value = true
  try {
    const r = await get<{ payload: { title: string; body: string } }>(
      '/app-settings/notifications/digest-preview',
    )
    digestPreview.value = r.payload
  } catch (e: any) {
    digestPreview.value = {
      title: 'Preview failed',
      body: e?.data?.detail || e?.message || 'Could not build digest.',
    }
  } finally {
    digestPreviewBusy.value = false
  }
}
async function sendDigestNow() {
  digestSendNowBusy.value = true
  digestSendResult.value = null
  try {
    if (notificationsDirty.value && !await saveNotifSettings()) return
    const r = await post<{ ok: boolean; reason?: string; payload?: { title: string; body: string } }>(
      '/app-settings/notifications/send-digest-now',
      {},
    )
    digestSendResult.value = { ok: !!r.ok, reason: r.reason }
    // Mirror the dispatched body into the preview pane so the user can
    // confirm what just got sent without round-tripping through Telegram.
    if (r.ok && r.payload) digestPreview.value = r.payload
  } catch (e: any) {
    digestSendResult.value = {
      ok: false,
      reason: e?.data?.detail || e?.message || 'Send failed',
    }
  } finally {
    digestSendNowBusy.value = false
  }
}

// Auto-detect chat id by reading the bot's recent messages — saves
// the user from having to open `https://api.telegram.org/bot<TOKEN>/getUpdates`
// and parse JSON by hand. Empty result usually means the user hasn't
// sent /start to their bot yet; the inline message tells them so.
const telegramDetectBusy = ref(false)
const telegramDetectResult = ref<{
  ok: boolean
  chat_id?: string
  chat_label?: string
  error?: string
} | null>(null)
async function detectTelegramChatId() {
  telegramDetectBusy.value = true
  telegramDetectResult.value = null
  try {
    const r = await post<{
      ok: boolean
      chat_id?: string
      chat_label?: string
      total_updates?: number
      error?: string
    }>(
      '/app-settings/notifications/telegram-detect-chat-id',
      { bot_token: notifSettings.value.telegram.bot_token },
    )
    telegramDetectResult.value = {
      ok: !!r.ok,
      chat_id: r.chat_id,
      chat_label: r.chat_label,
      error: r.error,
    }
    // Auto-fill the chat id but keep it visibly staged with the other edits.
    if (r.ok && r.chat_id) {
      notifSettings.value.telegram.chat_id = r.chat_id
    }
  } catch (e: any) {
    telegramDetectResult.value = {
      ok: false,
      error: e?.data?.detail || e?.data?.error || e?.message || 'Detection failed',
    }
  } finally {
    telegramDetectBusy.value = false
  }
}

onMounted(() => {
  loadNotifSettings()
})

// Per-action "Saved Xs ago" persistent indicator, keyed locally since this
// panel is now its own component. `<SaveIndicator>` renders a permanent pill
// so the operator can tell at a glance whether their last edit landed even
// after the toast fades.
const savedAt = reactive<Record<string, number | null>>({})
function stampSaved(key: string) { savedAt[key] = Date.now() }
function savedHintProps(key: string) {
  const ts = savedAt[key] ?? null
  return { state: (ts ? 'saved' : 'idle') as AutoSaveState, savedAt: ts }
}

// Open external URLs in the system browser instead of the Electron window
// (which doesn't load arbitrary domains by default and would just blank out).
function openExternal(url: string) {
  if (typeof window !== 'undefined' && (window as any).require) {
    try {
      const { shell } = (window as any).require('electron')
      shell.openExternal(url)
      return
    } catch { /* fall through to web fallback */ }
  }
  window.open(url, '_blank', 'noopener')
}
</script>

<style scoped>
/* ── Notification center ───────────────────────────────────────────── */
/* Scoped green/gold accents, matching AppFilesSettings' own pattern — the
   old page defined them on .settings-workspace and this component can mount
   outside it. */
.app-notification-settings {
  --settings-green: #58c692;
  --settings-gold: #e3b45a;
}
/* DS-12/F-14 — `overflow: hidden` made this panel the scroll container for its own
   `position: sticky; bottom: 10px` save bar. A hidden-overflow ancestor is a scroll
   container whose scroll position never changes, so the bar measured exactly its
   natural offset at every scroll position and its Save action was invisible until
   the very end of a 2680px page. `clip` still clips the panel's rounded corners but
   is not a scroll container, so the bar sticks against main.main-content instead. */
.notification-panel { overflow: clip; }
.notification-status-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; margin-bottom: 12px; }
.notification-status-card {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-tertiary) 58%, transparent);
}
.notification-status-card.active { border-color: rgba(88,198,146,.35); background: linear-gradient(135deg, rgba(88,198,146,.08), rgba(227,180,90,.035)); }
.notification-status-icon,
.notification-channel-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: var(--settings-green);
  background: rgba(88,198,146,.1);
  font-size: 13px;
  font-weight: 800;
}
.notification-status-card > div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.notification-status-card strong { font-size: var(--font-xs); }
.notification-status-card small { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }
.notification-state { padding: 3px 6px; border-radius: 999px; font-size: var(--font-xs); font-weight: 850; letter-spacing: .08em; white-space: nowrap; }
.notification-state.ready { color: #6bd6a8; background: rgba(88,198,146,.14); }
.notification-state.warn { color: #e0b760; background: rgba(227,180,90,.13); }
.notification-state.off { color: var(--text-muted); background: rgba(128,138,150,.12); }
.notification-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.notification-section {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-tertiary) 60%, transparent);
}
.notification-section--events,
.notification-section--telegram,
.notification-section--digest { grid-column: 1 / -1; }
.notification-section-head,
.notification-channel-head { display: flex; gap: 11px; align-items: center; }
.notification-section-head { justify-content: space-between; margin-bottom: 11px; }
.notification-section-head h4,
.notification-channel-head h4 { margin: 2px 0 3px; font-size: 13px; }
.notification-section-head > span { color: var(--text-muted); font-size: var(--font-xs); }
.notification-channel-head > div:nth-child(2) { min-width: 0; flex: 1; }
.notification-channel-head p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.notification-event-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.notification-event-card {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: color-mix(in srgb, var(--bg-primary) 48%, transparent);
  cursor: pointer;
  transition: .15s ease;
}
.notification-event-card:hover { border-color: rgba(227,180,90,.35); transform: translateY(-1px); }
.notification-event-card.active { border-color: rgba(88,198,146,.38); background: rgba(88,198,146,.07); }
/* The card is the containing block for its hidden checkbox. Without it the
   checkbox was positioned against the page and stretched the window, so
   Appearance & notifications scrolled far past its content (v1.4.249). */
.notification-event-card { position: relative; }
.notification-event-card input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.notification-event-mark { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 8px; color: var(--text-muted); background: var(--bg-tertiary); font-size: var(--font-xs); font-weight: 850; }
.notification-event-card.active .notification-event-mark { color: var(--settings-green); background: rgba(88,198,146,.12); }
.notification-event-card > span:last-child { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.notification-event-card strong { font-size: var(--font-xs); }
.notification-event-card small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.notification-switch { position: relative; flex: 0 0 auto; width: 34px; height: 20px; cursor: pointer; }
.notification-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.notification-switch span { display: block; width: 100%; height: 100%; border-radius: 999px; background: rgba(128,138,150,.28); transition: .18s ease; }
.notification-switch span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #c9ced4; transition: .18s ease; }
.notification-switch input:checked + span { background: rgba(88,198,146,.48); }
.notification-switch input:checked + span::after { left: 17px; background: #eaf9f2; }
.notification-threshold { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: end; margin-top: 15px; padding-top: 12px; border-top: 1px solid var(--border); }
.notification-threshold.disabled { opacity: .48; }
.notification-threshold > div { display: flex; flex-direction: column; gap: 3px; }
.notification-threshold strong { font-size: var(--font-xs); }
.notification-threshold small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.notification-threshold > :last-child { grid-column: 1 / -1; }
.notification-threshold-value { color: var(--settings-gold); font-size: var(--font-xs); font-weight: 800; }
.notification-setup { margin-top: 14px; border: 1px dashed var(--border); border-radius: 12px; background: rgba(0,0,0,.06); }
.notification-setup[open] { border-style: solid; }
.notification-setup > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; cursor: pointer; list-style: none; }
.notification-setup > summary::-webkit-details-marker { display: none; }
.notification-setup > summary > span:first-child { display: flex; flex-direction: column; gap: 2px; }
.notification-setup > summary strong { font-size: var(--font-xs); }
.notification-setup > summary small { color: var(--text-muted); font-size: var(--font-xs); }
.notification-setup-body { display: grid; gap: 0; border-top: 1px solid var(--border); }
.notification-setup-step { display: grid; grid-template-columns: 25px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 13px; }
.notification-setup-step + .notification-setup-step { border-top: 1px solid var(--border); }
.notification-setup-step > span:first-child { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; color: #16231e; background: var(--settings-green); font-size: var(--font-xs); font-weight: 850; }
.notification-setup-step strong { font-size: var(--font-xs); }
.notification-setup-step p { margin: 3px 0 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.notification-setup-fields { min-width: 0; }
.notification-setup-fields > label { display: block; margin: 10px 0 4px; color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; }
.notification-secret-row,
.notification-connect-row { display: flex; gap: 7px; align-items: center; }
.notification-secret-row .input,
.notification-connect-row .input { min-width: 0; flex: 1; }
.notification-connect-row { margin-top: 7px; }
.notification-test-action { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.notification-test-action small,
.notification-inline-result { font-size: var(--font-xs); line-height: 1.4; }
.notification-test-action .ok,
.notification-inline-result.ok { color: var(--success); }
.notification-test-action .error,
.notification-inline-result.error { color: var(--error); }
.notification-digest-controls { display: grid; grid-template-columns: .7fr 1fr 1fr .7fr; gap: 10px; align-items: stretch; margin-top: 14px; }
.notification-digest-controls.disabled { opacity: .55; }
.notification-time-control,
.notification-route-control,
.notification-quiet-control,
.notification-last-fired { display: flex; min-width: 0; flex-direction: column; gap: 5px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: rgba(0,0,0,.055); }
.notification-time-control > span,
.notification-route-control > span,
.notification-last-fired > span { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 750; }
.notification-time-control small,
.notification-route-control small,
.notification-quiet-control small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; }
.notification-route-control label { display: flex; align-items: center; gap: 5px; font-size: var(--font-xs); }
.notification-quiet-control { flex-direction: row; align-items: flex-start; cursor: pointer; }
.notification-quiet-control > span { display: flex; flex-direction: column; gap: 3px; }
.notification-quiet-control strong { font-size: var(--font-xs); }
.notification-last-fired strong { margin-top: auto; color: var(--settings-gold); font-size: var(--font-xs); }
.notification-digest-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 10px; }
.notification-preview { margin-top: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 11px; background: color-mix(in srgb, var(--bg-primary) 62%, transparent); }
.notification-preview > strong { display: block; margin: 4px 0 7px; font-size: var(--font-xs); }
.notification-preview pre { max-height: 280px; margin: 0; overflow: auto; color: var(--text-muted); font-family: var(--font-mono, monospace); font-size: var(--font-xs); line-height: 1.55; white-space: pre-wrap; }
.notification-save-bar { position: sticky; bottom: 10px; z-index: 4; display: flex; align-items: center; gap: 9px; margin-top: 12px; padding: 11px 12px; border: 1px solid rgba(88,198,146,.3); border-radius: 13px; background: color-mix(in srgb, var(--bg-secondary) 94%, rgba(88,198,146,.2)); box-shadow: 0 10px 28px rgba(0,0,0,.24); }
.notification-save-bar > div:first-child { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.notification-save-bar strong { font-size: var(--font-xs); }
.notification-save-bar span { color: var(--text-muted); font-size: var(--font-xs); }
.notification-save-bar .error { color: var(--error); }

/* Panel shell + section-head classes the panel used from the page's scoped
   styles. Included here so the component renders identically wherever it
   mounts, instead of relying on pages/projects/[slug]/settings.vue. */
.settings-panel {
  border-radius: 16px;
  border-color: color-mix(in srgb, var(--border) 88%, var(--settings-green));
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 96%, #17362a), var(--bg-secondary) 180px);
  box-shadow: 0 20px 45px rgba(0,0,0,.12), inset 0 1px rgba(255,255,255,.025);
}
.settings-section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding: 2px 2px 16px;
}
.settings-section-head h3 { margin: 3px 0 4px; font-size: 16px; letter-spacing: -.01em; }
.settings-section-head p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.settings-section-kicker {
  color: var(--settings-gold);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .13em;
  text-transform: uppercase;
}
.settings-section-count {
  flex: 0 0 auto;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .06em;
  text-transform: uppercase;
}

@media (max-width: 980px) {
  .notification-status-grid { grid-template-columns: 1fr; }
  .notification-layout { grid-template-columns: 1fr; }
  .notification-section--events,
  .notification-section--telegram,
  .notification-section--digest { grid-column: auto; }
  .notification-event-grid { grid-template-columns: 1fr; }
  .notification-digest-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .notification-setup-step { grid-template-columns: 25px minmax(0, 1fr); }
  .notification-setup-step > .btn,
  .notification-test-action { grid-column: 2; align-items: flex-start; }
  .notification-secret-row,
  .notification-connect-row { align-items: stretch; flex-direction: column; }
  .notification-digest-controls { grid-template-columns: 1fr; }
  .notification-save-bar { position: static; align-items: stretch; flex-direction: column; }
  .notification-save-bar .btn { width: 100%; }
}
</style>
