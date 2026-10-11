<template>
  <div class="settings-workspace">
    <header class="settings-head">
      <h1>Settings</h1>
      <p><span class="key-dot key-machine" /> <strong>This Mac</strong> settings apply to every channel. <span class="key-dot key-project" /> <strong>This Channel</strong> settings belong to <strong>{{ projectForm.name || project?.name || 'this channel' }}</strong>.</p>
    </header>

    <div class="settings-layout">
      <aside class="settings-rail">
        <SettingsSectionNav v-model="activeTab" :zones="tabZones" @go="goToSetting" />
      </aside>

      <div class="settings-content">
        <section
          v-if="activeZone && activeTabMeta"
          :class="['settings-active-intro', activeZone.id === 'machine' ? 'scope-machine' : 'scope-project']"
        >
          <div class="settings-active-copy">
            <h2 :id="activeTab">{{ activeTabMeta.label }}</h2>
            <span
              v-for="targetId in inactiveSettingsHashTargets"
              :id="targetId"
              :key="targetId"
              class="settings-hash-target"
              aria-hidden="true"
            ></span>
            <p>{{ activeTabMeta.description }}</p>
          </div>
          <span class="settings-scope-pill">
            {{ activeZone.id === 'machine' ? 'This Mac' : 'This Channel' }}
          </span>
        </section>

        <!-- ═══ This Mac → Connections ═══ -->
        <template v-if="activeTab === 'connections'">
          <div class="card settings-panel settings-panel-embedded">
            <ThisMacSettings section="connections" embedded />
          </div>
          <div class="card settings-panel settings-panel-embedded" data-setting="youtube-accounts">
            <YouTubeConnectionSettings :slug="slug" scope="connections" />
          </div>
          <div class="card settings-panel settings-panel-embedded" data-setting="scene-analysis"><SceneAnalysisSettings /></div>
          <AdvancedDisclosure label="Advanced: Gateway model catalog" data-setting="gateway-catalog">
            <div class="card settings-panel settings-panel-embedded"><GenStudioCatalogSettings /></div>
          </AdvancedDisclosure>
        </template>

        <!-- ═══ This Mac → Performance & recovery ═══ -->
        <div v-if="activeTab === 'performance'" class="settings-plain">
          <ThisMacSettings section="performance" embedded />
        </div>

        <!-- ═══ This Mac → Appearance & notifications ═══ -->
        <template v-if="activeTab === 'appearance'">
          <div class="settings-plain">
            <ThisMacSettings section="appearance" embedded />
          </div>
    <div class="card settings-panel notification-panel" data-setting="notifications">
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
                    <input v-model="notifSettings.telegram.bot_token" :type="showTelegramToken ? 'text' : 'password'" class="input" placeholder="1234567890:ABCdef…" spellcheck="false" autocomplete="off" />
                    <button type="button" class="btn btn-sm btn-ghost" @click="showTelegramToken = !showTelegramToken">{{ showTelegramToken ? 'Hide' : 'Show' }}</button>
                  </div>
                  <div class="notification-connect-row">
                    <button type="button" class="btn btn-sm btn-secondary" :disabled="telegramDetectBusy || !notifSettings.telegram.bot_token" @click="detectTelegramChatId">
                      {{ telegramDetectBusy ? 'Looking for Your Chat…' : 'Detect My Chat' }}
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
                    {{ telegramTestBusy ? 'Sending Test…' : 'Send Test Message' }}
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
            <button type="button" class="btn btn-sm btn-secondary" :disabled="digestPreviewBusy" @click="loadDigestPreview">{{ digestPreviewBusy ? 'Building Preview…' : 'Preview Brief' }}</button>
            <button type="button" class="btn btn-sm btn-primary" :disabled="digestSendNowBusy || !digestHasReadyDestination" @click="sendDigestNow">{{ digestSendNowBusy ? 'Sending Now…' : 'Send Now' }}</button>
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
        <button type="button" class="btn btn-primary" :disabled="!notificationsDirty || notifSaveStatus === 'saving'" @click="saveNotifSettings">{{ notifSaveStatus === 'saving' ? 'Saving…' : 'Save Notifications' }}</button>
      </div>
    </div>
          <AdvancedDisclosure label="Advanced: open Story Studio from another computer (Server Mode)" data-setting="server-mode">
            <div class="card settings-panel settings-panel-embedded"><ServerModeSettingsPanel /></div>
          </AdvancedDisclosure>
        </template>

        <!-- ═══ This Mac → Files & maintenance ═══ -->
        <template v-if="activeTab === 'maintenance'">
          <!-- v1.4.249 — "Where your files are". Replaces the storage map, Your
               Library, Where finished videos go and Advanced: move uploaded videos
               ("this library and your storage map thing is so confusing"). -->
          <section class="card settings-panel files-where" aria-labelledby="files-where-title">
            <header class="settings-card-head">
              <h3 id="files-where-title">Where your files are</h3>
              <p>Two folders on this Mac. Choose a folder with the button — no paths to type.</p>
            </header>

            <div data-setting="library-folder">
              <FolderField
                :model-value="library?.path || ''"
                label="Library folder"
                hint="Every channel lives here, each with its own files. Choosing another folder copies everything there and restarts Story Studio; the old folder is left untouched."
                picker-title="Choose where to keep your Library"
                picker-button-label="Use This Folder"
                choose-label="Move Library…"
                :disabled="projectsRootBusy"
                @change="moveLibraryTo"
              >
                <template #badge>
                  <span v-if="library && !library.exists" class="status-chip warn">Not found</span>
                </template>
              </FolderField>
              <p v-if="library && !library.exists" class="settings-warn">
                Story Studio looked here and the folder is not there. If it is on a drive that is not plugged in, reconnect it — nothing has been lost.
              </p>
              <p v-if="projectsRootStatus" :class="['settings-status', projectsRootStatusKind]">{{ projectsRootStatus }}</p>
            </div>

            <div data-setting="exports-folder">
              <FolderField
                :model-value="library?.exports_custom ? library.exports_dir : channelExportsDir"
                label="Finished videos folder"
                :hint="library?.exports_custom
                  ? 'New finished videos are saved here. Videos made before you changed it stay where they are and are still found.'
                  : 'Each channel saves its finished videos in its own Exports folder, so copying the channel folder takes them along. Choose another folder — another drive, say — to keep them separate.'"
                picker-title="Choose where finished videos go"
                picker-button-label="Use This Folder"
                :disabled="exportsBusy"
                :clearable="!!library?.exports_custom"
                clear-label="Use Library Folder"
                @change="chooseExportsFolder"
              />
              <p v-if="exportsStatus" :class="['settings-status', exportsStatusKind]">{{ exportsStatus }}</p>
            </div>

          </section>

          <section class="card settings-panel" data-setting="self-contained-all">
            <SelfContainedPanel />
          </section>

          <!-- v1.4.249 — ONE Free Up Space card ("four overlapping ways to free space"):
               the recommended preset first, then the other ways as options of the
               same card, then the read-only "What's using space" view. -->
          <section class="card settings-panel" data-setting="free-up-space">
            <MediaCleanupPanel :slug="slug" />
            <details class="disclosure space-option" data-setting="clear-uploaded-finals">
              <summary><strong>Clear uploaded final videos (verified)</strong><small>Each final video is checked against its YouTube upload, then moved to Story's Trash (Story → Trash). Anything that cannot be checked stays.</small></summary>
              <div class="space-option-body">
                <div class="flex gap-2 items-center">
                  <button v-if="!storage" class="btn btn-secondary btn-sm" :disabled="auditLoading" @click="loadStorageAudit">
                    {{ auditLoading ? 'Checking…' : 'Check Uploaded Videos' }}
                  </button>
                  <button
                    v-else
                    class="btn btn-primary btn-sm"
                    :disabled="bulkRunning || uploadedFinalsTotalBytes === 0"
                    :title="uploadedFinalsTotalBytes === 0 ? 'No verification candidates have local final videos' : `Verify and clear ${uploadedFinalsCount} local final video(s) — up to ${formatBytes(uploadedFinalsTotalBytes)}`"
                    @click="runBulkCleanup"
                  >
                    {{ bulkRunning ? 'Verifying…' : `Clear Uploaded Videos (${formatBytes(uploadedFinalsTotalBytes)})` }}
                  </button>
                  <button v-if="bulkRunning && bulkOperation" class="btn btn-secondary btn-sm" :disabled="bulkOperation.status === 'stopping'" @click="stopBulkCleanup">Stop</button>
                </div>
                <div v-if="bulkRunning && bulkOperation" class="storage-result mt-2" role="status" aria-live="polite">
                  <strong>{{ bulkProgressText }}</strong>
                  <progress v-if="bulkOperation.bytes_total" :value="bulkOperation.bytes_done" :max="bulkOperation.bytes_total" aria-label="Verifying uploaded videos" />
                  <p v-if="bulkOperation.detail" class="text-muted text-xs">{{ bulkOperation.detail }}</p>
                  <p class="text-muted text-xs">Each video is read once to match it with its YouTube upload, then YouTube is asked about it (up to a minute each). You can leave this page; renders keep going.</p>
                </div>
                <p v-if="bulkError" class="error-text mt-2" role="alert">{{ bulkError }}</p>
                <p v-if="storage && uploadedFinalsTotalBytes === 0 && !bulkRunning" class="settings-hint">
                  No uploaded episode has a local final video left to clear.
                </p>
                <div v-if="lastBulkCleanup" class="storage-result mt-2">
                  <strong>Cleanup:</strong>
                  {{ lastBulkCleanup.deleted_count }} file(s) moved to the Trash after verification ({{ formatBytes(lastBulkCleanup.bytes_freed) }}); the space is freed when you empty it on <NuxtLink to="/trash">Story → Trash</NuxtLink>.
                  <span v-if="lastBulkCleanup.skipped_count">{{ lastBulkCleanup.skipped_count }} kept locally (could not verify).</span>
                  <span v-if="lastBulkCleanup.failed_count" class="error-text">{{ lastBulkCleanup.failed_count }} failed.</span>
                  <ul v-if="lastBulkCleanup.items.length" class="cleanup-item-results">
                    <li v-for="item in lastBulkCleanup.items" :key="`${item.episode_code}:${item.file}`">
                      <strong>{{ item.episode_code }}:</strong>
                      {{ item.status === 'deleted' ? 'moved to the Trash after verification' : (item.reason || item.status) }}
                    </li>
                  </ul>
                </div>
                <details class="settings-tech-details disclosure">
                  <summary>Details</summary>
                  <p class="text-muted text-xs">
                    The file's SHA-256 is compared with the accepted upload, and the current processed video on the
                    assigned YouTube channel is refreshed. Unverified or legacy upload records stay local.
                  </p>
                </details>
              </div>
            </details>
            <details class="disclosure space-option" data-setting="move-uploaded" :open="archiveBusy || !!archivePreview || !!archiveResult">
              <summary><strong>Move uploaded videos to another drive</strong><small>Finished videos confirmed on YouTube, from every channel, are copied to a folder you choose and checked there before the original is removed. Everything else stays put.</small></summary>
              <div class="space-option-body">
              <div class="archive-flow">
                <FolderField
                  v-model="archiveSource"
                  label="Look for videos in"
                  placeholder="Your finished videos folder"
                  hint="Usually your finished videos folder. Choose another folder if your videos are somewhere else."
                  picker-title="Where are your finished videos?"
                  picker-button-label="Scan This Folder"
                  :disabled="archiveBusy"
                  @update:model-value="archivePreview = null"
                />
                <FolderField
                  v-model="archiveDest"
                  label="Move them to"
                  placeholder="Choose a folder on the other drive"
                  picker-title="Move finished videos into…"
                  picker-button-label="Move Here"
                  :disabled="archiveBusy"
                />
                <div class="flex gap-2 items-center">
                  <button class="btn btn-secondary btn-sm" :disabled="archiveBusy" @click="loadArchivePreview">
                    {{ archiveChecking ? 'Checking…' : 'Check What Would Move' }}
                  </button>
                  <button v-if="archivePreview?.complete && archivePreview?.ready_count" class="btn btn-primary btn-sm"
                          :disabled="archiveBusy || !archiveDest.trim()" @click="startArchive">
                    Move {{ archivePreview.ready_count }} Video{{ archivePreview.ready_count === 1 ? '' : 's' }} · {{ formatBytes(archivePreview.ready_bytes) }}
                  </button>
                  <button v-if="archiveRunning || archiveChecking" class="btn btn-danger btn-sm" @click="stopArchive">Stop</button>
                </div>
          <div v-if="archivePreview" class="mt-2">
            <p v-if="!archivePreview.source_exists" class="validation-msg text-sm">
              Nothing to scan — <code>{{ archivePreview.source_root }}</code> is not there.
            </p>
            <template v-else>
              <p v-if="!archivePreview.complete" class="validation-msg text-sm">
                Check stopped early. Nothing can move until the folder has been checked completely.
              </p>
              <p class="text-sm">
                <strong>{{ archivePreview.ready_count }}</strong> video(s) ready
                ({{ formatBytes(archivePreview.ready_bytes) }} ready to move),
                <strong>{{ archivePreview.skipped_count }}</strong> skipped
                ({{ formatBytes(archivePreview.skipped_bytes) }} staying put).
              </p>
              <ul v-if="archivePreview.by_channel.length" class="archive-channels">
                <li v-for="c in archivePreview.by_channel" :key="c.slug">
                  {{ c.slug }} — {{ c.count }} video(s), {{ formatBytes(c.bytes) }}
                </li>
              </ul>
              <details v-if="archivePreview.ready_count" class="mt-1 disclosure">
                <summary class="text-sm">Review {{ archivePreview.ready_count }} uploaded videos to move</summary>
                <ul class="archive-skipped">
                  <li v-for="c in archiveReadyRows" :key="c.source_path">
                    <strong>{{ c.slug }} · {{ c.code }}</strong> — <code>{{ c.filename }}</code>
                    · {{ formatBytes(c.bytes) }}
                    <a v-if="c.youtube_video_id" :href="`https://www.youtube.com/watch?v=${encodeURIComponent(c.youtube_video_id)}`"
                       target="_blank" rel="noopener noreferrer">Open recorded YouTube upload</a>
                  </li>
                </ul>
              </details>
              <details v-if="archivePreview.skipped_count" class="mt-1 disclosure">
                <summary class="text-muted text-sm">Why {{ archivePreview.skipped_count }} were skipped</summary>
                <ul class="archive-skipped">
                  <li v-for="c in archiveSkippedRows" :key="c.source_path">
                    <code>{{ c.filename }}</code> — {{ c.reason }}
                  </li>
                </ul>
              </details>
            </template>
          </div>

          <div v-if="archiveChecking || archiveRunning || archiveResult" class="mt-2">
            <p v-if="archiveChecking" class="text-sm">
              Checking {{ archiveProgress.checked }} video file{{ archiveProgress.checked === 1 ? '' : 's' }} —
              <code>{{ archiveProgress.current }}</code>
              <span v-if="archiveStopping"> · stopping after this file…</span>
            </p>
            <p v-else-if="archiveRunning" class="text-sm">
              {{ archiveStage === 'checking' ? 'Rechecking proof' : 'Moving' }} {{ archiveProgress.done }} / {{ archiveProgress.total }} —
              <code>{{ archiveProgress.current }}</code>
              <span v-if="archiveStopping"> · stopping after this file…</span>
            </p>
            <p v-if="archiveResult" class="text-sm">
              ✓ Moved {{ archiveResult.moved.length }} video(s), {{ formatBytes(archiveResult.bytes_moved) }} total.
              <span v-if="archiveResult.cancelled">Stopped early — everything not yet moved is untouched.</span>
              <span v-if="archiveResult.failed.length">
                {{ archiveResult.failed.length }} could not be verified and were left in both places.
              </span>
            </p>
            <ul v-if="archiveResult?.warnings?.length" class="archive-skipped">
              <li v-for="w in archiveResult.warnings" :key="w">{{ w }}</li>
            </ul>
          </div>
              </div>
              </div>
            </details>
            <details class="disclosure space-option" data-setting="episode-storage">
              <summary><strong>What's using space</strong><small>Space used by each episode in this channel, largest first.</small></summary>
              <div class="space-option-body storage-panel">
                <button class="btn btn-secondary btn-sm" :disabled="auditLoading" @click="loadStorageAudit">
                  {{ auditLoading ? 'Scanning…' : (storage ? 'Scan Again' : 'Scan Episodes') }}
                </button>
                <div v-if="storage?.space" class="storage-summary mt-2">
                  <span><strong>Free on this drive:</strong> {{ storage.space.free_bytes === null ? 'could not be measured' : formatBytes(storage.space.free_bytes) }}</span>
                  <span class="dot">·</span>
                  <span title="Everything Story Studio removed from this channel waits in the Trash until you empty it yourself.">
                    <strong>This channel in the Trash:</strong> {{ formatBytes(storage.space.project_trash_bytes) }}
                  </span>
                  <span class="dot">·</span>
                  <span><strong>Whole Trash:</strong> {{ formatBytes(storage.space.library_trash_bytes) }} <NuxtLink to="/trash">Open Trash</NuxtLink></span>
                </div>
                <div v-if="storage" class="storage-summary mt-2">
                  <span><strong>Channel total:</strong> {{ formatBytes(storage.project_bytes_total) }}</span>
                  <span class="dot">·</span>
                  <span><strong>Final videos:</strong> {{ formatBytes(storage.project_bytes_final_video) }}</span>
                  <span class="dot">·</span>
                  <span title="Per-scene motion clips, including the episode's Video Assets folder"><strong>Per-scene clips:</strong> {{ formatBytes(storage.project_bytes_per_scene_clips) }}</span>
                  <span class="dot">·</span>
                  <span title="Kept per-part narration takes (hidden .parts folders), already counted in each episode's audio. They stay until you move them with Free up space › Choose exactly which files › Narration parts.">
                    <strong>Narration parts:</strong> {{ formatBytes(storage.project_bytes_narration_parts ?? 0) }}
                  </span>
                  <span v-if="storage.project_bytes_thumbnail_cache" class="dot">·</span>
                  <span v-if="storage.project_bytes_thumbnail_cache" title="Small previews for the review grids. Safe to delete: they are rebuilt on demand.">
                    <strong>Preview cache:</strong> {{ formatBytes(storage.project_bytes_thumbnail_cache) }}
                  </span>
                  <button
                    v-if="storage.project_bytes_thumbnail_cache"
                    class="btn btn-secondary btn-sm"
                    :disabled="previewCacheClearing"
                    title="Moves the small review-grid previews to Story's Trash. They rebuild automatically as you open Scene Review and Motion Review."
                    @click="clearPreviewCache"
                  >
                    {{ previewCacheClearing ? 'Clearing…' : `Clear Preview Cache (${formatBytes(storage.project_bytes_thumbnail_cache)})` }}
                  </button>
                  <span v-if="storage.external_root_configured" class="dot">·</span>
                  <span v-if="storage.external_root_configured">
                    <strong>In the Exports folder:</strong> {{ formatBytes(storage.project_bytes_external_final_video) }}
                  </span>
                </div>
                <div v-if="lastPreviewCacheClear" class="storage-result mt-2">
                  Preview cache ({{ formatBytes(lastPreviewCacheClear.bytes) }}) moved to Story's Trash.
                  It rebuilds automatically as you use the review pages.
                </div>
                <div v-if="storage" class="storage-table mt-2">
                  <div class="storage-row storage-head">
                    <span class="col-code">Code</span>
                    <span class="col-title">Title</span>
                    <span class="col-final">Final</span>
                    <span class="col-clips">Clips</span>
                    <span class="col-other">Audio + img + other</span>
                    <span class="col-status">Upload</span>
                  </div>
                  <div
                    v-for="row in sortedStorageRows"
                    :key="row.episode_code"
                    :class="['storage-row', { uploaded: row.uploaded_to_youtube, 'no-final': row.bytes_final_video === 0 }]"
                  >
                    <span class="col-code"><strong>{{ row.episode_code }}</strong></span>
                    <span class="col-title" :title="row.title">{{ row.title }}</span>
                    <span class="col-final">
                      {{ formatBytes(row.bytes_final_video) }}
                      <span v-if="row.bytes_external_final_video > 0" class="ext-badge" title="Final video also in the Exports folder">
                        + {{ formatBytes(row.bytes_external_final_video) }} in Exports
                      </span>
                    </span>
                    <span class="col-clips">{{ formatBytes(row.bytes_per_scene_clips) }}</span>
                    <span class="col-other">{{ formatBytes(row.bytes_audio + row.bytes_images + row.bytes_other) }}<small v-if="row.bytes_narration_parts" class="row-reason">incl. {{ formatBytes(row.bytes_narration_parts) }} narration parts</small></span>
                    <span class="col-status">
                      <span v-if="row.cleanup_eligible" class="upload-badge ok" :title="`Candidate for fresh verification against YouTube video ${row.youtube_video_id}`">
                        ✓ verify candidate
                      </span>
                      <span
                        v-else-if="row.uploaded_to_youtube"
                        class="upload-badge warn"
                        :title="`YouTube video ${row.youtube_video_id}`"
                      >
                        ⚠ remains local
                      </span>
                      <small v-if="!row.cleanup_eligible && row.uploaded_to_youtube" class="row-reason">{{ row.cleanup_reason || 'The upload record cannot confirm the YouTube copy, so the local video is kept.' }}</small>
                      <span v-else class="upload-badge none">—</span>
                    </span>
                  </div>
                </div>
              </div>
            </details>
          </section>

          <section class="card settings-panel" data-setting="smaller-files">
            <GenerationCompressionPanel />
          </section>

          <!-- FFmpeg — plain status, one fix button; internals behind Advanced. -->
          <section id="ffmpeg-section" class="card settings-panel ffmpeg-card" data-setting="ffmpeg">
            <header class="settings-card-head">
              <h3>FFmpeg (video engine)</h3>
              <p>Joins narration, mixes music and makes the final MP4 for Audio Assembly and Video Assembly.</p>
            </header>
            <div class="ffmpeg-state" :class="ffmpegState.tone" role="status">
              <span class="ffmpeg-state-dot" aria-hidden="true" />
              <div>
                <strong>{{ ffmpegState.title }}</strong>
                <span v-if="ffmpegState.detail">{{ ffmpegState.detail }}</span>
              </div>
              <button v-if="ffmpegState.fix" class="btn btn-primary btn-sm" :disabled="ffmpegInstalling" @click="installFfmpeg">
                {{ ffmpegInstalling ? `${ffmpegInstallMessage || 'Installing…'} ${ffmpegInstallProgress}%` : ffmpegState.fix }}
              </button>
              <button class="btn btn-ghost btn-sm" :disabled="ffmpegStatusLoading" @click="refreshFfmpegStatus">{{ ffmpegStatusLoading ? 'Checking…' : 'Check Again' }}</button>
            </div>
            <p v-if="ffmpegInstallMessage && !ffmpegInstalling" class="settings-status" :class="ffmpegInstallError ? 'err' : 'ok'">{{ ffmpegInstallMessage }}</p>
            <div v-if="showFfmpegRestartPrompt" class="ffmpeg-restart-prompt">
              <span class="restart-msg"><strong>Install complete.</strong> Restart the app so Audio Assembly and Video Assembly use it.</span>
              <div class="flex gap-2 mt-1">
                <button class="btn btn-sm btn-primary" :disabled="restarting" @click="restartApp">{{ restarting ? 'Restarting…' : 'Restart Now' }}</button>
                <button class="btn btn-sm btn-secondary" @click="showFfmpegRestartPrompt = false">Later</button>
              </div>
            </div>
            <AdvancedDisclosure label="Advanced: FFmpeg details">
              <dl class="ffmpeg-details">
                <dt>Version</dt><dd>{{ ffmpegStatus?.version || '—' }}</dd>
                <dt>Copy in use</dt><dd>{{ ffmpegSourceLabel }}</dd>
                <dt>Location</dt><dd><code>{{ ffmpegStatus?.path || '—' }}</code></dd>
                <dt>Text overlays (drawtext)</dt><dd>{{ ffmpegStatus?.installed ? (ffmpegStatus.has_drawtext ? 'Yes' : 'No') : '—' }}</dd>
                <dt>Subtitle burn-in (libass)</dt><dd>{{ ffmpegStatus?.installed ? (ffmpegStatus.has_libass ? 'Yes' : 'No') : '—' }}</dd>
              </dl>
              <div v-if="ffmpegStatus?.installed && ffmpegStatus.source !== 'bundled' && !ffmpegState.fix" class="mt-2">
                <button class="btn btn-secondary btn-sm" :disabled="ffmpegInstalling" @click="installFfmpeg">Replace Recovery Copy</button>
                <span class="settings-hint"> Downloads the same pinned FFmpeg this app was tested with and checks it before use.</span>
              </div>
        <div v-if="ffmpegInstallError" class="ffmpeg-log-block mt-2">
          <div class="flex gap-2" style="align-items: center;">
            <button class="btn btn-sm btn-secondary" @click="loadInstallLog" :disabled="ffmpegLogLoading" title="Fetches the last hour of ffmpeg-install log entries">
              <span v-if="ffmpegLogLoading">Loading…</span>
              <span v-else-if="ffmpegInstallLog.length">Refresh Log</span>
              <span v-else>Show Install Log</span>
            </button>
            <button v-if="ffmpegInstallLog.length" class="btn btn-sm btn-primary" @click="copyInstallLog" title="Copies the log entries + your platform info to the clipboard so you can paste it into a bug report">
              Copy Log to Clipboard
            </button>
            <span v-if="ffmpegLogCopiedAt" class="text-muted" style="font-size: var(--font-xs);">Copied ✓</span>
          </div>
          <pre v-if="ffmpegInstallLog.length" class="ffmpeg-log-output mt-1">{{ ffmpegInstallLogText }}</pre>
          <p v-else-if="ffmpegInstallLogChecked" class="text-muted mt-1" style="font-size: var(--font-xs);">
            No ffmpeg-install entries in the last hour. The error may have happened before logging was wired up — try clicking Install again.
          </p>
        </div>
              <details v-if="ffmpegStatus && ffmpegStatus.source !== 'bundled'" class="ffmpeg-manual mt-2 disclosure">
                <summary>Install it yourself</summary>
                <p class="settings-hint">If the download is blocked, install FFmpeg with Homebrew (<code>brew install ffmpeg</code>), then press Check Again.</p>
              </details>
            </AdvancedDisclosure>
          </section>

          <section class="card settings-panel about-card" data-setting="about">
            <div>
              <h3>About Story Studio KH</h3>
              <p class="settings-hint">Version <strong>{{ appVersion }}</strong><template v-if="buildDate"> · built {{ buildDate }}</template>. Copy this when you report a problem.</p>
            </div>
            <button class="btn btn-secondary btn-sm" @click="copyVersionString">{{ versionCopied ? 'Copied' : 'Copy Version' }}</button>
          </section>
          <AppUpdatePanel />
        </template>

        <!-- ═══ This Project → Channel identity ═══ -->
        <template v-if="activeTab === 'identity'">
          <section class="card settings-panel" data-setting="formula">
            <header class="settings-card-head">
              <h3>Series Formula and Topic Packs</h3>
              <p>The Formula sets the hook, title style, script flow and voice of every episode. Topic Packs supply subjects.</p>
            </header>
            <section class="channel-identity-summary">
              <div class="channel-identity-summary-copy">
                <span>Series Formula</span>
                <strong>{{ selectedFormulaLabel }}</strong>
                <small>{{ selectedNicheProfile?.description || (nicheId ? 'This saved Formula is currently unavailable from the library.' : 'General generation without a repeatable Formula.') }}</small>
              </div>
              <div class="channel-identity-summary-copy">
                <span>Topic Packs</span>
                <strong>{{ selectedTopicPackLabel }}</strong>
                <small>{{ topicPackIds.length ? 'Reusable subject inventories selected for this channel.' : 'No Topic Packs selected.' }}</small>
              </div>
              <button type="button" class="btn btn-primary" @click="identityPickerOpen = true">Choose Formula &amp; Topics</button>
            </section>
            <div class="button-row"><SaveIndicator v-bind="savedHintProps('niche')" /></div>
          </section>

          <section class="card settings-panel" data-setting="idea-quality">
            <IdeaQualitySettings :slug="slug" />
          </section>

          <section class="card settings-panel" data-setting="project-name">
            <div class="form-group">
              <label>Channel name</label>
              <input v-model="projectForm.name" class="input" />
            </div>
            <div class="flex gap-2" style="align-items:center">
              <button class="btn btn-primary btn-sm" @click="saveProject('identity')">Save Name</button>
              <SaveIndicator v-bind="savedHintProps('project_identity')" />
            </div>
          </section>

          <AdvancedDisclosure :label="`Advanced: custom formulas (${nicheLibraryCount})`" data-setting="custom-formulas">
            <div class="card settings-panel">
        <div class="niche-library-header">
          <button
            class="btn btn-primary btn-sm"
            :disabled="nicheCreateBusy"
            @click="openNicheCreator"
          >Create Custom Formula…</button>
        </div>
        <p class="text-muted text-sm">
          Formulas written on this Mac. Pick one for this channel with <strong>Choose Formula &amp; Topics</strong> above.
        </p>

        <div v-if="nicheLibLoading" class="muted mt-3">Loading niches…</div>
        <div v-else-if="nicheLibError" class="error-box mt-3">{{ nicheLibError }}</div>
        <div v-else-if="!customNicheLibList.length" class="empty-box mt-3">
          No custom formulas yet. Create one here, then select it from the Channel Identity library.
        </div>

        <div v-else class="niche-lib-grid mt-3">
          <article
            v-for="n in customNicheLibList"
            :key="n.id"
            class="niche-lib-tile"
            :class="{ 'tile-builtin': n.builtin, 'tile-custom': !n.builtin, 'tile-active': n.id === nicheId }"
          >
            <div class="tile-header">
              <h5>{{ n.name }}</h5>
              <span v-if="n.id === nicheId" class="badge badge-active">channel niche</span>
              <span class="badge badge-custom">custom</span>
              <span v-if="n.catalog?.version" class="badge">v{{ n.catalog.version }}</span>
            </div>
            <p v-if="n.tagline" class="tile-tagline">{{ n.tagline }}</p>
            <p class="tile-description">{{ n.description }}</p>
            <div class="tile-stats">
              <span><strong>{{ n.exampleTopics.length }}</strong> example {{ n.exampleTopics.length === 1 ? 'topic' : 'topics' }}</span>
              <span v-if="n.vocabulary?.keyword">
                <strong>{{ n.vocabulary.keyword.length }}</strong> keywords
              </span>
              <span v-if="n.titleShapeRules?.length">
                <strong>{{ n.titleShapeRules.length }}</strong> title rules
              </span>
              <span v-if="n.referenceImages?.length">
                <strong>{{ n.referenceImages.length }}</strong> refs
              </span>
              <span v-if="n.project_count">
                in <strong>{{ n.project_count }}</strong> {{ n.project_count === 1 ? 'channel' : 'channels' }}
              </span>
            </div>
            <details class="tile-details disclosure">
              <summary>Example topics</summary>
              <ul class="topic-list">
                <li v-for="t in n.exampleTopics.slice(0, 10)" :key="t">{{ t }}</li>
                <li v-if="n.exampleTopics.length > 10" class="topic-more">+{{ n.exampleTopics.length - 10 }} more</li>
              </ul>
            </details>
            <details v-if="n.visualStyleSheet || n.scriptContext" class="tile-details disclosure">
              <summary>Generator context</summary>
              <div v-if="n.scriptContext" class="detail-row">
                <strong>Script:</strong> {{ n.scriptContext }}
              </div>
              <div v-if="n.visualStyleSheet" class="detail-row">
                <strong>Visual:</strong> {{ n.visualStyleSheet }}
              </div>
            </details>
            <div class="tile-actions">
              <button
                v-if="!n.builtin"
                class="btn btn-ghost btn-sm danger"
                :title="n.project_count ? `Can't delete — ${n.project_count} channel(s) still use this niche.` : 'Delete this custom niche.'"
                :disabled="!!n.project_count"
                @click="confirmDeleteNiche(n)"
              >Delete</button>
            </div>
          </article>
        </div>
            </div>
          </AdvancedDisclosure>
        </template>

        <!-- ═══ This Project → Production defaults ═══ -->
        <template v-if="activeTab === 'production'">
          <section class="card settings-panel" v-if="nicheId">
        <section v-if="nicheId" class="episode-shape-card" data-setting="episode-shape">
          <div class="episode-shape-head">
            <div>
              <h4>How long an episode runs, and how it is read</h4>
              <p class="text-muted text-sm mb-0">
                These are the numbers every new episode of this channel starts from. Change them
                whenever you like — the first change makes this channel its own copy of the Formula,
                so no other channel is affected.
              </p>
            </div>
            <button
              v-if="!shapeOpen"
              class="btn btn-sm btn-secondary"
              @click="openEpisodeShape"
            >Change…</button>
          </div>

          <div v-if="!shapeOpen" class="episode-shape-grid">
            <div class="episode-shape-item">
              <span>Usual length</span>
              <strong>{{ selectedNicheProfile?.scriptStructure?.defaultLengthMinutes ?? 8 }} min</strong>
              <small>
                Allowed {{ selectedNicheProfile?.scriptStructure?.lengthMinutesRange?.[0] ?? 3 }}–{{
                  selectedNicheProfile?.scriptStructure?.lengthMinutesRange?.[1] ?? 20 }} min
              </small>
            </div>
            <div class="episode-shape-item">
              <span>Chapters</span>
              <strong>{{ selectedNicheProfile?.scriptStructure?.defaultChapterCount ?? 5 }}</strong>
              <small>
                Allowed {{ selectedNicheProfile?.scriptStructure?.chapterCountRange?.[0] ?? 1 }}–{{
                  selectedNicheProfile?.scriptStructure?.chapterCountRange?.[1] ?? 20 }}
              </small>
            </div>
            <div class="episode-shape-item">
              <span>Reading pace</span>
              <strong>{{ selectedNicheProfile?.scriptStructure?.defaultWordsPerMinute ?? 160 }} wpm</strong>
              <small>Slower for sleep and prayer, faster for explainers.</small>
            </div>
            <div class="episode-shape-item">
              <span>Chapters</span>
              <strong>{{ selectedNicheProfile?.scriptStructure?.chaptersIndependent ? 'Standalone' : 'One story' }}</strong>
              <small>
                {{ selectedNicheProfile?.scriptStructure?.chaptersIndependent
                  ? 'Each chapter is its own subject, like a list.'
                  : 'Chapters continue into each other.' }}
              </small>
            </div>
          </div>

          <form v-else class="episode-shape-form" @submit.prevent="saveEpisodeShape">
            <div class="episode-shape-fields">
              <label>
                <span>Usual length (minutes)</span>
                <input v-model.number="shapeForm!.defaultLengthMinutes" type="number" min="1" max="600" />
              </label>
              <label>
                <span>Shortest allowed</span>
                <input v-model.number="shapeForm!.minutesMin" type="number" min="1" max="600" />
              </label>
              <label>
                <span>Longest allowed</span>
                <input v-model.number="shapeForm!.minutesMax" type="number" min="1" max="600" />
              </label>
              <label>
                <span>Usual chapters</span>
                <input v-model.number="shapeForm!.defaultChapterCount" type="number" min="1" max="100" />
              </label>
              <label>
                <span>Fewest allowed</span>
                <input v-model.number="shapeForm!.chapterMin" type="number" min="1" max="100" />
              </label>
              <label>
                <span>Most allowed</span>
                <input v-model.number="shapeForm!.chapterMax" type="number" min="1" max="100" />
              </label>
              <label>
                <span>Reading pace (words per minute)</span>
                <input v-model.number="shapeForm!.defaultWordsPerMinute" type="number" min="50" max="300" />
              </label>
            </div>

            <p class="episode-shape-maths text-muted text-sm">
              At these settings an episode is about
              <strong>{{ shapeTotalWords.toLocaleString() }}</strong> words —
              roughly <strong>{{ shapeWordsPerChapter.toLocaleString() }}</strong> per chapter.
            </p>

            <label class="episode-shape-check">
              <input v-model="shapeForm!.chaptersIndependent" type="checkbox" />
              <span>
                Each chapter stands alone
                <small class="text-muted">
                  Tick this for lists and countdowns, where a chapter is its own subject. Leave it
                  clear when the chapters tell one continuing story.
                </small>
              </span>
            </label>

            <label class="episode-shape-tone">
              <span>Title voice</span>
              <textarea
                v-model="shapeForm!.metadataTitleStyleHint"
                rows="2"
                placeholder="Leave empty to use the format's own wording."
              ></textarea>
              <small class="text-muted">
                How titles for this channel should be pitched, in your words — for example
                “Name the creature and the strange fact. No mystery-baiting.”
              </small>
            </label>

            <p v-if="shapeError" class="error-box mt-2">{{ shapeError }}</p>

            <div class="episode-shape-actions">
              <button class="btn btn-sm btn-primary" type="submit" :disabled="shapeSaving">
                {{ shapeSaving ? 'Saving…' : 'Save Episode Shape' }}
              </button>
              <button class="btn btn-sm btn-ghost" type="button" :disabled="shapeSaving" @click="shapeOpen = false">
                Cancel
              </button>
            </div>
          </form>
        </section>
          </section>

          <section class="card settings-panel" data-setting="continuity">
            <header class="settings-card-head">
              <h3>Reference behavior</h3>
              <p>Every channel uses the Continuity Engine. Choose how new episodes use earlier scenes as references; Character Sheet can still change one episode.</p>
            </header>
      <div class="continuity-mode-box">
        <div class="cm-options">
          <label class="cm-opt" :class="{ active: continuityMode === 'independent-stills' }">
            <input v-model="continuityMode" type="radio" value="independent-stills" />
            <div><strong>Independent illustrated scenes</strong><div class="text-muted text-xs">No previous-frame reference. Best for explainers, history, economics, and varied locations.</div></div>
          </label>
          <label class="cm-opt" :class="{ active: continuityMode === 'character-continuity' }">
            <input v-model="continuityMode" type="radio" value="character-continuity" />
            <div><strong>Character continuity</strong><div class="text-muted text-xs">Each scene references the previous render and character anchors for one recurring on-screen subject.</div></div>
          </label>
          <label class="cm-opt" :class="{ active: continuityMode === 'explainer-stills' }">
            <input v-model="continuityMode" type="radio" value="explainer-stills" />
            <div><strong>Explainer boards</strong><div class="text-muted text-xs">Independent subject-led scenes, ready for an optional composition reference.</div></div>
          </label>
        </div>
      </div>

      <div class="mt-3 button-row">
        <button class="btn btn-primary" :disabled="formatSaving || !formatDirty" @click="saveFormatSettings">
          {{ formatSaving ? 'Saving…' : 'Save Reference Behavior' }}
        </button>
        <SaveIndicator v-bind="savedHintProps('format')" />
        <span v-if="formatSaveError" class="text-error">{{ formatSaveError }}</span>
      </div>
          </section>

          <section class="card settings-panel">
      <section class="channel-visual-defaults" data-setting="guide-density">
        <div class="settings-section-head">
          <div>
            <h3>Recurring guide visibility</h3>
            <p>Controls how often Scene Plan includes its recurring on-screen guide in newly generated episodes. This is a channel rule, not a Character Sheet setting.</p>
          </div>
          <span class="settings-section-count">{{ guideDensityLabel }}</span>
        </div>
        <div class="channel-guide-density-row">
          <input
            v-model.number="guideDensity"
            type="range"
            min="0"
            max="100"
            step="5"
            class="channel-guide-density-slider"
            :disabled="savingGuideDensity"
            @change="saveGuideDensity"
          />
          <output class="channel-guide-density-value" :class="{ off: guideDensity === 0 }">{{ guideDensity }}%</output>
        </div>
        <p class="text-muted text-xs mt-1">
          <strong>0%</strong> means no recurring guide; <strong>100%</strong> means one in every scene. Existing Scene Plans stay unchanged—regenerate a plan to apply this default.
        </p>
        <SaveIndicator v-bind="savedHintProps('guide_density')" />
      </section>
          </section>

          <AdvancedDisclosure label="Advanced: narration quality checks and the Formula’s production kit">
            <section class="card settings-panel">
      <section class="audio-quality-settings" data-setting="audio-quality" aria-labelledby="audio-quality-settings-title">
        <div class="settings-section-head">
          <div>
            <h3 id="audio-quality-settings-title">Narration quality checks</h3>
            <p>Choose whether this channel checks chapter narration after subtitles exist. Normal Audio and Pipeline runs stay available in every mode.</p>
          </div>
          <span class="settings-section-count">{{ audioQualityModeSummary }}</span>
        </div>

        <div class="audio-quality-options" role="radiogroup" aria-label="Audio quality mode">
          <label v-for="option in audioQualityModeOptions" :key="option.value" :class="['audio-quality-option', { active: audioQualityMode === option.value }]">
            <input v-model="audioQualityMode" type="radio" :value="option.value" />
            <span>
              <strong>{{ option.label }} <small v-if="option.recommended">Recommended during calibration</small></strong>
              <span>{{ option.description }}</span>
            </span>
          </label>
        </div>

        <div v-if="audioQualityMode === 'check_and_repair'" class="audio-quality-alternate">
          <label>Alternate transcription model <span class="required" aria-hidden="true">*</span></label>
          <ModelMenu
            v-model="audioQualityAlternateModel"
            :options="audioQualityModelOptions"
            media-type="transcription"
            title="Choose the alternate transcription model"
            placeholder="Choose a published model…"
            search-placeholder="Search transcription models…"
            aria-label="Alternate transcription model"
          />
          <p class="text-muted text-xs mt-1">
            You choose the alternate. It must have a different published model ID from the first transcript; a different provider name alone does not make it a distinct model.
          </p>
          <p v-if="audioQualityCatalogLoading" class="text-muted text-xs mt-1"><LoadingSpinner size="sm" /> Loading published transcription models…</p>
          <p v-else-if="audioQualityCatalogError" class="text-warning text-xs mt-1">
            {{ audioQualityCatalogError }}
            <button type="button" class="btn btn-sm btn-ghost" @click="loadAudioQualityModels">Retry</button>
          </p>
          <p v-else-if="audioQualityCatalogStale" class="text-warning text-xs mt-1">
            {{ audioQualityCatalogStaleNote }}. Showing the last available catalog for display only; refresh it before starting a paid quality check.
            <button type="button" class="btn btn-sm btn-ghost" @click="loadAudioQualityModels">Refresh</button>
          </p>
        </div>

        <p v-if="audioQualityMode === 'check_and_repair'" class="audio-quality-cost-note">
          New narration made by a repair shows an estimate first. You set a credit limit for each check; if a check would cost more, the new audio waits for your OK.
        </p>
        <details v-if="audioQualityMode === 'check_and_repair'" class="settings-tech-details disclosure">
          <summary>Details</summary>
          <p class="text-muted text-xs">
            Replacement narration estimates are advisory because the current TTS contract has no hard aggregate credit ceiling. Audio requires an action-specific verification credit ceiling; transcription is quoted after candidate audio exists, and a higher quote holds that candidate for your approval.
          </p>
        </details>

        <div class="audio-quality-save-row">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="audioQualitySaving || !audioQualityDirty || !audioQualityValid"
            @click="saveAudioQuality"
          >{{ audioQualitySaving ? 'Saving…' : 'Save Narration Checks' }}</button>
          <SaveIndicator v-bind="savedHintProps('audio_quality')" />
          <span v-if="!audioQualityValid" class="text-warning text-xs">Choose an alternate transcription model to enable checked repair.</span>
          <span v-if="audioQualitySaveError" class="text-error text-xs">{{ audioQualitySaveError }}</span>
        </div>
      </section>
            </section>
            <section v-if="selectedProductionKit" class="card settings-panel mt-2">
        <section v-if="selectedProductionKit" class="production-kit-card">
          <div class="production-kit-head">
            <div>
              <span class="settings-section-kicker">Formula production kit</span>
              <h4>{{ selectedProductionKit.label }}</h4>
              <p>{{ selectedProductionKit.description }}</p>
            </div>
            <span class="production-kit-status">Suggestions</span>
          </div>

          <div class="production-kit-grid">
            <div class="production-kit-item">
              <span>Suggested visual style</span>
              <template v-if="productionKitStyleSuggestion">
                <strong>{{ productionKitStyleSuggestion.name }}</strong>
                <small v-if="productionKitStyleSuggestion.inUse">
                  In use on this channel. Art style is always your choice — change it any time in
                  Writing &amp; style → Art style.
                </small>
                <template v-else-if="productionKitStyleSuggestion.installed">
                  <small>Installed, but not selected. Your current art style stays until you apply this.</small>
                  <button
                    class="btn btn-sm btn-secondary mt-1"
                    type="button"
                    :disabled="artStyleSaving"
                    @click="useSuggestedProductionKitStyle"
                  >
                    Use This Style
                  </button>
                </template>
                <small v-else-if="visualStylesLoading">Checking installed Content Pack styles…</small>
                <small v-else-if="visualStylesError">
                  Could not check installed Content Pack styles. Retry in Writing &amp; style → Art style.
                </small>
                <small v-else>
                  Not installed. Get it from the
                  <NuxtLink to="/content-store">Content Store</NuxtLink>, or keep the style you already use.
                </small>
              </template>
              <template v-else>
                <strong>Your choice</strong>
                <small>This Formula suggests no particular look. Pick one in Writing &amp; style → Art style.</small>
              </template>
            </div>
            <div class="production-kit-item">
              <span>Thumbnail recipe</span>
              <strong>{{ selectedProductionKitThumbnailName }}</strong>
              <small>The Formula's default when you have not chosen one; overridable in Thumbnail Prompts.</small>
            </div>
            <div class="production-kit-item">
              <span>Motion</span>
              <strong>{{ selectedProductionKitMotionName }}</strong>
              <small>{{ selectedProductionKitMotionSummary }}</small>
            </div>
            <div class="production-kit-item">
              <span>Long-form presets</span>
              <strong>{{ selectedProductionKitDurations }}</strong>
              <small>Chapter count, narration pace, visual rhythm, and motion all come from the Formula.</small>
            </div>
          </div>

          <div v-if="selectedProductionKit.episodeProfiles?.length" class="production-kit-profiles">
            <span>Automatic episode profiles</span>
            <div>
              <span
                v-for="profile in selectedProductionKit.episodeProfiles"
                :key="profile.id"
                class="production-profile-pill"
                :title="profile.description"
              >{{ profile.label }}</span>
            </div>
            <small>Idea Campaign assigns and saves these lanes. Script and thumbnail behavior follow the saved idea profile—there is no per-run profile picker.</small>
          </div>
        </section>
            </section>
          </AdvancedDisclosure>
        </template>

        <!-- ═══ This Project → Writing & style ═══ -->
        <template v-if="activeTab === 'writing'">
          <section class="card settings-panel">
      <div class="form-group" data-setting="art-style">
        <label>Art style</label>
        <p class="settings-hint">Added to every image prompt for this channel. You can still change it for one run on the Image Prompts page.</p>
        <div class="art-style-picker">
          <select v-model="artStyleSelection" class="input" :disabled="artStyleSaving">
            <option value="">— None (use format / niche default) —</option>
            <optgroup v-if="savedStylePresets.length" label="Saved styles">
              <option v-for="s in savedStylePresets" :key="s.id" :value="s.id">{{ s.name }}</option>
            </optgroup>
            <optgroup label="Style library">
              <option v-for="s in visualStyles" :key="s.id" :value="s.id">{{ s.name }}</option>
            </optgroup>
          </select>
        </div>
        <p v-if="visualStylesLoading" class="text-muted text-sm mt-1">
          Loading installed Content Pack styles…
        </p>
        <p v-else-if="visualStylesError" class="text-warning text-sm mt-1">
          Installed Content Pack styles are unavailable. Existing saved style data is unchanged.
          <button type="button" class="btn btn-ghost btn-sm" @click="refreshVisualStyles">Retry</button>
        </p>
        <p v-else-if="!visualStyles.length" class="text-muted text-sm mt-1">
          No Content Pack styles are installed. Add one from the
          <NuxtLink to="/content-store">Content Store</NuxtLink>.
        </p>
        <p v-if="unresolvedArtStyleId" class="text-warning text-sm mt-1">
          This channel is saved against the art style <code>{{ humanizeCatalogId(unresolvedArtStyleId) }}</code>,
          but nothing installed provides it — images are being generated without it. Pick a style
          above, or install the pack that provides it from the
          <NuxtLink to="/content-store">Content Store</NuxtLink>.
        </p>
        <span v-if="artStyleSaveMessage" class="text-muted" style="font-size: var(--font-xs)">{{ artStyleSaveMessage }}</span>
      </div>
          </section>

          <CollapsibleCard title="Writing instructions" description="Channel guidance and intro rules, with reusable presets" data-setting="writing-instructions">
      <div class="sub-tabs">
        <button v-for="st in standardsSubTabs" :key="st.id" :disabled="writingControlsDisabled" :class="['sub-tab', { active: standardsSubTab === st.id }]" @click="standardsSubTab = st.id">
          {{ st.label }}
        </button>
      </div>

      <div class="sub-tab-body">
        <h3>{{ currentStandardDoc.title }}</h3>
        <p class="text-muted mt-1 mb-2">{{ currentStandardDoc.description }}</p>
        <p v-if="standardsLoading" class="text-muted mt-2">Loading saved instructions…</p>
        <p v-else-if="standardsError" class="text-error mt-2">{{ standardsError }}</p>

        <!-- Starter templates + preset dropdown -->
        <div class="standards-toolbar">
          <div class="toolbar-group">
            <label class="toolbar-label">Start from</label>
            <select v-model="selectedTemplateId" class="select input-sm" :disabled="writingControlsDisabled">
              <option value="">— pick a template —</option>
              <option v-for="t in currentTemplates" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
            <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled || !selectedTemplateId" @click="loadStarterTemplate">Load</button>
          </div>

          <div class="toolbar-group" v-if="currentPresets.length">
            <label class="toolbar-label">Saved presets</label>
            <select v-model="selectedPresetId" class="select input-sm" :disabled="writingControlsDisabled">
              <option value="">— none —</option>
              <option v-for="p in currentPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled || !selectedPresetId" @click="loadPreset">Load</button>
            <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled || !selectedPresetId" @click="deletePreset">Delete Preset</button>
          </div>

          <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled" @click="copyAsAiPrompt" title="Copy a chatbot-ready prompt to your clipboard">Copy as AI Prompt</button>
          <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled" @click="showSavePreset = true">Save as Preset…</button>
        </div>

        <textarea
          v-model="currentStandardText"
          class="textarea"
          style="min-height: 400px; font-family: monospace; font-size: 13px;"
          :placeholder="currentStandardDoc.placeholder"
          :disabled="writingControlsDisabled"
        />

        <div class="flex gap-2 mt-2" style="align-items: center;">
          <button class="btn btn-primary" :disabled="writingControlsDisabled" @click="saveStandardsCurrent">Save Instructions</button>
          <SaveIndicator v-bind="savedHintProps('standards')" />
        </div>
      </div>

      <!-- Save preset modal -->
      <Modal :visible="showSavePreset" :close-on-backdrop="false" labelledby="save-preset-title" @close="showSavePreset = false">
        <h3 id="save-preset-title" class="modal-small-title">Save {{ standardsSubTab === 'intro' ? 'Intro' : 'Channel Instructions' }} Preset</h3>
        <p class="text-muted mt-1 mb-2" style="font-size:12px">Give this preset a name so you can reuse it across channels of the same style.</p>
        <input
          v-model="newPresetName"
          class="input"
          placeholder="e.g. Sleep Stories v2, Horror Narration"
          :disabled="writingControlsDisabled"
          @keyup.enter.stop.prevent="savePreset"
        />
        <div class="flex gap-2 mt-2" style="justify-content:flex-end">
          <button class="btn btn-secondary" :disabled="writingControlsDisabled" @click="showSavePreset = false">Cancel</button>
          <button class="btn btn-primary" :disabled="writingControlsDisabled || !newPresetName.trim()" @click="savePreset">Save Preset</button>
        </div>
      </Modal>
          </CollapsibleCard>

          <CollapsibleCard title="Custom art styles" description="Browse the style library or make your own" data-setting="style-library">
      <ProjectStyleLibrary
        :project-slug="slug"
        title="Channel style library"
        :show-catalog-starters="true"
      />
          </CollapsibleCard>
        </template>

        <!-- ═══ This Project → Publishing ═══ -->
        <template v-if="activeTab === 'publishing'">
          <PublishingScheduleCard :slug="slug" data-setting="upload-schedule" />

          <div class="card settings-panel settings-panel-embedded" data-setting="youtube-channel">
            <YouTubeConnectionSettings :slug="slug" scope="assignment" />
            <p class="settings-cross-link">
              YouTube accounts are shared by this Mac.
              <a href="#connections" @click="activeTab = 'connections'">Manage connected accounts</a>
            </p>
          </div>

          <section class="card settings-panel">
            <header class="settings-card-head">
              <h3>Upload defaults</h3>
              <p>Used for every new upload and every update to an uploaded video.</p>
            </header>
      <div class="form-group" data-setting="category">
        <label>
          YouTube Category
          <span class="text-muted" style="font-weight:normal">(used for new uploads and updates to existing videos)</span>
        </label>
        <div class="flex gap-2 items-center" style="flex-wrap: wrap;">
          <select
            v-if="ytCategoryList.length"
            v-model.number="projectForm.category_id"
            class="input"
            style="flex: 1; min-width: 240px;"
          >
            <option :value="undefined">— Default (24 · Entertainment) —</option>
            <option v-for="c in ytCategoryList" :key="c.id" :value="Number(c.id)">
              {{ c.id }} · {{ c.title }}
            </option>
          </select>
          <input
            v-else
            v-model.number="projectForm.category_id"
            type="number"
            min="1"
            class="input"
            style="flex: 1; min-width: 240px;"
            :placeholder="'24 (default — Entertainment)'"
          />
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="ytCategoryLoading"
            @click="loadYoutubeCategoryList"
          >
            {{ ytCategoryLoading ? 'Fetching…' : 'Refresh Categories' }}
          </button>
        </div>
        <span class="text-muted" style="font-size: var(--font-xs);">
          <template v-if="ytCategoryHint">⚠ {{ ytCategoryHint }}</template>
          <template v-else-if="ytCategorySource">
            {{ ytCategorySource === 'live' ? 'Just fetched' : ytCategorySource === 'cache' ? 'From cache' : ytCategorySource === 'stale' ? 'Stale cache (fetch failed)' : 'Empty' }}
            · {{ ytCategoryList.length }} assignable categor{{ ytCategoryList.length === 1 ? 'y' : 'ies' }}
          </template>
          <template v-else>Click Refresh to load YouTube’s category list (cached 7 days).</template>
        </span>
      </div>
      <div class="form-group" data-setting="ai-disclosure">
        <label>
          AI / Altered or Synthetic Content disclosure
          <span class="text-muted" style="font-weight:normal">(shown in YouTube’s altered-content disclosure)</span>
        </label>
        <div class="flex gap-2 items-center" style="flex-wrap: wrap;">
          <select
            v-model="aiDisclosureSelection"
            class="input"
            style="flex: 1; min-width: 240px;"
          >
            <option value="default">Use app default ({{ ytAppDefaults?.default_mark_as_ai_generated === false ? 'OFF' : 'ON' }})</option>
            <option value="on">ON — mark uploads as AI-generated</option>
            <option value="off">OFF — do not disclose</option>
          </select>
        </div>
        <span class="text-muted" style="font-size: var(--font-xs);">
          Required by YouTube when a video contains realistic AI-made narration, images or footage. New uploads use this automatically.
        </span>
      </div>
            <div class="flex gap-2 mt-2" style="align-items:center">
              <button class="btn btn-primary" @click="saveProject('publishing')">Save Upload Defaults</button>
              <SaveIndicator v-bind="savedHintProps('project_publishing')" />
            </div>
            <AdvancedDisclosure label="Advanced: apply disclosure and category to videos already uploaded">
              <p class="settings-hint">Updates every uploaded video on this channel with the disclosure and category above. Privacy and schedule are kept. Uses YouTube quota: 1 unit per 50 videos read, 50 per video updated.</p>
              <div class="flex gap-2 items-center" style="flex-wrap: wrap;">
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="!!ytBackfillBusy"
            @click="onYoutubeBackfillPreview"
            title="Show what would change without applying"
          >
            {{ ytBackfillBusy === 'preview' ? 'Checking…' : 'Preview Changes' }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="!!ytBackfillBusy"
            @click="onYoutubeBackfillApply"
            title="Apply current AI disclosure + category to every uploaded video on this channel"
          >
            {{ ytBackfillBusy === 'apply' ? 'Applying…' : 'Apply to All Uploaded Videos' }}
          </button>

              </div>
        <div v-if="ytBackfillResult" class="card mt-2" style="font-size: 12px;">
          <div class="flex gap-3" style="flex-wrap: wrap;">
            <span><strong>Scanned:</strong> {{ ytBackfillResult.scanned }}</span>
            <span><strong>Eligible:</strong> {{ ytBackfillResult.eligible }}</span>
            <span class="text-success"><strong>Updated:</strong> {{ ytBackfillResult.updated }}</span>
            <span><strong>Skipped (already ok):</strong> {{ ytBackfillResult.skipped }}</span>
            <span v-if="ytBackfillResult.failed" class="text-danger"><strong>Failed:</strong> {{ ytBackfillResult.failed }}</span>
            <span v-if="ytBackfillResult.missing" class="text-muted"><strong>Missing on YouTube:</strong> {{ ytBackfillResult.missing }}</span>
            <span v-if="ytBackfillResult.dry_run" class="text-warning"><strong>(dry run — nothing applied)</strong></span>
          </div>
          <div v-if="ytBackfillResult.message" class="text-muted mt-1">{{ ytBackfillResult.message }}</div>
          <details v-if="ytBackfillResult.details?.length" class="mt-1 disclosure">
            <summary style="cursor: pointer;">Per-video details ({{ ytBackfillResult.details.length }})</summary>
            <ul style="margin: 6px 0 0; padding-left: 18px;">
              <li v-for="d in ytBackfillResult.details" :key="d.video_id">
                <code>{{ d.episode_code }}</code> ·
                <span :class="{ 'text-success': d.action === 'updated', 'text-muted': d.action === 'skipped', 'text-danger': d.action === 'failed', 'text-warning': d.action === 'missing' }">
                  {{ d.action }}
                </span>
                <template v-if="d.changed">
                  · {{ Object.entries(d.changed).map(([k, v]) => `${k}=${v}`).join(', ') }}
                </template>
                <template v-if="d.error || d.reason">
                  · <span class="text-muted">{{ d.error || d.reason }}</span>
                </template>
              </li>
            </ul>
          </details>
        </div>

            </AdvancedDisclosure>
          </section>

          <section class="card settings-panel publishing-profile-card" data-setting="publishing-profile">
            <div class="settings-section-head">
              <div>
                <h3>Publishing profile</h3>
                <p>Channel-wide links, credits, calls to action, disclosures, recurring tags and an optional title wrapper.</p>
              </div>
              <NuxtLink :to="`/projects/${slug}/metadata-template`" class="btn btn-secondary">Open Publishing Profile</NuxtLink>
            </div>
          </section>
        </template>

        <!-- ═══ This Project → Project files & behavior ═══ -->
        <template v-if="activeTab === 'files'">
          <!-- 2026-10-07 — self-contained channels: this channel's shared files and
               finished videos move into its own folder, so the folder can be copied
               to another Mac. -->
          <section class="card settings-panel" data-setting="self-contained">
            <SelfContainedPanel :slug="slug" />
          </section>
          <section class="card settings-panel" data-setting="numbering">
            <header class="settings-card-head">
              <h3>Episode numbering</h3>
            </header>
            <div class="grid-2">
        <div class="form-group">
          <label>Episode prefix</label>
          <input v-model="projectForm.episode_prefix" class="input" />
        </div>
        <div class="form-group">
          <label>Group name</label>
          <input v-model="projectForm.season_prefix" class="input" placeholder="Season" />
          <span class="text-muted" style="font-size: var(--font-xs)">Season, Batch, Volume, Collection, etc.</span>
        </div>
        <div class="form-group">
          <label>Episodes per group</label>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <input v-model.number="projectForm.season_size" class="input" type="number" min="1" max="1000" style="max-width: 120px;" />
            <button
              v-if="seasonSizeChanged"
              type="button"
              class="btn btn-sm btn-secondary"
              :disabled="reseasonState.opening"
              :title="`Preview the folder rebalance from ${serverSeasonSize} → ${projectForm.season_size} episodes per group, then commit. Reversible from the Unlinked Uploads tab for 30 days.`"
              @click="openReseasonPreview"
            >
              <LoadingSpinner v-if="reseasonState.opening" size="sm" />
              {{ reseasonState.opening ? 'Loading…' : `Rebalance to ${projectForm.season_size} per Group…` }}
            </button>
          </div>
          <span class="text-muted" style="font-size: var(--font-xs);">
            Changing this moves every episode folder into the new groups, so it has its own
            <strong>Rebalance</strong> button (Save leaves it alone). Reversible for 30 days.
          </span>
        </div>
            </div>
            <div class="flex gap-2 mt-2" style="align-items:center">
              <button class="btn btn-primary btn-sm" @click="saveProject('files')">Save Numbering</button>
              <SaveIndicator v-bind="savedHintProps('project_files')" />
            </div>
          </section>

          <section class="card settings-panel" data-setting="project-location">
            <div class="form-group">
              <label>Channel folder</label>
              <div class="flex gap-2 items-center" style="flex-wrap:wrap">
                <code class="path-display">{{ projectLocation || '(no location set)' }}</code>
                <button class="btn btn-sm btn-secondary" :disabled="!projectLocation" @click="revealInFinder">Show in Finder</button>
              </div>
              <p class="settings-hint">This channel is a folder in your Library. To move it, quit Story Studio and drag the folder — anywhere inside the Library works.</p>
            </div>
          </section>

          <section class="card settings-panel" data-setting="project-smaller-files">
            <GenerationCompressionPanel :slug="slug" />
          </section>

          <CollapsibleCard title="Confirmation prompts" description="Choose which generation and file actions ask first" data-setting="confirmations">
      <h3>Generation Confirmations</h3>
      <p class="text-muted mt-1 mb-2">
        Choose which generators ask for confirmation before starting. Disabled generators skip the prompt and start immediately.
      </p>
      <div class="confirm-list">
        <label v-for="gen in confirmGenerationRows" :key="gen.key" class="confirm-row">
          <div class="confirm-info">
            <span class="confirm-label">{{ gen.label }}</span>
            <span class="confirm-desc text-muted">{{ gen.description }}</span>
          </div>
          <div class="toggle-switch" :class="{ active: confirmPrefs[gen.key] !== false }" @click="confirmPrefs[gen.key] = !(confirmPrefs[gen.key] !== false)">
            <div class="toggle-knob" />
          </div>
        </label>
      </div>

      <h3 class="mt-3">Action Confirmations</h3>
      <p class="text-muted mt-1 mb-2">
        Non-generation guardrails. Turn off to skip the dialog (the action fires immediately); turn on to restore the prompt after you dismissed it with "don't ask again".
      </p>
      <div class="confirm-list">
        <label v-for="gen in confirmActionRows" :key="gen.key" class="confirm-row">
          <div class="confirm-info">
            <span class="confirm-label">{{ gen.label }}</span>
            <span class="confirm-desc text-muted">{{ gen.description }}</span>
          </div>
          <div class="toggle-switch" :class="{ active: confirmPrefs[gen.key] !== false }" @click="confirmPrefs[gen.key] = !(confirmPrefs[gen.key] !== false)">
            <div class="toggle-knob" />
          </div>
        </label>
      </div>
            <div class="flex gap-2 mt-3" style="align-items: center;">
              <button class="btn btn-primary btn-sm" @click="saveConfirmPrefs">Save Confirmations</button>
              <SaveIndicator v-bind="savedHintProps('confirm_prefs')" />
            </div>
          </CollapsibleCard>

          <CollapsibleCard title="Episode folder names" description="Names used when Story Studio creates episode folders" data-setting="folder-names">
            <p class="settings-hint">Each name must include <code>{{ '{code}' }}</code>, which becomes the episode code (for example EP0024). New folders use the new names.</p>
            <p v-if="folderConfigLoading" class="text-muted mt-2">Loading folder settings…</p>
            <p v-else-if="folderConfigError" class="text-error mt-2">{{ folderConfigError }}</p>
      <div v-if="folderConfig.length" class="folder-config-list">
        <div class="folder-config-header">
          <span class="col-order">#</span>
          <span class="col-label">Folder</span>
          <span class="col-template">Template</span>
          <span class="col-generator">Generator</span>
        </div>
        <div v-for="entry in folderConfig" :key="entry.key" class="folder-config-row">
          <span class="col-order text-muted">{{ entry.order.toString().padStart(2, '0') }}</span>
          <span class="col-label">{{ entry.label }}</span>
          <input v-model="entry.template" class="input input-sm col-template" />
          <span class="col-generator text-muted" style="font-size:12px">{{ entry.generator }}</span>
        </div>
      </div>
            <div class="flex gap-2 mt-3" style="align-items: center;">
              <button class="btn btn-primary btn-sm" :disabled="folderConfigLoading || !!folderConfigError" @click="saveFolderConfig">Save Folder Names</button>
              <button class="btn btn-secondary btn-sm" :disabled="folderConfigLoading || !!folderConfigError" @click="resetFolderDefaults">Reset to Defaults</button>
              <SaveIndicator v-bind="savedHintProps('folder_config')" />
            </div>
          </CollapsibleCard>

          <section class="card settings-panel danger-zone" data-setting="hide-project">
            <h3>Hide this channel</h3>
            <p class="settings-hint">
              Removes the channel from the app's list; every file stays on disk. Bring it back any time from
              <em>Hidden channels</em> on the All Channels page — moving the folder out and back would not bring it back on its own.
            </p>
            <button class="btn btn-danger btn-sm mt-2" @click="deleteProject">Hide Channel (Keep Files)</button>
          </section>

          <!-- v1.4.249 — "Heavy media on another drive" is retired for projects that
               don't use it: shown only when this project's project.json has media_root
               (it can still be changed or cleared); the server refuses a new one. -->
          <AdvancedDisclosure :label="mediaRootSavedValue ? 'Advanced: heavy media on another drive, script recovery data' : 'Advanced: script recovery data'">
            <details v-if="mediaRootSavedValue" id="media-root-section" class="storage-disclosure card settings-panel" open data-setting="heavy-media">
        <summary class="storage-disclosure-summary">
          <span class="storage-section-icon" aria-hidden="true">⌁</span>
          <span><strong>Heavy media on another drive</strong><small>This channel keeps its heavy media on another drive.</small></span>
        </summary>
        <div class="storage-disclosure-body">
        <p class="text-muted hint">
          This channel's <strong>heavy media</strong> — scene images, thumbnails, audio and finished
          video — lives in the folder below, while scripts, metadata, prompts and subtitles stay in
          the channel folder. You can change or clear it here. New channels keep everything together,
          and once cleared this cannot be turned on again.
        </p>
        <div class="external-root-row">
          <input
            v-model="mediaRootInput"
            class="input"
            placeholder="(not set — media stays in the channel folder)   e.g. ${ASSET}/Media"
            spellcheck="false"
          />
          <button
            class="btn btn-secondary btn-sm"
            :disabled="!mediaRootInput.trim() || mediaRootChecking"
            title="Check that this token/path resolves on this machine"
            @click="checkMediaRoot"
          >
            {{ mediaRootChecking ? 'Checking…' : 'Check' }}
          </button>
          <button
            v-if="mediaRootInput.trim() !== mediaRootSavedValue"
            class="btn btn-primary btn-sm"
            :disabled="mediaRootSaving"
            @click="mediaRootInput.trim() ? saveMediaRoot() : clearMediaRoot()"
          >
            {{ mediaRootSaving ? 'Saving…' : 'Save' }}
          </button>
          <button v-if="mediaRootInput" class="btn btn-ghost btn-sm" :disabled="mediaRootSaving" @click="clearMediaRoot">
            Clear
          </button>
        </div>
        <p v-if="mediaRootStatus" :class="['external-root-status', mediaRootOk ? 'ok' : 'warn']">
          {{ mediaRootStatus }}
        </p>
        <p class="text-muted" style="font-size: var(--font-xs); margin-top: 4px;">
          ⚠ Advanced &amp; experimental. New media is written here going forward. To move your
          <strong>existing</strong> episodes' media onto this root, use the button below.
          Keep the drive connected during generation / rendering / migration.
        </p>
        <div class="external-root-row" style="margin-top: 8px;">
          <button
            class="btn btn-secondary btn-sm"
            :disabled="!mediaRootSavedValue || mediaMigrateRunning || mediaRootInput.trim() !== mediaRootSavedValue"
            :title="!mediaRootSavedValue ? 'Save a media root first' : (mediaRootInput.trim() !== mediaRootSavedValue ? 'Save your change first' : 'Preview, then move existing media to the media root')"
            @click="migrateMediaToRoot"
          >
            {{ mediaMigrateRunning ? 'Moving…' : 'Move Existing Media Here' }}
          </button>
        </div>
        <div v-if="lastMediaMigration" class="storage-result">
          <strong>Media migration:</strong>
          {{ lastMediaMigration.files_moved }} file(s) moved
          ({{ formatBytes(lastMediaMigration.bytes_moved) }} off the channel folder)
          across {{ lastMediaMigration.folders.length }} folder(s).
          <span v-if="lastMediaMigration.scene_plan_rewrites">
            {{ lastMediaMigration.scene_plan_rewrites }} scene-plan path(s) updated.
          </span>
          <span v-if="lastMediaMigration.errors.length" class="error-text">
            {{ lastMediaMigration.errors.length }} error(s): {{ lastMediaMigration.errors[0]?.reason }}
          </span>
        </div>
        </div>
            </details>
            <details id="chunked-sidecars-section" class="storage-disclosure card settings-panel mt-2" data-setting="recovery-data">
        <summary class="storage-disclosure-summary">
          <span class="storage-section-icon" aria-hidden="true">↻</span>
          <span><strong>Script recovery data</strong><small>Small files that let an unfinished script carry on where it stopped.</small></span>
        </summary>
        <div class="storage-disclosure-body">
        <div class="flex items-center" style="justify-content: space-between; gap: 12px;">
          <div>
            <h4>Leftover script progress files</h4>
            <p class="text-muted hint">
              While a long script is being written, Story keeps a small
              progress file for that episode. If the writing is stopped or
              the app crashes, the script carries on from the last finished
              chapter instead of starting over. Once the episode's script is
              finished, the file is no longer needed.
            </p>
            <p class="text-muted voice-helper-line">
              💡 Click <strong>Scan</strong> to find them, then <strong>Clean Up</strong>
              to remove the ones from finished scripts. Scripts still being
              written are never touched, and scripts, audio and images always stay.
            </p>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" :disabled="sidecarScanLoading" @click="scanChunkedSidecars">
              {{ sidecarScanLoading ? 'Scanning…' : (sidecarScan ? '↻ Scan Again' : 'Scan') }}
            </button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!sidecarScan || sidecarCleanupRunning || sidecarScan.eligible_count === 0"
              :title="!sidecarScan ? 'Click Scan first' : sidecarScan.eligible_count === 0 ? 'Nothing to remove — no finished script has a leftover file' : `Remove ${sidecarScan.eligible_count} leftover file(s) — frees ${formatBytes(sidecarScan.reclaimable_bytes)}`"
              @click="cleanupAllChunkedSidecars"
            >
              {{ sidecarCleanupRunning
                ? 'Cleaning…'
                : sidecarScan && sidecarScan.eligible_count > 0
                  ? `Clean Up ${sidecarScan.eligible_count} Finished (${formatBytes(sidecarScan.reclaimable_bytes)})`
                  : 'Clean Up Finished' }}
            </button>
          </div>
        </div>

        <div v-if="sidecarScan" class="storage-summary mt-2">
          <span><strong>Checked:</strong> {{ sidecarScan.episodes.length }} episode{{ sidecarScan.episodes.length === 1 ? '' : 's' }}</span>
          <span class="dot">·</span>
          <span><strong>Safe to remove:</strong> {{ sidecarScan.eligible_count }}</span>
          <span class="dot">·</span>
          <span><strong>Space you get back:</strong> {{ formatBytes(sidecarScan.reclaimable_bytes) }}</span>
        </div>

        <div v-if="sidecarScan && sidecarScan.episodes.some(e => e.sidecar_present)" class="storage-table mt-2">
          <div class="storage-row storage-head">
            <span class="col-code">Episode</span>
            <span class="col-title">Script</span>
            <span class="col-final">Size</span>
            <span class="col-actions"></span>
          </div>
          <div
            v-for="row in sidecarScan.episodes.filter(e => e.sidecar_present)"
            :key="row.episode_code"
            :class="['storage-row', { uploaded: row.eligible }]"
          >
            <span class="col-code"><strong>{{ row.episode_code }}</strong></span>
            <span class="col-title" :title="row.reason || ''">
              <span v-if="row.eligible" class="upload-badge ok">✓ finished, safe to remove</span>
              <span v-else class="text-muted">{{ row.reason || `${row.chapters_done || 0}/${row.total_chapters || 0} chapters written` }}</span>
            </span>
            <span class="col-final">{{ formatBytes(row.sidecar_size_bytes || 0) }}</span>
            <span class="col-actions">
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!row.eligible || sidecarCleanupRunning"
                :title="row.eligible ? `Remove this file (frees ${formatBytes(row.sidecar_size_bytes || 0)})` : 'Kept — this script is not finished yet'"
                @click="cleanupOneSidecar(row.episode_code)"
              >
                Clean Up
              </button>
            </span>
          </div>
        </div>

        <div v-if="lastSidecarCleanup" class="storage-result mt-2">
          <strong>Cleanup:</strong>
          {{ lastSidecarCleanup.deleted.length }} leftover file(s) removed, freed {{ formatBytes(lastSidecarCleanup.total_bytes_freed) }}.
          <span v-if="lastSidecarCleanup.skipped.length">{{ lastSidecarCleanup.skipped.length }} skipped.</span>
        </div>
        </div>
            </details>
          </AdvancedDisclosure>
        </template>
      </div>
    </div>

    <ChannelIdentityPickerModal
      :visible="identityPickerOpen"
      :project-slug="slug"
      :selected-formula-id="nicheId"
      :selected-topic-pack-ids="topicPackIds"
      :project-content-pack-versions="projectContentPackVersions"
      @close="identityPickerOpen = false"
      @saved="onIdentitySaved"
    />

    <!-- v1.0.96+ Create-custom-niche modal. Lives under the Niche tab now
         (the standalone /niches sidebar page is gone). Same form fields as
         before — id, name, tagline, description, example topics, script
         context, visual style sheet. -->
    <Modal
      v-if="nicheCreateOpen"
      :visible="nicheCreateOpen"
      size="md"
      labelledby="niche-create-title"
      @close="closeNicheCreator"
    >
      <h3 id="niche-create-title">Create custom niche</h3>
      <p class="text-muted text-sm mt-1 mb-2">
        Custom niches live alongside the built-ins. Fill in the basics here;
        you can expand example topics, add a visual style sheet, or layer in
        title shape rules later by editing the JSON file directly.
      </p>
      <div class="form-group">
        <label><strong>id</strong> <span class="text-muted text-xs">lowercase slug — letters / digits / dashes / underscores</span></label>
        <input v-model="nicheDraft.id" class="input" placeholder="e.g. gemstones" :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>name</strong> <span class="text-muted text-xs">label shown in the picker</span></label>
        <input v-model="nicheDraft.name" class="input" placeholder="e.g. Gemstones & Minerals" :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>tagline</strong> <span class="text-muted text-xs">optional one-liner shown on the niche card</span></label>
        <input v-model="nicheDraft.tagline" class="input" placeholder="e.g. Crystalline, ancient, weirdly violent to form." :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>description</strong> <span class="text-muted text-xs">2-3 sentences describing what this niche covers</span></label>
        <textarea v-model="nicheDraft.description" class="input" rows="3" :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>example topics</strong> <span class="text-muted text-xs">one per line — feeds the Ideas generator's title bar</span></label>
        <textarea v-model="nicheDraftExampleTopicsText" class="input" rows="6" :disabled="nicheCreateBusy" placeholder="Diamond&#10;Ruby&#10;Sapphire&#10;…" />
      </div>
      <div class="form-group mt-2">
        <label><strong>script context</strong> <span class="text-muted text-xs">one-line context injected into the narration system prompt</span></label>
        <textarea v-model="nicheDraft.scriptContext" class="input" rows="2" :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>visual style sheet</strong> <span class="text-muted text-xs">long-form style instructions appended to every image prompt</span></label>
        <textarea v-model="nicheDraft.visualStyleSheet" class="input" rows="3" :disabled="nicheCreateBusy" />
      </div>
      <div v-if="nicheCreateError" class="error-box mt-2">{{ nicheCreateError }}</div>
      <div class="flex gap-2 mt-3" style="justify-content: flex-end">
        <button class="btn btn-secondary" :disabled="nicheCreateBusy" @click="closeNicheCreator">Cancel</button>
        <button class="btn btn-primary" :disabled="nicheCreateBusy || !nicheCanCreate" @click="submitNicheCreate">
          {{ nicheCreateBusy ? 'Creating…' : 'Create Niche' }}
        </button>
      </div>
    </Modal>

    <Modal :visible="reseasonState.open" size="lg" dialog-class="modal-flush" labelledby="reseason-title" @close="closeReseasonPreview">
      <div class="reseason-modal">
        <div class="reseason-modal-header">
          <strong id="reseason-title">↻ Rebalance season folders</strong>
          <button class="reseason-modal-close" type="button" title="Close" @click="closeReseasonPreview">✕</button>
        </div>
        <div class="reseason-modal-body">
          <template v-if="reseasonState.preview && reseasonState.preview.moves.length === 0">
            <p class="text-muted" style="font-size: 13px; margin: 0;">
              Nothing to rebalance — all
              {{ reseasonState.preview.total_accepted }} accepted episode{{ reseasonState.preview.total_accepted === 1 ? '' : 's' }}
              already sit at the same season number under
              <strong>{{ reseasonState.preview.new_season_size }}</strong> per group as they did at
              <strong>{{ reseasonState.preview.current_season_size }}</strong>.
              Confirming still updates the saved size so future episodes follow the new grouping.
            </p>
          </template>
          <template v-else-if="reseasonState.preview">
            <p class="text-muted" style="font-size: 13px; margin: 0;">
              From <strong>{{ reseasonState.preview.current_season_size }}</strong> →
              <strong>{{ reseasonState.preview.new_season_size }}</strong> episodes per group.
              <strong>{{ reseasonState.preview.moves.length }}</strong>
              folder{{ reseasonState.preview.moves.length === 1 ? '' : 's' }} will move,
              <span v-if="reseasonState.preview.noop_count > 0">
                {{ reseasonState.preview.noop_count }} stay where they are.
              </span>
              <br />
              Finished videos in your finished-videos folder are regrouped in the same step.
              A safety record is written first, so this can be undone for 30 days.
            </p>
            <div class="reseason-move-list">
              <div
                v-for="(m, idx) in reseasonState.preview.moves.slice(0, 12)"
                :key="m.code"
                class="reseason-move-row"
              >
                <code>{{ m.code }}</code>
                <span class="text-muted">·</span>
                <span class="text-muted">{{ projectForm.season_prefix || 'Season' }} {{ String(m.old_season).padStart(3, '0') }} →
                  {{ projectForm.season_prefix || 'Season' }} {{ String(m.new_season).padStart(3, '0') }}</span>
                <span class="reseason-move-title text-muted">{{ m.title }}</span>
              </div>
              <div v-if="reseasonState.preview.moves.length > 12" class="text-muted" style="font-size: var(--font-xs); padding: 4px 0;">
                + {{ reseasonState.preview.moves.length - 12 }} more
              </div>
            </div>
          </template>
          <p v-if="reseasonState.error" class="text-danger" style="font-size: 12px; margin: 8px 0 0;">
            ⚠ {{ reseasonState.error }}
          </p>
        </div>
        <div class="reseason-modal-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeReseasonPreview">Cancel</button>
          <button
            v-if="reseasonState.preview"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="reseasonState.running"
            @click="confirmReseason"
          >
            <LoadingSpinner v-if="reseasonState.running" size="sm" />
            {{ reseasonState.running
              ? 'Rebalancing…'
              : (reseasonState.preview.moves.length === 0
                ? 'Save New Size'
                : `Rebalance ${reseasonState.preview.moves.length} Folder${reseasonState.preview.moves.length === 1 ? '' : 's'}`) }}
          </button>
        </div>
      </div>
    </Modal>
  </div>
</template>

<script setup lang="ts">
// pickFolder() branches between Electron's native dialog and the in-app
// FileBrowserModal (server mode / remote tailnet browser). Not auto-imported
// — it's a bare named export, not a useX composable.
import { pickFolder as pickFolderShared } from '~/composables/usePathPicker'
import { resolveSettingsSectionHash, settingsAnchorTargetIds } from '~/utils/settingsNavigation'
import { SETTINGS_ZONES, type SettingEntry } from '~/utils/settingsIndex'
import { projectSettingsSavePlan, type ProjectSettingsSaveSection } from '~/utils/projectSettingsSave'
// Reactive installed Content Pack catalog used by the per-project selector.
// Project-local saved styles remain independent compatibility data.
import { useVisualStyleCatalog } from '~/composables/useVisualStyleCatalog'
import type { AudioQualityMode } from '~/types/audio-quality'
import { genstudioStaleNote } from '~/utils/genstudio-freshness'
// Every Settings destination replaces content beneath the same heading. On a
// cross-page hash arrival there is nothing lower to scroll to, and Nuxt checks
// the hash before this client-only page mounts. Let same-page hashes use the
// concrete heading targets below, while an initial/cross-page arrival starts
// at the normal page position without asking the router to find unmounted DOM.
definePageMeta({ layout: 'dashboard', scrollToTop: to => !to.hash })
useAppTitle('Settings')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, patch, del } = useApi()
const {
  styles: visualStyles,
  loading: visualStylesLoading,
  error: visualStylesError,
  refresh: refreshVisualStyles,
} = useVisualStyleCatalog()
onMounted(() => { void refreshVisualStyles() })
const { ask } = useConfirm()
const { project, config, refreshConfig, loadProject, episodesRoot } = useProject()
/** `<channel>/Exports` — where this channel's finals go unless a separate folder is chosen. */
const channelExportsDir = computed(() => {
  const root = episodesRoot.value || ''
  return root ? `${root.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '')}/Exports` : ''
})
const { success, error: showError, info } = useToast()
const {
  modelId: audioQualityAlternateModel,
  options: audioQualityModelOptions,
  loading: audioQualityCatalogLoading,
  error: audioQualityCatalogError,
  isStale: audioQualityCatalogStale,
  sourceFreshness: audioQualityCatalogFreshness,
  load: loadAudioQualityModels,
} = useGenStudioTranscriptionModels()
const audioQualityCatalogStaleNote = computed(() => genstudioStaleNote(
  audioQualityCatalogStale.value,
  audioQualityCatalogFreshness.value?.loadedAt ?? null,
))
// v1.4.3 — the move-this-project-to dialog and the unlink flow lived here.
// Both are gone with the per-Mac register of folders outside the projects
// folder. `projectLocation` below still shows where this channel sits; moving
// it is a Finder drag inside the Library.

