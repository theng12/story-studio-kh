<template>
  <div class="home-page page-frame">

    <main class="home-main">
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
        <!-- One line: the title, how many channels it means, and the controls
             that change what you see (owner, 2026-10-30: "a small title and
             count share one line with search, sort, a Cards / List switch and
             New Channel"). The old "Production workspace / Your channels" block
             is gone; it said nothing the list did not say. -->
        <div class="channels-head">
          <div class="channels-head-title">
            <h1 id="channels-heading">Channels</h1>
            <span class="channels-count">{{ channelCountLine }}</span>
            <span v-if="refreshingChannels" class="channel-refreshing" aria-live="polite">Refreshing…</span>
          </div>
          <div class="channel-tools">
            <div class="channel-search">
              <svg class="channel-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.8" />
                <path d="m15.5 15.5 4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
              <input
                id="channel-search"
                ref="searchInput"
                v-model="search"
                class="channel-search-field"
                type="search"
                placeholder="Search channels"
                aria-label="Search channels by name, label, Formula or language"
                autocomplete="off"
                spellcheck="false"
              />
              <kbd v-if="!search" class="channel-search-key" aria-hidden="true">/</kbd>
              <button v-else type="button" class="channel-search-clear" aria-label="Clear the search" @click="search = ''">&times;</button>
            </div>
            <label class="channel-sort" for="channel-sort" :title="CHANNEL_SORT_HINTS[sort]">
              <span>Sort</span>
              <select id="channel-sort" v-model="sort" class="input channel-sort-select" :title="CHANNEL_SORT_HINTS[sort]">
                <option v-for="option in CHANNEL_SORTS" :key="option" :value="option">
                  {{ CHANNEL_SORT_LABELS[option] }}
                </option>
              </select>
            </label>
            <div class="channel-view-switch" role="group" aria-label="How channels are shown">
              <button
                type="button"
                class="channel-view-button"
                :class="{ active: viewMode === 'cards' }"
                :aria-pressed="viewMode === 'cards'"
                title="Show channels as cards"
                @click="viewMode = 'cards'"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>
              </button>
              <button
                type="button"
                class="channel-view-button"
                :class="{ active: viewMode === 'list' }"
                :aria-pressed="viewMode === 'list'"
                title="Show channels as a list"
                @click="viewMode = 'list'"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="2" width="13" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="6.5" width="13" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="11" width="13" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>
              </button>
            </div>
            <button type="button" class="btn btn-primary channels-new" @click="openCreate">New Channel</button>
          </div>
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

        <!-- Labels, with how many channels each one would leave. The counts are
             read over the channels the search currently matches, so a chip never
             promises a number the grid cannot show. Several at once means all of
             them — that is what makes two labels a narrowing rather than a
             widening. -->
        <div v-if="labelChips.length" class="channel-label-filter" role="group" aria-label="Filter channels by label">
          <button
            v-for="chip in labelChips"
            :key="chip.label"
            type="button"
            class="label-chip"
            :class="{ 'is-active': chip.selected }"
            :aria-pressed="chip.selected"
            @click="toggleLabel(chip.label)"
          >
            {{ chip.label }} <span class="label-chip-count">{{ chip.count }}</span>
          </button>
          <button
            v-if="activeLabels.length > 1"
            type="button"
            class="label-chip label-chip-quiet"
            @click="clearLabels"
          >Show every label</button>
        </div>

        <div v-if="!visibleProjects.length" class="channel-no-match">
          <span class="state-kicker">No match</span>
          <h3>No channels match</h3>
          <p>{{ noMatchLine }}</p>
          <button type="button" class="btn btn-primary" @click="clearFilters">Clear search and labels</button>
        </div>

        <!-- List view: one compact row per channel. The row itself opens the
             channel; the lesser columns drop at narrow widths so the ones that
             decide anything (name, Formula, being made now) are never squeezed
             out. -->
        <div v-else-if="viewMode === 'list'" class="project-list" role="list">
          <div v-for="project in visibleProjects" :key="`list-${String(project.slug || project.name)}`" class="project-row" role="listitem">
            <NuxtLink
              v-if="projectHref(project)"
              :to="projectHref(project)"
              class="project-row-main"
              :aria-label="`Open ${project.name || project.slug}`"
            >
              <span class="project-row-mark" aria-hidden="true">
                <img v-if="logoUrl(project)" :src="logoUrl(project)" alt="" @error="markArtFailed(project, 'logo', logoUrl(project))" />
                <template v-else>{{ projectInitials(project) }}</template>
              </span>
              <span class="project-row-name">{{ project.name || project.slug }}</span>
              <span class="project-row-fact" :title="formulaLabel(project) || undefined">{{ formulaLabel(project) }}</span>
              <span class="project-row-fact project-row-language">{{ cardLanguage(project) || '—' }}</span>
              <span class="project-row-stats">
                <template v-for="(part, i) in (countsView(project)?.parts || [])" :key="i">
                  <span v-if="i > 0" aria-hidden="true"> · </span>
                  <span :class="{ 'project-counts-warn': part.warn }">{{ part.text }}</span>
                </template>
              </span>
              <span
                v-if="isFolderUnreadable(project) || project.output_root_exists === false"
                class="project-row-key"
                data-ready="false"
              >{{ isFolderUnreadable(project) ? 'Can’t read this channel’s folder' : 'Folder missing' }}</span>
              <span v-else class="project-row-key" :data-ready="Boolean(project.has_api_keys)">
                {{ project.has_api_keys ? 'Key connected' : 'Needs Gateway API Key' }}
              </span>
            </NuxtLink>
            <div class="project-row-actions">
              <NuxtLink class="project-edit" :to="`/projects/${projectSlug(project.slug)}/settings#identity`">Edit profile</NuxtLink>
              <button type="button" class="project-edit project-label-action" @click="openLabels(project)">{{ labelActionText(project) }}</button>
            </div>
          </div>
        </div>

        <div v-else class="project-grid">
          <div v-for="project in visibleProjects" :key="String(project.slug || project.name)" class="project-card-wrap">
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
                <!-- What the channel IS, as opposed to what it is called: the
                     owner's labels, and the audience language when it has one.
                     Both are what the search box reads, so a match always has
                     something on the card to point at. -->
                <!-- Formula and language on one line, the Formula truncating
                     with its full name on hover (owner, 2026-10-30). Labels live
                     in the card's own action row, where you label channels in a
                     row and compare them. -->
                <span class="project-facts">
                  <!-- No name means the row's metadata could not be read (a timed-out
                       folder). That says nothing about its Formula, so nothing is shown
                       rather than an invented "No Formula chosen" (§6). -->
                  <span v-if="formulaLabel(project)" class="project-tag project-formula" data-kind="formula" :title="formulaLabel(project)">{{ formulaLabel(project) }}</span>
                  <!-- The language is skipped when a label already says it: saying
                       "Khmer" twice is noise, not a second fact. -->
                  <span v-if="cardLanguage(project)" class="project-tag project-language" data-kind="language">{{ cardLanguage(project) }}</span>
                </span>
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
                 link, it is a trap for the keyboard and for the screen reader.
                 Labelling a channel is the one thing worth doing from here
                 rather than inside it — you label channels in a row, comparing
                 them, which is exactly what the list is for. -->
            <div v-if="projectHref(project)" class="project-card-actions">
              <NuxtLink
                class="project-edit"
                :to="`/projects/${projectSlug(project.slug)}/settings#identity`"
              >Edit profile</NuxtLink>
              <button
                type="button"
                class="project-edit project-label-action"
                @click="openLabels(project)"
              >{{ labelActionText(project) }}</button>
            </div>
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
          <!-- The slug is the channel's FOLDER name, and the server derives it
               from the name. A derived value that is enforced must also be
               shown, so the customer sees exactly what will be created before
               they press Create (owner rule, AGENTS §1). For a Khmer-only name
               the derived part is "channel-" plus a short id from the name. -->
          <p v-if="slugPreview" class="slug-preview">
            Folder slug: <code>{{ slugPreview }}</code>
            <small>
              This becomes the channel's folder under your Library. It is fixed once the channel exists —
              Story Studio does not rename channel folders.
            </small>
          </p>
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

    <!-- Labelling, from the list itself. The suggestions are every label already
         in use in this Library, so a label is spelled one way — the whole point
         of a label is that clicking its chip finds the same channels twice. -->
    <Modal
      :visible="!!labelTarget"
      size="md"
      labelledby="channel-labels-title"
      @close="closeLabels"
    >
      <form class="create-form" @submit.prevent="saveLabels">
        <div class="create-heading">
          <span class="home-eyebrow">Labels</span>
          <h2 id="channel-labels-title">Labels for {{ labelTargetName }}</h2>
          <p>
            Your own words for what this channel is — “Khmer”, “Sleep”, “History”.
            They show on the card, the list can be searched by them, and the chips
            above the list filter by them.
          </p>
        </div>

        <div class="form-group">
          <label>Labels</label>
          <ChipInput
            v-model="labelDraft"
            :suggestions="labelSuggestionList"
            placeholder="Add a label"
            allow-custom
            :max="MAX_PROJECT_LABELS"
          />
          <small class="channel-labels-hint">
            A label can be up to {{ MAX_PROJECT_LABEL_LENGTH }} characters, and a channel can have up to
            {{ MAX_PROJECT_LABELS }}. Spelling is not case-sensitive: “Sleep” and “sleep” are the same label.
          </small>
        </div>

        <p v-if="labelError" class="create-error" role="alert">{{ labelError }}</p>

        <div class="create-actions">
          <button type="button" class="btn btn-secondary" :disabled="labelSaving" @click="closeLabels">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="labelSaving || !labelsDirty">
            <LoadingSpinner v-if="labelSaving" size="sm" />
            {{ labelSaving ? 'Saving…' : 'Save labels' }}
          </button>
        </div>
      </form>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { projectSlug } from '~/utils/project-slug'
