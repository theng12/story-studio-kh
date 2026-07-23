<template>
  <div class="remote">
    <header class="rm-head">
      <h1 class="rm-title">Remote control</h1>
      <p class="rm-sub">Kick off a run and watch it — touch-friendly, over Tailscale.</p>
    </header>

    <div v-if="loadingProjects" class="rm-empty">Loading projects…</div>
    <div v-else-if="!projects.length" class="rm-empty">No projects found.</div>

    <template v-else>
      <!-- Project switcher + status -->
      <div class="rm-row">
        <select v-model="selectedSlug" class="rm-select" aria-label="Project">
          <option v-for="p in projects" :key="p.slug" :value="p.slug">{{ p.name || p.slug }}</option>
        </select>
      </div>
      <div class="rm-chips">
        <span class="rm-chip rm-chip-run" v-if="stats">{{ stats.running }} running</span>
        <span class="rm-chip rm-chip-queue" v-if="stats && stats.queued">{{ stats.queued }} queued</span>
        <span class="rm-chip rm-chip-err" v-if="stats && stats.error">{{ stats.error }} failed</span>
        <span class="rm-chip rm-chip-mut">{{ episodeCount }} episode{{ episodeCount === 1 ? '' : 's' }}</span>
      </div>

      <!-- Bulk run -->
      <section class="rm-card">
        <p class="rm-card-title">Bulk run</p>

        <div class="rm-seg">
          <button :class="['rm-seg-btn', { active: runMode === 'full' }]" @click="runMode = 'full'">Full run</button>
          <button v-if="hasFinal" :class="['rm-seg-btn', { active: runMode === 'review' }]" @click="runMode = 'review'">Up to review</button>
        </div>

        <div class="rm-steps">
          <span class="rm-steps-label">{{ steps.length }} steps</span>
          <span class="rm-steps-list">{{ stepSummary }}</span>
        </div>

        <label class="rm-toggle">
          <span>Re-run finished steps <span class="rm-mut">(force)</span></span>
          <input type="checkbox" v-model="force" class="rm-check" />
        </label>

        <button class="rm-run" :disabled="submitting || !episodeCount" @click="run">
          <span v-if="submitting">Queuing…</span>
          <span v-else>Run {{ episodeCount }} episode{{ episodeCount === 1 ? '' : 's' }}</span>
        </button>
        <p class="rm-note">Each step uses its saved preset. Done steps are skipped unless force is on.</p>
        <p v-if="runError" class="rm-err-text">{{ runError }}</p>
      </section>

      <!-- Active jobs -->
      <section class="rm-card">
        <div class="rm-card-head">
          <p class="rm-card-title">Active jobs</p>
          <button v-if="activeJobs.length" class="rm-stopall" :disabled="stoppingAll" @click="stopAll">Stop all</button>
        </div>

        <p v-if="!activeJobs.length" class="rm-mut rm-empty-sm">Nothing running right now.</p>

        <div v-for="job in activeJobs" :key="job.job_id" class="rm-job">
          <div class="rm-job-main">
            <p class="rm-job-title">
              {{ job.title || job.type }}
              <span v-if="job.episode_id" class="rm-mut">· {{ job.episode_id }}</span>
              <span v-if="job.status === 'error'" class="rm-err-tag">— failed</span>
            </p>
            <p class="rm-job-sub">{{ jobSubline(job) }}</p>
          </div>
          <button
            v-if="job.status === 'error'"
            class="rm-job-btn rm-retry"
            :disabled="retrying.has(job.job_id)"
            @click="retry(job)"
          >Retry</button>
          <button
            v-else
            class="rm-job-btn rm-stop"
            :disabled="cancelling.has(job.job_id)"
            :aria-label="`Stop ${job.title || job.type}`"
            @click="cancel(job)"
          >Stop</button>
        </div>
      </section>

      <!-- Needs approval -->
      <section v-if="pendingApprovals.length" class="rm-card">
        <p class="rm-card-title">Needs approval</p>
        <div v-for="ep in pendingApprovals" :key="ep.episode_id" class="rm-job">
          <div class="rm-job-main">
            <p class="rm-job-title">{{ ep.title }} <span class="rm-mut">· {{ ep.episode_id }}</span></p>
            <p class="rm-job-sub">{{ ep.with_image }}/{{ ep.total }} rendered · {{ ep.approved }} approved</p>
          </div>
          <button
            class="rm-job-btn rm-approve"
            :disabled="approving.has(ep.episode_id)"
            @click="approve(ep)"
          >Approve</button>
        </div>
      </section>

      <p class="rm-foot">Alerts on run finish / fail go to Telegram — enable it in Settings → Notifications on the desktop.</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { normalizeVisualSource, type VisualSource } from '~/composables/useProjectFlow'