const activeTab = ref('connections')

// ── About-tab bindings ──────────────────────────────────────────────────
// App version + build date come from runtimeConfig (set in nuxt.config.ts
// at build time from the root package.json). Surfaced here so beta
// testers can copy "Story Studio KH v1.0.11 · built 2026-04-27" into a
// bug report.
const { public: pubCfg } = useRuntimeConfig()
const appVersion = computed(() => (pubCfg.appVersion as string | undefined) || '0.0.0')
const buildDate = computed(() => (pubCfg.buildDate as string | undefined) || '')
const versionCopied = ref(false)
async function copyVersionString() {
  const txt = `Story Studio KH v${appVersion.value} · built ${buildDate.value}`
  try {
    await navigator.clipboard.writeText(txt)
    versionCopied.value = true
    setTimeout(() => { versionCopied.value = false }, 1400)
    success('Version copied')
  } catch {
    showError('Could not copy — your browser/OS blocked clipboard access.')
  }
}

// Per-action "Saved Xs ago" persistent indicator. Each successful save
// stamps a timestamp under its key; <SaveIndicator> renders a permanent
// pill so the operator can tell at a glance whether their last edit
// landed even after the toast fades. Replaces the ad-hoc savedStandardHint
// + notifSaveStatus → 'idle' auto-clear that used to disappear after
// 1.5–2s. Fed via savedHintProps(key) in the template.
const savedAt = reactive<Record<string, number | null>>({})
function stampSaved(key: string) { savedAt[key] = Date.now() }
function savedHintProps(key: string) {
  const ts = savedAt[key] ?? null
  return { state: (ts ? 'saved' : 'idle') as AutoSaveState, savedAt: ts }
}