// The slug rule itself — the SAME module the create route uses, so the preview
// below is the value, not a second copy of the rule that can drift.
import { projectSlugBase, uniqueProjectSlug } from '@shared/project-slug'
import { readLastKnownList, writeLastKnownList } from '~/utils/last-known-list'
import { CONTENT_LANGUAGE_OPTIONS } from '~/utils/content-language'
import {
  CHANNEL_SORTS,
  CHANNEL_SORT_LABELS,
  CHANNEL_SORT_HINTS,
  MAX_PROJECT_LABELS,
  MAX_PROJECT_LABEL_LENGTH,
  applyChannelFilters,
  channelLabels,
  formulaLabel,
  isTypingTarget,
  labelCounts,
  labelSuggestions,
  languageLabel,
  normalizeProjectLabels,
  readChannelViewPrefs,
  sameLabel,
  sortChannels,
  type ChannelSort,
  writeChannelViewPrefs,
} from '~/utils/channel-view'

useAppTitle()

const { get, post, put } = useApi()

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

/**
 * The folder slug the server will create for the name typed so far.
 *
 * Computed by the same shared module `project-manager.resolveCreateSlug` uses,
 * against the channel list this page already loaded (hidden channels still own
 * their folder, so their slugs count). `-2` / `-3` is the server's suffix rule,
 * shown rather than applied invisibly later.
 */