import { fullRunSteps, upToReviewSteps, chainHasFinal, stepLabelFor, type CockpitStep } from '~/composables/useRemoteChain'
import type { Job } from '~/composables/useJobs'

definePageMeta({ layout: 'default' })

const { get, post, put, del } = useApi()
const { success, error: showError } = useToast()
const { jobs, stats, startPolling, stopPolling } = useJobs()

interface ProjectSummary { slug: string; name?: string }

const projects = ref<ProjectSummary[]>([])
const loadingProjects = ref(true)
const selectedSlug = ref('')
const visualSource = ref<VisualSource>('narrated-scenes')
const episodeCodes = ref<string[]>([])
const runMode = ref<'full' | 'review'>('full')
const force = ref(false)
const submitting = ref(false)
const runError = ref('')
const stoppingAll = ref(false)
const cancelling = ref<Set<string>>(new Set())
const retrying = ref<Set<string>>(new Set())

const LAST_KEY = 'remote_last_project'

const hasFinal = computed(() => chainHasFinal(visualSource.value))
const steps = computed<CockpitStep[]>(() =>
  runMode.value === 'review' ? upToReviewSteps(visualSource.value) : fullRunSteps(visualSource.value),
)
const stepSummary = computed(() => steps.value.map(s => stepLabelFor(visualSource.value, s)).join(' · '))
const episodeCount = computed(() => episodeCodes.value.length)

// Active = anything not finished/cancelled. Errors stay so the user can retry.
const activeJobs = computed<Job[]>(() =>
  (jobs.value as Job[]).filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'error'),
)

function jobSubline(job: Job): string {
  if (job.status === 'error') return job.error || 'failed'
  if (job.status === 'queued') return 'queued'
  const last = job.output_lines?.[job.output_lines.length - 1]
  return last ? String(last).slice(0, 80) : 'running…'
}

interface PendingApproval { episode_id: string; title: string; total: number; approved: number; with_image: number }
const pendingApprovals = ref<PendingApproval[]>([])
const approving = ref<Set<string>>(new Set())

async function loadApprovals(slug: string) {
  try {
    const r = await get<{ pending: PendingApproval[] }>(`/projects/${slug}/pipeline/pending-approvals`)
    pendingApprovals.value = r?.pending || []
  } catch { pendingApprovals.value = [] }
}

async function approve(ep: PendingApproval) {
  const slug = selectedSlug.value
  if (!slug || approving.value.has(ep.episode_id)) return
  approving.value = new Set(approving.value).add(ep.episode_id)
  try {
    await put(`/projects/${slug}/scene-review/${ep.episode_id}/approve`, { all: true })
    success(`Approved ${ep.episode_id}`)
    await loadApprovals(slug)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to approve')
  } finally {
    const next = new Set(approving.value); next.delete(ep.episode_id); approving.value = next
  }
}

async function loadProjects() {
  loadingProjects.value = true
  try {
    const data = await get<any>('/projects')
    projects.value = Array.isArray(data) ? data : (data?.projects || [])
    const saved = (import.meta.client && localStorage.getItem(LAST_KEY)) || ''
    const initial = projects.value.find(p => p.slug === saved)?.slug || projects.value[0]?.slug || ''
    selectedSlug.value = initial
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to load projects')
  } finally {
    loadingProjects.value = false
  }
}