// ── Continuity Engine state ────────────────────────────────────────────────
const formatId = ref<string>('continuity-chain')
const formatSaving = ref(false)
const formatSaveError = ref('')
type ContinuityMode = 'character-continuity' | 'independent-stills' | 'explainer-stills'
const continuityMode = ref<ContinuityMode>('independent-stills')
const continuityModeBaseline = ref<ContinuityMode>('independent-stills')
const formatIdBaseline = ref<string>('continuity-chain')
const guideDensity = ref(40)
const savingGuideDensity = ref(false)
const audioQualityMode = ref<AudioQualityMode>('off')
const audioQualityBaseline = ref(JSON.stringify({ mode: 'off' }))
const audioQualityLoadedSlug = ref('')
const audioQualitySaving = ref(false)
const audioQualitySaveError = ref('')
const audioQualityModeOptions: Array<{
  value: AudioQualityMode
  label: string
  description: string
  recommended?: boolean
}> = [
  { value: 'off', label: 'Off', description: 'Keep narration checks out of this channel.' },
  { value: 'flag_issues', label: 'Flag issues', recommended: true, description: 'Review saved source and transcript evidence locally. No provider request or credit charge.' },
  { value: 'check_and_repair', label: 'Check and repair', description: 'Inspect selected chapters and offer one reviewed repair when evidence supports it. May use credits.' },
]
const audioQualityDraft = computed(() => ({
  mode: audioQualityMode.value,
  ...(audioQualityAlternateModel.value ? { alternate_transcription_model: audioQualityAlternateModel.value } : {}),
}))
const audioQualityDirty = computed(() => JSON.stringify(audioQualityDraft.value) !== audioQualityBaseline.value)
const audioQualityValid = computed(() => audioQualityMode.value !== 'check_and_repair' || !!audioQualityAlternateModel.value)
const audioQualityModeSummary = computed(() => audioQualityMode.value === 'flag_issues'
  ? 'Flag issues'
  : audioQualityMode.value === 'check_and_repair'
    ? 'Check & repair'
    : 'Off')
