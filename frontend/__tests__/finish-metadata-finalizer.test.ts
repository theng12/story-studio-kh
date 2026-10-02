import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Audit-finish fixes for the YouTube Finalizer page (metadata.vue).
 *
 * Source assertions, like the neighbouring finalizer tests. They cannot prove
 * timing (that a debounce really fires or flushes when expected) or what the
 * screen looks like; they pin that each guard exists in the code that matters.
 */
const page = readFileSync(new URL('../pages/projects/[slug]/metadata.vue', import.meta.url), 'utf8')
const fn = (name: string) => {
  const m = page.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`))
  assert.ok(m, `expected function ${name}`)
  return m[0]
}

test('a failed or cleared episode load blanks the previous episode and shows a Retry', () => {
  const load = fn('loadExistingMetadata')
  // cleared episode
  assert.match(load, /if \(!code\) \{\s*blankPreview\(\)/)
  // failed load
  assert.match(load, /catch \{[\s\S]*?blankPreview\(\)[\s\S]*?metadataLoadError\.value = code/)
  // the blank covers every episode-specific field, including title alternatives
  assert.match(fn('blankPreview'), /preview\.title = ''[\s\S]*preview\.description = ''[\s\S]*preview\.tags = \[\][\s\S]*titleOptions\.value = \[\]/)
  assert.match(page, /Couldn't load saved metadata for <strong>\{\{ metadataLoadError \}\}<\/strong>/)
  assert.match(page, /@click="retryLoadMetadata">Retry</)
})

test('the post-save dropdown refresh cannot wipe what the user is editing', () => {
  assert.match(page, /loadExistingMetadata\(\{ keepOnError: true \}\)/)
  assert.match(page, /if \(opts\.keepOnError\) return/)
})

test('an episode change flushes the pending save against its own episode, then blanks', () => {
  const watcher = page.match(/watch\(\[slug, episodeId\], async \(\[projectSlug, code\]\) => \{[\s\S]*?\n\}\)/)
  assert.ok(watcher)
  const body = watcher[0]
  assert.match(body, /autoSave\.state\.value === 'dirty' && scheduledTarget\) void autoSave\.flush\(\)/)
  assert.ok(body.indexOf('autoSave.flush()') < body.indexOf('blankPreview()'), 'flush must run before the preview is replaced')
  assert.match(body, /sessionVersion\.value = null/)
  // The save writes to the episode captured when the edit was made.
  assert.match(page, /scheduledTarget = \{ slug: slug\.value, code: episodeId\.value, title: selectedEpisode\.value\?\.title \|\| '' \}/)
  assert.match(page, /const target = scheduledTarget \?\? /)
  assert.match(page, /episode_id: code,\s*title: target\.title,/)
})

test('editing is disabled without an episode, and leaving the page flushes the last edit', () => {
  assert.match(page, /<input v-model="preview\.title" class="input" :disabled="!episodeId"/)
  assert.match(page, /<textarea v-model="preview\.description"[^>]*:disabled="!episodeId"/)
  assert.match(page, /<textarea v-model="tagsAsString"[^>]*:disabled="!episodeId"/)
  assert.match(page, /if \(suppressAutoSave \|\| !episodeId\.value\) return/)
  assert.match(page, /onBeforeUnmount\(\(\) => \{\s*if \(autoSave\.state\.value === 'dirty'\) void autoSave\.flush\(\)/)
})

test('a failed readiness check says so and offers Retry instead of "Checking…" forever', () => {
  assert.match(page, /const finalizationError = ref\(false\)/)
  assert.match(page, /finalizationError\.value = true/)
  assert.match(page, /if \(finalizationError\.value\) return "Couldn't check whether this episode is ready\./)
  assert.match(page, /Couldn't check whether this episode is ready<\/strong>/)
  assert.match(page, /@click="loadFinalizationStatus">Retry</)
  // reset on episode change like the status itself
  const watcher = page.match(/watch\(\[slug, episodeId\], \(\[projectSlug, newEp\][\s\S]*?\n\}\)/)
  assert.ok(watcher)
  assert.match(watcher[0], /finalizationError\.value = false/)
})

test('the Audio Assembly gate links to Audio Assembly for this episode', () => {
  assert.match(page, /audio-merge\?episode_id=\$\{encodeURIComponent\(episodeId\)\}`[^>]*>Open Audio Assembly →/)
  assert.match(page, /v-if="finalizationStatus && !finalizationStatus\.audio_assembly_ready"/)
})

test('the generation poll stops on unmount and tolerates a few network blips', () => {
  const poll = fn('waitForJob')
  assert.match(poll, /while \(!pageUnmounted\)/)
  assert.match(poll, /catch \{[\s\S]*failures\+\+[\s\S]*JOB_POLL_MAX_FAILURES[\s\S]*Lost contact, still checking…/)
  assert.match(poll, /failures = 0/)
  assert.match(poll, /return null/)
  assert.match(page, /onBeforeUnmount\(\(\) => \{ pageUnmounted = true \}\)/)
  // generateAll must not report a closed page as a failure
  assert.match(page, /const completed = await waitForJob\(projectSlug, job\.job_id\)\s*if \(!completed\) return/)
  assert.match(page, /\{\{ pollNotice \}\}/)
  // a give-up is not "the job failed"
  assert.match(poll, /The job may still be running/)
})

test('jargon and stale copy are gone, and a finished package links on to Publish', () => {
  assert.doesNotMatch(page, /Fork to v/)
  assert.doesNotMatch(page, /🔱/)
  assert.match(page, /Save as new version \(v\{\{ nextVersionNumber \}\}\)/)
  assert.doesNotMatch(page, /click an option above/)
  assert.match(page, /placeholder="SEO video title"/)
  assert.doesNotMatch(page, /Sections builder below is not used/)
  assert.doesNotMatch(page, /\(model=\$\{model\.value\}\)/)
  assert.match(page, /\/upload\/publish\?episode_id=\$\{encodeURIComponent\(episodeId\)\}`[\s\S]{0,80}Continue to Publish →/)
  assert.match(page, /lastGenResult\.kind === 'success' && episodeId/)
})
