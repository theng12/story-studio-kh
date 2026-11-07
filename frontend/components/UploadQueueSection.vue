<!--
  Upload queue — the ONE persistent projection list (Story 386 Item 1).

  Shows every paced upload waiting on this channel: when it transfers, when it
  goes public, the plain reason it is waiting, and the actual next eligible
  time. Pause / resume / remove / reorder reuse the existing Jobs queue
  controls — this is a view of that queue, never a second scheduler.

  Honest states (AGENTS §6): an absent projection is NOT an empty queue. The
  server may be offline or asleep; Story Studio says so instead of promising
  nothing is running.
-->
<template>
  <section class="panel upload-queue" data-setting="upload-queue" aria-labelledby="upload-queue-title">
    <header class="queue-head">
      <div>
        <h3 id="upload-queue-title">Upload queue</h3>
        <p class="hint">
          Everything waiting to go to YouTube: transfer time, publication time, why it waits,
          and when it can next start.
        </p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="emit('refresh')">
        {{ busy ? 'Working…' : 'Refresh' }}
      </button>
    </header>

    <p v-if="unavailable" class="result warn" role="status">{{ unavailable }}</p>
    <p v-else-if="!entries.length" class="hint" role="status">Nothing waiting in the queue.</p>
    <p v-if="actionError" class="result err" role="alert">{{ actionError }}</p>

    <ul v-if="entries.length" class="queue-list">
      <li
        v-for="entry in entries"
        :key="entry.job_id || entry.episode_code"
        class="queue-item"
        :data-episode-code="entry.episode_code"
        :data-paused="entry.is_paused ? 'true' : 'false'"
      >
        <div class="queue-identity">
          <strong>{{ entry.episode_code }}</strong>
          <span v-if="entry.title" class="queue-title">{{ entry.title }}</span>
          <span v-if="entry.is_paused" class="state-text tone-warn">Paused</span>
        </div>
        <dl class="queue-facts">
          <div>
            <dt>Upload time</dt>
            <dd>{{ formatWhen(entry.upload_at) }}</dd>
          </div>
          <div>
            <dt>Publication</dt>
            <dd>{{ entry.publish_at ? formatWhen(entry.publish_at) : 'Private, no public time' }}</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>{{ waitingReasonLabel(entry.wait_reason, entry.wait_detail) }}</dd>
          </div>
          <div>
            <dt>Next eligible</dt>
            <dd>{{ formatWhen(entry.next_eligible_at) }}</dd>
          </div>
        </dl>
        <!-- Reuse of the existing Jobs queue controls: same routes, same
             semantics. Hidden when the projection gives no job to act on. -->
        <div v-if="entry.job_id" class="queue-actions">
          <button
            class="btn btn-ghost btn-sm" type="button"
            :disabled="busy || !entry.job_id"
            @click="act(entry, entry.is_paused ? 'resume' : 'pause')"
          >
            {{ entry.is_paused ? 'Resume' : 'Pause' }}
          </button>
          <button
            v-if="entry.can_reorder && index0(entry) > 0"
            class="btn btn-ghost btn-sm" type="button"
            :disabled="busy"
            title="Move earlier in the queue"
            @click="act(entry, 'up')"
          >Move Up</button>
          <button
            v-if="entry.can_reorder"
            class="btn btn-ghost btn-sm" type="button"
            :disabled="busy"
            title="Move later in the queue"
            @click="act(entry, 'down')"
          >Move Down</button>
          <button
            v-if="entry.can_remove !== false"
            class="btn btn-ghost btn-sm remove" type="button"
            :disabled="busy"
            @click="act(entry, 'remove')"
          >Remove</button>
        </div>
      </li>
    </ul>

    <p class="hint">
      Times are shown in this device’s timezone. Story Studio starts uploads only while the
      server is awake — an offline or asleep server cannot run anything, and this list cannot
      promise otherwise.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { waitingReasonLabel, type UploadQueueEntry } from '~/utils/upload-pacing'

const props = defineProps<{
  /** The channel this queue belongs to (the page's route slug). */
  slug: string
  /** The overview's `upload_queue` projection. null/undefined = not available. */
  queue?: UploadQueueEntry[] | null
  /** The page's overview error, so the queue says WHY it cannot show state. */
  overviewError?: string
}>()

const emit = defineEmits<{ (e: 'refresh'): void }>()

const { post } = useApi()
const busy = ref(false)
const actionError = ref('')

const entries = computed<UploadQueueEntry[]>(() => Array.isArray(props.queue) ? props.queue : [])

const unavailable = computed(() => {
  if (Array.isArray(props.queue)) return ''
  if (props.overviewError) return `${props.overviewError} The queue list cannot be shown until the server answers.`
  return 'Queue state is unavailable — the server may be offline or asleep, so Story Studio cannot promise what is waiting right now.'
})

function formatWhen(value: string | null | undefined): string {
  if (!value) return '—'
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return 'Time unavailable'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  } catch {
    return at.toLocaleString()
  }
}

function index0(entry: UploadQueueEntry): number {
  return entries.value.findIndex(item => (item.job_id && entry.job_id)
    ? item.job_id === entry.job_id : item.episode_code === entry.episode_code)
}

type QueueAction = 'pause' | 'resume' | 'up' | 'down' | 'remove'

async function act(entry: UploadQueueEntry, action: QueueAction): Promise<void> {
  if (!entry.job_id || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    const jobId = encodeURIComponent(entry.job_id)
    const base = `/projects/${encodeURIComponent(props.slug)}/jobs/${jobId}`
    if (action === 'pause' || action === 'resume') {
      await post(`${base}/${action}`, {})
    } else if (action === 'up' || action === 'down') {
      await post(`${base}/move`, { direction: action })
    } else {
      await post(`${base}/cancel`, {})
    }
    emit('refresh')
  } catch (error: any) {
    actionError.value = error?.data?.detail || error?.message || 'That queue action could not be done.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.upload-queue {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem;
  border-radius: 8px;
  background: var(--bg-surface, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.queue-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.queue-head h3 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-normal, #f0f0f0);
}

.queue-head .hint,
.upload-queue > .hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-muted, #a0a0a0);
}

.queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.queue-item {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(280px, 3fr) auto;
  gap: 0.75rem 1rem;
  align-items: start;
  padding: 0.75rem;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.12);
}

.queue-identity {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.queue-title {
  font-size: 0.85rem;
  color: var(--text-muted, #a0a0a0);
  overflow-wrap: anywhere;
}

.queue-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.5rem 1rem;
  margin: 0;
}

.queue-facts dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
}

.queue-facts dd {
  margin: 0.15rem 0 0;
  font-size: 0.85rem;
  color: var(--text-normal, #e8e8e8);
  overflow-wrap: anywhere;
}

.queue-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  justify-content: flex-end;
}

.queue-actions .remove {
  color: var(--danger, #f87171);
}

.state-text.tone-warn {
  color: var(--warn, #facc15);
  font-size: 0.78rem;
  font-weight: 600;
}

@media (max-width: 900px) {
  .queue-item {
    grid-template-columns: 1fr;
  }

  .queue-actions {
    justify-content: flex-start;
  }
}
</style>