const formatDirty = computed(() => {
  if (formatId.value !== formatIdBaseline.value) return true
  if (continuityMode.value !== continuityModeBaseline.value) return true
  return false
})

function syncFormatFromProject() {
  const m = project.value as any
  if (!m) return
  formatId.value = 'continuity-chain'
  continuityMode.value = m.continuity_mode === 'character-continuity' || m.continuity_mode === 'explainer-stills'
    ? m.continuity_mode
    : 'independent-stills'
  formatIdBaseline.value = formatId.value
  continuityModeBaseline.value = continuityMode.value
}

// Hydrate when project meta arrives + on slug change.
watch(project, syncFormatFromProject, { immediate: true })

// Channel-wide visual planning default. It remains in ProjectConfig under the
// existing `character_density` key, which Scene Plan reads whenever it creates
// a fresh plan. Character Sheet only owns per-episode anchors and pacing.
watch(config, (value) => {
  const density = Number((value as any)?.character_density)
  if (Number.isFinite(density)) guideDensity.value = Math.max(0, Math.min(100, Math.round(density)))
}, { immediate: true })

watch([slug, config], ([projectSlug, value]) => {
  if (!projectSlug || !value) return
  if (audioQualityLoadedSlug.value === projectSlug && audioQualityDirty.value) return
  const saved = (value as any).audio_quality
  audioQualityMode.value = saved?.mode === 'flag_issues' || saved?.mode === 'check_and_repair'
    ? saved.mode
    : 'off'
  audioQualityAlternateModel.value = typeof saved?.alternate_transcription_model === 'string'
    ? saved.alternate_transcription_model
    : ''
  audioQualityLoadedSlug.value = projectSlug
  audioQualityBaseline.value = JSON.stringify(audioQualityDraft.value)
}, { immediate: true })

watch(audioQualityMode, (mode) => {
  if (mode === 'check_and_repair') void loadAudioQualityModels()
})
const guideDensityLabel = computed(() =>
  guideDensity.value === 0 ? 'No recurring guide'
    : guideDensity.value >= 100 ? 'Guide in every scene'
      : `Guide in ~${guideDensity.value}% of scenes`)

