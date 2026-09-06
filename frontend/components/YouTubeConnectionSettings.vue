<template>
  <div class="youtube-connection-settings">
    <header>
      <h3>{{ scope === 'assignment' ? `YouTube channel for ${slug}` : 'YouTube accounts on this Mac' }}</h3>
      <p v-if="scope !== 'assignment'">
        One Google Cloud OAuth application connects every YouTube channel on this Mac. Each channel is
        authorized separately. Project assignment is managed in this project’s Publishing section.
      </p>
      <p v-else>Choose which connected channel this project may publish to. The OAuth application and channel credentials stay on this Mac.</p>
    </header>

    <p v-if="loading" class="hint">Loading the YouTube connection…</p>
    <section v-else-if="loadError" class="panel recovery">
      <p class="result err">{{ loadError }}</p>
      <template v-if="loadErrorCode === 'YOUTUBE_SECRET_RECOVERY_REQUIRED'">
        <p class="hint">
          Recovery removes only the unusable local YouTube credentials. Provider API keys, projects,
          channel assignments, published-video records and history stay in place. You will reconnect the channels afterward.
        </p>
        <div class="field-row">
          <button class="btn btn-danger btn-sm" type="button" :disabled="busy !== ''" @click="recoverCredentials">
            {{ busy === 'recover' ? 'Removing…' : 'Remove unusable YouTube credentials…' }}
          </button>
        </div>
      </template>
    </section>

    <template v-else>
      <!-- ── The owner OAuth application ───────────────────────────────── -->
      <section v-if="scope !== 'assignment'" class="panel application">
        <div>
          <span class="eyebrow">Step 1</span>
          <h4>Google Cloud OAuth application</h4>
          <p v-if="!application" class="hint">
            A one-time setup. Create an OAuth client of type “Desktop app” in your Google Cloud project,
            then paste its client ID and client secret here. Story Studio stores the secret encrypted on
            this Mac and never shows it again.
          </p>
          <p v-else-if="!application.has_client_secret" class="hint">
            The saved application no longer has an available encrypted client secret. Enter its client ID
            and secret again before reconnecting channels.
          </p>
          <p v-else class="hint">
            Connected channels share this application's daily quota, because quota belongs to the Google
            Cloud project rather than to a channel.
          </p>
        </div>

        <dl v-if="application" class="facts">
          <div><dt>Client ID</dt><dd>{{ application.client_id }}</dd></div>
          <div v-if="application.google_cloud_project_id">
            <dt>Cloud project</dt><dd>{{ application.google_cloud_project_id }}</dd>
          </div>
          <div><dt>Client secret</dt><dd>{{ application.has_client_secret ? 'Stored, encrypted' : 'Missing' }}</dd></div>
          <div><dt>Configured</dt><dd>{{ formatWhen(application.configured_at) }}</dd></div>
        </dl>

        <div v-if="!application || !application.has_client_secret || replacing" class="fields">
          <label for="youtube-client-id">Client ID</label>
          <input
            id="youtube-client-id" v-model="clientIdDraft" class="input" type="text"
            autocomplete="off" spellcheck="false" placeholder="…apps.googleusercontent.com"
          />
          <label for="youtube-client-secret">Client secret</label>
          <input
            id="youtube-client-secret" v-model="clientSecretDraft" class="input" type="password"
            autocomplete="off" spellcheck="false" placeholder="Write-only — never shown again"
          />
          <label for="youtube-cloud-project">Google Cloud project ID <span class="optional">(optional)</span></label>
          <input
            id="youtube-cloud-project" v-model="cloudProjectDraft" class="input" type="text"
            autocomplete="off" spellcheck="false"
          />
          <div class="field-row">
            <button
              class="btn btn-primary btn-sm" type="button"
              :disabled="busy !== '' || !clientIdDraft.trim() || !clientSecretDraft.trim()"
              @click="saveApplication"
            >
              {{ busy === 'application' ? 'Saving…' : application ? 'Replace application' : 'Save application' }}
            </button>
            <button v-if="replacing" class="btn btn-sm" type="button" :disabled="busy !== ''" @click="cancelReplace">
              Cancel
            </button>
          </div>
        </div>
        <div v-else class="field-row">
          <button class="btn btn-sm" type="button" :disabled="busy !== ''" @click="replacing = true">
            Replace application…
          </button>
        </div>

        <p v-if="applicationResult" :class="['result', applicationResult.kind]">{{ applicationResult.message }}</p>
        <p class="security-note">The client secret is write-only. It is never sent back to this screen.</p>
      </section>

      <!-- ── Connected channels ────────────────────────────────────────── -->
      <section v-if="scope !== 'assignment'" class="panel channels">
        <div>
          <span class="eyebrow">Step 2</span>
          <h4>Connected channels</h4>
          <p v-if="!application || !application.has_client_secret" class="hint">Save the OAuth application above before connecting a channel.</p>
          <p v-else-if="!channels.length" class="hint">
            No channel is connected yet. Connecting opens Google in your browser and asks only for upload,
            read, manage and analytics permission.
          </p>
        </div>

        <ul v-if="channels.length" class="channel-list">
          <li v-for="channel in channels" :key="channel.channel_id" class="channel">
            <div class="channel-identity">
              <strong>{{ channel.title }}</strong>
              <span v-if="channel.handle" class="handle">{{ channel.handle }}</span>
              <code class="channel-id">{{ channel.channel_id }}</code>
            </div>
            <div class="channel-state">
              <span :class="['badge', channel.status]">{{ statusLabel(channel.status) }}</span>
              <span class="hint">
                {{ channel.assigned_project_slug ? `Publishing for ${channel.assigned_project_slug}` : 'Not assigned to a project' }}
              </span>
              <span v-if="channel.last_refresh_at" class="hint">Authorized {{ formatWhen(channel.last_refresh_at) }}</span>
            </div>
            <div class="channel-actions">
              <button
                v-if="channel.status !== 'connected'" class="btn btn-sm btn-primary" type="button"
                :disabled="busy !== '' || !application?.has_client_secret" @click="connectChannel(channel.channel_id)"
              >
                Reconnect
              </button>
              <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="disconnect(channel)">
                Disconnect
              </button>
            </div>
          </li>
        </ul>

        <div v-if="application?.has_client_secret" class="field-row">
          <button class="btn btn-sm btn-primary" type="button" :disabled="busy !== ''" @click="connectChannel()">
            {{ busy === 'connect' ? 'Waiting for Google…' : 'Connect a YouTube channel' }}
          </button>
        </div>
        <p v-if="channelResult" :class="['result', channelResult.kind]">{{ channelResult.message }}</p>
      </section>

      <!-- ── This project's channel ────────────────────────────────────── -->
      <section v-if="scope !== 'connections'" class="panel assignment">
        <div>
          <span class="eyebrow">{{ scope === 'assignment' ? 'Project setting' : 'Step 3' }}</span>
          <h4>Channel for {{ slug }}</h4>
          <p class="hint">
            One project publishes to exactly one channel, and a channel belongs to one project. Choosing a
            different channel replaces this one; videos already published stay attached to the channel that
            published them.
          </p>
        </div>

        <p v-if="assignment" class="assigned">
          Publishing to <strong>{{ titleOf(assignment.channel_id) }}</strong>
          <code class="channel-id">{{ assignment.channel_id }}</code>
        </p>
        <p v-else class="hint">No channel is assigned. This project stays fully usable locally, but cannot read or change YouTube.</p>

        <div v-if="assignableChannels.length" class="field-row">
          <select v-model="assignmentDraft" class="input" aria-label="Channel for this project">
            <option value="">Choose a channel…</option>
            <option v-for="channel in assignableChannels" :key="channel.channel_id" :value="channel.channel_id">
              {{ channel.title }}
            </option>
          </select>
          <button
            class="btn btn-sm btn-primary" type="button"
            :disabled="busy !== '' || !assignmentDraft || assignmentDraft === assignment?.channel_id"
            @click="assign"
          >
            {{ assignment ? 'Replace channel' : 'Assign channel' }}
          </button>
          <button v-if="assignment" class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="release">
            Release
          </button>
        </div>
        <!-- "Nothing to choose from" has two different causes and they need
             two different sentences: no channel is connected at all, or every
             connected channel is already another project's. -->
        <p v-else-if="!assignment && connectedChannels.length" class="hint">
          Every connected channel already belongs to another project. Connect another channel in This Mac → Connections to publish from this one.
        </p>
        <p v-else-if="!assignment && channels.length" class="hint">
          {{ scope === 'assignment'
            ? 'Reconnect a channel in This Mac → Connections before assigning it to this project.'
            : 'Reconnect a channel in step 2 before assigning it to this project.' }}
        </p>
        <p v-else-if="!assignment" class="hint">
          {{ scope === 'assignment'
            ? 'Connect a YouTube channel in This Mac → Connections first, then choose it here.'
            : 'Connect a YouTube channel in step 2 first, then choose it here.' }}
        </p>

        <p v-if="assignmentResult" :class="['result', assignmentResult.kind]">{{ assignmentResult.message }}</p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
