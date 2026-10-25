<template>
  <div class="home-page">
    <header class="home-header">
      <NuxtLink to="/" class="home-brand" aria-label="Story Studio home">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="1.5" />
          <path d="M15.5 12a5.5 5.5 0 0 1-9 4.24A7 7 0 0 0 12 5a5.5 5.5 0 0 1 3.5 7Z" fill="var(--accent)" opacity=".65" />
        </svg>
        <span>
          <strong>Story Studio KH</strong>
          <small>Channels and production</small>
        </span>
      </NuxtLink>

      <nav class="home-actions" aria-label="Application">
        <NuxtLink to="/publishing" class="home-action">Publishing</NuxtLink>
        <NuxtLink to="/content-store" class="home-action">Content Store</NuxtLink>
        <NuxtLink to="/usage" class="home-action">Usage</NuxtLink>
        <NuxtLink to="/trash" class="home-action">Trash</NuxtLink>
        <button type="button" class="home-action" @click="appSettingsModal.open()">Settings</button>
      </nav>
    </header>

    <main class="home-main">
      <section class="home-intro" aria-labelledby="home-title">
        <div>
          <span class="home-eyebrow">Production workspace</span>
          <h1 id="home-title">Your channels</h1>
          <p>Open a channel to continue production, or create a clean workspace for a new series.</p>
        </div>
        <button type="button" class="btn btn-primary home-create" @click="openCreate">New Channel</button>
      </section>

      <section v-if="loading && projects.length === 0" class="home-state" aria-live="polite">
        <LoadingSpinner size="sm" />
        <p>Loading channels…</p>
      </section>

      <section v-else-if="projectsLoadError && projects.length === 0" class="home-state" role="alert">
        <!-- v1.4.3 — a Library that is configured but not there is NOT an empty
             channel list, and it is not a dead backend either. Reconnecting the
             drive is the first thing to try, so Try again leads; choosing a new
             Library is deliberately the quieter option, because someone who
             re-points the app while a drive is merely unplugged loses track of
             where their work actually is. -->
        <span class="state-kicker">{{ libraryMissing ? 'Library not available' : 'Couldn’t load channels' }}</span>
        <h2>{{ libraryMissing ? 'Story Studio can’t find your Library' : 'Story Studio is not responding yet' }}</h2>
        <p>{{ projectsLoadError }}</p>
        <p v-if="libraryMissingPath" class="home-state-path"><code>{{ libraryMissingPath }}</code></p>
        <div class="home-state-actions">
          <button type="button" class="btn btn-primary" :disabled="projectsRetrying" @click="retryLoadProjects">
            <LoadingSpinner v-if="projectsRetrying" size="sm" />
            {{ projectsRetrying ? 'Checking…' : (libraryMissing ? 'It’s Connected Now — Look Again' : 'Try Again') }}
          </button>
          <!-- v1.4.6 — the way out. Without this he was stuck: with the Library
               gone there are no projects, so Settings (which lives under
               /projects/:slug) could not be opened, and the welcome screen
               bounced him straight back here. Deliberately the QUIETER of the
               two actions — reconnecting a drive is nearly always the right
               move, and re-pointing while it is merely unplugged is how someone
               loses track of where their work actually is. -->
          <NuxtLink v-if="libraryMissing" to="/welcome" class="btn btn-secondary">
            Choose a Different Folder…
          </NuxtLink>
        </div>
      </section>

      <section v-else-if="projects.length === 0" class="home-state home-empty">
        <span class="state-kicker">Start here</span>
        <h2>Create your first channel</h2>
        <p>Choose a name and optional Series Formula. Story Studio will create the continuity workflow and take you straight to its dashboard.</p>
        <button type="button" class="btn btn-primary" @click="openCreate">Create Channel</button>
      </section>

      <section v-if="projects.length" aria-labelledby="channels-heading">
        <div class="channel-list-header">
          <h2 id="channels-heading">Channels</h2>
          <span>{{ projects.length }} {{ projects.length === 1 ? 'channel' : 'channels' }}</span>
          <!-- Deliberately quiet, and deliberately not a spinner over the list.
               The rows are usable while this is up; the only thing it changes is
               that a slow read is visible instead of invisible. -->
          <span v-if="refreshingChannels" class="channel-refreshing" aria-live="polite">Refreshing…</span>
        </div>

        <p v-if="showingUnconfirmedChannels" class="channel-stale-notice" role="status">
          <span>{{ projectsLoadError }} Showing the channels from your last visit until Story Studio answers.</span>
          <span class="channel-stale-actions">
            <button type="button" class="btn btn-sm" :disabled="projectsRetrying" @click="retryLoadProjects">
              {{ projectsRetrying ? 'Checking…' : 'Try Again' }}
            </button>
            <!-- The same way out the blank-state branch offers. Without it,
                 having a remembered list would COST the user the escape hatch
                 that a first-time visitor gets — the cache is meant to add a
                 painted list, never to take away a route out of a stuck app. -->
            <NuxtLink v-if="libraryMissing" to="/welcome" class="btn btn-sm btn-secondary">
              Choose a Different Folder…
            </NuxtLink>
          </span>
        </p>

        <div class="project-grid">
          <div v-for="project in projects" :key="String(project.slug || project.name)" class="project-card-wrap">
            <NuxtLink
              v-if="projectHref(project)"
              :to="projectHref(project)"
              class="project-card"
              :aria-label="`Open ${project.name || project.slug}`"
            >
              <!-- The channel's own banner, when it has one. Decorative: the card
                   already names the channel, so the image carries no text of its own. -->
              <span v-if="bannerUrl(project)" class="project-banner">
                <img :src="bannerUrl(project)" alt="" @error="markArtFailed(project, 'banner', bannerUrl(project))" />
              </span>
              <span class="project-card-top">
                <span class="project-mark" aria-hidden="true">
                  <img v-if="logoUrl(project)" :src="logoUrl(project)" alt="" @error="markArtFailed(project, 'logo', logoUrl(project))" />
                  <template v-else>{{ projectInitials(project) }}</template>
                </span>
                <!-- v1.4.2 — a project whose episode folder does not resolve used
                     to render exactly like a healthy one while every episode
                     silently vanished inside. The app already knew; it just never
                     said. A missing folder outranks "Setup needed", because
                     nothing else about the project matters until it is found. -->
                <span
                  v-if="isFolderUnreadable(project)"
                  class="project-status project-status-missing"
                >Can't read this channel's folder</span>
                <span
                  v-else-if="project.output_root_exists === false"
                  class="project-status project-status-missing"
                >Folder missing</span>
                <!-- This pill only says whether a Gateway API Key is saved. It is
                     not a readiness check, so it must not read like one. -->
                <span v-else class="project-status" :data-ready="Boolean(project.has_api_keys)">
                  {{ project.has_api_keys ? 'Key connected' : 'Needs Gateway API Key' }}
                </span>
              </span>
              <span class="project-copy">
                <strong>{{ project.name || project.slug }}</strong>
                <span v-if="isFolderUnreadable(project)" class="project-missing-path">
                  This folder did not answer in time. Check that its drive is connected, then reload.
                </span>
                <span v-else-if="project.output_root_exists === false" class="project-missing-path">
                  Episodes folder not found:
                  <code>{{ project.output_root }}</code>
                </span>
                <template v-else>
                  <span>Episode codes: {{ project.episode_prefix || 'EP' }}… · Created {{ formatDate(project.created_at) }}</span>
                  <!-- Counts come from a cheap per-channel read (no episode folders
                       are scanned) and arrive after the list, so each card says what
                       it is doing instead of showing a number that might be a guess. -->
                  <span v-if="countsView(project)" class="project-counts" aria-live="polite">
                    <template v-for="(part, i) in countsView(project)!.parts" :key="i">
                      <span v-if="i > 0" aria-hidden="true"> · </span>
                      <span :class="{ 'project-counts-warn': part.warn }">{{ part.text }}</span>
                    </template>
                  </span>
                </template>
              </span>
              <span class="project-open" aria-hidden="true">Open channel <span>→</span></span>
            </NuxtLink>

            <div v-else class="project-card project-card-disabled" aria-disabled="true">
              <span class="project-copy">
                <strong>{{ project.name || 'Unavailable channel' }}</strong>
                <span>This channel does not have a valid project identifier.</span>
              </span>
            </div>

            <!-- Outside the card link on purpose: a link inside a link is not a
                 link, it is a trap for the keyboard and for the screen reader. -->
            <NuxtLink
              v-if="projectHref(project)"
              class="project-edit"
              :to="`/projects/${projectSlug(project.slug)}/settings#identity`"
            >Edit profile</NuxtLink>
          </div>
        </div>

        <!-- v1.4.2 — the way back from "Hide project".
             The restore UI was removed with the rest of the home page on
             2026-08-08, but Settings still offers "Hide project (keep files)"
             and hiding a project in the projects folder writes a tombstone that
             the folder scan obeys. With no UI to clear it, hiding was a ONE-WAY
             DOOR: the files were safe on disk and unreachable from the app
             forever. The backend routes and their tests were untouched, so this
             is wiring rather than new machinery. -->
        <div v-if="hiddenProjects.items.value.length || hiddenProjects.lastError.value" class="hidden-projects">
          <p v-if="hiddenProjects.lastError.value" class="notice-error" role="alert">{{ hiddenProjects.lastError.value }}</p>
          <button
            v-if="hiddenProjects.items.value.length"
            type="button"
            class="hidden-projects-chip"
            :aria-expanded="showHidden"
            @click="showHidden = !showHidden"
          >
            🗑️ Hidden channels ({{ hiddenProjects.items.value.length }})
            <span class="ds-chevron" aria-hidden="true" :class="{ 'is-open': showHidden }" />
          </button>
          <div v-if="showHidden && hiddenProjects.items.value.length" class="hidden-projects-list">
            <p class="hidden-projects-note">
              Hidden channels are removed from the list above. Every file is still on disk —
              restoring one puts it back exactly as it was.
            </p>
            <div v-for="row in hiddenProjects.items.value" :key="row.slug" class="hidden-project-row">
              <span class="hidden-project-name">
                <strong>{{ row.name || row.slug }}</strong>
                <code>{{ row.path }}</code>
                <em v-if="!row.exists">folder no longer on disk</em>
              </span>
              <span class="hidden-project-actions">
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  :disabled="row.exists === false || !!restoringSlug"
                  @click="restoreHidden(row.slug)"
                >{{ restoringSlug === row.slug ? 'Restoring…' : 'Restore' }}</button>
              </span>
            </div>
          </div>
        </div>
      </section>
    </main>

    <Modal
      :visible="showCreate"
      size="lg"
      labelledby="create-channel-title"
      @close="closeCreate"
    >
      <form class="create-form" @submit.prevent="createProject">
        <div class="create-heading">
          <span class="home-eyebrow">New workspace</span>
          <h2 id="create-channel-title">Create channel</h2>
          <p>Name the series and choose its repeatable promise. Everything else can be set inside the channel.</p>
        </div>

        <div class="form-group">
          <label for="channel-name">Channel name</label>
          <input
            id="channel-name"
            ref="channelNameInput"
            v-model="form.name"
            class="input"
            placeholder="My channel"
            autocomplete="off"
            required
          />
        </div>

        <!-- Owner ruling, 2026-10-25: the Formula is a required step, with an
             explicit Generic choice so "no Formula" is never accidental. The
             Generic option records a deliberate choice (§6) rather than leaving
             the same blank a channel that never chose has. -->
        <fieldset class="formula-choice" :disabled="creating">
          <legend>Series Formula <span class="formula-required-badge">required</span></legend>
          <p class="formula-choice-hint">
            The repeatable promise every episode follows — its hook, title grammar, script structure and narrator voice.
            A channel's scene rhythm is never decided here; it stays an episode choice in Scene Plan.
          </p>

          <label class="formula-choice-card" :class="{ selected: form.formula_choice === 'formula' }">
            <input
              v-model="form.formula_choice"
              type="radio"
              value="formula"
              name="formula-choice"
            />
            <span>
              <strong>Choose a Series Formula</strong>
              <small>Pick from the installed Formulas below. Recommended for every real channel.</small>
            </span>
          </label>

          <label class="formula-choice-card" :class="{ selected: form.formula_choice === 'generic' }">
            <input
              v-model="form.formula_choice"
              type="radio"
              value="generic"
              name="formula-choice"
              @change="chooseGeneric"
            />
            <span>
              <strong>Generic — no Formula</strong>
              <small>
                For testing only. The channel gets no repeatable hook or title grammar; each episode's
                rhythm is still chosen in Scene Plan. This is a deliberate choice, and it is remembered.
              </small>
            </span>
          </label>
        </fieldset>

        <div v-if="form.formula_choice === 'formula'" class="formula-picker">
          <NichePicker v-model="form.niche_id" :allow-empty="false" :disabled="creating" />
          <p v-if="!form.niche_id" class="formula-required-note">
            Pick a Formula to continue, or switch to Generic above.
          </p>
        </div>
        <p v-else-if="form.formula_choice === 'generic'" class="formula-generic-note" role="status">
          This channel will be created without a Series Formula. You can add one later in Settings → Channel.
        </p>
        <p v-else class="formula-required-note">
          Choose a Series Formula or Generic to continue.
        </p>

        <div class="form-group">
          <label for="content-language">Audience language</label>
          <select id="content-language" v-model="form.content_language" class="input" :disabled="creating">
            <option value="">Not set (legacy prompts)</option>
            <option v-for="option in CONTENT_LANGUAGE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </div>

        <details class="naming-options disclosure">
          <summary>Episode naming options</summary>
          <div class="naming-grid">
            <div class="form-group">
              <label for="episode-prefix">Episode prefix</label>
              <input id="episode-prefix" v-model="form.episode_prefix" class="input" placeholder="EP" />
            </div>
            <div class="form-group">
              <label for="group-label">Group label</label>
              <input id="group-label" v-model="form.season_prefix" class="input" placeholder="Season" />
            </div>
            <div class="form-group">
              <label for="group-size">Episodes per group</label>
              <input id="group-size" v-model.number="form.season_size" class="input" type="number" min="1" max="999" />
            </div>
          </div>
        </details>

        <p v-if="createError" class="create-error" role="alert">{{ createError }}</p>

        <div class="create-actions">
          <button type="button" class="btn btn-secondary" :disabled="creating" @click="closeCreate">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="!form.name.trim() || !formulaChoiceMade || creating">
            <LoadingSpinner v-if="creating" size="sm" />
            {{ creating ? 'Creating…' : 'Create channel' }}
          </button>
        </div>
      </form>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { projectSlug } from '~/utils/project-slug'