async function saveGuideDensity(): Promise<void> {
  savingGuideDensity.value = true
  try {
    await put(`/projects/${slug.value}/settings/config`, { character_density: guideDensity.value })
    await refreshConfig(slug.value)
    stampSaved('guide_density')
    success(`Guide visibility saved — ${guideDensityLabel.value.toLowerCase()}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save guide visibility')
    // Put the slider back on the saved value rather than leave it showing one that was never saved.
    const saved = Number((config.value as any)?.character_density)
    if (Number.isFinite(saved)) guideDensity.value = Math.max(0, Math.min(100, Math.round(saved)))
  } finally {
    savingGuideDensity.value = false
  }
}

async function saveAudioQuality(): Promise<void> {
  if (!audioQualityValid.value || audioQualitySaving.value) return
  audioQualitySaving.value = true
  audioQualitySaveError.value = ''
  const targetSlug = slug.value
  const payload = audioQualityDraft.value
  try {
    await put(`/projects/${targetSlug}/settings/config`, { audio_quality: payload })
    if (slug.value !== targetSlug) return
    audioQualityBaseline.value = JSON.stringify(payload)
    if (config.value) (config.value as any).audio_quality = payload
    stampSaved('audio_quality')
    success('Audio quality setting saved')
  } catch (e: any) {
    audioQualitySaveError.value = e?.data?.detail || e?.message || 'Could not save audio quality'
    showError(audioQualitySaveError.value)
  } finally {
    if (slug.value === targetSlug) audioQualitySaving.value = false
  }
}

async function saveFormatSettings() {
  formatSaving.value = true
  formatSaveError.value = ''
  try {
    const body: any = {
      format_id: 'continuity-chain',
      content_mode: 'format',
      continuity_mode: continuityMode.value,
    }
    await put(`/projects/${slug.value}`, body)
    formatId.value = 'continuity-chain'
    formatIdBaseline.value = 'continuity-chain'
    continuityModeBaseline.value = continuityMode.value
    stampSaved('format')
    success('Format settings saved')
    await loadProject(slug.value)
  } catch (e: any) {
    formatSaveError.value = e?.data?.detail || e?.message || 'Failed to save format settings'
    showError(formatSaveError.value)
  } finally {
    formatSaving.value = false
  }
}

// ── Niche tab state (subject-domain layer) ─────────────────────────────────
//
// Niche is orthogonal to Format — empty string means "no niche, use format
// defaults only". Saved via the dedicated /projects/:slug/niche endpoint
// so the existing /projects/:slug
// PATCH path doesn't need to learn about a new field shape.

// v1.0.96+ — Niche tab also absorbs the standalone /niches sidebar page
// (browse / create custom / delete custom). One source for niche stuff.
const {
  find: findNicheProfile,
  niches: nicheLibList,
  isLoading: nicheLibLoading,
  error: nicheLibError,
  createNiche: createNicheApi,
  deleteNiche: deleteNicheApi,
  refresh: refreshNiches,
} = useNiches()
const { topicPacks: topicPackLibList } = useTopicPacks()
const nicheId = ref<string>('')
const topicPackIds = ref<string[]>([])
const identityPickerOpen = ref(false)
const customNicheLibList = computed(() => nicheLibList.value.filter(niche => !niche.builtin))
const nicheLibraryCount = computed(() => customNicheLibList.value.length)
const selectedNicheProfile = computed(() => findNicheProfile(nicheId.value))
const selectedFormulaLabel = computed(() => selectedNicheProfile.value?.catalogName || selectedNicheProfile.value?.name || nicheId.value || 'No Formula')
const selectedTopicPackLabel = computed(() => {
  if (!topicPackIds.value.length) return 'No Topic Packs'
  const names = topicPackIds.value.map(id => topicPackLibList.value.find(pack => pack.id === id)?.name || id)
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')
})
const projectContentPackVersions = computed<Record<string, string>>(() => (project.value as any)?.content_pack_versions || {})
const selectedProductionKit = computed(() => selectedNicheProfile.value?.productionKit || null)
const humanizeCatalogId = (value?: string) => (value || 'Not specified')
  .replace(/^com\.storystudio\.(?:style|thumbnail|formula|topic)\./, '')
  .replace(/^builtin-/, '')
  .split(/[-_]/g)
  .filter(Boolean)
  .map(part => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ')
/**
 * A Formula SUGGESTS a visual style; it never writes one. The suggestion has
 * three honest states, and the card says which one you are in:
 *   - in use            → you already picked it, nothing to do
 *   - installed         → one click applies it
 *   - not installed     → we name it and point at the Content Store
 * Before v1.4.64 there was no state at all: saving the Formula silently wrote
 * a style into the project, so the look was decided for you and the picker
 * showed a value you never chose.
 */
const productionKitStyleSuggestionIds = computed<string[]>(() => {
  const ids = selectedNicheProfile.value?.recommendedVisualStyleIds
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id.trim()) : []
})
const productionKitStyleSuggestion = computed(() => {
  const id = productionKitStyleSuggestionIds.value[0]
  if (!id) return null
  const installed = visualStyles.value.find(style => style.id === id) || null
  const active = String((config.value as any)?.active_style_preset_id || '').trim()
  return {
    id,
    name: installed?.name || humanizeCatalogId(id),
    installed: Boolean(installed),
    inUse: active === id,
  }
})
/** One click, and only ever from this button. Routes through the same picker
 *  the customer uses, so the choice is recorded exactly as a manual one. */
function useSuggestedProductionKitStyle(): void {
  const suggestion = productionKitStyleSuggestion.value
  if (artStyleSaving.value || !suggestion || !suggestion.installed || suggestion.inUse) return
  artStyleSelection.value = suggestion.id
}
const selectedProductionKitThumbnailName = computed(() =>
  humanizeCatalogId(selectedNicheProfile.value?.defaultThumbnailTemplateId))
const selectedProductionKitMotionName = computed(() =>
  selectedNicheProfile.value?.scriptStructure?.motionProfile?.label || 'Formula default')
const selectedProductionKitMotionSummary = computed(() => {
  const profile = selectedNicheProfile.value?.scriptStructure?.motionProfile
  if (!profile) return 'Uses the Formula’s normal scene behavior.'
  return `Opening: ${profile.opening.still}% still · ${profile.opening.gentle}% gentle · ${profile.opening.limited}% limited. Settled: ${profile.settled.still}% still · ${profile.settled.gentle}% gentle · ${profile.settled.limited}% limited.`
})
const selectedProductionKitDurations = computed(() => {
  const presets = selectedNicheProfile.value?.scriptStructure?.durationPresets || []
  return presets.length ? presets.map(value => `${value} min`).join(' · ') : 'Formula default'
})

// ── Publishing cadence ── moved to components/PublishingScheduleCard.vue (v1.4.249):
// Settings now shows and edits the channel's active upload plan itself.

// ── Episode shape (v1.4.18) ───────────────────────────────────────────────
// 1.4.16 gave every Formula its own chapters, length and pace, and left no way
// to change them without editing JSON. The owner: "series formula editing ui.
// do it please then, i thought you already did it."
//
// This edits through PATCH /niches/:id/episode-shape, a MERGE. The
// full-document PUT beside it validates against `NicheSchema`, which does not
// contain scriptStructure, narratorStyles, pacingArc or titleShapeRules — so
// sending a real Formula through it is refused, and would have stripped those
// fields if it were not. See routes/niches.ts.
const shapeOpen = ref(false)
const shapeSaving = ref(false)
const shapeError = ref('')
interface EpisodeShapeForm {
  defaultChapterCount: number
  chapterMin: number
  chapterMax: number
  defaultLengthMinutes: number
  minutesMin: number
  minutesMax: number
  defaultWordsPerMinute: number
  chaptersIndependent: boolean
  metadataTitleStyleHint: string
}
const shapeForm = ref<EpisodeShapeForm | null>(null)

/** Roughly how many words a chapter carries at this shape — the number that
 *  makes a length and a pace mean something together. */
const shapeWordsPerChapter = computed(() => {
  const f = shapeForm.value
  if (!f || !f.defaultChapterCount) return 0
  return Math.round((f.defaultLengthMinutes * f.defaultWordsPerMinute) / f.defaultChapterCount)
})
const shapeTotalWords = computed(() => {
  const f = shapeForm.value
  return f ? Math.round(f.defaultLengthMinutes * f.defaultWordsPerMinute) : 0
})

function openEpisodeShape() {
  const n = selectedNicheProfile.value
  const ss: any = n?.scriptStructure || {}
  shapeError.value = ''
  shapeForm.value = {
    defaultChapterCount: ss.defaultChapterCount ?? 5,
    chapterMin: ss.chapterCountRange?.[0] ?? 1,
    chapterMax: ss.chapterCountRange?.[1] ?? 20,
    defaultLengthMinutes: ss.defaultLengthMinutes ?? 8,
    minutesMin: ss.lengthMinutesRange?.[0] ?? 3,
    minutesMax: ss.lengthMinutesRange?.[1] ?? 20,
    defaultWordsPerMinute: ss.defaultWordsPerMinute ?? 160,
    chaptersIndependent: !!ss.chaptersIndependent,
    metadataTitleStyleHint: (n as any)?.metadataTitleStyleHint || '',
  }
  shapeOpen.value = true
}

async function saveEpisodeShape() {
  const f = shapeForm.value
  if (!f || !nicheId.value) return
  shapeSaving.value = true
  shapeError.value = ''
  try {
    // project_slug is not optional in effect: without it the fork is written
    // and nothing points at it, so the change would look saved and do nothing.
    const res = await patch(
      `/niches/${encodeURIComponent(nicheId.value)}/episode-shape`
      + `?project_slug=${encodeURIComponent(slug.value)}`,
      {
        defaultChapterCount: Number(f.defaultChapterCount),
        chapterCountRange: [Number(f.chapterMin), Number(f.chapterMax)],
        defaultLengthMinutes: Number(f.defaultLengthMinutes),
        lengthMinutesRange: [Number(f.minutesMin), Number(f.minutesMax)],
        defaultWordsPerMinute: Number(f.defaultWordsPerMinute),
        chaptersIndependent: !!f.chaptersIndependent,
        metadataTitleStyleHint: f.metadataTitleStyleHint || '',
      },
    )
    // A built-in becomes a user copy on first edit, so the project's Formula id
    // changes underneath us. Reload both or the page keeps showing the old one.
    await refreshNiches()
    await loadProject(slug.value)
    syncNicheFromProject()
    shapeOpen.value = false
    success(res?.forked_from
      ? 'Episode shape saved — this channel now uses its own copy of the Formula'
      : 'Episode shape saved')
  } catch (e: any) {
    shapeError.value = e?.data?.detail || e?.message || 'Could not save the episode shape'
  } finally {
    shapeSaving.value = false
  }
}

function syncNicheFromProject() {
  const m = project.value as any
  if (!m) return
  nicheId.value = m.niche_id || ''
  topicPackIds.value = Array.isArray(m.topic_pack_ids)
    ? [...m.topic_pack_ids]
    : [...(findNicheProfile(nicheId.value)?.defaultTopicPackIds || [])]
}

watch(project, syncNicheFromProject, { immediate: true })
watch(nicheLibList, () => {
  const meta = project.value as any
  if (!meta?.niche_id || Array.isArray(meta.topic_pack_ids)) return
  const defaults = findNicheProfile(meta.niche_id)?.defaultTopicPackIds || []
  topicPackIds.value = [...defaults]
}, { immediate: true })

async function onIdentitySaved(value: { formulaId: string; topicPackIds: string[] }): Promise<void> {
  nicheId.value = value.formulaId
  topicPackIds.value = [...value.topicPackIds]
  stampSaved('niche')
  success(value.formulaId ? 'Series Formula and Topic Packs saved' : 'Series Formula cleared')
  await loadProject(slug.value)
}

// ── v1.0.96+ Niche library: create / delete / use-on-project ──────────
//
// Merged in from the standalone /niches sidebar page (now retired).
// Custom-formula actions share the catalogue cache with the Channel Identity
// library, so a newly created local Formula appears the next time it opens.

const nicheCreateOpen = ref(false)
const nicheCreateBusy = ref(false)
const nicheCreateError = ref('')
const nicheDraft = reactive({
  id: '',
  name: '',
  tagline: '',
  description: '',
  scriptContext: '',
  visualStyleSheet: '',
})
const nicheDraftExampleTopicsText = ref('')

const nicheCanCreate = computed(() => {
  if (!nicheDraft.id.trim()) return false
  if (!nicheDraft.name.trim()) return false
  if (!nicheDraft.description.trim()) return false
  if (!nicheDraftExampleTopicsText.value.trim()) return false
  return /^[a-z0-9][a-z0-9_-]*$/.test(nicheDraft.id.trim())
})

function openNicheCreator(): void {
  nicheDraft.id = ''
  nicheDraft.name = ''
  nicheDraft.tagline = ''
  nicheDraft.description = ''
  nicheDraft.scriptContext = ''
  nicheDraft.visualStyleSheet = ''
  nicheDraftExampleTopicsText.value = ''
  nicheCreateError.value = ''
  nicheCreateOpen.value = true
}
function closeNicheCreator(): void {
  if (nicheCreateBusy.value) return
  nicheCreateOpen.value = false
}
async function submitNicheCreate(): Promise<void> {
  if (!nicheCanCreate.value) return
  nicheCreateBusy.value = true
  nicheCreateError.value = ''
  try {
    const topics = nicheDraftExampleTopicsText.value
      .split('\n').map(s => s.trim()).filter(Boolean)
    await createNicheApi({
      id: nicheDraft.id.trim(),
      name: nicheDraft.name.trim(),
      description: nicheDraft.description.trim(),
      builtin: false,
      schemaVersion: 1,
      tagline: nicheDraft.tagline.trim() || undefined,
      exampleTopics: topics,
      scriptContext: nicheDraft.scriptContext.trim() || undefined,
      visualStyleSheet: nicheDraft.visualStyleSheet.trim() || undefined,
    })
    success(`Created custom niche "${nicheDraft.name.trim()}"`)
    nicheCreateOpen.value = false
  } catch (e: any) {
    nicheCreateError.value = e?.data?.detail || e?.message || 'Failed to create niche'
  } finally {
    nicheCreateBusy.value = false
  }
}

async function confirmDeleteNiche(n: { id: string; name: string; project_count?: number }): Promise<void> {
  if (n.project_count && n.project_count > 0) {
    showError(`Cannot delete "${n.name}" — ${n.project_count} channel(s) still reference it. Change those channels' niches first.`)
    return
  }
  const ok = await ask({
    title: `Delete niche "${n.name}"?`,
    message: 'Removes the custom niche file from this Mac. Built-in niches cannot be deleted.',
    confirmLabel: 'Delete Niche',
    danger: true,
  })
  if (!ok) return
  try {
    await deleteNicheApi(n.id)
    success(`Deleted "${n.name}"`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to delete niche')
  }
}

// (Removed: connectivity precheck state. It used to live alongside the
// API Keys tab on this page; the tab is gone, and the wizard on /
// runs its own precheck on entry to step 4.)

// ── Storage tab state ─────────────────────────────────────────────────────
//
// Audit/cleanup talks to the new /storage-* endpoints. External-root
// is per-machine (lives in app-settings, not project config) so we
// fetch it from /app-settings/external-final-video-root rather than
// the project's config. Lazy-loaded — first scan only fires when the
// user clicks the Run scan button so opening the tab is instant.

interface StorageEntry {
  episode_code: string
  title: string
  bytes_final_video: number
  bytes_per_scene_clips: number
  bytes_audio: number
  bytes_narration_parts?: number
  bytes_images: number
  bytes_other: number
  bytes_total: number
  bytes_external_final_video: number
  uploaded_to_youtube: boolean
  youtube_video_id: string
  cleanup_eligible: boolean
  cleanup_reason?: string
}
interface StorageAudit {
  project_bytes_total: number
  project_bytes_final_video: number
  project_bytes_per_scene_clips: number
  project_bytes_narration_parts?: number
  project_bytes_external_final_video: number
  project_bytes_thumbnail_cache?: number
  /** Free disk and what waits in `_trash`; free_bytes null = could not be measured. */
  space?: { free_bytes: number | null; project_trash_bytes: number; library_trash_bytes: number }
  external_root_configured: boolean
  external_root: string
  episodes: StorageEntry[]
}
interface MigrationResult {
  moved: Array<{ episode_code: string; from: string; to: string; bytes: number }>
  errors: Array<{ episode_code: string; reason: string }>
  bytes_moved: number
}
interface MediaMigrationResult {
  dry_run: boolean
  folders: Array<{ episode_code: string; key: string; from: string; to: string; files: number; bytes: number }>
  scene_plan_rewrites: number
  errors: Array<{ episode_code: string; reason: string }>
  bytes_moved: number
  files_moved: number
}
interface CleanupResult {
  deleted_count: number; skipped_count: number; failed_count: number
  bytes_freed: number
  items: Array<{ episode_code: string; file: string; status: string; bytes_freed: number; reason?: string }>
}

const storage = ref<StorageAudit | null>(null)
const auditLoading = ref(false)
const previewCacheClearing = ref(false)
const lastPreviewCacheClear = ref<{ bytes: number; moved: boolean } | null>(null)

// ── External media root (Level B, per-project, opt-in) ───────────────────────
// Routes heavy media (images/thumbnails/audio/merged audio/video) to a separate
// root (e.g. an external SSD) while light artifacts stay in the project tree.
// Stored in project.json as `media_root` (a ${NAME} token or absolute path).
const mediaRootInput = ref('')
const mediaRootSavedValue = ref('')
const mediaRootSaving = ref(false)
const mediaRootChecking = ref(false)
const mediaRootStatus = ref('')
const mediaRootOk = ref(false)
const mediaMigrateRunning = ref(false)
const lastMediaMigration = ref<MediaMigrationResult | null>(null)
const lastMigration = ref<MigrationResult | null>(null)
const bulkRunning = ref(false)
const lastBulkCleanup = ref<CleanupResult | null>(null)
/** Clear Uploaded Videos runs as a background operation (1.4.289): what it is doing, and how far. */
interface BulkOperation { id: string; status: string; done: number; total: number; bytes_done: number; bytes_total: number; current: string; detail: string; error?: string; final_cleanup?: CleanupResult }
const bulkOperation = ref<BulkOperation | null>(null)
const bulkError = ref('')
let bulkPoll: ReturnType<typeof setTimeout> | null = null
const bulkProgressText = computed(() => {
  const op = bulkOperation.value
  if (!op) return ''
  if (op.status === 'stopping') return 'Stopping after this episode…'
  if (!op.total) return 'Finding the uploaded videos…'
  return `Verifying ${Math.min(op.done + 1, op.total)} of ${op.total} episodes · ${formatBytes(op.bytes_done)} of ${formatBytes(op.bytes_total)} checked`
})

// v1.0.71: chunked-progress sidecar cleanup (manual; never auto-wipes).
// listChunkedSidecars walks every accepted episode and tags each as
// `eligible` (unified narration done + chapters_done covers total) or
// gives a reason it's not safe to clean. The user reviews before
// triggering deletion.
interface SidecarEligibilityRow {
  episode_code: string
  sidecar_present: boolean
  sidecar_path: string
  sidecar_size_bytes?: number
  total_chapters?: number
  chapters_done?: number
  unified_present: boolean
  eligible: boolean
  reason?: string
}
interface SidecarScanResult {
  episodes: SidecarEligibilityRow[]
  eligible_count: number
  reclaimable_bytes: number
}
interface SidecarCleanupResult {
  deleted: Array<{ episode_code: string; path: string; bytes_freed: number }>
  skipped: Array<{ episode_code: string; reason: string }>
  total_bytes_freed: number
}
const sidecarScan = ref<SidecarScanResult | null>(null)
const sidecarScanLoading = ref(false)
const sidecarCleanupRunning = ref(false)
const lastSidecarCleanup = ref<SidecarCleanupResult | null>(null)

const sortedStorageRows = computed<StorageEntry[]>(() => {
  if (!storage.value) return []
  return [...storage.value.episodes].sort((a, b) => b.bytes_total - a.bytes_total)
})

// Bulk cleanup offers only candidates with a current content-hash receipt.
// The backend re-verifies exact bytes and current provider state before rm.
const uploadedFinals = computed<StorageEntry[]>(() => {
  if (!storage.value) return []
  return storage.value.episodes.filter(e => e.cleanup_eligible
    && (e.bytes_final_video > 0 || e.bytes_external_final_video > 0))
})
const uploadedFinalsCount = computed(() => uploadedFinals.value.length)
const uploadedFinalsTotalBytes = computed(() =>
  uploadedFinals.value.reduce((s, e) => s + e.bytes_final_video + e.bytes_external_final_video, 0),
)

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

// Verify the media_root token/path resolves on THIS machine (does not check
// that the drive is currently plugged in — just that ${MEDIA} is defined).
async function checkMediaRoot() {
  const val = mediaRootInput.value.trim()
  if (!val) { mediaRootStatus.value = ''; mediaRootOk.value = false; return }
  mediaRootChecking.value = true
  try {
    const r = await post<{ output: string; is_portable: boolean }>(
      '/system/resolve-asset-path', { path: val },
    )
    mediaRootOk.value = true
    mediaRootStatus.value = `✓ Resolves to ${r.output} — keep this drive connected when generating media.`
  } catch (e: any) {
    mediaRootOk.value = false
    mediaRootStatus.value = `⚠ ${e?.data?.detail || e?.message || 'Could not resolve this path on this Mac. Use a full folder path or ${ASSET}/….'}`
  } finally {
    mediaRootChecking.value = false
  }
}

async function saveMediaRoot() {
  mediaRootSaving.value = true
  try {
    const val = mediaRootInput.value.trim()
    await put(`/projects/${slug.value}`, { media_root: val })
    mediaRootSavedValue.value = val
    stampSaved('mediaRoot')
    if (val) { await checkMediaRoot() } else { mediaRootStatus.value = ''; mediaRootOk.value = false }
    success(val
      ? 'External media root saved — new media for this channel will be written there.'
      : 'External media root cleared — media stays in the channel folder.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save external media root')
  } finally {
    mediaRootSaving.value = false
  }
}

async function clearMediaRoot() {
  // The option is retired for projects without it, so clearing is one-way.
  if (!await ask({
    title: 'Stop using the other drive for this channel?',
    message: 'Story Studio looks for this channel\'s media in the channel folder again. Files already on the other drive are not moved back. Once cleared, this cannot be turned on again.',
    confirmLabel: 'Clear',
    danger: true,
  })) return
  mediaRootInput.value = ''
  await saveMediaRoot()
}

async function loadStorageAudit() {
  auditLoading.value = true
  try {
    storage.value = await get<StorageAudit>(`/projects/${slug.value}/storage-audit`)
  } catch (e: any) {
    storage.value = null
    showError(e?.data?.detail || e?.message || 'Storage audit failed')
  } finally {
    auditLoading.value = false
  }
}

async function clearPreviewCache() {
  if (previewCacheClearing.value) return
  previewCacheClearing.value = true
  try {
    lastPreviewCacheClear.value = await post<{ bytes: number; moved: boolean }>(
      `/projects/${slug.value}/storage/clear-preview-cache`,
      {},
    )
    await loadStorageAudit()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Clearing the preview cache failed')
  } finally {
    previewCacheClearing.value = false
  }
}

async function runBulkCleanup() {
  if (!storage.value || uploadedFinalsCount.value === 0) return
  const ok = await ask({
    title: 'Verify and clear local videos?',
    message: `Verify ${uploadedFinalsCount.value} local final video file(s) (${formatBytes(uploadedFinalsTotalBytes.value)}) before clearing them?\n\n` +
    `Story Studio checks each file is the exact one you uploaded and that YouTube still has it, right before clearing it. ` +
    `Any file it cannot verify stays local and is reported below.`,
    confirmLabel: `Verify & clear ${uploadedFinalsCount.value} files`, danger: true,
  })
  if (!ok) return
  bulkRunning.value = true
  bulkError.value = ''
  lastBulkCleanup.value = null
  try {
    const { operation_id } = await post<{ operation_id: string }>(`/projects/${slug.value}/storage/bulk-cleanup-final/start`, {})
    bulkOperation.value = { id: operation_id, status: 'queued', done: 0, total: 0, bytes_done: 0, bytes_total: 0, current: '', detail: '' }
    void pollBulkCleanup()
  } catch (e: any) {
    bulkRunning.value = false
    bulkError.value = `${e?.data?.detail || e?.message || 'Clearing uploaded videos could not start.'}`
  }
}

async function pollBulkCleanup() {
  const op = bulkOperation.value
  if (!op) return
  try {
    const next = await get<BulkOperation>(`/projects/${slug.value}/media-cleanup/operations/${op.id}`)
    bulkOperation.value = next
    if (['queued', 'running', 'stopping'].includes(next.status)) { bulkPoll = setTimeout(() => void pollBulkCleanup(), 1000); return }
    bulkRunning.value = false
    lastBulkCleanup.value = next.final_cleanup ?? null
    if (next.status === 'failed') bulkError.value = `Clearing uploaded videos stopped: ${next.error || 'unknown error'}. Nothing that was not verified was moved; press the button again to retry.`
    await loadStorageAudit()
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.status === 404) {
      bulkRunning.value = false; bulkOperation.value = null
      bulkError.value = 'The clearing is no longer running (Story Studio restarted?). Check the uploaded videos again.'
      return
    }
    bulkPoll = setTimeout(() => void pollBulkCleanup(), 3000) // one missed read: keep following it
  }
}

async function stopBulkCleanup() {
  const op = bulkOperation.value
  if (!op) return
  try { bulkOperation.value = { ...op, ...await post<{ status: string }>(`/projects/${slug.value}/media-cleanup/operations/${op.id}/stop`, {}) } }
  catch (e: any) { bulkError.value = `${e?.data?.detail || e?.message || 'Could not stop it.'}` }
}

// v1.0.71: chunked-sidecar scan + cleanup handlers. Mirrors the storage
// audit + bulk-cleanup pattern above but with strict per-episode
// eligibility (unified narration done + chapters_done covers total).
async function scanChunkedSidecars() {
  sidecarScanLoading.value = true
  try {
    sidecarScan.value = await get<SidecarScanResult>(
      `/projects/${slug.value}/storage/chunked-sidecars`,
    )
    lastSidecarCleanup.value = null
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not check for leftover script progress files')
  } finally {
    sidecarScanLoading.value = false
  }
}

async function cleanupAllChunkedSidecars() {
  if (!sidecarScan.value || sidecarScan.value.eligible_count === 0) return
  const ok = await ask({
    title: `Remove ${sidecarScan.value.eligible_count} narration progress file(s)?`,
    message: `${formatBytes(sidecarScan.value.reclaimable_bytes)} of small progress files left over from finished narration. ` +
      'Only those files go — chapter documents, audio and everything else stay put.',
    confirmLabel: 'Remove Them',
    danger: true,
  })
  if (!ok) return
  sidecarCleanupRunning.value = true
  try {
    lastSidecarCleanup.value = await post<SidecarCleanupResult>(
      `/projects/${slug.value}/storage/cleanup-chunked-sidecars`,
      { all_eligible: true },
    )
    // Re-scan so the table updates (cleaned rows drop out, in-progress
    // ones stay).
    await scanChunkedSidecars()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not remove the leftover script progress files')
  } finally {
    sidecarCleanupRunning.value = false
  }
}

async function cleanupOneSidecar(episode_code: string) {
  if (!await ask({
    title: `Remove ${episode_code}'s narration progress files?`,
    message: 'Only the leftover progress files go; chapter documents and audio stay put.',
    confirmLabel: 'Remove',
    danger: true,
  })) return
  sidecarCleanupRunning.value = true
  try {
    lastSidecarCleanup.value = await post<SidecarCleanupResult>(
      `/projects/${slug.value}/storage/cleanup-chunked-sidecars`,
      { episode_codes: [episode_code] },
    )
    await scanChunkedSidecars()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not remove the leftover script progress files')
  } finally {
    sidecarCleanupRunning.value = false
  }
}


// Move existing HEAVY media to the project's media root. Previews via a dry-run
// first, shows the totals in a confirm, then executes for real.
async function migrateMediaToRoot() {
  if (!mediaRootSavedValue.value) { showError('Set + save an external media root first.'); return }
  if (mediaRootInput.value.trim() !== mediaRootSavedValue.value) { showError('Save your media root change before migrating.'); return }
  mediaMigrateRunning.value = true
  try {
    const plan = await post<MediaMigrationResult>(
      `/projects/${slug.value}/storage/migrate-media-to-external`, { dry_run: true },
    )
    const totalFiles = plan.folders.reduce((s, f) => s + f.files, 0)
    const totalBytes = plan.folders.reduce((s, f) => s + f.bytes, 0)
    if (totalFiles === 0) { info('Nothing to migrate — no media found in the channel folder.'); return }
    const ok = await ask({
      title: 'Move channel media?',
      message: `Move ${totalFiles} media file(s) (${formatBytes(totalBytes)}) across ${plan.folders.length} folder(s) ` +
      `from the channel folder to:\n\n${mediaRootSavedValue.value}\n\n` +
      `Files are copied, verified, then removed from the channel folder. ` +
      `Keep the drive connected until it finishes. This is resumable if interrupted.`,
      confirmLabel: `Move ${totalFiles} files`, danger: true,
    })
    if (!ok) return
    const r = await post<MediaMigrationResult>(
      `/projects/${slug.value}/storage/migrate-media-to-external`, { dry_run: false },
    )
    lastMediaMigration.value = r
    if (r.errors.length) showError(`Migrated with ${r.errors.length} error(s) — see details below.`)
    else success(`Migrated ${r.files_moved} file(s) (${formatBytes(r.bytes_moved)}) to the media root.`)
    if (storage.value) await loadStorageAudit()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Media migration failed')
  } finally {
    mediaMigrateRunning.value = false
  }
}

/**
 * The Library — one location, replacing the projects-root override (v1.4.3).
 *
 * Changing it is a COPY, done by the same mover the old flow used, then a
 * restart: long-lived state (job queue, watchers, caches) still points at the
 * old place until the app comes back up. The old folder is deliberately left
 * behind — deleting someone's library after copying it is not a decision this
 * app makes.
 */
interface LibraryStatus {
  configured: boolean
  path: string
  exists: boolean
  writable: boolean
  suggested: string
  assets_dir: string
  exports_dir: string
  exports_custom?: boolean
  exports_previous?: string[]
}

const library = ref<LibraryStatus | null>(null)
const projectsRootBusy = ref(false)
const projectsRootStatus = ref('')
const projectsRootStatusKind = ref<'ok' | 'warn' | 'err'>('ok')
const exportsBusy = ref(false)
const exportsStatus = ref('')
const exportsStatusKind = ref<'ok' | 'warn' | 'err'>('ok')

async function loadLibrary() {
  try {
    library.value = await get<LibraryStatus>('/library')
  } catch (e: any) {
    projectsRootStatus.value = `Couldn't read your Library location: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
  }
}
onMounted(loadLibrary)

/**
 * Archive uploaded videos (v1.4.4) — Library-wide.
 *
 * Preview first, then move. The run is fire-and-poll rather than one long
 * request: 220 GB takes many minutes and any proxy in between would give up
 * long before the copy did.
 */
type ArchiveSkipReason =
  | 'no_code' | 'unknown_channel' | 'ambiguous_channel'
  | 'not_uploaded' | 'not_reviewed' | 'collision'
interface ArchivePreviewRow {
  source_path: string; filename: string; bytes: number; code: string
  slug?: string; youtube_video_id?: string
  status: 'ready' | 'skipped'; reason?: string; reason_code?: ArchiveSkipReason
}
interface ArchivePreviewResult {
  source_root: string; source_exists: boolean
  complete: boolean; cancelled: boolean
  candidates: ArchivePreviewRow[]
  ready_count: number; ready_bytes: number
  skipped_count: number; skipped_bytes: number
  by_channel: Array<{ slug: string; count: number; bytes: number }>
}

const archiveSource = ref('')
const archiveDest = ref('')
const archiveBusy = ref(false)
const archiveRunning = ref(false)
const archiveChecking = ref(false)
const archiveStopping = ref(false)
const archiveStage = ref<'checking' | 'moving' | null>(null)
const archivePreview = ref<ArchivePreviewResult | null>(null)
const archiveResult = ref<any>(null)
const archiveProgress = ref({ done: 0, total: 0, checked: 0, current: '' })
let archivePoll: ReturnType<typeof setInterval> | null = null
let archivePollInFlight = false
let archiveRestoreInFlight = false
let archivePanelDisposed = false

const archiveSkippedRows = computed(
  () => (archivePreview.value?.candidates || []).filter(c => c.status === 'skipped'),
)
const archiveReadyRows = computed(
  () => (archivePreview.value?.candidates || []).filter(c => c.status === 'ready'),
)

/**
 * What the skipped pile is actually made of, in his words.
 *
 * The confirm dialog used to describe every skip as "not confirmed uploaded".
 * That was wrong twice: files with no episode code at all were counted as
 * unproven uploads (his TerenceGaming folder is full of them), and until
 * v1.4.10 the sentence's promise — that nothing unproven would be touched —
 * was not true across channels. Say what is true instead.
 */
const archiveSkipSummary = computed(() => {
  const counts: Record<string, number> = {}
  for (const row of archiveSkippedRows.value) {
    const key = row.reason_code || 'other'
    counts[key] = (counts[key] || 0) + 1
  }
  const phrases: string[] = []
  const say = (key: string, one: string, many: string) => {
    const n = counts[key]
    if (n) phrases.push(`${n} ${n === 1 ? one : many}`)
  }
  say('not_uploaded', 'is not confirmed uploaded', 'are not confirmed uploaded')
  say('no_code', 'has no episode code', 'have no episode code')
  say('unknown_channel', 'cannot be tied to a channel', 'cannot be tied to a channel')
  say('ambiguous_channel', 'sits where more than one channel could own it',
    'sit where more than one channel could own them')
  say('other', 'is skipped for another reason', 'are skipped for other reasons')
  return phrases
})

async function loadArchivePreview() {
  if (archiveBusy.value) return
  archiveBusy.value = true
  archiveChecking.value = true
  archiveRunning.value = false
  archiveStopping.value = false
  archiveStage.value = 'checking'
  archiveProgress.value = { done: 0, total: 0, checked: 0, current: '' }
  archiveResult.value = null
  archivePreview.value = null
  try {
    await post('/library/archive/preview', {
      source_root: archiveSource.value.trim() || undefined,
    })
    if (archivePoll) clearInterval(archivePoll)
    archivePoll = setInterval(pollArchive, 1000)
    void pollArchive()
  } catch (e: any) {
    archiveChecking.value = false
    archiveStage.value = null
    archiveBusy.value = false
    showError(e?.data?.detail || e?.message || 'Could not check the folder')
  }
}

async function startArchive() {
  if (archiveBusy.value) return
  const preview = archivePreview.value
  if (!preview?.complete) return
  const approved = preview.candidates.filter(c => c.status === 'ready').map(c => c.source_path)
  const staying = archiveSkipSummary.value.length
    ? `${preview.skipped_count} video(s) stay where they are — ${archiveSkipSummary.value.join(', ')}.`
    : 'Nothing else in that folder is affected.'
  const ok = await ask({
    title: 'Move finished videos?',
    message: `${preview.ready_count} video(s) — ${formatBytes(preview.ready_bytes)} — will be COPIED to\n`
      + `  ${archiveDest.value}\n\n`
      + `Each one is checked at the destination before the original is removed, so nothing is lost `
      + `if the copy fails.\n\n`
      + `${staying}\n\n`
      + `Only the ${preview.ready_count} listed above will be moved — anything added to the folder `
      + `after this check is left alone.`,
    confirmLabel: 'Move Them',
  })
  if (!ok) return

  archiveBusy.value = true
  archiveRunning.value = true
  archiveChecking.value = false
  archiveStopping.value = false
  archiveStage.value = 'checking'
  archiveProgress.value = { done: 0, total: approved.length, checked: 0, current: '' }
  archiveResult.value = null
  try {
    await post('/library/archive/run', {
      destination: archiveDest.value.trim(),
      // Bind the move to the root that produced this bill. Editing the input
      // after a completed review must not substitute a different folder.
      source_root: preview.source_root,
      // The reviewed set. The server re-checks each one's upload proof and can
      // only get stricter, but it will not move anything outside this list.
      approved,
    })
    if (archivePoll) clearInterval(archivePoll)
    archivePoll = setInterval(pollArchive, 1000)
    void pollArchive()
  } catch (e: any) {
    archiveRunning.value = false
    archiveBusy.value = false
    archiveStage.value = null
    showError(e?.data?.detail || e?.message || 'Could not start the sweep')
  }
}

function applyArchiveStatus(st: any): boolean {
  const phase = st.phase === 'preview' || st.phase === 'run' ? st.phase : null
  // A fresh server has no archive operation to restore. Do not turn that into
  // an empty result or a fake stopped scan when Settings first opens.
  if (!st.running && !phase) return false

  archiveStage.value = st.stage || null
  archiveProgress.value = {
    done: st.done || 0, total: st.total || 0, checked: st.checked || 0, current: st.current || '',
  }
  archiveStopping.value = !!st.stopping
  archiveBusy.value = !!st.running
  archiveChecking.value = !!st.running && phase === 'preview'
  archiveRunning.value = !!st.running && phase === 'run'
  if (st.running) return true

  if (archivePoll) { clearInterval(archivePoll); archivePoll = null }
  archiveStage.value = null
  if (phase === 'preview') {
    archivePreview.value = st.result || null
    archiveResult.value = null
  } else {
    archiveResult.value = st.result
    archivePreview.value = null
  }
  if (st.error) showError(st.error)
  return true
}

async function pollArchive() {
  if (archivePollInFlight) return
  archivePollInFlight = true
  try {
    applyArchiveStatus(await get<any>('/library/archive/status'))
  } catch { /* transient — keep polling */ }
  finally { archivePollInFlight = false }
}

async function stopArchive() {
  archiveStopping.value = true
  try { await post('/library/archive/stop', {}) } catch { /* best effort */ }
}

async function restoreArchiveInFlight() {
  if (archiveBusy.value || archivePoll || archiveRestoreInFlight || archivePanelDisposed) return
  archiveRestoreInFlight = true
  try {
    const st = await get<any>('/library/archive/status')
    if (archivePanelDisposed || archiveBusy.value || archivePoll) return
    if (applyArchiveStatus(st) && st.running) archivePoll = setInterval(pollArchive, 1000)
  } catch { /* the archive panel remains idle until its next explicit action */ }
  finally { archiveRestoreInFlight = false }
}

onBeforeUnmount(() => {
  if (bulkPoll) clearTimeout(bulkPoll)
  archivePanelDisposed = true
  if (archivePoll) clearInterval(archivePoll)
  archivePoll = null
})

async function moveLibraryTo(picked: string) {
  if (!picked || picked === library.value?.path) return
  const ok = await ask({
    title: 'Move your Library?',
    message: `To: ${picked}\n\nEvery channel, your shared assets and your exports are COPIED there. ` +
      'The current folder is left exactly as it is, so nothing can be lost — you can delete it yourself once you have checked the new one. ' +
      'Story Studio restarts afterwards.',
    confirmLabel: 'Copy and Restart',
  })
  if (!ok) return

  projectsRootBusy.value = true
  projectsRootStatus.value = 'Copying your Library…'
  projectsRootStatusKind.value = 'ok'
  try {
    await put('/library', { path: picked, move: true })
    projectsRootStatus.value = '✓ Moved. Restarting…'
    setTimeout(async () => {
      try { await post('/system/restart-app', {}) } catch (e: any) {
        if (e?.status === 503) {
          showError('App is in dev mode and can\'t auto-restart. Quit and start it again to use the new Library.')
        } else {
          showError(`Restart failed: ${e?.data?.detail || e?.message}. Quit and reopen manually.`)
        }
      }
    }, 600)
  } catch (e: any) {
    projectsRootStatus.value = `Move failed: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    projectsRootBusy.value = false
  }
}


/** Choose where NEW finished videos go ('' = the Library's Exports folder). Moves nothing. */
async function chooseExportsFolder(picked: string) {
  const current = library.value?.exports_dir || ''
  if (picked && picked === current) return
  const ok = await ask({
    title: picked ? 'Save new finished videos here?' : 'Go back to the Library folder?',
    message: `${picked || 'The Exports folder inside your Library'}\n\nNew finished videos are saved there from now on. `
      + 'Videos you already made are NOT moved: they stay where they are and Story Studio still finds them.',
    confirmLabel: picked ? 'Use This Folder' : 'Use Library Folder',
  })
  if (!ok) return
  exportsBusy.value = true
  exportsStatus.value = ''
  try {
    library.value = await put<LibraryStatus>('/library/exports', { path: picked })
    exportsStatusKind.value = 'ok'
    exportsStatus.value = 'Saved. New finished videos go to this folder.'
  } catch (e: any) {
    exportsStatusKind.value = 'err'
    exportsStatus.value = e?.data?.detail || e?.message || 'Could not use that folder.'
  } finally {
    exportsBusy.value = false
  }
}

// v1.0.150 — The Chatterbox standalone provider was removed. All the
// chatterbox* state, loaders, savers, test-connection, and reference-upload
// handlers that used to live here have been deleted. Old project.json
// files keep their chatterbox_enabled / chatterbox_reference_id fields on
// disk (we marked the types @deprecated) — nothing reads them anymore.

// v1.0.150 — onChatterboxReferenceFile + the config watcher hydrating
// chatterbox_enabled / chatterbox_reference_id were deleted together with
// the rest of the Chatterbox integration. The fields still exist on
// disk for legacy projects (see types.ts @deprecated tags) but nothing
// in the frontend reads them.

watch(activeTab, (t) => {
  // Item J — lazy-load the YouTube category list when the user enters
  // Publishing so the dropdown is populated without a click. Cached
  // 7d on the backend, so the cost is one extra fetch per session at
  // most (and usually zero — fully cache-served).
  if (t === 'publishing' && !ytCategoryList.value.length) {
    void loadYoutubeCategoryList()
  }
  if (t === 'publishing' && !ytAppDefaults.value) {
    void loadYoutubeAppDefaults()
  }
  if (t === 'maintenance') {
    // F-04 (DS-11) — entering the tab that owns the FFmpeg card must fetch the
    // real status before the card can propose an install or recovery download.
    // Re-probing only while the answer is unknown keeps the explicit
    // "Re-check status" button meaningful and avoids a hidden fetch per visit.
    if (!ffmpegStatus.value && !ffmpegStatusLoading.value) void refreshFfmpegStatus()
    void restoreArchiveInFlight()
  }
  // v1.0.107+ — load location status so the "Unlink from this Mac"
  // danger-zone renders only when the project is actually linked.

})

// ── Item J — YouTube videoCategories.list state ────────────────────────
// Direct fetch via `get` rather than instantiating the full
// useUploadAccounts composable here (which pulls a lot of unrelated
// state into Settings). The endpoint handles 7d caching + soft fallback
// server-side.
interface YtCategoriesResponse {
  source: 'cache' | 'live' | 'stale' | 'empty'
  region: string
  fetched_at?: string
  categories: Array<{ id: string; title: string }>
  hint?: string
}
const ytCategoryList = ref<Array<{ id: string; title: string }>>([])
const ytCategorySource = ref<'cache' | 'live' | 'stale' | 'empty' | ''>('')
const ytCategoryHint = ref<string>('')
const ytCategoryLoading = ref(false)
async function loadYoutubeCategoryList() {
  ytCategoryLoading.value = true
  ytCategoryHint.value = ''
  try {
    const r = await get<YtCategoriesResponse>(`/projects/${slug.value}/upload/youtube-categories?region=US`)
    ytCategoryList.value = r.categories || []
    ytCategorySource.value = (r.source || '') as any
    ytCategoryHint.value = r.hint || ''
  } catch (e: any) {
    ytCategoryHint.value = e?.data?.detail || e?.message || 'Failed to load categories'
  } finally {
    ytCategoryLoading.value = false
  }
}

// ── v1.0.77 — AI / Synthetic content disclosure + backfill ──────────────────
//
// `aiDisclosureSelection` is a UI-only tri-state that maps to the per-project
// `mark_as_ai_generated` boolean (or undefined for "use app default"). The
// app-level fallback is fetched on tab-open so the dropdown can show the
// resolved default to the user.
interface YtAppDefaults {
  default_mark_as_ai_generated: boolean
  default_yt_category_id: number
}
const ytAppDefaults = ref<YtAppDefaults | null>(null)
const aiDisclosureSelection = computed<'on' | 'off' | 'default'>({
  get() {
    const v = projectForm.mark_as_ai_generated
    if (v === true) return 'on'
    if (v === false) return 'off'
    return 'default'
  },
  set(value) {
    if (value === 'on') projectForm.mark_as_ai_generated = true
    else if (value === 'off') projectForm.mark_as_ai_generated = false
    else projectForm.mark_as_ai_generated = undefined
  },
})

interface YtBackfillRow {
  episode_code: string
  video_id: string
  action: 'updated' | 'skipped' | 'failed' | 'missing'
  changed?: Record<string, unknown>
  reason?: string
  error?: string
}
interface YtBackfillResp {
  scanned: number
  eligible: number
  updated: number
  skipped: number
  failed: number
  missing?: number
  dry_run?: boolean
  message?: string
  details?: YtBackfillRow[]
}
const ytBackfillBusy = ref<'' | 'preview' | 'apply'>('')
const ytBackfillResult = ref<YtBackfillResp | null>(null)

async function loadYoutubeAppDefaults() {
  try {
    ytAppDefaults.value = await get<YtAppDefaults>('/app-settings/youtube-defaults')
  } catch { /* non-fatal — dropdown just shows "ON" as the assumed default */ }
}

async function runYoutubeBackfill(dryRun: boolean) {
  ytBackfillBusy.value = dryRun ? 'preview' : 'apply'
  try {
    // If the user changed the AI toggle in the UI but hasn't hit Save yet,
    // the backfill would use the LAST-SAVED value — confusing. Force a
    // save first so the in-flight selection is what gets backfilled.
    // A failed save must stop here: otherwise every uploaded video is updated
    // from the OLD saved values while the form shows the new ones.
    if (!await saveProject('publishing')) return
    const r = await post<YtBackfillResp>(
      `/projects/${slug.value}/upload/youtube-backfill`,
      { dry_run: dryRun },
    )
    ytBackfillResult.value = r
    if (!dryRun) {
      if (r.updated > 0) success(`Updated ${r.updated} YouTube video${r.updated === 1 ? '' : 's'}.`)
      else info('No videos needed updating.')
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Backfill failed')
  } finally {
    ytBackfillBusy.value = ''
  }
}

function onYoutubeBackfillPreview() { void runYoutubeBackfill(true) }
async function onYoutubeBackfillApply() {
  if (!await ask({ title: 'Update every uploaded video?', message: 'Apply the current AI disclosure and category to every uploaded video? This costs 50 YouTube quota units per video. Privacy and schedule are preserved.', confirmLabel: 'Apply to All', danger: true })) return
  await runYoutubeBackfill(false)
}

const tabZones = SETTINGS_ZONES

const tabs = tabZones.flatMap(zone => zone.sections)
const settingsHashTargetIds = settingsAnchorTargetIds(tabs.map(tab => tab.id))
const inactiveSettingsHashTargets = computed(() => settingsHashTargetIds.filter(id => id !== activeTab.value))

// v1.0.186 (S3) — the zone (This Mac / This Project) that owns the active tab.
// Drives the in-page scope banner so the user always sees whether the panel
// they're editing is per-machine or per-project.
const activeZone = computed(() =>
  tabZones.find(zone => zone.sections.some(section => section.id === activeTab.value)) || null,
)

const activeTabMeta = computed(() => tabs.find(tab => tab.id === activeTab.value) || null)

/**
 * Search result → open its section, open any Advanced disclosure around it,
 * scroll to it and flash it, so the owner sees exactly which control it was.
 */
async function goToSetting(hit: SettingEntry): Promise<void> {
  activeTab.value = hit.section
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 60))
  const el = document.querySelector<HTMLElement>(`[data-setting="${hit.anchor}"]`)
  if (!el) return
  const openDisclosure = (node: HTMLElement) => {
    if (node.classList.contains('adv-disclosure')) {
      const toggle = node.querySelector<HTMLButtonElement>(':scope > .adv-disclosure-toggle')
      if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click()
    }
    if (node.tagName === 'DETAILS') (node as HTMLDetailsElement).open = true
  }
  for (let node: HTMLElement | null = el; node; node = node.parentElement) openDisclosure(node)
  await nextTick()
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.classList.add('setting-flash')
  setTimeout(() => el.classList.remove('setting-flash'), 1600)
}