const slugPreview = computed(() => {
  const name = form.name.trim()
  if (!name) return ''
  const taken = [
    ...projects.value.map((row: any) => row?.slug),
    ...hiddenProjects.items.value.map((row: any) => row?.slug),
  ].filter((value: unknown): value is string => typeof value === 'string' && !!value)
  return uniqueProjectSlug(projectSlugBase(name), taken)
})

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

/**
 * Finding a channel: the search, the label filter and the sort.
 *
 * All of it is a pure function of the list in `~/utils/channel-view`, and the
 * only thing this page owns is the inputs and the order in which they apply.
 * The result never touches `projects`: filtering is a VIEW of the channel list,
 * so a filtered screen can never feed a filtered list back to the server or the
 * painted cache.
 *
 * The sort and the label filter are remembered across launches; the SEARCH is
 * not. A remembered search is how a channel list appears to have lost channels —
 * you open the page and the list is not the one you expect, with nothing on
 * screen explaining why.
 */
const rememberedView = readChannelViewPrefs()
const search = ref('')
const sort = ref<ChannelSort>(rememberedView.sort)

/**
 * Cards or a list, remembered like the sort and the labels (owner, 2026-10-30:
 * "a Cards / List switch (two small icons, remembered like similar choices,
 * default cards)"). A store that cannot be read leaves the default; it never
 * blocks the page.
 */
const CHANNEL_LAYOUT_KEY = 'story-studio:channels-layout:v1'
function readLayout(): 'cards' | 'list' {
  try {
    return localStorage.getItem(CHANNEL_LAYOUT_KEY) === 'list' ? 'list' : 'cards'
  } catch { return 'cards' }
}
const viewMode = ref<'cards' | 'list'>(readLayout())
watch(viewMode, (now) => {
  try { localStorage.setItem(CHANNEL_LAYOUT_KEY, now) } catch { /* best effort */ }
})
const activeLabels = ref<string[]>(rememberedView.labels)
const searchInput = ref<HTMLInputElement | null>(null)