import { readLastKnownList, writeLastKnownList } from '~/utils/last-known-list'
import { CONTENT_LANGUAGE_OPTIONS } from '~/utils/content-language'

useAppTitle()

const { get, post } = useApi()
const appSettingsModal = useAppSettingsModal()

/**
 * The channel list paints from the last known one, then reconciles.
 *
 * This page used to start empty and hold a full-screen spinner until `/projects`
 * answered. That read walks every channel folder on disk, and when the machine
 * is also rendering video the disk is saturated — so the first thing the owner
 * saw on opening his own app during a render was "Loading channels…" for as long
 * as the disk took, with no way to tell a slow read from a dead one.
 *
 * The channel list is the one thing on this page that is almost never different
 * from last time, so it is exactly the thing worth showing immediately. The
 * server read still runs on every visit and still wins: anything it returns
 * replaces what was painted. A true first run has no cache and gets the spinner
 * it always got.
 */
const LAST_KNOWN_CHANNELS = 'channels'
const cachedChannels = readLastKnownList<any>(LAST_KNOWN_CHANNELS)
const projects = ref<any[]>(cachedChannels)
// A channel folder whose read timed out is still listed, with a status other
// than 'ready'. Only an explicit non-ready status counts: a list
// cached by an older version has no status at all and must not read as broken.
function isFolderUnreadable(project: { status?: string }): boolean {
  return !!project.status && project.status !== 'ready'
}
const loading = ref(true)
const projectsLoadError = ref('')
const projectsRetrying = ref(false)
const libraryMissing = ref(false)
const libraryMissingPath = ref('')

