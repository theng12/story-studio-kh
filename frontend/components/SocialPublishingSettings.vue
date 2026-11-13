<template>
  <div class="social-publishing-settings">
    <header>
      <h3>{{ scope === 'channel' ? `Where ${slug} posts` : 'Facebook, Instagram and TikTok accounts on this Mac' }}</h3>
      <p v-if="scope === 'channel'">
        Tick the platforms this channel posts to. Every upload still asks, and nothing posts unless you tick it there.
      </p>
      <p v-else>
        Story Studio never posts anywhere you have not connected and ticked. One Meta application serves both
        Facebook and Instagram; TikTok has its own.
      </p>
    </header>

    <p v-if="loading" class="hint">Loading the publishing connections…</p>
    <p v-else-if="loadError" class="result err" role="alert">{{ loadError }}</p>

    <template v-else>
      <section v-if="scope !== 'channel'" v-for="provider in PROVIDERS" :key="provider.id" class="panel application">
        <div>
          <span class="eyebrow">{{ provider.label }} application</span>
          <p v-if="!applications[provider.id]" class="hint">{{ provider.setup }}</p>
          <p v-else-if="!applications[provider.id].has_client_secret" class="hint">
            The saved secret is no longer available. Enter it again before connecting an account.
          </p>
          <p v-else class="hint">
            Required permissions: <code>{{ applications[provider.id].required_scopes.join(', ') }}</code>
          </p>
        </div>

        <dl v-if="applications[provider.id]" class="facts">
          <div><dt>Client ID</dt><dd>{{ applications[provider.id].client_id }}</dd></div>
          <div><dt>Redirect URI</dt><dd>{{ applications[provider.id].redirect_uri }}</dd></div>
          <div><dt>Client secret</dt><dd>{{ applications[provider.id].has_client_secret ? 'Saved' : 'Not set' }}</dd></div>
        </dl>

        <div class="fields">
          <label :for="`${provider.id}-client-id`">Client ID{{ provider.id === 'tiktok' ? ' (client key)' : '' }}</label>
          <input
            :id="`${provider.id}-client-id`" v-model="drafts[provider.id].clientId" class="input" type="text"
            autocomplete="off" spellcheck="false"
          />
          <label :for="`${provider.id}-client-secret`">Client secret</label>
          <input
            :id="`${provider.id}-client-secret`" v-model="drafts[provider.id].clientSecret" class="input" type="password"
            autocomplete="off" spellcheck="false" placeholder="Write-only — never shown again"
          />
          <label :for="`${provider.id}-redirect`">Redirect URI</label>
          <input
            :id="`${provider.id}-redirect`" v-model="drafts[provider.id].redirectUri" class="input" type="text"
            autocomplete="off" spellcheck="false" :placeholder="provider.redirectHint"
          />
          <div class="field-row">
            <button
              class="btn btn-primary btn-sm" type="button"
              :disabled="busy !== '' || !drafts[provider.id].clientId.trim() || !drafts[provider.id].clientSecret.trim()"
              @click="saveApplication(provider.id)"
            >
              {{ busy === `app-${provider.id}` ? 'Saving…' : 'Save Application' }}
            </button>
            <button
              class="btn btn-sm" type="button"
              :disabled="busy !== '' || !applications[provider.id]?.has_client_secret"
              @click="connect(provider.id)"
            >
              {{ busy === `connect-${provider.id}` ? 'Waiting…' : 'Connect an Account' }}
            </button>
          </div>
        </div>
        <p v-if="results[provider.id]" :class="['result', results[provider.id].kind]">{{ results[provider.id].message }}</p>
      </section>

      <section v-if="scope !== 'channel'" class="panel">
        <div>
          <span class="eyebrow">Connected accounts</span>
          <p v-if="!accounts.length" class="hint">No account is connected yet. Nothing will post anywhere until one is.</p>
        </div>
        <ul v-if="accounts.length" class="account-list">
          <li v-for="account in accounts" :key="`${account.platform}:${account.remote_id}`" class="account">
            <div class="account-identity">
              <strong>{{ account.remote_name }}</strong>
              <span class="muted">{{ platformLabel(account.platform) }} · {{ account.remote_id }}</span>
            </div>
            <span :class="['badge', account.status]">{{ account.status === 'connected' ? 'Connected' : 'Reconnect required' }}</span>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="disconnect(account)">
              Disconnect
            </button>
          </li>
        </ul>
      </section>

      <section v-if="scope === 'channel'" class="panel">
        <div>
          <span class="eyebrow">Platforms</span>
          <p>A ticked platform is pre-ticked on every upload for this channel. You can still untick it per upload.</p>
        </div>
        <ul class="platform-list">
          <li v-for="platform in platforms" :key="platform.platform" class="platform-row">
            <label class="platform-choice">
              <input
                type="checkbox" :checked="chosen.includes(platform.platform)"
                :disabled="busy !== '' || !accountFor(platform.platform)"
                @change="togglePlatform(platform.platform)"
              />
              <span><strong>{{ platform.label }}</strong></span>
            </label>
            <span v-if="!accountFor(platform.platform)" class="hint">
              No {{ platform.label }} account is connected. <a href="#connections" @click="$emit('open-connections')">Connect one</a>.
            </span>
            <span v-else class="hint">{{ accountFor(platform.platform)?.remote_name }}</span>
          </li>
        </ul>
        <p v-if="channelResult" :class="['result', channelResult.kind]">{{ channelResult.message }}</p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