/** What the search alone leaves. The label counts are read from this, so a chip
 *  never quotes a number the search has already made impossible. */
const searchMatches = computed(() => (
  applyChannelFilters(projects.value, { search: search.value, labels: [] })
))

const visibleProjects = computed(() => (
  sortChannels(applyChannelFilters(projects.value, { search: search.value, labels: activeLabels.value }), sort.value)
))

/**
 * One chip per label in use, selected or not.
 *
 * A selected label that the current search cannot match keeps its chip and
 * reports 0, rather than vanishing: a filter you can no longer see is one you
 * cannot undo, and the grid underneath would be empty with no explanation.
 */
const labelChips = computed(() => {
  const counted = labelCounts(searchMatches.value)
  const chips = counted.map(entry => ({
    label: entry.label,
    count: entry.count,
    selected: activeLabels.value.some(active => sameLabel(active, entry.label)),
  }))
  for (const active of activeLabels.value) {
    if (!chips.some(chip => sameLabel(chip.label, active))) {
      chips.push({ label: active, count: 0, selected: true })
    }
  }
  return chips
})

/** Every label in this Library — the suggestion source for the label editor. */
const libraryLabels = computed(() => labelCounts(projects.value).map(entry => entry.label))

const channelCountLine = computed(() => {
  const total = projects.value.length
  const shown = visibleProjects.value.length
  const noun = total === 1 ? 'channel' : 'channels'
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`
})

const noMatchLine = computed(() => {
  const query = search.value.trim()
  const labels = activeLabels.value
  const said: string[] = []
  if (query) said.push(`matches “${query}”`)
  if (labels.length) said.push(`${said.length ? 'and carries' : 'carries'} ${labels.map(label => `“${label}”`).join(' and ')}`)
  // The sentence names the filters, because the way out is to remove one of
  // them — and the header already says how many channels exist.
  return `No channel ${said.join(' ')}.`
})

function isLabelActive(label: string): boolean {
  return activeLabels.value.some(active => sameLabel(active, label))
}

function toggleLabel(label: string): void {
  const next = isLabelActive(label)
    ? activeLabels.value.filter(active => !sameLabel(active, label))
    : [...activeLabels.value, label]
  activeLabels.value = normalizeProjectLabels(next)
}

function clearLabels(): void {
  activeLabels.value = []
}

function clearFilters(): void {
  search.value = ''
  clearLabels()
}

// Remembered locally, per Mac, the way the app remembers its other view
// preferences. Written on change rather than on unload so a crash costs nothing.
watch([sort, activeLabels], () => {
  writeChannelViewPrefs({ sort: sort.value, labels: activeLabels.value })
}, { deep: true })

/**
 * `/` focuses the search — the shortcut people already have in their fingers.
 *
 * Ignored wherever a person is already typing (an input, a textarea, a rich
 * text host, a select), because there `/` is a character. Modifier keys are left
 * alone: Cmd+/ is somebody else's shortcut, not this one.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
  // Two questions, because they are the same question: where the key was aimed,
  // and where the person actually is. In a real browser those are one element —
  // a key event is aimed at what has focus — so this is belt and braces; it
  // also means a synthesised event carrying no target can never lift focus out
  // of a field someone is typing in.
  if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return
  event.preventDefault()
  searchInput.value?.focus()
  searchInput.value?.select()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

/**
 * Cards carry the Series Formula first, then the owner's labels, then the
 * audience language when it has one.
 *
 * The Formula is what most of the card's other choices follow from, so it leads.
 * Its name is resolved server-side (`formula_name`); a row without one — the
 * last-known-list cache from an older build — shows no Formula tag rather than
 * claiming "No Formula chosen".
 *
 * The language is dropped when a label already says the same word: the owner's
 * Khmer channels are labelled "Khmer", and "Khmer Khmer" on one card reads as a
 * duplicate rather than as two facts. The search still matches the language
 * either way — this is about what is worth reading, not about what is indexed.
 */
/** The audience language, unless one of the channel's own labels already says it. */
function cardLanguage(project: any): string {
  const language = languageLabel(project?.content_language)
  if (!language) return ''
  return channelLabels(project).some(label => sameLabel(label, language)) ? '' : language
}

function cardTags(project: any): Array<{ text: string; kind: 'formula' | 'label' | 'language' }> {
  const tags: Array<{ text: string; kind: 'formula' | 'label' | 'language' }> = []
  const formula = formulaLabel(project)
  if (formula) tags.push({ text: formula, kind: 'formula' })
  const labels = channelLabels(project)
  tags.push(...labels.map(text => ({ text, kind: 'label' as const })))
  const language = languageLabel(project?.content_language)
  if (language && !labels.some(label => sameLabel(label, language))) {
    tags.push({ text: language, kind: 'language' })
  }
  return tags
}

/** "Labels" until it has some, then "Labels · 2" — so the card says whether
 *  there is anything to look at without opening the dialog. */
function labelActionText(project: any): string {
  const count = channelLabels(project).length
  return count ? `Labels · ${count}` : 'Labels'
}

// ── the label editor ───────────────────────────────────────────────────────

const labelTarget = ref<any | null>(null)
const labelDraft = ref<string[]>([])
const labelSaving = ref(false)
const labelError = ref('')

const labelTargetName = computed(() => String(labelTarget.value?.name || labelTarget.value?.slug || ''))
const labelSuggestionList = computed(() => labelSuggestions(libraryLabels.value, labelDraft.value))
/** Dirty by NORMALISED comparison: adding and removing the same label, or adding
 *  a second spelling of one that is already there, is not a change. */
const labelsDirty = computed(() => (
  JSON.stringify(normalizeProjectLabels(labelDraft.value))
  !== JSON.stringify(normalizeProjectLabels(labelTarget.value?.labels))
))

function openLabels(project: any): void {
  labelTarget.value = project
  labelDraft.value = channelLabels(project)
  labelError.value = ''
}

function closeLabels(): void {
  if (labelSaving.value) return
  labelTarget.value = null
  labelDraft.value = []
  labelError.value = ''
}

/**
 * Fold a saved label list back into the row on screen AND into the painted
 * cache, so the chips change the moment the save lands and a reload before the
 * next list read shows what the server just confirmed. The server's own answer
 * is what is stored — its normalising rules are the authority, not ours.
 */
function applySavedLabels(slug: string, labels: string[]): void {
  const row = projects.value.find(candidate => projectSlug(candidate?.slug) === slug)
  if (row) row.labels = labels
  writeLastKnownList(LAST_KNOWN_CHANNELS, projects.value)
}

async function saveLabels(): Promise<void> {
  const target = labelTarget.value
  if (!target || labelSaving.value) return
  const slug = projectSlug(target.slug)
  if (!slug) {
    labelError.value = 'This channel has no valid identifier, so its labels cannot be saved.'
    return
  }
  labelSaving.value = true
  labelError.value = ''
  try {
    const sent = normalizeProjectLabels(labelDraft.value)
    const saved = await put<any>(`/projects/${slug}`, { labels: sent })
    // The server's answer is the authority. A reply that carries no label list
    // at all is not "no labels" — it is a reply we cannot read — so the row keeps
    // what was just sent rather than being blanked by an absence.
    applySavedLabels(slug, Array.isArray(saved?.labels) ? saved.labels : sent)
    labelTarget.value = null
    labelDraft.value = []
  } catch (error: any) {
    // The dialog stays open with what was typed and the server's own words: a
    // refused label (too long, too many) is fixable in place.
    labelError.value = errorMessage(error, 'Could not save the labels.')
  } finally {
    labelSaving.value = false
  }
}

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

/* The shared page frame sets width and gutter now; the page keeps only a
   readable measure for the card grid and the state blocks. */
.home-main {
  width: 100%;
  min-width: 0;
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

.channels-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.channels-head-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.channels-head-title h1 { margin: 0; font-size: var(--font-xl); line-height: 1.2; }
.channels-count { color: var(--text-secondary); font-size: var(--font-sm); }
.channels-head .channel-refreshing { color: var(--text-muted); font-size: var(--font-xs); font-style: italic; }
.channel-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.channel-view-switch { display: inline-flex; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm, 6px); }
.channel-view-button {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.channel-view-button:hover { background: var(--bg-hover); color: var(--text-primary); }
.channel-view-button.active { background: var(--accent-dim); color: var(--text-primary); }
.channels-new { min-height: 34px; }
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
.project-card-wrap {
  display: flex;
  min-width: 0;
  /* Uniform height: every card offers the same slots in the same order, so a
     long name or a banner never makes one card taller than its neighbours. */
  min-height: 268px;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 12px);
  background: var(--bg-secondary);
}
.project-card-wrap:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); box-shadow: var(--shadow-lg); }
.project-card {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  justify-content: space-between;
  padding: 18px 18px 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-primary);
  text-decoration: none;
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
.project-copy strong {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: var(--font-xl);
  line-height: 1.25;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.project-copy span { color: var(--text-secondary); font-size: var(--font-sm); }
.project-copy .project-counts { margin-top: 4px; overflow-wrap: anywhere; }
.project-copy .project-counts .project-counts-warn { color: var(--warning); font-weight: 650; }
.project-open { display: flex; justify-content: space-between; margin-top: 10px; color: var(--accent); font-size: var(--font-sm); font-weight: 650; }

/* Formula and language, one line, Formula truncated with the full name on hover. */
.project-facts { display: flex; min-width: 0; align-items: baseline; gap: 6px; color: var(--text-secondary); font-size: var(--font-sm); }
.project-facts .project-tag { min-width: 0; overflow: hidden; padding: 0; border: 0; background: none; color: inherit; text-overflow: ellipsis; white-space: nowrap; }
.project-formula { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-language { flex: none; color: var(--text-muted); }
.project-language::before { content: '· '; }

/* One compact row per channel. */
.project-list { display: grid; gap: 6px; }
.project-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  background: var(--bg-secondary);
  padding-right: 10px;
}
.project-row:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.project-row-main {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  align-items: center;
  gap: 12px;
  grid-template-columns: 30px minmax(140px, 1.3fr) minmax(120px, 1fr) 48px minmax(160px, 1.4fr) auto;
  padding: 9px 4px 9px 10px;
  color: var(--text-primary);
  text-decoration: none;
}
.project-row-mark {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  overflow: hidden;
  border-radius: 8px;
  background: var(--bg-tertiary, var(--bg-primary));
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 750;
}
.project-row-mark img { width: 100%; height: 100%; object-fit: cover; }
.project-row-name { overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.project-row-fact { overflow: hidden; color: var(--text-secondary); font-size: var(--font-sm); text-overflow: ellipsis; white-space: nowrap; }
.project-row-language { color: var(--text-muted); }
.project-row-stats { overflow: hidden; color: var(--text-secondary); font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }
.project-row-key { color: var(--text-muted); font-size: var(--font-xs); white-space: nowrap; }
.project-row-key[data-ready="false"] { color: var(--warning); }
.project-row-actions { display: flex; flex: none; gap: 10px; }
@media (max-width: 1080px) {
  .project-row-main { grid-template-columns: 30px minmax(120px, 1fr) minmax(110px, 1fr) minmax(140px, 1.2fr) auto; }
  .project-row-language { display: none; }
}
@media (max-width: 820px) {
  .project-row-main { grid-template-columns: 30px minmax(110px, 1fr) minmax(150px, 1fr); }
  .project-row-key { display: none; }
}
@media (max-width: 640px) {
  .project-row-main { grid-template-columns: 30px minmax(0, 1fr); }
  .project-row-fact, .project-row-stats { display: none; }
  .project-row-actions { flex-direction: column; gap: 4px; }
}
/* The edit route lives outside the card's own link — a link inside a link is a
   trap, not a shortcut. */
.project-card-actions {
  display: flex;
  flex: none;
  gap: 14px;
  margin-top: auto;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--border);
}
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
.slug-preview {
  display: grid;
  gap: 2px;
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.45;
}
.slug-preview code {
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow-wrap: anywhere;
}
.slug-preview small { color: var(--text-muted); }
.naming-options { border-top: 1px solid var(--border); padding-top: 16px; }
.naming-options summary { color: var(--text-secondary); cursor: pointer; font-weight: 650; }
.naming-options[open] summary { margin-bottom: 14px; color: var(--text-primary); }
.naming-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.create-error { padding: 10px 12px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--error) 11%, transparent); color: var(--error); }
.create-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 4px; }
.channel-labels-hint { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }

/* ── Finding a channel ─────────────────────────────────────────────────────
   One row, one job per control: the field takes the width because typing is
   what happens here most, and the sort is a fixed control beside it. Both sit
   on the app's own input/surface tokens so this reads as the same family as
   every other filter row in the app. */
.channel-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.channel-search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
}
.channel-search-icon {
  position: absolute;
  left: 11px;
  color: var(--text-muted);
  pointer-events: none;
}
.channel-search-field {
  width: 100%;
  min-height: 38px;
  padding: 8px 40px 8px 33px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-sm);
}
.channel-search-field::placeholder { color: var(--text-muted); }
.channel-search-field:focus { border-color: var(--accent); outline: none; box-shadow: var(--focus-ring); }
/* The native clear button is replaced by ours, so the two never both appear. */
.channel-search-field::-webkit-search-cancel-button { display: none; }
.channel-search-key,
.channel-search-clear {
  position: absolute;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-tertiary, var(--bg-primary));
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1;
}
.channel-search-clear { cursor: pointer; font-size: 15px; }
.channel-search-clear:hover { color: var(--text-primary); border-color: var(--accent); }
.channel-search-clear:focus-visible { outline: none; box-shadow: var(--focus-ring); }

.channel-sort {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  color: var(--text-secondary);
  font-size: var(--font-sm);
}
.channel-sort-select { min-height: 38px; width: auto; }

/* Label chips. Small, quiet, and only as loud as the state they are in —
   the accent fill is reserved for labels that are actually filtering. */
.channel-label-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-bottom: 16px;
}
.label-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 600;
  cursor: pointer;
  transition: border-color var(--motion-fast), background var(--motion-fast), color var(--motion-fast);
}
.label-chip:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); color: var(--text-primary); }
.label-chip:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.label-chip.is-active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.label-chip-count { color: var(--text-muted); font-variant-numeric: tabular-nums; font-weight: 650; }
.label-chip.is-active .label-chip-count { color: color-mix(in srgb, var(--accent) 75%, var(--text-muted)); }
.label-chip-quiet { border-style: dashed; font-weight: 500; }

/* "No channels match" — a state you leave, not a dead end, so it is a quiet
   card with the way out on it rather than the full empty-state treatment. */
.channel-no-match {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 38px 22px;
  border: 1px dashed var(--border-light);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bg-secondary) 70%, transparent);
  text-align: center;
}
.channel-no-match h3 { font-size: var(--font-xl); }
.channel-no-match p { max-width: 520px; color: var(--text-secondary); font-size: var(--font-sm); }
.channel-no-match .btn { margin-top: 4px; }

/* Labels and language on a card. The language is the quieter of the two: it is
   a fact about the channel, not something the owner chose to say about it. */
.project-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.project-tag {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 650;
  line-height: 1.5;
}
/* The Series Formula is a fact about the channel, not one of the owner's own
   labels: a neutral outline rather than the accent-filled label pill, so a card
   never reads "Khmer" and "Pastoral Scripture" as the same kind of word. */
.project-tag[data-kind='formula'] {
  border-color: var(--border);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  color: var(--text-primary);
  font-weight: 600;
}
.project-tag[data-kind='language'] {
  border-color: var(--border);
  background: transparent;
  color: var(--text-muted);
  font-weight: 600;
}

.project-card-actions { display: flex; flex-wrap: wrap; gap: 12px; align-self: flex-start; }
.project-label-action {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
}
.project-label-action:hover { color: var(--text-primary); }

@media (max-width: 680px) {
  .home-header { align-items: flex-start; }
  .home-brand small { display: none; }
  .home-main { width: min(100% - 24px, 1180px); padding-top: 28px; }
  .home-intro { align-items: stretch; flex-direction: column; margin-bottom: 24px; }
  .home-create { width: 100%; justify-content: center; }
  .project-grid,
  .naming-grid { grid-template-columns: 1fr; }
  .home-state { min-height: 260px; padding: 26px 18px; }
  /* The search keeps the width it needs to be usable; the sort drops below it
     rather than being squeezed into a sliver beside it. */
  .channel-tools { align-items: stretch; flex-direction: column; gap: 8px; }
  .channel-sort { justify-content: space-between; }
  .channel-sort-select { flex: 1 1 auto; }
  .channel-search-key { display: none; }
  /* Two rows of chrome must not push the page's own navigation off the screen:
     at 390px the five nav links did not fit beside the brand and "Trash" and
     "Settings" were simply out of sight. */
  .home-header { flex-wrap: wrap; gap: 6px 12px; }
  .home-brand { flex: 1 1 auto; }
  .home-brand strong { white-space: nowrap; }
  .home-actions { flex-wrap: wrap; }
}
</style>