// v1.4.2 — hidden channels. `useSoftDeletedProjects` and its backend routes
// survived the 2026-08-08 home-page collapse with their tests; only the UI that
// called them was removed, which turned "Hide project" into a one-way door.
const hiddenProjects = useSoftDeletedProjects()
const showHidden = ref(false)

const restoringSlug = ref('')

async function restoreHidden(slug: string) {
  if (restoringSlug.value) return
  restoringSlug.value = slug
  hiddenProjects.lastError.value = ''
  try {
    if (await hiddenProjects.restore(slug)) {
      // Re-read the live list too: restoring clears the tombstone, so the channel
      // must reappear above without a manual reload.
      await loadProjects()
    }
  } finally {
    restoringSlug.value = ''
  }
}
const showCreate = ref(false)
const creating = ref(false)
const createError = ref('')
const channelNameInput = ref<HTMLInputElement | null>(null)

const form = reactive({
  name: '',
  episode_prefix: 'EP',
  season_prefix: 'Season',
  season_size: 20,
  niche_id: '',
  /** '' = not chosen yet; 'formula' = a Formula must be picked; 'generic' = deliberate no-Formula. */
  formula_choice: '' as '' | 'formula' | 'generic',
  content_language: '',
})

/** The choice is made only when it has an answer behind it, not merely a tab. */
const formulaChoiceMade = computed(() => (
  form.formula_choice === 'generic'
  || (form.formula_choice === 'formula' && !!form.niche_id)
))