const props = withDefaults(defineProps<{ slug?: string; scope?: 'connections' | 'channel' }>(), {
  scope: 'connections',
})
defineEmits<{ (event: 'open-connections'): void }>()

const { get, put, post, del } = useApi()
const { ask } = useConfirm()

interface ApplicationView {
  provider: string
  client_id: string
  redirect_uri: string
  has_client_secret: boolean
  required_scopes: string[]
}
interface AccountView {
  platform: 'facebook' | 'instagram' | 'tiktok'
  remote_id: string
  remote_name: string
  status: 'connected' | 'reconnect_required'
}

const PROVIDERS = [
  {
    id: 'meta' as const,
    label: 'Meta',
    setup: 'Create a Meta app with Facebook Login and the Instagram Graph API, then paste its client ID and secret here.',
    redirectHint: 'http://127.0.0.1:41234/callback',
  },
  {
    id: 'tiktok' as const,
    label: 'TikTok',
    setup: 'Create a TikTok app with Login Kit and the Content Posting API, then paste its client key and secret here.',
    redirectHint: 'http://127.0.0.1:41235/callback',
  },
]

const loading = ref(true)
const loadError = ref('')
const busy = ref('')
const applications = ref<Record<string, ApplicationView | undefined>>({})
const accounts = ref<AccountView[]>([])
const platforms = ref<Array<{ platform: AccountView['platform']; label: string }>>([])
const chosen = ref<AccountView['platform'][]>([])
const channelAccounts = ref<Record<string, string | null>>({})
const channelResult = ref<{ kind: string; message: string } | null>(null)
const results = reactive<Record<string, { kind: string; message: string } | undefined>>({})
const drafts = reactive<Record<string, { clientId: string; clientSecret: string; redirectUri: string }>>({
  meta: { clientId: '', clientSecret: '', redirectUri: 'http://127.0.0.1:41234/callback' },
  tiktok: { clientId: '', clientSecret: '', redirectUri: 'http://127.0.0.1:41235/callback' },
})

function platformLabel(platform: string): string {
  return platforms.value.find(entry => entry.platform === platform)?.label || platform
}

function accountFor(platform: AccountView['platform']): AccountView | undefined {
  const id = channelAccounts.value[platform]
  if (!id) return undefined
  return accounts.value.find(account => account.platform === platform && account.remote_id === id)
}

function messageOf(error: any, fallback: string): string {
  return error?.data?.detail || error?.data?.message || error?.message || fallback
}

async function load(): Promise<void> {
  loadError.value = ''
  try {
    if (props.scope === 'connections') {
      const connections = await get<{
        applications: Record<string, ApplicationView | undefined>
        accounts: AccountView[]
        platforms: Array<{ platform: AccountView['platform']; label: string }>
      }>('/social/connections')
      applications.value = connections.applications
      accounts.value = connections.accounts
      platforms.value = connections.platforms
      for (const provider of PROVIDERS) {
        const saved = connections.applications[provider.id]
        if (!saved) continue
        drafts[provider.id].clientId = saved.client_id
        drafts[provider.id].redirectUri = saved.redirect_uri
      }
    } else {
      if (!props.slug) throw new Error('Choose a channel before changing where it posts.')
      const [settings, connections] = await Promise.all([
        get<{ platforms: AccountView['platform'][]; accounts: Array<{ platform: AccountView['platform']; account_id: string | null }> }>(
          `/projects/${props.slug}/social/settings`,
        ),
        get<{ accounts: AccountView[]; platforms: Array<{ platform: AccountView['platform']; label: string }> }>('/social/connections'),
      ])
      chosen.value = [...settings.platforms]
      accounts.value = connections.accounts
      platforms.value = connections.platforms
      channelAccounts.value = Object.fromEntries(settings.accounts.map(entry => [entry.platform, entry.account_id]))
    }
  } catch (error: any) {
    loadError.value = messageOf(error, 'Could not load the publishing connections.')
  } finally {
    loading.value = false
  }
}