interface ApplicationView {
  application_id: string
  client_id: string
  google_cloud_project_id?: string
  fingerprint: string
  configured_at: string
  updated_at: string
  has_client_secret: boolean
}

interface ChannelView {
  channel_id: string
  title: string
  handle?: string
  status: 'connected' | 'reconnect_required' | 'scope_upgrade_required'
  last_refresh_at?: string
  assigned_project_slug: string | null
}

interface AssignmentView { project_slug: string; channel_id: string; assigned_at: string }

type Result = { kind: 'ok' | 'warn' | 'err'; message: string }

const props = withDefaults(defineProps<{
  slug: string
  scope?: 'all' | 'connections' | 'assignment'
}>(), { scope: 'all' })
const scope = computed(() => props.scope)

const { get, put, post, del } = useApi()
const { ask } = useConfirm()

const loading = ref(true)
const loadError = ref('')
const loadErrorCode = ref('')
const busy = ref('')
/** Set on teardown so a pending connect poll stops instead of running on. */
let unmounted = false

const application = ref<ApplicationView | null>(null)
const channels = ref<ChannelView[]>([])
const assignment = ref<AssignmentView | null>(null)

const clientIdDraft = ref('')
const clientSecretDraft = ref('')
const cloudProjectDraft = ref('')
const replacing = ref(false)
const assignmentDraft = ref('')