function chooseGeneric(): void {
  // A deliberate Generic choice replaces any half-picked Formula, so the
  // payload cannot carry both (AGENTS §4: replace, never leave the old value).
  form.niche_id = ''
}

function errorMessage(error: any, fallback: string): string {
  return error?.data?.detail || error?.message || fallback
}

/** A quiet line above the list while a read is in flight behind painted rows. */
const refreshingChannels = computed(() => loading.value && projects.value.length > 0)
/**
 * The read failed but rows are on screen from the cache.
 *
 * This has to be said out loud. Painting a remembered list and then staying
 * silent when the read fails is the worse failure of the two: the page would
 * look perfectly healthy while showing something nobody had confirmed. The rows
 * stay — they are still the best guess, and they are still clickable — but the
 * page admits what it is showing and offers the retry.
 */
const showingUnconfirmedChannels = computed(() => (
  !loading.value && !!projectsLoadError.value && projects.value.length > 0
))

async function loadProjects(): Promise<void> {
  loading.value = true
  try {
    const fresh = await get<any[]>('/projects', { cache: 'no-store' })
    projects.value = fresh
    void loadChannelCounts(fresh)
    void loadChannelProfiles(fresh)
    // Reconciled, not merged. Whatever the server just said is the whole truth
    // about which channels exist — a channel deleted elsewhere must disappear
    // here, so the cache is REPLACED rather than added to.
    writeLastKnownList(LAST_KNOWN_CHANNELS, fresh)
    projectsLoadError.value = ''
    libraryMissing.value = false
    libraryMissingPath.value = ''
  } catch (error: any) {
    // v1.4.3 — the backend answers 409 LIBRARY_UNAVAILABLE when the Library was
    // chosen and is not there. Distinct from an unreachable backend, and the
    // path it looked for is the whole point of the message.
    const data = error?.data
    if (data?.code === 'LIBRARY_UNAVAILABLE') {
      libraryMissing.value = true
      libraryMissingPath.value = data.library_path || ''
      projectsLoadError.value = data.detail || 'Your Library is not available.'
    } else {
      libraryMissing.value = false
      libraryMissingPath.value = ''
      projectsLoadError.value = errorMessage(error, 'Unable to reach the local Story Studio service.')
    }
  } finally {
    loading.value = false
  }
}