// ── FFmpeg tab state ─────────────────────────────────────────────────────
// The backend exposes a self-contained installer at POST /ffmpeg/install
// that downloads the binary from the official release mirror into the app's
// user-data directory. No brew / sudo / Terminal needed. Status is fetched
// at GET /ffmpeg/status. Other generator pages link here via the URL hash
// `#ffmpeg` — see `route.hash` watcher below for the auto-tab-switch.
interface FfmpegStatus {
  installed: boolean
  version?: string
  source?: 'bundled' | 'app-data' | 'system' | 'not-found'
  has_drawtext?: boolean
  has_libass?: boolean
  path?: string
}
const ffmpegStatus = ref<FfmpegStatus | null>(null)
/** The FFmpeg card in one plain sentence, plus the one button that fixes it (v1.4.249). */
const ffmpegState = computed<{ tone: 'ok' | 'warn' | 'err' | 'idle'; title: string; detail: string; fix: string }>(() => {
  const st = ffmpegStatus.value
  if (ffmpegStatusError.value) return { tone: 'err', title: 'Could not check FFmpeg', detail: `${ffmpegStatusError.value} — this does not mean it is missing. Check again.`, fix: '' }
  if (!st) return { tone: 'idle', title: 'Checking FFmpeg…', detail: '', fix: '' }
  if (!st.installed) return { tone: 'err', title: 'FFmpeg is missing', detail: 'Audio Assembly and Video Assembly cannot run until it is installed.', fix: 'Install FFmpeg' }
  const missing = [!st.has_drawtext && 'text overlays', !st.has_libass && 'subtitle burn-in'].filter(Boolean) as string[]
  if (!missing.length) return { tone: 'ok', title: 'Ready — includes text overlays and subtitle burn-in', detail: st.source === 'bundled' ? 'The copy that ships with Story Studio.' : '', fix: '' }
  // A bundled copy is pinned to the app; it is never replaced from here.
  return {
    tone: 'warn',
    title: `Works, but missing ${missing.join(' and ')}`,
    detail: st.source === 'bundled' ? 'Update Story Studio to get the full version.' : 'Install the full version Story Studio was tested with.',
    fix: st.source === 'bundled' ? '' : 'Install Full Version',
  }
})
const ffmpegSourceLabel = computed(() => ({
  bundled: 'Bundled with Story Studio', 'app-data': 'Recovery copy', system: 'Installed on this Mac', 'not-found': 'None',
} as Record<string, string>)[ffmpegStatus.value?.source || ''] || '—')
const ffmpegStatusLoading = ref(false)
// F-04 (DS-11) — the FFmpeg card proposes an install/recovery download from
// `ffmpegStatus.installed === false`, and a failed status check used to be
// written as exactly that (`{ installed: false }`). "I could not check" must
// not become "not installed" (AGENTS.md §6), and no install action may be
// offered for a status that was never read. `null` status = unknown.
const ffmpegStatusError = ref('')
const ffmpegInstalling = ref(false)
const ffmpegInstallProgress = ref(0)
const ffmpegInstallMessage = ref('')
const ffmpegInstallError = ref(false)

// Install-log fetch state. Populated on demand (after a failed install
// the user clicks "Show install log") rather than auto-loaded so a
// successful run doesn't hit the log endpoint unnecessarily.
interface InstallLogEntry { ts: string; level: string; message: string; phase?: string; error?: string; code?: string; stack?: string; [k: string]: any }
const ffmpegInstallLog = ref<InstallLogEntry[]>([])
const ffmpegInstallLogChecked = ref(false)
const ffmpegLogLoading = ref(false)
const ffmpegLogCopiedAt = ref(0)

// Restart prompt — shown after the in-app installer succeeds OR after a
// Re-check status flips the badges from missing → installed. The renderer
// keeps a stale "ffmpeg not found" state for some pages until the whole
// app restarts; one explicit relaunch saves the user from "I installed
// it but it's still broken" confusion.
const showFfmpegRestartPrompt = ref(false)
const restarting = ref(false)
const ffmpegInstallLogText = computed(() => {
  // Render entries as one-line-per-event with phase + duration + key
  // fields, then a separate stack/error block when present. Format
  // chosen so the user can paste into a chat/issue without further
  // formatting, and the assistant can scan it quickly.
  return ffmpegInstallLog.value.map(e => {
    const ts = e.ts || '?'
    const phase = e.phase || (e.message.split(':').slice(1).join(':') || '?')
    const ms = typeof e.ms === 'number' ? ` (${e.ms}ms)` : ''
    const errBits: string[] = []
    if (e.code) errBits.push(`code=${e.code}`)
    if (e.error) errBits.push(`error="${e.error}"`)
    const head = `[${ts}] ${e.level.toUpperCase()} ${phase}${ms}${errBits.length ? ' · ' + errBits.join(' ') : ''}`
    return e.stack ? `${head}\n  ${e.stack.split('\n').slice(0, 6).join('\n  ')}` : head
  }).join('\n')
})

async function refreshFfmpegStatus() {
  // Capture the previous state so we can detect a "missing → installed"
  // flip after the user installed ffmpeg externally (brew, manual). When
  // that happens, surface the restart prompt automatically — same UX as
  // the in-app installer success path.
  const wasMissing = !!ffmpegStatus.value && !ffmpegStatus.value.installed
  ffmpegStatusLoading.value = true
  ffmpegStatusError.value = ''
  try {
    ffmpegStatus.value = await get<FfmpegStatus>('/ffmpeg/status')
    if (wasMissing && ffmpegStatus.value.installed) {
      showFfmpegRestartPrompt.value = true
    }
  } catch (e: any) {
    // Unknown, not missing. The card keeps the installer closed and shows the
    // failure with a Retry instead of inviting a download it cannot justify.
    ffmpegStatus.value = null
    ffmpegStatusError.value = e?.data?.detail || e?.message || 'Could not check FFmpeg'
  } finally {
    ffmpegStatusLoading.value = false
  }
}

async function installFfmpeg() {
  if (ffmpegInstalling.value) return
  if (ffmpegStatus.value?.installed && ffmpegStatus.value.source === 'bundled') {
    success('Bundled FFmpeg is already verified — no download is needed')
    return
  }
  ffmpegInstalling.value = true
  ffmpegInstallProgress.value = 0
  ffmpegInstallError.value = false
  ffmpegInstallMessage.value = 'Starting download…'

  // Poll the install-progress endpoint every second while the POST is in
  // flight. The POST is synchronous (waits for the whole download to
  // finish), so without polling the user sees a frozen progress bar for
  // up to 5 minutes. The polling endpoint reads the same in-memory state
  // that downloadFFmpeg writes to on every phase transition.
  let pollHandle: ReturnType<typeof setInterval> | null = null
  pollHandle = setInterval(async () => {
    try {
      const p = await get<{ status: string; phase?: string; percent: number; message: string; error?: string }>('/ffmpeg/install-progress')
      if (typeof p.percent === 'number') ffmpegInstallProgress.value = p.percent
      if (p.message) ffmpegInstallMessage.value = p.message
      if (p.status === 'done' || p.status === 'error' || p.status === 'idle') {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
      }
    } catch { /* polling is best-effort */ }
  }, 1000)

  try {
    const result = await post<{ ok: boolean; path: string; status: FfmpegStatus }>('/ffmpeg/install', {})
    ffmpegInstallProgress.value = 100
    ffmpegInstallMessage.value = `Installed to ${result.path}`
    ffmpegStatus.value = result.status
    showFfmpegRestartPrompt.value = true
    success('FFmpeg installed successfully')
  } catch (e: any) {
    ffmpegInstallError.value = true
    ffmpegInstallMessage.value = e?.data?.detail || e?.message || 'Install failed — see manual instructions below'
    showError('FFmpeg install failed')
  } finally {
    if (pollHandle) clearInterval(pollHandle)
    ffmpegInstalling.value = false
  }
}

async function restartApp() {
  if (restarting.value) return
  restarting.value = true
  try {
    // Backend responds with `{ ok: true }`, then triggers `app.relaunch()
    // + app.exit(0)` after a 200ms grace. The fetch resolves before the
    // process dies, then the renderer is killed by the relaunch — Nuxt
    // boots fresh on the new process and lands the user back on this
    // same page (the URL is preserved by Electron's restoreSession).
    await post('/app/restart', {})
    // Don't reset `restarting` — the page is about to be replaced, and
    // showing the spinner during the brief relaunch window is the
    // correct affordance.
  } catch (e: any) {
    restarting.value = false
    showError(e?.data?.detail || 'Restart failed — please quit and reopen the app manually.')
  }
}

async function loadInstallLog() {
  ffmpegLogLoading.value = true
  ffmpegInstallLogChecked.value = true
  try {
    const resp = await get<{ entries: InstallLogEntry[]; path: string; total?: number; message?: string }>('/ffmpeg/install-log')
    ffmpegInstallLog.value = resp.entries || []
  } catch (e: any) {
    showError('Could not load install log: ' + (e?.data?.detail || e?.message || 'unknown'))
    ffmpegInstallLog.value = []
  } finally {
    ffmpegLogLoading.value = false
  }
}