const applicationResult = ref<Result | null>(null)
const channelResult = ref<Result | null>(null)
const assignmentResult = ref<Result | null>(null)

/** Only healthy channels no other project owns may be offered to this one. */
const assignableChannels = computed(() => channels.value.filter(
  channel => channel.status === 'connected'
    && (!channel.assigned_project_slug || channel.assigned_project_slug === props.slug),
))

const connectedChannels = computed(() => channels.value.filter(channel => channel.status === 'connected'))

function statusLabel(status: ChannelView['status']): string {
  if (status === 'connected') return 'Connected'
  if (status === 'reconnect_required') return 'Reconnect required'
  return 'Permission upgrade required'
}

function titleOf(channelId: string): string {
  return channels.value.find(channel => channel.channel_id === channelId)?.title || channelId
}

function formatWhen(value: string | undefined): string {
  if (!value) return 'Unknown'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleString()
}

function messageOf(error: any, fallback: string): string {
  return error?.data?.detail || error?.data?.message || error?.message || fallback
}

async function load(): Promise<void> {
  loadError.value = ''
  loadErrorCode.value = ''
  try {
    const [connections, projectAssignment] = await Promise.all([
      get<{ application: ApplicationView | null; channels: ChannelView[] }>('/youtube/connections'),
      get<{ assignment: AssignmentView | null }>(`/projects/${props.slug}/youtube/assignment`),
    ])
    application.value = connections.application
    channels.value = connections.channels
    assignment.value = projectAssignment.assignment
    assignmentDraft.value = projectAssignment.assignment?.channel_id || ''
  } catch (error: any) {
    loadError.value = messageOf(error, 'Could not load the YouTube connection.')
    loadErrorCode.value = typeof error?.data?.code === 'string' ? error.data.code : ''
  } finally {
    loading.value = false
  }
}

async function recoverCredentials(): Promise<void> {
  if (!await ask({
    title: 'Remove unusable YouTube credentials?',
    message: 'This removes only the unreadable or unprotected local YouTube credential bucket. Provider API keys, projects, channel assignments, published-video records and history are kept. Every retained channel must be reconnected.',
    confirmLabel: 'Remove YouTube credentials',
    danger: true,
  })) return
  busy.value = 'recover'
  try {
    await del('/youtube/connections/credential-authority')
    await load()
  } catch (error: any) {
    loadError.value = messageOf(error, 'Could not recover the YouTube credential store.')
    loadErrorCode.value = typeof error?.data?.code === 'string' ? error.data.code : ''
  } finally {
    busy.value = ''
  }
}

function cancelReplace(): void {
  replacing.value = false
  clientIdDraft.value = ''
  clientSecretDraft.value = ''
  cloudProjectDraft.value = ''
}