async function retryLoadProjects(): Promise<void> {
  if (projectsRetrying.value) return
  projectsRetrying.value = true
  try {
    await loadProjects()
  } finally {
    projectsRetrying.value = false
  }
}

// Episode counts per channel card. A card's entry exists only while that channel
// is on screen and healthy, so nothing leaks between cards or outlives a refresh.
interface ChannelCounts { episodes: number; on_youtube: number | null; in_progress: number; needs_attention: number }
type CountsEntry = { state: 'loading' } | { state: 'error' } | { state: 'ok'; counts: ChannelCounts }
const channelCounts = ref<Record<string, CountsEntry>>({})
let countsRun = 0

function hasReadableFolder(project: { status?: string; output_root_exists?: boolean }): boolean {
  return !isFolderUnreadable(project) && project.output_root_exists !== false
}

async function loadChannelCounts(list: any[]): Promise<void> {
  const run = ++countsRun
  const slugs = list.filter(hasReadableFolder).map(project => projectSlug(project?.slug)).filter(Boolean)
  channelCounts.value = Object.fromEntries(slugs.map(slug => [slug, { state: 'loading' } as CountsEntry]))
  await Promise.all(slugs.map(async (slug) => {
    let entry: CountsEntry
    try {
      entry = { state: 'ok', counts: await get<ChannelCounts>(`/projects/${slug}/channel-counts`, { cache: 'no-store' }) }
    } catch {
      entry = { state: 'error' }
    }
    // A newer list replaced this one while the read was in flight: drop the answer.
    if (run === countsRun) channelCounts.value = { ...channelCounts.value, [slug]: entry }
  }))
}