async function saveApplication(provider: 'meta' | 'tiktok'): Promise<void> {
  busy.value = `app-${provider}`
  results[provider] = undefined
  try {
    const saved = await put<{ invalidated_accounts: number }>(`/social/connections/applications/${provider}`, {
      client_id: drafts[provider].clientId.trim(),
      client_secret: drafts[provider].clientSecret,
      redirect_uri: drafts[provider].redirectUri.trim(),
    })
    drafts[provider].clientSecret = ''
    results[provider] = {
      kind: saved.invalidated_accounts ? 'warn' : 'ok',
      message: saved.invalidated_accounts
        ? `Application saved. ${saved.invalidated_accounts} account(s) need reconnecting.`
        : 'Application saved. Connect an account next.',
    }
    await load()
  } catch (error: any) {
    results[provider] = { kind: 'err', message: messageOf(error, 'Could not save the application.') }
  } finally {
    busy.value = ''
  }
}

async function connect(provider: 'meta' | 'tiktok'): Promise<void> {
  busy.value = `connect-${provider}`
  results[provider] = undefined
  let popup: Window | null = null
  try {
    const isElectron = (window as any).electron?.isElectron === true
    if (!isElectron) {
      popup = window.open('about:blank', '_blank')
      if (!popup) {
        results[provider] = { kind: 'err', message: 'Your browser blocked the sign-in window. Allow pop-ups and try again.' }
        return
      }
      popup.opener = null
    }
    const started = await post<{ flow_id: string; auth_url: string }>(`/social/connections/${provider}/connect`, {})
    if (isElectron) window.open(started.auth_url, '_blank', 'noopener')
    else popup!.location.replace(started.auth_url)

    let outcome: any = { status: 'error', error: 'Story Studio stopped waiting. Try connecting again.' }
    for (let attempt = 0; attempt < 300; attempt++) {
      outcome = await get<any>(`/social/connections/connect/${started.flow_id}`)
      if (outcome.status !== 'pending') break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    if (outcome.status === 'success') {
      const names = (outcome.result?.accounts || []).map((account: any) => `${account.remote_name}`).join(', ')
      results[provider] = { kind: 'ok', message: `${names || 'Account'} connected.` }
    } else {
      results[provider] = { kind: 'err', message: outcome.error || 'The account was not connected.' }
    }
    await load()
  } catch (error: any) {
    popup?.close()
    results[provider] = { kind: 'err', message: messageOf(error, 'Could not start the account connection.') }
  } finally {
    busy.value = ''
  }
}

async function disconnect(account: AccountView): Promise<void> {
  if (!await ask({
    title: `Disconnect ${account.remote_name}?`,
    message: 'Story Studio removes only the local sign-in. Posts already published stay on the platform, and the platform’s own permissions page is where the grant itself is removed.',
    confirmLabel: 'Disconnect',
    danger: true,
  })) return
  busy.value = 'disconnect'
  try {
    await del(`/social/connections/accounts/${account.platform}/${encodeURIComponent(account.remote_id)}`)
    await load()
  } catch (error: any) {
    loadError.value = messageOf(error, 'Could not disconnect that account.')
  } finally {
    busy.value = ''
  }
}

async function togglePlatform(platform: AccountView['platform']): Promise<void> {
  const next = chosen.value.includes(platform)
    ? chosen.value.filter(entry => entry !== platform)
    : [...chosen.value, platform]
  busy.value = 'channel'
  channelResult.value = null
  try {
    await put(`/projects/${props.slug}/social/settings`, { platforms: next })
    chosen.value = next
    channelResult.value = {
      kind: 'ok',
      message: next.length ? `New uploads are pre-ticked for ${next.map(platformLabel).join(', ')}.` : 'This channel posts nowhere unless you tick a platform on an upload.',
    }
  } catch (error: any) {
    channelResult.value = { kind: 'err', message: messageOf(error, 'Could not save this channel’s posting choice.') }
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<style scoped>
.social-publishing-settings { container-name: social-publishing; container-type: inline-size; display: grid; min-width: 0; gap: 14px; }
header h3, .panel h4 { margin: 3px 0; }
header p, .panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.panel { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.hint { color: var(--text-muted); font-size: var(--font-xs); }
.fields { display: grid; gap: 7px; }
.fields label { margin-top: 4px; font-size: var(--font-xs); font-weight: 700; color: var(--text-secondary); }
.field-row { display: flex; flex-wrap: wrap; gap: 7px; }
.facts { display: grid; gap: 6px; margin: 0; }
.facts > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.facts dt, .facts dd { margin: 0; font-size: var(--font-xs); }
.facts dd { color: var(--text-secondary); overflow-wrap: anywhere; text-align: right; }
.account-list, .platform-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.account, .platform-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.platform-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); }
.account-identity { display: grid; gap: 2px; }
.badge { justify-self: start; padding: 2px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 700; }
.badge.connected { background: rgba(80, 160, 120, .16); color: var(--success); }
.badge.reconnect_required { background: rgba(217, 119, 6, .16); color: var(--warning, #d97706); }
.platform-choice { display: flex; align-items: center; gap: 8px; }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }
@container social-publishing (max-width: 720px) { .account { grid-template-columns: 1fr; } }
</style>