async function loadProject(slug: string) {
  runError.value = ''
  // Format → chain.
  try {
    const f = await get<{ visualSource?: string; sceneAlignment?: string }>(`/projects/${slug}/effective-format`)
    visualSource.value = normalizeVisualSource(f?.visualSource, f?.sceneAlignment)
  } catch { visualSource.value = 'narrated-scenes' }
  // Episodes (for the run scope + count).
  try {
    const data = await get<any>(`/projects/${slug}/episodes`)
    const list = Array.isArray(data) ? data : (data?.episodes || [])
    episodeCodes.value = list.map((e: any) => e.episode_code).filter((c: any) => typeof c === 'string' && c)
  } catch { episodeCodes.value = [] }
  void loadApprovals(slug)
}

watch(selectedSlug, (slug, prev) => {
  if (!slug || slug === prev) return
  if (import.meta.client) localStorage.setItem(LAST_KEY, slug)
  stopPolling()
  pendingApprovals.value = []
  void loadProject(slug)
  startPolling(slug)
})

// Each time a job completes, a render may have just finished — refresh the
// approvals list so newly-rendered episodes surface without a manual reload.
watch(() => stats.value?.done, (now, prev) => {
  if (now !== prev && selectedSlug.value) void loadApprovals(selectedSlug.value)
})

async function run() {
  const slug = selectedSlug.value
  if (!slug || !episodeCount.value || submitting.value) return
  submitting.value = true
  runError.value = ''
  try {
    const r = await post<any>(`/projects/${slug}/pipeline/run-batch`, {
      episode_ids: episodeCodes.value,
      steps: steps.value,
      force: force.value,
    })
    const enq = r?.enqueued ?? 0
    const skipped = Array.isArray(r?.steps_skipped_as_done) ? r.steps_skipped_as_done.length : 0
    success(`Queued ${enq} episode chain(s)${skipped ? ` · ${skipped} step(s) already done` : ''}`)
  } catch (e: any) {
    const missing = e?.data?.missing
    if (Array.isArray(missing) && missing.length) {
      const names = missing.map((m: any) => stepLabelFor(visualSource.value, m.step as CockpitStep) || m.step).join(', ')
      runError.value = `These steps need a saved preset (set them on the desktop): ${names}.`
    } else {
      runError.value = e?.data?.detail || e?.message || 'Failed to start the run'
    }
  } finally {
    submitting.value = false
  }
}