function countsView(project: any): { parts: Array<{ text: string; warn?: boolean }> } | null {
  const entry = channelCounts.value[projectSlug(project?.slug)]
  if (!entry) return null
  if (entry.state === 'loading') return { parts: [{ text: 'Counting episodes…' }] }
  if (entry.state === 'error') return { parts: [{ text: 'Episode counts unavailable right now' }] }
  const c = entry.counts
  if (c.episodes === 0) return { parts: [{ text: 'No episodes yet' }] }
  const parts: Array<{ text: string; warn?: boolean }> = [
    { text: `${c.episodes} ${c.episodes === 1 ? 'episode' : 'episodes'}` },
    { text: c.on_youtube === null ? 'YouTube count unavailable' : `${c.on_youtube} on YouTube` },
  ]
  if (c.in_progress > 0) parts.push({ text: `${c.in_progress} being made now` })
  if (c.needs_attention > 0) parts.push({ text: `${c.needs_attention} ${c.needs_attention === 1 ? 'needs' : 'need'} attention`, warn: true })
  return { parts }
}

/**
 * The channel profile — its logo and banner — read per channel.
 *
 * The channel list itself carries no art, so each card's picture is a second,
 * small read. A channel that cannot answer one loses its picture and keeps
 * its initials; it must not take the page down with it.
 */
interface ChannelProfile {
  name: string
  handle: string
  description: string
  logo_url: string | null
  banner_url: string | null
}
const channelProfiles = ref<Record<string, ChannelProfile | null>>({})
let profileRun = 0

async function loadChannelProfiles(list: any[]): Promise<void> {
  const run = ++profileRun
  const slugs = list.map(project => projectSlug(project?.slug)).filter(Boolean) as string[]
  const entries = await Promise.all(slugs.map(async (slug) => {
    try {
      const profile = await get<ChannelProfile>(`/projects/${slug}/channel-profile`)
      return [slug, profile] as const
    } catch {
      return [slug, null] as const
    }
  }))
  // A newer list replaced this one while the reads were in flight: drop the answers.
  if (run !== profileRun) return
  channelProfiles.value = Object.fromEntries(entries)
}

function profileOf(project: any): ChannelProfile | null {
  const slug = projectSlug(project?.slug)
  if (!slug) return null
  return channelProfiles.value[slug] || null
}

/**
 * Art whose file is gone must not paint a broken-image icon on the card. The
 * failure is keyed by slug, kind and URL, so new art (a new digest) and a
 * different channel each start clean.
 */
const failedArt = reactive<Record<string, boolean>>({})
function artKey(slug: string, kind: 'logo' | 'banner', url: string): string {
  return `${slug}|${kind}|${url}`
}
function markArtFailed(project: any, kind: 'logo' | 'banner', url: string): void {
  const slug = projectSlug(project?.slug)
  if (!slug) return
  failedArt[artKey(slug, kind, url)] = true
}
function logoUrl(project: any): string {
  const slug = projectSlug(project?.slug)
  const url = profileOf(project)?.logo_url
  if (!slug || !url) return ''
  return failedArt[artKey(slug, 'logo', url)] ? '' : url
}
function bannerUrl(project: any): string {
  const slug = projectSlug(project?.slug)
  const url = profileOf(project)?.banner_url
  if (!slug || !url) return ''
  return failedArt[artKey(slug, 'banner', url)] ? '' : url
}

function projectHref(project: { slug?: unknown }): string {
  const slug = projectSlug(project?.slug)
  return slug ? `/projects/${slug}` : ''
}

function projectInitials(project: { name?: unknown; slug?: unknown }): string {
  const name = String(project.name || project.slug || 'SS').trim()
  return name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || 'SS'
}

function formatDate(value: unknown): string {
  const date = new Date(String(value || ''))
  return Number.isNaN(date.getTime())
    ? 'recently'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function resetForm(): void {
  Object.assign(form, {
    name: '',
    episode_prefix: 'EP',
    season_prefix: 'Season',
    season_size: 20,
    niche_id: '',
    formula_choice: '',
    content_language: '',
  })
  createError.value = ''
}

function openCreate(): void {
  resetForm()
  showCreate.value = true
  nextTick(() => channelNameInput.value?.focus())
}

function closeCreate(): void {
  if (creating.value) return
  showCreate.value = false
  resetForm()
}

async function createProject(): Promise<void> {
  const name = form.name.trim()
  if (!name || !formulaChoiceMade.value || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const project = await post<any>('/projects', {
      name,
      episode_prefix: form.episode_prefix.trim() || 'EP',
      season_prefix: form.season_prefix.trim() || 'Season',
      season_size: Math.max(1, Number(form.season_size) || 20),
      niche_id: form.formula_choice === 'formula' ? form.niche_id || undefined : undefined,
      // Sent on every create the wizard makes: 'selected' when a Formula is
      // behind the choice, 'generic' when the customer deliberately chose none.
      formula_choice: form.formula_choice === 'generic' ? 'generic' : 'selected',
      content_language: form.content_language || undefined,
    })
    const href = projectHref(project)
    if (!href) throw new Error('The new channel did not return a valid project identifier.')
    showCreate.value = false
    await navigateTo(href)
  } catch (error: any) {
    createError.value = errorMessage(error, 'Could not create the channel.')
  } finally {
    creating.value = false
  }
}

onMounted(async () => {
  await loadProjects()
  // Never fatal: a failure here must not stop the channel list rendering.
  await hiddenProjects.refresh().catch(() => {})
})
</script>

<style scoped>
.home-page {
  min-height: 100dvh;
  background:
    radial-gradient(circle at 88% 4%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 28%),
    var(--bg-primary);
}

.home-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 68px;
  padding: 12px clamp(18px, 4vw, 56px);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-secondary) 92%, transparent);
}