async function saveApplication(): Promise<void> {
  if (application.value && !await ask({
    title: 'Replace the OAuth application?',
    message: `Every connected channel (${channels.value.length}) will need to be reconnected before it can publish again. `
      + 'Story Studio removes the old local credentials; project assignments and published videos are kept. '
      + 'Manage any remaining Google grant in your Google Account permissions.',
    confirmLabel: 'Replace application',
    danger: true,
  })) return

  busy.value = 'application'
  applicationResult.value = null
  try {
    const saved = await put<{ application: ApplicationView; dependent_channel_count: number; replaced_previous_application: boolean }>(
      '/youtube/connections/application',
      {
        client_id: clientIdDraft.value.trim(),
        client_secret: clientSecretDraft.value,
        ...(cloudProjectDraft.value.trim() ? { google_cloud_project_id: cloudProjectDraft.value.trim() } : {}),
      },
    )
    // The secret is write-only: drop the draft the moment it is stored.
    clientSecretDraft.value = ''
    clientIdDraft.value = ''
    cloudProjectDraft.value = ''
    replacing.value = false
    applicationResult.value = {
      kind: saved.replaced_previous_application ? 'warn' : 'ok',
      message: saved.replaced_previous_application
        ? `Application replaced. ${saved.dependent_channel_count} channel(s) need reconnecting.`
        : 'OAuth application saved. Connect a YouTube channel next.',
    }
    await load()
  } catch (error: any) {
    applicationResult.value = { kind: 'err', message: messageOf(error, 'Could not save the OAuth application.') }
  } finally {
    busy.value = ''
  }
}

async function connectChannel(expectedChannelId?: string): Promise<void> {
  busy.value = 'connect'
  channelResult.value = null
  let browserPopup: Window | null = null
  try {
    const isElectron = (window as any).electron?.isElectron === true
    // Reserve a browser tab while the click still carries user activation.
    // Electron's main process intercepts the direct provider URL and opens it
    // externally; its denied child WindowProxy is not a popup-block signal.
    if (!isElectron) {
      browserPopup = window.open('about:blank', '_blank')
      if (!browserPopup) {
        channelResult.value = {
          kind: 'err',
          message: 'Your browser blocked the Google sign-in window. Allow pop-ups for Story Studio and connect again.',
        }
        return
      }
      browserPopup.opener = null
    }
    const started = await post<{ flow_id: string; auth_url: string }>(
      '/youtube/connections/channels/connect',
      expectedChannelId ? { expected_channel_id: expectedChannelId } : {},
    )
    if (isElectron) window.open(started.auth_url, '_blank', 'noopener')
    else browserPopup!.location.replace(started.auth_url)
    const outcome = await pollConnect(started.flow_id)
    if (outcome.status === 'abandoned') return
    if (outcome.status === 'success') {
      channelResult.value = outcome.scope_upgrade_required
        ? { kind: 'warn', message: `${outcome.channel.channel_title} connected, but Google granted fewer permissions than Story Studio needs. Reconnect and accept all of them.` }
        : { kind: 'ok', message: `${outcome.channel.channel_title} connected.` }
    } else {
      channelResult.value = { kind: 'err', message: outcome.error || 'The channel was not connected.' }
    }
    await load()
  } catch (error: any) {
    browserPopup?.close()
    channelResult.value = { kind: 'err', message: messageOf(error, 'Could not start the channel connection.') }
  } finally {
    busy.value = ''
  }
}