async function copyInstallLog() {
  // Bundle the log entries WITH platform info so a recipient (assistant
  // or support engineer) doesn't have to ask "what arch / OS / app
  // version?" as a follow-up. Browsing this clipboard payload should
  // be enough to triage 90% of install failures.
  const platformInfo = [
    `Platform: ${navigator.platform || 'unknown'}`,
    `User agent: ${navigator.userAgent || 'unknown'}`,
    `App URL: ${window.location.origin}`,
    `Captured at: ${new Date().toISOString()}`,
  ].join('\n')
  const body = `=== Story Studio FFmpeg install log ===\n${platformInfo}\n\n--- log entries (${ffmpegInstallLog.value.length}) ---\n${ffmpegInstallLogText.value}\n=== end ===`
  try {
    await navigator.clipboard.writeText(body)
    ffmpegLogCopiedAt.value = Date.now()
    setTimeout(() => { if (Date.now() - ffmpegLogCopiedAt.value >= 2500) ffmpegLogCopiedAt.value = 0 }, 2700)
  } catch {
    showError('Could not copy — select the text in the log box and copy manually.')
  }
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

const _route = useRoute()
function applyHash() {
  const rawTarget = (_route.hash || '').toLowerCase().replace(/^#/, '')
  const target = resolveSettingsSectionHash(rawTarget, tabs.map(tab => tab.id))
  if (!target) return
  activeTab.value = target
  if (rawTarget === 'youtube') {
    // The Reconnect links land on the channel rows, each with its own Reconnect.
    nextTick(() => document.querySelector('[data-setting="youtube-accounts"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  if (rawTarget === 'free-up-space') {
    nextTick(() => document.getElementById('free-up-space')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  if (rawTarget === 'ffmpeg') {
    refreshFfmpegStatus()
    nextTick(() => {
      document.getElementById('ffmpeg-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
}
onMounted(() => {
  applyHash()
  if (activeTab.value === 'maintenance') {
    refreshFfmpegStatus()
    void restoreArchiveInFlight()
  }

  loadNotifSettings()
})
watch(() => _route.hash, applyHash)

// ── Notifications tab (app-level, not per-project) ─────────────────────
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

// (Removed: KEY_PROVIDERS catalog. The API Keys tab moved to app-level
// Settings — see /app-settings — so this page no longer drives a
// per-project key UI.)

// Assets audit logic moved to assets.vue (new top-level page).
const standards = ref('')
const introStandards = ref('')

// ── Standards sub-tabs, templates, and presets ────────────────────────────
const standardsSubTabs = [
  { id: 'production', label: 'Channel instructions' },
  { id: 'intro', label: 'Episode intro rules' },
] as const
const standardsSubTab = ref<'production' | 'intro'>('production')
const selectedTemplateId = ref('')
const selectedPresetId = ref('')
const showSavePreset = ref(false)
const newPresetName = ref('')

interface StandardPreset { id: string; name: string; content: string }
const standardsPresets = ref<StandardPreset[]>([])
const introPresets = ref<StandardPreset[]>([])
const standardsLoading = ref(false)
const standardsError = ref('')
let loadStandardsRequest = 0
let standardsLoadedSlug = ''
let writingConfigScope = 0
let writingConfigLoadedSlug = ''
const standardsSaving = ref(false)
const presetSaving = ref(false)
const writingConfigReady = computed(() => writingConfigLoadedSlug === slug.value && !!config.value)
const writingControlsDisabled = computed(() => !writingConfigReady.value
  || standardsLoading.value || !!standardsError.value || standardsSaving.value || presetSaving.value)

const STANDARDS_TEMPLATES: Record<string, Array<{ id: string; name: string; content: string }>> = {
  production: [
    {
      id: 'sleep-stories',
      name: 'Sleep Stories (cozy, calming)',
      content: `# Production Standards — Sleep Stories\n\nTone: warm, slow-paced, gentle. Avoid conflict spikes, loud action, sudden jumps.\nPacing: long paragraphs, sensory detail, present-moment grounding.\nVocabulary: simple, evocative, avoid jargon. Read-aloud cadence.\nStructure per chapter:\n  - Opening sensory anchor (2-3 sentences)\n  - Gentle forward motion\n  - Soft close that hands off to the next chapter\nAvoid: explicit content, violence, cliffhangers, loud onomatopoeia.\nInclude: nature imagery, warm light, textures, slow breath.\n`,
    },
    {
      id: 'horror',
      name: 'Horror / Mystery',
      content: `# Production Standards — Horror\n\nTone: unsettling, patient, atmosphere over gore.\nPacing: slow burn; reveal dread through detail, not shock.\nVocabulary: tactile, decaying, cold. Concrete nouns.\nStructure per chapter:\n  - Normal-life anchor\n  - Small wrongness\n  - Escalation\n  - Soft cliffhanger\nAvoid: cheap jump scares, excessive gore, moralizing.\nInclude: unreliable perception, liminal spaces, silence.\n`,
    },
    {
      id: 'documentary',
      name: 'Documentary / Educational',
      content: `# Production Standards — Documentary\n\nTone: curious, authoritative but warm.\nPacing: steady; alternate fact with narrative.\nVocabulary: precise, with brief plain-language restatements.\nStructure per chapter:\n  - Hook (a vivid anecdote or question)\n  - Context / history\n  - Evidence / examples\n  - Takeaway\nAvoid: speculation presented as fact, moralizing, filler.\nInclude: dates, names, numbers — concrete, verifiable.\n`,
    },
    {
      id: 'blank',
      name: 'Blank scaffold',
      content: `# Production Standards\n\nTone:\nPacing:\nVocabulary:\nStructure per chapter:\nAvoid:\nInclude:\n`,
    },
  ],
  intro: [
    {
      id: 'welcome-long',
      name: 'Warm welcome (long)',
      content: `# Intro Format — Warm welcome\n\n1. Welcome & host intro (2-3 sentences, use {host_name} if provided)\n2. Story teaser (1-2 evocative sentences)\n3. Community question or reflection\n4. Subscribe / Patreon CTA (gentle, not pushy)\n5. Relaxation or breathing cue (2-3 sentences)\n6. Transition into chapter 1\n\nTotal target: ~350 words. Read time: ~2-3 minutes.\n`,
    },
    {
      id: 'short-teaser',
      name: 'Short teaser (podcast-style)',
      content: `# Intro Format — Short teaser\n\n1. Welcome & host intro (1 sentence)\n2. Story teaser (1 sentence)\n3. Subscribe CTA (1 sentence)\n4. Transition into chapter 1 (1 sentence)\n\nTotal target: ~80 words. Read time: ~30 seconds.\n`,
    },
    {
      id: 'blank-intro',
      name: 'Blank scaffold',
      content: `# Intro Format\n\nBeats:\n  - \n  - \n  - \n\nWord target:\nTone:\n`,
    },
  ],
}

const currentStandardText = computed({
  get: () => standardsSubTab.value === 'intro' ? introStandards.value : standards.value,
  set: (v: string) => {
    if (standardsSubTab.value === 'intro') introStandards.value = v
    else standards.value = v
  },
})

const currentTemplates = computed(() => STANDARDS_TEMPLATES[standardsSubTab.value] || [])
const currentPresets = computed(() => standardsSubTab.value === 'intro' ? introPresets.value : standardsPresets.value)
const currentStandardDoc = computed(() => {
  if (standardsSubTab.value === 'intro') {
    return {
      title: 'Intro Format',
      description: 'Reference used by the Script Generator for the introduction section. Define beats, word targets, and tone so the AI can match your channel\'s voice.',
      placeholder: 'Describe how your episode intros should be structured…',
    }
  }
  return {
      title: 'Optional channel instructions',
      description: 'Use this only for channel-specific facts, terminology, exclusions, or recurring production rules. It is appended after the Series Formula and cannot replace Formula-owned voice, point of view, or structure.',
      placeholder: 'e.g. always use Khmer place names as written here; do not mention sponsors; pronounce these names this way…',
  }
})

async function loadStarterTemplate() {
  const scope = writingConfigScope
  if (writingControlsDisabled.value) return
  const tpl = currentTemplates.value.find(t => t.id === selectedTemplateId.value)
  if (!tpl) return
  if (currentStandardText.value.trim()) {
    const ok = await ask({
      title: 'Replace current text?',
      message: 'Loading this template will overwrite the text in the editor. Unsaved edits will be lost.',
      confirmLabel: 'Replace',
    })
    if (!ok || scope !== writingConfigScope) return
  }
  currentStandardText.value = tpl.content
  selectedTemplateId.value = ''
}

async function loadPreset() {
  const scope = writingConfigScope
  if (writingControlsDisabled.value) return
  const p = currentPresets.value.find(x => x.id === selectedPresetId.value)
  if (!p) return
  if (currentStandardText.value.trim()) {
    const ok = await ask({
      title: 'Replace current text?',
      message: 'Loading this preset will overwrite the text in the editor. Unsaved edits will be lost.',
      confirmLabel: 'Replace',
    })
    if (!ok || scope !== writingConfigScope) return
  }
  currentStandardText.value = p.content
}

async function savePreset() {
  if (writingControlsDisabled.value) return
  const name = newPresetName.value.trim()
  if (!name) return
  const projectSlug = slug.value
  const scope = writingConfigScope
  const subTab = standardsSubTab.value
  const id = `preset-${Date.now()}`
  const preset: StandardPreset = { id, name, content: currentStandardText.value }
  const list = subTab === 'intro' ? introPresets : standardsPresets
  const next = [...list.value, preset]
  const key = subTab === 'intro' ? 'intro_presets' : 'standards_presets'
  const current = () => projectSlug === slug.value && scope === writingConfigScope
  presetSaving.value = true
  try {
    await put(`/projects/${projectSlug}/settings/config`, {
      [key]: next,
    })
    if (!current()) return
    list.value = next
    selectedPresetId.value = id
    success('Preset saved!')
  } catch (e: any) {
    if (current()) showError(e.data?.detail || 'Failed to save preset')
  } finally {
    if (current()) presetSaving.value = false
  }
  if (current()) {
    showSavePreset.value = false
    newPresetName.value = ''
  }
}

async function deletePreset() {
  if (writingControlsDisabled.value) return
  const doomed = (standardsSubTab.value === 'intro' ? introPresets : standardsPresets).value.find(p => p.id === selectedPresetId.value)
  if (!await ask({ title: `Delete preset “${doomed?.name || 'this preset'}”?`, message: 'The text in the editor stays; only the saved preset is removed.', confirmLabel: 'Delete Preset', danger: true })) return
  const projectSlug = slug.value
  const scope = writingConfigScope
  const subTab = standardsSubTab.value
  const list = subTab === 'intro' ? introPresets : standardsPresets
  const next = list.value.filter(p => p.id !== selectedPresetId.value)
  const key = subTab === 'intro' ? 'intro_presets' : 'standards_presets'
  const current = () => projectSlug === slug.value && scope === writingConfigScope
  presetSaving.value = true
  try {
    await put(`/projects/${projectSlug}/settings/config`, {
      [key]: next,
    })
    if (!current()) return
    list.value = next
    selectedPresetId.value = ''
    success('Preset deleted')
  } catch (e: any) {
    if (current()) showError(e.data?.detail || 'Failed to delete')
  } finally {
    if (current()) presetSaving.value = false
  }
}

async function copyAsAiPrompt() {
  const label = standardsSubTab.value === 'intro' ? 'episode intro format' : 'production standards'
  const wrapped = `I'm producing a narrated story-video channel. Help me refine and tighten the ${label} below.
Keep it concise, scannable, and written as clear rules the AI writer can follow.
Output the improved version only — no commentary, no markdown tables.

--- CURRENT ${label.toUpperCase()} ---
${currentStandardText.value || '(empty — generate a starter based on best practices)'}
--- END ---`
  try {
    await navigator.clipboard.writeText(wrapped)
    success('Copied! Paste into your chatbot, then paste the result back here.')
  } catch {
    showError('Could not copy — select the text and copy manually.')
  }
}

async function saveStandardsCurrent() {
  if (writingControlsDisabled.value) return
  const projectSlug = slug.value
  const scope = writingConfigScope
  const request = loadStandardsRequest
  const current = () => projectSlug === slug.value && scope === writingConfigScope && request === loadStandardsRequest
  const subTab = standardsSubTab.value
  const content = currentStandardText.value
  standardsSaving.value = true
  try {
    if (subTab === 'intro') {
      await put(`/projects/${projectSlug}/settings/config`, { intro_standards: content })
    } else {
      // Standards endpoint accepts either JSON { content } or text/plain;
      // we go text/plain so there's no escape/diff noise on every keystroke.
      await put(`/projects/${projectSlug}/settings/standards`, content, {
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    if (!current()) return
    stampSaved('standards')
    success('Saved!')
  } catch (e: any) {
    if (!current()) return
    showError('Failed to save')
  } finally {
    if (current()) standardsSaving.value = false
  }
}
const projectForm = reactive<{
  name: string
  episode_prefix: string
  season_prefix: string
  season_size: number
  /**
   * Item J — YouTube videoCategories.list ID. Stored in ProjectConfig
   * (not project meta), so saveProject() splits this off and PUTs it to
   * /settings/config separately. Undefined = use the upload-metadata
   * default (24 · Entertainment, switched from 22 in v1.0.77).
   */
  category_id: number | undefined
  /**
   * v1.0.77 — Project-level toggle for the YouTube "altered or synthetic
   * content" disclosure flag. Threaded into uploadVideo's status block as
   * `containsSyntheticMedia`. Undefined = inherit the app-level default
   * (which itself defaults to true since Story Studio's primary use is
   * AI-generated content).
   */
  mark_as_ai_generated: boolean | undefined
}>({ name: '', episode_prefix: '', season_prefix: 'Season', season_size: 20, category_id: undefined, mark_as_ai_generated: undefined })

// ── Per-project Art Style (v1.0.518) ──────────────────────────────────────
// The project's active art style is persisted as config.active_style_preset_id
// (an id in config.style_presets). The generator auto-applies it to every
// image prompt and feeds its preview image into img2img renders. A legacy
// project-local style already lives in config.style_presets. A signed
// catalog style resolves through its immutable Content Pack pin instead.
const artStyleSelection = ref('')
const artStyleSaveMessage = ref('')
const artStyleSaving = ref(false)
let artStyleSelectionInitialized = false
let artStyleRollback = false
let artStyleRouteEpoch = 0
const savedStylePresets = computed(() =>
  Array.isArray((config.value as any)?.style_presets) ? (config.value as any).style_presets : [])

/**
 * A saved style id that resolves to nothing renders nothing — the generator
 * quietly falls back and the picker still shows a name, so the project looks
 * configured while every prompt goes out without the style. Saving one is
 * refused now, but a project can still carry an id from an older build or
 * from a pack that has since been uninstalled. Say so, here, in the UI.
 */
const unresolvedArtStyleId = computed(() => {
  if (visualStylesLoading.value || visualStylesError.value) return ''
  const active = String((config.value as any)?.active_style_preset_id || '').trim()
  if (!active) return ''
  if (visualStyles.value.some(style => style.id === active)) return ''
  if (savedStylePresets.value.some((preset: any) =>
    preset?.id === active && String(preset?.description || '').trim())) return ''
  return active
})

watch(artStyleSelection, async (next, prev) => {
  if (artStyleRollback) {
    artStyleRollback = false
    return
  }
  if (!artStyleSelectionInitialized) return
  if (next === prev) return
  if (artStyleSaving.value) return
  const targetSlug = slug.value
  const routeEpoch = artStyleRouteEpoch
  artStyleSaving.value = true
  artStyleSaveMessage.value = 'Saving…'
  try {
    const payload: Record<string, any> = {}
    let activeId = next
    const bs = visualStyles.value.find(style => style.id === next)
    if (bs) {
      activeId = bs.id
      // A SIGNED style already resolves through the project's content pin, so
      // copying its prose into the project config would fork it: the pack
      // could be updated or revoked and this project would keep rendering a
      // stale private copy nobody could see or edit. Only an unqualified id
      // has nowhere else to live and needs its text materialised here.
      if (!activeId.startsWith('com.storystudio.')) {
        const existing = Array.isArray((config.value as any)?.style_presets)
          ? [...(config.value as any).style_presets]
          : []
        if (!existing.some((p: any) => p && p.id === bs.id)) {
          existing.push({
            id: bs.id,
            name: bs.name,
            description: bs.data.style_bible,
            created_at: new Date().toISOString(),
          })
          payload.style_presets = existing
        }
      }
    }
    payload.active_style_preset_id = activeId
    await put(`/projects/${targetSlug}/settings/config`, payload)
    if (slug.value !== targetSlug || artStyleRouteEpoch !== routeEpoch) return
    await refreshConfig(targetSlug)
    artStyleSaveMessage.value = activeId ? 'Art style applied to this channel' : 'Art style cleared'
    setTimeout(() => { artStyleSaveMessage.value = '' }, 2500)
  } catch (e: any) {
    if (slug.value !== targetSlug || artStyleRouteEpoch !== routeEpoch) return
    artStyleSaveMessage.value = e?.data?.detail || e?.message || 'Failed to save art style'
    // Roll back the visible value so the dropdown matches what's persisted.
    artStyleRollback = true
    artStyleSelection.value = prev || ''
  } finally {
    artStyleSaving.value = false
  }
})

// Register the save watcher before immediate hydration: it consumes the
// suppression flag that config hydration sets, so the first user choice is
// never mistaken for an initial sync.
watch(config, (c) => {
  if (!c) return
  const persistedStyleId = (c as any).active_style_preset_id || ''
  if (artStyleSelection.value !== persistedStyleId) {
    artStyleRollback = true
    artStyleSelection.value = persistedStyleId
  }
  artStyleSelectionInitialized = true
}, { immediate: true })

watch(slug, () => {
  artStyleRouteEpoch++
  artStyleSaveMessage.value = ''
  if (artStyleSelection.value) {
    artStyleRollback = true
    artStyleSelection.value = ''
  }
})

// Absolute path to the episodes folder, for the read-only "Reveal in Finder"
// row. Read from the resolved path the backend computes, not from a stored
// setting — there is no longer one, and there is no form here that could
// change it. The old version read the RELATIVE './episodes' and then filtered
// it back out for not looking absolute, so this row was blank for every real
// project.
const projectLocation = computed(() => project.value?.output_root_resolved || '')

async function revealInFinder() {
  if (!projectLocation.value) return
  const { askSkippable } = useConfirmSkip()
  const browser = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Win')
    ? 'File Explorer'
    : typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac')
      ? 'Finder' : 'your file manager'
  const ok = await askSkippable({
    skipKey: 'reveal_folder',
    title: 'Open in Finder?',
    message: `This will open the channel folder in ${browser}:\n${projectLocation.value}`,
    confirmLabel: 'Open',
  })
  if (!ok) return
  try {
    await post('/system/reveal-folder', { path: projectLocation.value })
  } catch (e: any) {
    showError(e.data?.detail || 'Could not open folder')
  }
}

// Confirmation preferences
// `group: 'generation'` → action-only dialogs before generation begins.
// `group: 'action'` → everyday action dialogs (Open in Finder, etc.)
// that don't cost money but still deserve a guardrail the user can
// disable once they've decided they trust it. Both live in the same
// `confirmation_preferences` map so one Save button covers all rows.
// v1.4.249 — only keys something actually reads (useConfirmation callers:
// scripts.vue script + introduction, images.vue thumb_images, audio.vue audio;
// useConfirmSkip: reveal_folder). Rows for thumb_prompts, scene_plan,
// scene_review, description and video switched nothing and are gone; their
// stored values stay on disk (saveConfirmPrefs merges, never drops keys).
const confirmGenerators = [
  { key: 'script', label: 'Scripts', description: 'Episode script generation', group: 'generation' },
  { key: 'introduction', label: 'Introduction', description: 'Episode introduction generation', group: 'generation' },
  { key: 'thumb_images', label: 'Thumbnail Images', description: 'Thumbnail image generation', group: 'generation' },
  { key: 'audio', label: 'Audio', description: 'TTS narration', group: 'generation' },
  { key: 'reveal_folder', label: 'Open in Finder', description: 'Confirm before opening a folder in Finder / File Explorer', group: 'action' },
]
const confirmGenerationRows = computed(() => confirmGenerators.filter(g => g.group === 'generation'))
const confirmActionRows = computed(() => confirmGenerators.filter(g => g.group === 'action'))
const confirmPrefs = reactive<Record<string, boolean>>({})

// Folder config
interface FolderEntry { key: string; label: string; generator: string; order: number; template: string }
const folderConfig = ref<FolderEntry[]>([])
const folderDefaults = ref<Record<string, string>>({})
const folderConfigLoading = ref(false)
const folderConfigError = ref('')
let loadFolderConfigRequest = 0
let folderConfigLoadedSlug = ''

// v1.4.3 — the named-roots state and its loader/saver went with the tab. See
// the note where the tab used to be: shared files now live at
// <Library>/_Project Assets and are addressed as ${ASSET}/…

async function loadFolderConfig() {
  const projectSlug = slug.value
  const request = ++loadFolderConfigRequest
  const current = () => projectSlug === slug.value && request === loadFolderConfigRequest
  folderConfigLoading.value = true
  folderConfigError.value = ''
  try {
    const data = await get<any>(`/projects/${projectSlug}/settings/subfolder-config`)
    if (!current()) return
    folderConfig.value = Array.isArray(data.linkage) ? data.linkage : []
    folderDefaults.value = data.defaults || {}
    folderConfigLoadedSlug = projectSlug
  } catch (e: any) {
    if (!current()) return
    folderConfigError.value = e?.data?.detail || e?.message || 'Could not load folder settings.'
  } finally {
    if (current()) folderConfigLoading.value = false
  }
}

// Load folder config when tab becomes active.
watch(activeTab, (tab) => {
  if (tab === 'files' && folderConfigLoadedSlug !== slug.value) void loadFolderConfig()
})

async function saveFolderConfig() {
  if (folderConfigLoading.value || folderConfigError.value) return
  const projectSlug = slug.value
  const request = loadFolderConfigRequest
  const current = () => projectSlug === slug.value && request === loadFolderConfigRequest
  const subfolder_names: Record<string, string> = {}
  for (const entry of folderConfig.value) {
    subfolder_names[entry.key] = entry.template
  }
  try {
    await put(`/projects/${projectSlug}/settings/subfolder-config`, { subfolder_names })
    if (!current()) return
    await loadProject(projectSlug)
    if (!current()) return
    stampSaved('folder_config')
    success('Folder config saved!')
  } catch (e: any) {
    if (!current()) return
    showError(e.data?.detail || 'Failed to save folder config')
  }
}

function resetFolderDefaults() {
  for (const entry of folderConfig.value) {
    entry.template = folderDefaults.value[entry.key] || entry.template
  }
}

// Sync editable data from config
// What each draft field was last hydrated to. Saving the art style or the guide slider refreshes
// the whole config, and this watcher used to overwrite every field with it — silently throwing away
// an intro being typed or a category not yet saved. A field is replaced only on a new project, or
// when it still shows exactly what was last loaded (i.e. nothing unsaved is in it).
const hydratedDrafts: Record<string, unknown> = {}
function hydrateDraft<T>(key: string, current: T, incoming: T, freshProject: boolean): T {
  const untouched = Object.is(current, hydratedDrafts[key])
  hydratedDrafts[key] = incoming
  return freshProject || untouched ? incoming : current
}

watch(config, (c) => {
  if (c) {
    // Item J — hydrate the YouTube category_id from config when it
    // arrives. Lives in this watch (not the chatterbox one above)
    // because projectForm is declared between them and the
    // `immediate: true` in the upper watch would TDZ-fault.
    const cAny = c as any
    const fresh = writingConfigLoadedSlug !== slug.value
    projectForm.category_id = hydrateDraft('category_id', projectForm.category_id,
      typeof cAny?.category_id === 'number' && cAny.category_id > 0 ? cAny.category_id : undefined, fresh)
    projectForm.mark_as_ai_generated = hydrateDraft('mark_as_ai_generated', projectForm.mark_as_ai_generated,
      typeof cAny?.mark_as_ai_generated === 'boolean' ? cAny.mark_as_ai_generated : undefined, fresh)
    standardsPresets.value = JSON.parse(JSON.stringify((c as any).standards_presets || []))
    introPresets.value = JSON.parse(JSON.stringify((c as any).intro_presets || []))
    introStandards.value = hydrateDraft('intro_standards', introStandards.value, (c as any).intro_standards || '', fresh)
    writingConfigLoadedSlug = slug.value
    // Load confirmation preferences
    const prefs = (c as any).confirmation_preferences || {}
    for (const gen of confirmGenerators) {
      confirmPrefs[gen.key] = hydrateDraft(`confirm:${gen.key}`, confirmPrefs[gen.key], prefs[gen.key] !== false, fresh) // default true
    }
  }
}, { immediate: true })

async function loadStandards() {
  const projectSlug = slug.value
  const request = ++loadStandardsRequest
  const current = () => projectSlug === slug.value && request === loadStandardsRequest
  standardsLoading.value = true
  standardsError.value = ''
  try {
    const data = await get<{ content: string }>(`/projects/${projectSlug}/settings/standards`)
    if (!current()) return
    standards.value = data.content || ''
    standardsLoadedSlug = projectSlug
  } catch (e: any) {
    if (!current()) return
    standardsError.value = e?.data?.detail || e?.message || 'Could not load saved instructions.'
  } finally {
    if (current()) standardsLoading.value = false
  }
}

// Load standards when tab becomes active.
watch(activeTab, (tab) => {
  if (tab === 'writing' && standardsLoadedSlug !== slug.value) void loadStandards()
})

watch(slug, () => {
  writingConfigScope++
  writingConfigLoadedSlug = ''
  standards.value = ''
  introStandards.value = ''
  standardsPresets.value = []
  introPresets.value = []
  selectedTemplateId.value = ''
  selectedPresetId.value = ''
  showSavePreset.value = false
  newPresetName.value = ''
  standardsSaving.value = false
  presetSaving.value = false
  loadFolderConfigRequest++
  folderConfigLoadedSlug = ''
  folderConfig.value = []
  folderDefaults.value = {}
  folderConfigLoading.value = false
  folderConfigError.value = ''
  loadStandardsRequest++
  standardsLoadedSlug = ''
  standardsLoading.value = false
  standardsError.value = ''
  // F-05 (DS-11) — a different project is now on screen, so the previous
  // project's Publishing values must not stand (AGENTS.md §4). These two live
  // on ProjectConfig and are re-hydrated from this project's own config, which
  // is fetched after the slug changes; a failed or empty config read leaves
  // them blank rather than showing the last project's answer.
  projectForm.category_id = undefined
  projectForm.mark_as_ai_generated = undefined
  if (activeTab.value === 'files') void loadFolderConfig()
  if (activeTab.value === 'writing') void loadStandards()
})

// Sync project form. v1.0.45 — track the server-side season_size
// separately so the Reseason flow can detect "user wants to change it"
// and offer the rebalance preview, while the regular save flow filters
// out season_size to avoid silent mismatches with on-disk folders.
const serverSeasonSize = ref(20)
watch(project, (p) => {
  if (p) {
    projectForm.name = p.name
    projectForm.episode_prefix = p.episode_prefix
    projectForm.season_prefix = p.season_prefix || 'Season'
    projectForm.season_size = p.season_size || 20
    serverSeasonSize.value = p.season_size || 20
    // Level B external media root (lives on project meta). Seed the Storage-tab
    // control + verify it resolves on this machine for the status line.
    mediaRootInput.value = (p as any).media_root || ''
    mediaRootSavedValue.value = mediaRootInput.value
    if (mediaRootInput.value) void checkMediaRoot()
    // F-05 (DS-11) — `category_id` lives on ProjectConfig, not project meta, so
    // this watcher must not touch it. It used to blank the field on every
    // `project` replacement, and `loadProject()` fetches project meta and
    // config IN PARALLEL: whenever meta resolved after config, the hydrated
    // category was wiped and the next Publishing save persisted that silent
    // clear. The per-project reset now happens on the slug change itself (see
    // the `watch(slug, …)` reset above), which is the only event that actually
    // means "a different project is on screen" (AGENTS.md §4).
  }
}, { immediate: true })
const seasonSizeChanged = computed(() =>
  Number.isInteger(projectForm.season_size)
  && projectForm.season_size >= 1
  && projectForm.season_size !== serverSeasonSize.value,
)

// ── Reseason preview / apply (v1.0.45) ────────────────────────────────────
interface ReseasonMove {
  code: string
  title: string
  old_dir: string
  new_dir: string
  old_season: number
  new_season: number
}
interface ReseasonPreviewData {
  current_season_size: number
  new_season_size: number
  moves: ReseasonMove[]
  noop_count: number
  total_accepted: number
}
const reseasonState = reactive<{
  open: boolean
  opening: boolean
  running: boolean
  preview: ReseasonPreviewData | null
  error: string
}>({
  open: false,
  opening: false,
  running: false,
  preview: null,
  error: '',
})

async function openReseasonPreview() {
  if (!seasonSizeChanged.value) return
  if (reseasonState.opening || reseasonState.running) return
  reseasonState.opening = true
  reseasonState.error = ''
  try {
    reseasonState.preview = await get<ReseasonPreviewData>(
      `/projects/${slug.value}/episodes/reseason-preview?new_size=${projectForm.season_size}`,
    )
    reseasonState.open = true
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to compute reseason plan')
  } finally {
    reseasonState.opening = false
  }
}

function closeReseasonPreview() {
  if (reseasonState.running) return
  reseasonState.open = false
  reseasonState.preview = null
  reseasonState.error = ''
}

async function confirmReseason() {
  if (reseasonState.running || !reseasonState.preview) return
  reseasonState.running = true
  reseasonState.error = ''
  try {
    const r = await post<{
      ok: true
      moves: ReseasonMove[]
      moved: Array<{ code: string; from: string; to: string }>
      moved_external: Array<{ code: string; from: string; to: string }>
      errors: Array<{ stage: string; detail: string }>
    }>(`/projects/${slug.value}/episodes/reseason`, { new_size: reseasonState.preview.new_season_size })
    const movedCount = r.moved.length
    const externalCount = r.moved_external.length
    const errorCount = r.errors.length
    const parts: string[] = []
    if (movedCount) parts.push(`${movedCount} folder${movedCount === 1 ? '' : 's'} moved`)
    if (externalCount) parts.push(`${externalCount} external`)
    if (errorCount) parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`)
    success(`Rebalanced · ${parts.length ? parts.join(', ') : 'no-op'}. Reversible from Unlinked Uploads tab for 30 days.`)
    reseasonState.open = false
    reseasonState.preview = null
    await loadProject(slug.value)
  } catch (e: any) {
    reseasonState.error = e?.data?.detail || e?.message || 'Rebalance failed'
  } finally {
    reseasonState.running = false
  }
}

async function saveConfirmPrefs() {
  try {
    await put(`/projects/${slug.value}/settings/config`, {
      // The server replaces the whole map: keep keys this page has no row for.
      confirmation_preferences: { ...((config.value as any)?.confirmation_preferences || {}), ...confirmPrefs },
    })
    await refreshConfig(slug.value)
    stampSaved('confirm_prefs')
    success('Confirmation preferences saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
  }
}

async function saveStandards() {
  try {
    await put(`/projects/${slug.value}/settings/standards`, standards.value, {
      headers: { 'Content-Type': 'text/plain' },
    })
    success('Production standards saved!')
  } catch (e: any) {
    showError('Failed to save standards')
  }
}

/** True only when the section was saved for the project still on screen. */
async function saveProject(requestedSection?: ProjectSettingsSaveSection): Promise<boolean> {
  try {
    const targetSlug = slug.value
    const section = requestedSection || (activeTab.value as ProjectSettingsSaveSection)
    if (!['identity', 'publishing', 'files'].includes(section)) return false
    const draftBeforeSave = { ...projectForm }
    const plan = projectSettingsSavePlan(section, draftBeforeSave, serverSeasonSize.value)

    // The regular Files save deliberately excludes season_size. Only the
    // Rebalance action can change it because that also moves existing folders.
    if (plan.hasPendingSeasonSize) {
      info('Episodes per Group not saved — use the ↻ Rebalance button next to the field to apply size changes.')
    }

    // Publishing owns no project.json field: send nothing rather than rewrite the file.
    const savedProject = plan.project ? await put<any>(`/projects/${targetSlug}`, plan.project) : null
    if (plan.config) {
      await put(`/projects/${targetSlug}/settings/config`, plan.config)
    }
    if (slug.value !== targetSlug) return false
    if (project.value && plan.project) {
      for (const key of Object.keys(plan.project)) {
        (project.value as any)[key] = savedProject[key]
      }
    }
    if (plan.config) {
      if (config.value) {
        for (const [key, value] of Object.entries(plan.config)) {
          if (value !== undefined) (config.value as any)[key] = value
        }
      }
    }

    // Mutate only the acknowledged fields in place. Replacing the whole refs
    // would hydrate every section and discard drafts hidden behind another link.
    stampSaved(`project_${section}`)
    success(`${section === 'identity' ? 'Channel identity' : section === 'publishing' ? 'Publishing defaults' : 'Channel files'} saved!`)
    return true
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
    return false
  }
}

async function deleteProject() {
  // The delete is non-destructive — files stay on disk. Confirm reflects
  // that ("hide" not "delete") so the user knows they can recover.
  const ok = await ask({
    title: `Hide "${project.value?.name}" from the app?`,
    message:
      'Files stay on disk — only the registration is removed. ' +
      'You can restore the channel anytime, or permanently delete it later from the home-page Hidden channels panel.',
    confirmLabel: 'Hide Channel',
    danger: false,
  })
  if (!ok) return
  try {
    const result = await del<{ ok: boolean; disposition?: string; orphan_path?: string; name?: string }>(
      `/projects/${slug.value}`,
    )
    success(`Hidden "${result?.name || slug.value}" — files kept at ${result?.orphan_path || 'their location'}`)
    // Surface the orphan path in a follow-up dialog with Open-in-Finder.
    // The user explicitly asked to be told where the bytes still live so
    // they can manually clean up later.
    if (result?.orphan_path) {
      const reveal = await ask({
        title: 'Files are still on disk',
        message: `Your files are still at:\n\n${result.orphan_path}\n\nClick "Open in Finder" to reveal the folder, or "Got it" to dismiss. You can manage hidden channels from the home page anytime.`,
        confirmLabel: 'Open in Finder',
        cancelLabel: 'Got It',
        danger: false,
      })
      if (reveal) {
        try {
          await post('/system/reveal-folder', { path: result.orphan_path })
        } catch (e: any) {
          showError(e?.data?.detail || 'Could not open Finder')
        }
      }
    }
    navigateTo('/')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to hide channel')
  }
}
</script>

<style scoped>
/* v1.0.270 — content mode toggle (Format tab) */
.cm-options { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 720px) { .cm-options { grid-template-columns: 1fr; } }
.cm-opt {
  display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
  padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary);
}
.cm-opt.active { border-color: var(--accent); background: rgba(108, 143, 255, 0.06); }
.cm-opt input { margin-top: 3px; }

/* ── Art style picker (Project tab) ────────────────────────────────────── */
.art-style-picker {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.art-style-picker .input { flex: 1; min-width: 200px; }

/* ── Format tab ──────────────────────────────────────────────────────── */
.channel-visual-defaults {
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--bg-secondary), var(--surface-raised));
}
.channel-guide-density-row { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
.channel-guide-density-slider { flex: 1; min-width: 0; accent-color: var(--accent); cursor: pointer; }
.channel-guide-density-value { min-width: 46px; color: var(--text-primary); font-size: 13px; font-weight: 700; text-align: right; }
.channel-guide-density-value.off { color: var(--text-muted); font-weight: 500; }

/* v1.0.165 — Patterns sub-section CSS removed with the Pattern system. */

/* ── FFmpeg tab ──────────────────────────────────────────────────────── */
.ffmpeg-manual a { color: var(--accent); text-decoration: underline; }

/* Restart prompt — visually distinct from the install block (green
   accent vs amber) so the success state reads as different from the
   "click to install" state. */
.ffmpeg-restart-prompt {
  padding: 10px 14px;
  background: rgba(46, 160, 67, 0.08);
  border-left: 3px solid var(--success, #3fb950);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.ffmpeg-restart-prompt .restart-msg { color: var(--text-primary); }

/* Install-log diagnostic block: surfaces only on failure. The <pre>
   keeps formatting (timestamps, indented stack lines) and lets the
   user select-copy fragments instead of the whole thing. */
.ffmpeg-log-block {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}
.ffmpeg-log-output {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: var(--font-xs);
  line-height: 1.5;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Connectivity Diagnose block on the API Keys tab. Reachable hosts are
   styled green, unreachable red — so the user can tell at a glance whether
   the issue is a single provider or a whole-network outage. */

.settings-workspace {
  --settings-green: #58c692;
  --settings-gold: #e3b45a;
  /* v1.4.249 — a positioned box, so no absolutely-positioned control inside a
     section can escape the scroll area and stretch the whole window. */
  position: relative;
  padding-bottom: 48px;
}
/* v1.4.249 layout: section rail on the left, one section on the right. */
.settings-head { margin: 4px 0 16px; }
.settings-head h1 { margin: 0 0 4px; font-size: 26px; font-weight: 600; letter-spacing: -.02em; }
.settings-head p { margin: 0; color: var(--text-secondary); font-size: 13px; }
.settings-head .key-dot { display: inline-block; vertical-align: middle; margin: 0 2px 2px 0; }
.settings-layout { display: grid; grid-template-columns: 232px minmax(0, 1fr); gap: 24px; align-items: start; }
.settings-rail { position: sticky; top: 0; max-height: calc(100dvh - 120px); overflow-y: auto; padding-right: 4px; }
.settings-content { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
.settings-content > .settings-active-intro { margin: 0; }
.settings-plain { min-width: 0; }
.settings-card-head { margin-bottom: 12px; }
.settings-card-head h3 { margin: 0 0 4px; font-size: 16px; }
.settings-card-head p { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.settings-hint { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.settings-warn { margin: 6px 0 0; color: var(--warning, #d97706); font-size: 12px; }
.settings-status { margin: 6px 0 0; font-size: 12px; }
.settings-status.ok { color: var(--success); }
.settings-status.warn { color: var(--warning, #d97706); }
.settings-status.err { color: var(--error); }
.status-chip { padding: 1px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 600; }
.status-chip.warn { background: color-mix(in srgb, var(--warning, #d97706) 18%, transparent); color: var(--warning, #d97706); }
/* A section already drawn as a card does not get a second frame inside the card. */
.settings-content .settings-panel > .channel-visual-defaults,
.settings-content .settings-panel > .episode-shape-card,
.settings-content .settings-panel > .production-kit-card { padding: 0; border: 0; background: none; box-shadow: none; }
.settings-content .settings-panel > .audio-quality-settings { padding-top: 0; border-top: 0; }
.settings-content .settings-section-head h3 { font-size: 16px; letter-spacing: -.01em; }
.settings-content .storage-panel .btn { white-space: nowrap; }
.settings-content .storage-panel .flex.gap-2 { flex: 0 0 auto; }
.files-where { display: grid; gap: 18px; }
/* Free Up Space options — the same rules as MediaCleanupPanel's own .space-option. */
.space-option { border-top: 1px solid var(--border); padding: 12px 0; }
.space-option > summary small { display: block; margin: 2px 0 0 18px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.space-option-body { padding: 4px 0 0 18px; }
.archive-flow { display: grid; gap: 12px; }
.ffmpeg-state { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-primary); }
.ffmpeg-state > div { display: grid; flex: 1 1 auto; gap: 2px; }
.ffmpeg-state strong { font-size: 13px; }
.ffmpeg-state span { color: var(--text-muted); font-size: 12px; }
.ffmpeg-state .btn { white-space: nowrap; }
.ffmpeg-state-dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; background: var(--text-muted); }
.ffmpeg-state.ok .ffmpeg-state-dot { background: var(--success); }
.ffmpeg-state.warn .ffmpeg-state-dot { background: var(--warning, #d97706); }
.ffmpeg-state.err .ffmpeg-state-dot { background: var(--error); }
.ffmpeg-details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 0; font-size: 12px; }
.ffmpeg-details dt { color: var(--text-muted); }
.ffmpeg-details dd { margin: 0; overflow-wrap: anywhere; }
.ffmpeg-manual summary { cursor: pointer; font-size: 12px; }
.about-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.about-card h3 { margin: 0; font-size: 14px; }
.setting-flash { animation: setting-flash 1.6s ease; border-radius: 8px; }
@keyframes setting-flash { 0%, 40% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 70%, transparent); } 100% { box-shadow: 0 0 0 3px transparent; } }
@media (max-width: 1100px) {
  .settings-layout { grid-template-columns: 1fr; }
  .settings-rail { position: static; max-height: none; overflow: visible; }
}
.key-dot { width: 7px; height: 7px; border-radius: 50%; }
.key-machine { background: var(--settings-gold); }
.key-project { background: var(--settings-green); }

.settings-active-intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin: 14px 0 0;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-secondary);
}
.settings-active-intro.scope-machine { border-left: 3px solid var(--settings-gold); }
.settings-active-intro.scope-project { border-left: 3px solid var(--settings-green); }
.settings-active-copy { position: relative; }
.settings-active-copy h2 { margin: 1px 0 3px; font-size: 18px; letter-spacing: -0.015em; }
.settings-hash-target { position: absolute; width: 1px; height: 1px; overflow: hidden; }
.settings-active-copy p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.settings-scope-pill {
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .07em;
  text-transform: uppercase;
  white-space: nowrap;
}

.settings-panel {
  border-radius: 16px;
  border-color: color-mix(in srgb, var(--border) 88%, var(--settings-green));
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 96%, #17362a), var(--bg-secondary) 180px);
  box-shadow: 0 20px 45px rgba(0,0,0,.12), inset 0 1px rgba(255,255,255,.025);
}
.settings-panel-embedded { padding: 14px; }
.settings-panel > h3:first-child,
.settings-panel > .card-header:first-child h3 { font-size: 18px; letter-spacing: -.015em; }
.settings-section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding: 2px 2px 16px;
}
.settings-section-kicker {
  color: var(--settings-gold);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .13em;
  text-transform: uppercase;
}
.settings-section-head h3 { margin: 3px 0 4px; font-size: 20px; letter-spacing: -.025em; }
.settings-section-head p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
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

@media (max-width: 720px) {
      .settings-active-intro { grid-template-columns: 1fr; }
  .settings-scope-pill { grid-column: 1 / -1; justify-self: start; }
  .settings-section-head { align-items: flex-start; flex-direction: column; }
}

.input-sm {
  padding: 6px 10px;
  font-size: 13px;
  width: auto;
}

.btn-icon {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
}
.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.btn-icon.danger:hover {
  color: var(--error);
  background: rgba(248, 113, 113, 0.1);
}

/* ── Notification center ───────────────────────────────────────────── */
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

/* ── Storage tab ─────────────────────────────────────────────────────── */
.storage-panel { overflow: hidden; }
#archive-section > summary { cursor: pointer; }
.storage-section h4 {
  margin: 0 0 6px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.storage-section .hint { margin: 4px 0 8px; font-size: var(--font-xs); line-height: 1.45; }
.storage-section-icon { font-size: 16px; line-height: 1; }
/* Top-bordered subsections inside the Storage card. The first subsection
   (Projects storage location) skips the modifier so the top of the card
   stays flush; everything below gets a clear horizontal divider + breathing
   room so it's obvious where one section ends and the next begins. */
/* Inline help panel beneath a section's status row. Used to translate
   "Picker failed: …" into actionable guidance ("type the path manually")
   without burying the message inside the same line as a save error. */
.optional-tag { color: var(--text-muted); font-size: var(--font-xs); font-weight: normal; }

/* ── Cloud sync overview (top-of-Storage indicator card) ─────────── */
.overview-badge {
  display: inline-block;
  padding: 1px 6px;
  font-size: var(--font-xs); font-weight: 700; letter-spacing: 0.05em;
  border-radius: 999px;
  margin-left: auto;
}
.overview-badge.on { background: rgba(75, 130, 200, 0.2); color: #60a5fa; }
.overview-badge.off { background: rgba(120, 130, 140, 0.18); color: var(--text-muted); }
.overview-badge.info { background: rgba(214, 155, 43, 0.15); color: var(--warning, #d69b2b); }

.storage-disclosure { margin-top: 8px; border: 1px dashed var(--border); border-radius: 13px; background: color-mix(in srgb, var(--bg-primary) 42%, transparent); scroll-margin-top: 18px; }
.storage-disclosure[open] { border-style: solid; background: color-mix(in srgb, var(--bg-tertiary) 56%, transparent); }
.storage-disclosure-summary { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto 18px; gap: 10px; align-items: center; padding: 13px 15px; cursor: pointer; list-style: none; }
.storage-disclosure-summary::-webkit-details-marker { display: none; }
.storage-disclosure-summary > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.storage-disclosure-summary strong { font-size: var(--font-xs); }
.storage-disclosure-summary small { color: var(--text-muted); font-size: var(--font-xs); }
.storage-disclosure-summary::after { content: '+'; grid-column: 4; grid-row: 1; justify-self: end; color: var(--text-muted); font-size: 13px; }
.storage-disclosure[open] > .storage-disclosure-summary::after { content: '−'; }
.storage-disclosure-body { padding: 0 15px 15px; border-top: 1px solid var(--border); }
.storage-disclosure-body > :first-child { margin-top: 13px; }
.storage-disclosure .storage-row { grid-template-columns: 90px minmax(220px, 1fr) 100px 110px; min-width: 620px; }

/* ── Projects storage location ─────────────────────────────────────── */

.archive-channels, .archive-skipped { color: var(--text-secondary); margin: 6px 0; padding-left: 18px; }
.archive-skipped code { overflow-wrap: anywhere; }

.external-root-row {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
}
.external-root-row .input { flex: 1; min-width: 280px; }
.external-root-status {
  margin: 6px 0 0; padding: 6px 10px;
  background: var(--bg-tertiary); border-radius: var(--radius-sm);
  font-size: var(--font-xs);
}
.external-root-status.ok { color: var(--success, #5fc070); }
.external-root-status.warn { color: var(--warning, #d69b2b); }

.storage-summary {
  display: flex; flex-wrap: wrap; gap: 8px;
  padding: 8px 12px; background: var(--bg-tertiary);
  border-radius: var(--radius-sm); font-size: 12px;
}
.storage-summary .dot { color: var(--text-muted); }

.storage-table {
  display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-tertiary); padding: 4px;
  max-height: 60vh; overflow: auto;
}
.storage-row {
  display: grid;
  grid-template-columns: 80px 1.5fr 110px 90px 130px 130px;
  gap: 8px; align-items: center;
  padding: 6px 8px; font-size: 12px;
  background: var(--bg-secondary); border-radius: var(--radius-sm);
  min-width: 760px;
}
.storage-row.storage-head {
  background: transparent; padding: 6px 8px 4px;
  font-size: var(--font-xs); font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.storage-row.uploaded { background: rgba(75, 200, 100, 0.06); }
.storage-row.no-final { opacity: 0.55; }
.col-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-final, .col-clips, .col-other { font-family: 'Menlo', 'Monaco', monospace; font-size: var(--font-xs); }
.col-final .ext-badge {
  margin-left: 4px; padding: 1px 5px;
  background: rgba(96, 165, 250, 0.18); color: #60a5fa;
  border-radius: 4px; font-size: var(--font-xs);
}

.upload-badge {
  display: inline-block; padding: 1px 7px;
  font-size: var(--font-xs); font-weight: 600;
  border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em;
}
.upload-badge.ok { background: rgba(75, 200, 100, 0.18); color: var(--success, #5fc070); }
.upload-badge.warn { background: rgba(224, 167, 44, 0.18); color: var(--warning, #d9a62e); }
.upload-badge.none { color: var(--text-muted); }
/* Why a video stays local: visible text, not a tooltip. */
.row-reason { display: block; margin-top: 2px; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.3; }
/* Technical wording kept one click away. */
.settings-tech-details summary { cursor: pointer; color: var(--text-muted); font-size: var(--font-xs); }

.storage-result {
  padding: 8px 12px; background: var(--bg-tertiary);
  border-left: 3px solid var(--success, #5fc070);
  border-radius: var(--radius-sm); font-size: 12px;
}
.storage-result .error-text { color: var(--error, #e25c5c); margin-left: 4px; }
.cleanup-item-results { margin: 6px 0 0; padding-left: 18px; }

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
    .storage-disclosure-summary { grid-template-columns: 28px minmax(0, 1fr) 18px; }
  .storage-disclosure-summary .overview-badge { grid-column: 2; justify-self: start; margin-left: 0; }
  .storage-disclosure-summary::after { grid-column: 3; }
}

.folder-config-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.folder-config-header,
.folder-config-row {
  display: grid;
  grid-template-columns: 32px 140px 1fr 180px;
  gap: 10px;
  align-items: center;
  padding: 8px 4px;
}
.folder-config-header {
  font-size: var(--font-xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border);
}
.folder-config-row {
  border-bottom: 1px solid var(--border);
}
.folder-config-row:hover {
  background: var(--bg-hover);
}
.col-order { text-align: center; }
.col-label { font-weight: 500; font-size: 13px; }
.col-generator { font-style: italic; }

.confirm-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.confirm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 8px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
}
.confirm-row:hover {
  background: var(--bg-hover);
}
.confirm-row:first-child {
  border-top: 1px solid var(--border);
}
.confirm-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.confirm-label {
  font-size: 14px;
  font-weight: 500;
}
.confirm-desc {
  font-size: 12px;
}
.toggle-switch {
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  position: relative;
  transition: all 0.2s;
  flex-shrink: 0;
  cursor: pointer;
}
.toggle-switch.active {
  background: var(--accent);
  border-color: var(--accent);
}
.toggle-knob {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: white;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.toggle-switch.active .toggle-knob {
  transform: translateX(20px);
}

.danger-zone {
  border-top: 1px solid var(--error);
  padding-top: 20px;
  margin-top: 20px;
}

.danger-zone h3 {
  color: var(--error);
}

/* Standards sub-tabs */
.sub-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 16px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-primary) 52%, transparent);
}
.sub-tab {
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: var(--font-xs);
  transition: all 0.15s;
}
.sub-tab:hover { color: var(--text-primary); border-color: var(--border); background: var(--bg-tertiary); }
.sub-tab.active {
  color: var(--text-primary);
  border-color: rgba(88,198,146,.4);
  background: linear-gradient(145deg, rgba(88,198,146,.14), rgba(227,180,90,.06));
}

.standards-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  margin-bottom: 12px;
}
.toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.toolbar-label {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.modal-small-title { font-size: 16px; font-weight: 600; margin: 0; }

.path-display {
  display: inline-block;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 12px;
  font-family: 'SF Mono', Monaco, monospace;
  color: var(--accent);
  word-break: break-all;
  max-width: 100%;
}

.badge-warning {
  background: rgba(234, 179, 8, 0.15); color: #eab308;
  border: 1px solid rgba(234, 179, 8, 0.3);
}

/* About tab — version/build readout. Two-column k/v with monospace value
   so the version string is easy to read and select for copying. */

/* v1.0.45 — Reseason preview modal. Same shape as Compact's preview
   modal (defined in upload.vue scope) — small, scrollable list of
   moves + a Confirm. The box is the shared <Modal> (modal-flush). */
.reseason-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.reseason-modal-close {
  background: none; border: none; font-size: 16px;
  color: var(--text-secondary);
  cursor: pointer; padding: 0 4px;
}
.reseason-modal-close:hover { color: var(--text-primary); }
.reseason-modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  flex: 1;
}
.reseason-modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}
.reseason-move-list {
  margin-top: 12px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  max-height: 320px;
  overflow-y: auto;
}
.reseason-move-row {
  display: flex; gap: 8px; align-items: center;
  padding: 3px 0;
  font-size: 12px;
}
.reseason-move-title {
  flex: 1; min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* v1.0.93+ Niche-moved-to-its-own-tab wayfinder inside the Format tab. */

/* v1.0.96+ — Niche library inside the Settings → Niche tab. The
   standalone /niches sidebar page used to host this; merged here so
   all niche stuff lives under Settings. */
.niche-library-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-top: 6px;
  margin-bottom: 4px;
  gap: 12px;
  flex-wrap: wrap;
}
.niche-lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.niche-lib-tile {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--radius-sm, 4px);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.15s;
}
.niche-lib-tile.tile-builtin { border-left-color: var(--accent, #6c8fff); }
.niche-lib-tile.tile-custom { border-left-color: color-mix(in srgb, var(--accent) 85%, transparent); }
.niche-lib-tile.tile-active {
  background: rgba(108, 143, 255, 0.06);
  border-color: var(--accent, #6c8fff);
}
.niche-lib-tile .tile-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.niche-lib-tile h5 {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary);
}
.niche-lib-tile .badge {
  font-size: var(--font-xs);
  padding: 1px 7px;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.niche-lib-tile .badge-builtin { background: rgba(108, 143, 255, 0.12); color: var(--accent, #6c8fff); }
.niche-lib-tile .badge-custom { background: color-mix(in srgb, var(--accent) 14%, transparent); color: color-mix(in srgb, var(--accent) 95%, transparent); }
.niche-lib-tile .badge-active { background: rgba(108, 143, 255, 0.20); color: var(--accent, #6c8fff); font-weight: 500; }
.niche-lib-tile .tile-tagline {
  margin: 0;
  font-size: var(--font-xs);
  font-style: italic;
  color: var(--text-muted);
}
.niche-lib-tile .tile-description {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.niche-lib-tile .tile-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: var(--font-xs);
  color: var(--text-muted);
}
.niche-lib-tile .tile-details summary {
  cursor: pointer;
  font-size: var(--font-xs);
  color: var(--accent, #6c8fff);
  user-select: none;
}
.niche-lib-tile .topic-list {
  list-style: none;
  margin: 6px 0 0 0;
  padding: 0;
  font-size: var(--font-xs);
  line-height: 1.5;
}
.niche-lib-tile .topic-list li {
  color: var(--text-secondary);
}
.niche-lib-tile .topic-more {
  color: var(--text-muted);
  font-style: italic;
}
.niche-lib-tile .detail-row {
  margin-top: 6px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
  line-height: 1.5;
}
.niche-lib-tile .tile-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.niche-lib-tile .btn.danger { color: var(--error, #e25c5c); }

/* v1.4.20 — publishing cadence day picker. */

/* v1.4.18 — the episode shape, read as a summary and edited in place. */
.episode-shape-card {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  padding: 16px;
  background: var(--surface-2, rgba(255, 255, 255, 0.02));
}
.episode-shape-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.episode-shape-head h4 { margin: 2px 0 6px; }
.episode-shape-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.episode-shape-item { display: flex; flex-direction: column; gap: 2px; }
.episode-shape-item > span { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.65; }
.episode-shape-item > strong { font-size: 18px; }
.episode-shape-item > small { opacity: 0.6; }
.episode-shape-form { margin-top: 14px; }
.episode-shape-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.episode-shape-fields label { display: flex; flex-direction: column; gap: 4px; }
.episode-shape-fields label > span { font-size: 13px; opacity: 0.8; }
.episode-shape-maths { margin: 12px 0 0; }
.episode-shape-check { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; }
.episode-shape-check small { display: block; margin-top: 2px; }
.episode-shape-tone { display: flex; flex-direction: column; gap: 4px; margin-top: 14px; }
.episode-shape-tone > span { font-size: 13px; opacity: 0.8; }
.episode-shape-tone textarea { width: 100%; resize: vertical; }
.episode-shape-actions { display: flex; gap: 8px; margin-top: 16px; }

.production-kit-card {
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 14px;
  padding: 16px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, transparent), transparent 48%),
    var(--bg-secondary);
}
.production-kit-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.production-kit-head h4 { margin: 3px 0 5px; }
.production-kit-head p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  line-height: 1.5;
  max-width: 900px;
}
.production-kit-status {
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--accent) 52%, var(--border));
  border-radius: 999px;
  padding: 5px 9px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.production-kit-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}
.production-kit-item {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 11px 12px;
  background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
}
.production-kit-item > span,
.production-kit-profiles > span {
  display: block;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.production-kit-item strong {
  display: block;
  margin-top: 4px;
  color: var(--text-primary);
  font-size: var(--font-sm);
}
.production-kit-item small,
.production-kit-profiles small {
  display: block;
  margin-top: 5px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.4;
}
.production-kit-profiles {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.production-kit-profiles > div {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 7px;
}
.production-profile-pill {
  border-radius: 999px;
  padding: 5px 9px;
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-primary));
  color: var(--text-primary);
  font-size: var(--font-xs);
  font-weight: 600;
}
.audio-quality-settings {
  border-top: 1px solid var(--border);
  padding-top: 18px;
}
.audio-quality-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin-top: 14px;
}
.audio-quality-option {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  cursor: pointer;
}
.audio-quality-option.active {
  border-color: color-mix(in srgb, var(--accent) 58%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-secondary));
}
.audio-quality-option input { flex: none; margin-top: 3px; accent-color: var(--accent); }
.audio-quality-option > span { min-width: 0; }
.audio-quality-option strong { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--text-primary); font-size: var(--font-sm); }
.audio-quality-option strong small {
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: var(--font-xs);
}
.audio-quality-option > span > span { display: block; margin-top: 4px; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.audio-quality-alternate { max-width: 720px; margin-top: 14px; }
.audio-quality-alternate > label { display: block; margin-bottom: 6px; color: var(--text-primary); font-size: var(--font-sm); font-weight: 650; }
.audio-quality-cost-note {
  max-width: 75ch;
  margin: 12px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.5;
}
.audio-quality-save-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
@media (max-width: 1100px) {
  .production-kit-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .production-kit-head { flex-direction: column; }
  .production-kit-grid { grid-template-columns: 1fr; }
  .audio-quality-options { grid-template-columns: 1fr; }
  .audio-quality-save-row .btn { width: 100%; justify-content: center; }
}

.channel-identity-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 5%, var(--bg-secondary));
}
.channel-identity-summary-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.channel-identity-summary-copy > span { color: var(--text-muted); font-size: var(--font-xs); font-weight: 700; }
.channel-identity-summary-copy > strong { overflow: hidden; color: var(--text-primary); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.channel-identity-summary-copy > small { color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.4; }
@media (max-width: 820px) {
  .channel-identity-summary { grid-template-columns: 1fr; align-items: stretch; }
  .channel-identity-summary .btn { justify-self: start; }
}

/* v1.0.391 — local server pool status card */
</style>