.home-brand {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  color: var(--text-primary);
}

.home-brand span,
.project-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.home-brand strong { font-size: var(--font-lg); }
.home-brand small { color: var(--text-secondary); font-size: var(--font-xs); }

.home-actions { display: flex; gap: 8px; }
.home-action {
  min-height: 38px;
  padding: 8px 13px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  cursor: pointer;
}
.home-action:hover { border-color: var(--border); background: var(--bg-hover); color: var(--text-primary); }

.home-main {
  width: min(1180px, calc(100% - 36px));
  margin: 0 auto;
  padding: clamp(38px, 7vw, 86px) 0 64px;
}

.home-intro {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin-bottom: 34px;
}
.home-eyebrow,
.state-kicker {
  display: block;
  margin-bottom: 8px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 750;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.home-intro h1 { font-size: clamp(34px, 5vw, 54px); line-height: 1.05; letter-spacing: -.04em; }
.home-intro p,
.create-heading p { max-width: 650px; margin-top: 12px; color: var(--text-secondary); font-size: var(--font-lg); line-height: 1.6; }
.home-create { min-height: 44px; flex: 0 0 auto; }

.channel-list-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
}
.channel-list-header h2 { flex: 1; font-size: var(--font-xl); }
.channel-list-header span { color: var(--text-secondary); font-size: var(--font-sm); }
/* Quiet on purpose. A read that is merely slow is not news; a read that is slow
   and invisible is what made the app look frozen. */
.channel-list-header .channel-refreshing { color: var(--text-muted); font-size: var(--font-xs); font-style: italic; }

/* Rows on screen that nobody has confirmed. Warning-weight rather than muted,
   because the whole point is that the page must not look healthy while it is
   showing a remembered list. */
.channel-stale-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 14px;
  padding: 9px 11px;
  border-left: 2px solid var(--warning, #d97706);
  border-radius: var(--radius-sm, 4px);
  background: color-mix(in srgb, var(--warning, #d97706) 8%, transparent);
  color: var(--text-primary);
  font-size: var(--font-sm);
  line-height: 1.45;
}
.channel-stale-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }

.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
  gap: 14px;
}
.project-card-wrap { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
.project-card {
  display: flex;
  min-width: 0;
  min-height: 190px;
  flex-direction: column;
  justify-content: space-between;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  box-shadow: var(--shadow);
  color: var(--text-primary);
  overflow: hidden;
  transition: border-color var(--motion-fast), transform var(--motion-fast), box-shadow var(--motion-fast);
}
.project-card:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); color: var(--text-primary); transform: translateY(-2px); box-shadow: var(--shadow-lg); }
.project-card:focus-visible,
.home-action:focus-visible { outline: none; box-shadow: var(--focus-ring); }
/* The channel's own banner, bled to the card's edges. */
.project-banner {
  display: block;
  height: 72px;
  margin: -20px -20px 16px;
  background: var(--bg-tertiary, var(--bg-primary));
}
.project-banner img { display: block; width: 100%; height: 100%; object-fit: cover; }
.project-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.project-mark {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border-radius: 12px;
  background: var(--accent-dim);
  color: var(--accent);
  font-weight: 800;
  letter-spacing: -.02em;
}
.project-mark img { display: block; width: 100%; height: 100%; object-fit: cover; }
.project-status {
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
  border-radius: 999px;
  color: var(--warning);
  font-size: var(--font-xs);
  font-weight: 650;
}
.project-status[data-ready='true'] { border-color: color-mix(in srgb, var(--success) 35%, var(--border)); color: var(--success); }
/* v1.4.2 — a project whose episodes folder cannot be found. Deliberately the
   loudest state on the card: everything else is cosmetic until it is fixed. */