async function pollConnect(flowId: string): Promise<any> {
  // The flow itself times out server-side; this only stops asking. Leaving the
  // page stops it immediately rather than polling for five more minutes into a
  // component nobody is looking at.
  for (let attempt = 0; attempt < 300 && !unmounted; attempt++) {
    const status = await get<any>(`/youtube/connections/channels/connect/${flowId}`)
    if (status.status !== 'pending') return status
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (unmounted) return { status: 'abandoned' }
  return { status: 'error', error: 'Story Studio stopped waiting for Google. Try connecting again.' }
}

async function disconnect(channel: ChannelView): Promise<void> {
  if (!await ask({
    title: `Disconnect ${channel.title}?`,
    message: (channel.assigned_project_slug
      ? `${channel.assigned_project_slug} will have no channel until one is assigned. Videos already published stay on YouTube and keep their history.`
      : 'Videos already published stay on YouTube and keep their history.')
      + ' Story Studio removes only the local credential. Manage the Google grant in your Google Account permissions.',
    confirmLabel: 'Disconnect',
    danger: true,
  })) return

  busy.value = 'disconnect'
  channelResult.value = null
  try {
    await del(`/youtube/connections/channels/${encodeURIComponent(channel.channel_id)}`)
    channelResult.value = { kind: 'ok', message: `${channel.title} disconnected.` }
    await load()
  } catch (error: any) {
    channelResult.value = { kind: 'err', message: messageOf(error, 'Could not disconnect that channel.') }
  } finally {
    busy.value = ''
  }
}

async function assign(): Promise<void> {
  const next = assignmentDraft.value
  if (!next) return
  if (assignment.value && !await ask({
    title: 'Replace this project’s channel?',
    message: `${props.slug} will publish to ${titleOf(next)} instead of ${titleOf(assignment.value.channel_id)}. `
      + 'Videos already published stay attached to the channel that published them.',
    confirmLabel: 'Replace channel',
    danger: true,
  })) return

  busy.value = 'assign'
  assignmentResult.value = null
  try {
    await put(`/projects/${props.slug}/youtube/assignment`, {
      channel_id: next,
      expected_previous_channel_id: assignment.value?.channel_id ?? null,
    })
    assignmentResult.value = { kind: 'ok', message: `${props.slug} now publishes to ${titleOf(next)}.` }
    await load()
  } catch (error: any) {
    assignmentResult.value = { kind: 'err', message: messageOf(error, 'Could not assign that channel.') }
  } finally {
    busy.value = ''
  }
}

async function release(): Promise<void> {
  const current = assignment.value
  if (!current) return
  if (!await ask({
    title: 'Release this project’s channel?',
    message: `${props.slug} will keep working locally but cannot read or change YouTube until a channel is assigned.`,
    confirmLabel: 'Release channel',
    danger: true,
  })) return

  busy.value = 'release'
  assignmentResult.value = null
  try {
    await del(`/projects/${props.slug}/youtube/assignment`, { body: { expected_channel_id: current.channel_id } })
    assignmentResult.value = { kind: 'ok', message: 'Channel released.' }
    await load()
  } catch (error: any) {
    assignmentResult.value = { kind: 'err', message: messageOf(error, 'Could not release that channel.') }
  } finally {
    busy.value = ''
  }
}

onMounted(load)
onUnmounted(() => { unmounted = true })
</script>

<style scoped>
.youtube-connection-settings {
  container-name: youtube-connection-settings;
  container-type: inline-size;
  display: grid;
  min-width: 0;
  gap: 14px;
}
header h3, .panel h4 { margin: 3px 0; }
header p, .panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.panel { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.hint { color: var(--text-muted); font-size: var(--font-xs); }
.optional { font-weight: 400; color: var(--text-muted); text-transform: none; letter-spacing: 0; }

.fields { display: grid; gap: 7px; }
.fields label { margin-top: 4px; font-size: var(--font-xs); font-weight: 700; color: var(--text-secondary); }
.field-row { display: flex; flex-wrap: wrap; gap: 7px; }
.field-row .input { min-width: 0; flex: 1; }

.facts { display: grid; gap: 6px; margin: 0; }
.facts > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.facts dt, .facts dd { margin: 0; font-size: var(--font-xs); }
.facts dd { color: var(--text-secondary); overflow-wrap: anywhere; text-align: right; }

.channel-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.channel { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.channel > * { min-width: 0; }
.channel-identity { display: grid; gap: 2px; }
.channel-identity strong { overflow-wrap: anywhere; }
.handle { color: var(--text-secondary); font-size: var(--font-xs); }
.channel-id { color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.channel-state { display: grid; gap: 3px; }
.channel-actions { display: flex; flex-wrap: wrap; gap: 6px; }

.badge { justify-self: start; padding: 2px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 700; }
.badge.connected { background: rgba(80, 160, 120, .16); color: var(--success); }
.badge.reconnect_required { background: rgba(217, 119, 6, .16); color: var(--warning, #d97706); }
.badge.scope_upgrade_required { background: rgba(217, 119, 6, .16); color: var(--warning, #d97706); }

.assigned { margin: 0; display: grid; gap: 2px; }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }
.security-note { color: var(--text-muted); font-size: var(--font-xs); }

@container youtube-connection-settings (max-width: 720px) {
  .channel { grid-template-columns: 1fr; }
  .channel-actions .btn { flex: 1 1 auto; }
}
</style>