async function cancel(job: Job) {
  const slug = selectedSlug.value
  if (!slug || cancelling.value.has(job.job_id)) return
  cancelling.value = new Set(cancelling.value).add(job.job_id)
  try {
    await del(`/projects/${slug}/jobs/${job.job_id}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to stop the job')
  } finally {
    const next = new Set(cancelling.value); next.delete(job.job_id); cancelling.value = next
  }
}

async function stopAll() {
  if (stoppingAll.value) return
  stoppingAll.value = true
  try {
    const slug = selectedSlug.value
    const live = activeJobs.value.filter(j => j.status !== 'error')
    await Promise.allSettled(live.map(j => del(`/projects/${slug}/jobs/${j.job_id}`)))
    if (live.length) success(`Stopped ${live.length} job(s)`)
  } finally {
    stoppingAll.value = false
  }
}

// Retry a failed job by re-running that episode's outstanding steps (force off,
// so only the failed/incomplete work re-runs). Avoids brittle job-type→step
// mapping — the chain + skip-done does the right thing.
async function retry(job: Job) {
  const slug = selectedSlug.value
  if (!slug || !job.episode_id || retrying.value.has(job.job_id)) return
  retrying.value = new Set(retrying.value).add(job.job_id)
  try {
    await post(`/projects/${slug}/pipeline/run-batch`, {
      episode_ids: [job.episode_id],
      steps: fullRunSteps(visualSource.value),
      force: false,
    })
    success(`Re-running ${job.episode_id}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to retry')
  } finally {
    const next = new Set(retrying.value); next.delete(job.job_id); retrying.value = next
  }
}

onMounted(loadProjects)
onBeforeUnmount(() => stopPolling())
</script>

<style scoped>
.remote {
  max-width: 460px;
  margin: 0 auto;
  padding: 12px 14px 32px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rm-head { display: flex; flex-direction: column; gap: 2px; }
.rm-title { margin: 0; font-size: 20px; }
.rm-sub { margin: 0; font-size: 13px; color: var(--text-muted, #888); }
.rm-empty { padding: 24px 0; text-align: center; color: var(--text-muted, #888); }
.rm-empty-sm { margin: 0; font-size: 13px; }

.rm-row { display: flex; gap: 8px; }
.rm-select { flex: 1; height: 48px; font-size: 16px; font-weight: 500; border-radius: 8px; }

.rm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.rm-chip { font-size: 12px; padding: 6px 10px; border-radius: 999px; }
.rm-chip-run { background: rgba(108,143,255,0.16); color: var(--accent, #6c8fff); }
.rm-chip-queue { background: rgba(240,198,116,0.18); color: #c79328; }
.rm-chip-err { background: rgba(220,38,38,0.15); color: #dc6666; }
.rm-chip-mut { background: var(--bg-secondary, #1c1c1f); color: var(--text-muted, #888); }

.rm-card {
  background: var(--bg-secondary, #1c1c1f);
  border: 1px solid var(--border, #333);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rm-card-head { display: flex; align-items: center; justify-content: space-between; }
.rm-card-title { margin: 0; font-size: 14px; font-weight: 500; }

.rm-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.rm-seg-btn { height: 46px; border-radius: 8px; font-size: 14px; }
.rm-seg-btn.active { border: 2px solid var(--accent, #6c8fff); color: var(--accent, #6c8fff); font-weight: 500; }

.rm-steps {
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px 12px; border-radius: 8px;
  background: var(--bg-tertiary, #161618); border: 1px solid var(--border, #333);
}
.rm-steps-label { font-size: 12px; font-weight: 500; }
.rm-steps-list { font-size: 12px; color: var(--text-muted, #888); line-height: 1.45; }

.rm-toggle { display: flex; align-items: center; justify-content: space-between; min-height: 44px; font-size: 14px; cursor: pointer; }
.rm-check { width: 26px; height: 26px; }
.rm-mut { color: var(--text-muted, #888); }

.rm-run {
  height: 52px; font-size: 16px; font-weight: 500; border-radius: 10px;
  background: var(--accent, #6c8fff); color: #fff; border: none;
}
.rm-run:disabled { opacity: 0.5; }
.rm-note { margin: 0; font-size: var(--font-xs); color: var(--text-muted, #888); }
.rm-err-text { margin: 0; font-size: 13px; color: #dc6666; }

.rm-job { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
.rm-job-main { flex: 1; min-width: 0; }
.rm-job-title { margin: 0; font-size: 14px; }
.rm-job-sub { margin: 3px 0 0; font-size: 12px; color: var(--text-muted, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rm-err-tag { color: #dc6666; font-size: 12px; }
.rm-job-btn { height: 44px; min-width: 64px; padding: 0 14px; border-radius: 8px; font-size: 14px; flex-shrink: 0; }
.rm-stop { color: #dc6666; border-color: rgba(220,38,38,0.4); }
.rm-retry { color: #c79328; border-color: rgba(240,198,116,0.5); }
.rm-approve { color: #4ade80; border-color: rgba(74,222,128,0.45); }
.rm-stopall { height: 36px; padding: 0 12px; border-radius: 8px; font-size: 13px; color: #dc6666; border-color: rgba(220,38,38,0.4); }

.rm-foot { margin: 0; font-size: var(--font-xs); color: var(--text-muted, #888); text-align: center; }
</style>