.project-status-missing {
  border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
  color: var(--warning);
}
.project-missing-path {
  color: var(--warning);
  overflow-wrap: anywhere;
}
.project-missing-path code { font-family: ui-monospace, monospace; }

/* v1.4.2 — hidden channels. Deliberately quiet: this is a recovery route, not
   a place to spend attention, so it stays a chip until asked to open. */
.hidden-projects { margin-top: 20px; }
.hidden-projects-chip {
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  display: inline-flex;
  gap: 8px;
  padding: 6px 12px;
}
.hidden-projects-chip:hover { color: var(--text-primary); border-color: var(--accent); }
.hidden-projects-list { margin-top: 12px; }
.hidden-projects-note { color: var(--text-secondary); margin-bottom: 8px; }
.hidden-project-row {
  align-items: center;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 12px;
  justify-content: space-between;
  padding: 10px 0;
}
.hidden-project-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hidden-project-name code { color: var(--text-secondary); overflow-wrap: anywhere; }
.hidden-project-name em { color: var(--warning); font-style: normal; }

.home-state-path { margin-top: 8px; }
.home-state-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.home-state-path code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.notice-error { margin-top: 10px; padding: 10px 12px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--error) 11%, transparent); color: var(--error); }
.project-copy { gap: 4px; }
.project-copy strong { overflow-wrap: anywhere; font-size: var(--font-xl); }
.project-copy span { color: var(--text-secondary); font-size: var(--font-sm); }
.project-copy .project-counts { margin-top: 4px; overflow-wrap: anywhere; }
.project-copy .project-counts .project-counts-warn { color: var(--warning); font-weight: 650; }
.project-open { display: flex; justify-content: space-between; color: var(--accent); font-size: var(--font-sm); font-weight: 650; }
/* The edit route lives outside the card's own link — a link inside a link is a
   trap, not a shortcut. */
.project-edit {
  align-self: flex-start;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  text-decoration: underline;
}
.project-edit:hover { color: var(--text-primary); }
.project-edit:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: var(--radius-sm); }
.project-card-disabled { justify-content: center; opacity: .7; }

.home-state {
  display: flex;
  min-height: 310px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 40px;
  border: 1px dashed var(--border-light);
  border-radius: var(--radius-xl);
  background: color-mix(in srgb, var(--bg-secondary) 82%, transparent);
  text-align: center;
}
.home-state h2 { font-size: var(--font-2xl); }
.home-state p { max-width: 600px; color: var(--text-secondary); }

.create-form { display: grid; gap: 22px; }
.create-heading h2 { font-size: 28px; }
.create-heading p { font-size: var(--font-md); }
.formula-choice {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
}
.formula-choice legend {
  padding: 0;
  color: var(--text-primary);
  font-weight: 650;
}
.formula-required-badge {
  margin-left: 8px;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: 999px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.formula-choice-hint { margin: 2px 0 4px; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.5; }
.formula-choice-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  cursor: pointer;
}
.formula-choice-card.selected {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  box-shadow: var(--focus-ring);
}
.formula-choice-card input { margin-top: 3px; accent-color: var(--accent); }
.formula-choice-card span { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.formula-choice-card strong { font-size: var(--font-md); }
.formula-choice-card small { color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.5; }
.formula-picker { display: grid; gap: 8px; }
.formula-required-note {
  margin: 0;
  padding: 8px 10px;
  border-left: 2px solid var(--warning, #d8a23c);
  border-radius: var(--radius-sm, 4px);
  background: color-mix(in srgb, var(--warning, #d8a23c) 8%, transparent);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.45;
}
.formula-generic-note { margin: 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.naming-options { border-top: 1px solid var(--border); padding-top: 16px; }
.naming-options summary { color: var(--text-secondary); cursor: pointer; font-weight: 650; }
.naming-options[open] summary { margin-bottom: 14px; color: var(--text-primary); }
.naming-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.create-error { padding: 10px 12px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--error) 11%, transparent); color: var(--error); }
.create-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 4px; }

@media (max-width: 680px) {
  .home-header { align-items: flex-start; }
  .home-brand small { display: none; }
  .home-main { width: min(100% - 24px, 1180px); padding-top: 28px; }
  .home-intro { align-items: stretch; flex-direction: column; margin-bottom: 24px; }
  .home-create { width: 100%; justify-content: center; }
  .project-grid,
  .naming-grid { grid-template-columns: 1fr; }
  .home-state { min-height: 260px; padding: 26px 18px; }
}
</style>
