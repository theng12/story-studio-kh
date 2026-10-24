import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { jobWorkspaceLink } from '../utils/job-presentation.js'

const failed = { type: 'audio', status: 'error', project_slug: 'terranash-sleep-stories', episode_id: 'TN0354' }

test('failed audio opens its own project and episode without retry or repair parameters', () => {
  assert.deepEqual(jobWorkspaceLink(failed), {
    label: 'Open Audio Generator',
    ariaLabel: 'Open Audio Generator for TN0354',
    to: '/projects/terranash-sleep-stories/audio?episode_id=TN0354',
  })
  assert.equal(jobWorkspaceLink({ ...failed, status: 'cancelled' })?.to, jobWorkspaceLink(failed)?.to)
  assert.equal(jobWorkspaceLink({ ...failed, project_slug: 'another project', episode_id: 'EP/1 & 2' })?.to,
    '/projects/another%20project/audio?episode_id=EP%2F1%20%26%202')
})

test('unknown and app-wide tasks have no misleading workspace shortcut', () => {
  for (const job of [
    { ...failed, type: 'future_job' }, { ...failed, type: 'constructor' }, { ...failed, project_slug: '_app_' },
    { ...failed, project_slug: '' },
  ]) assert.equal(jobWorkspaceLink(job), null)
})

test('every status opens its generator, not only failed ones', () => {
  for (const status of ['running', 'queued', 'done', 'paused', 'needs_attention'])
    assert.equal(jobWorkspaceLink({ ...failed, status })?.to, '/projects/terranash-sleep-stories/audio?episode_id=TN0354')
})

test('writing, media and upload tasks use existing work pages', () => {
  const cases = {
    expand_chapters: 'scripts', 'introduction-only': 'introduction', audio_merge: 'audio-merge',
    subtitles_transcribe: 'subtitles', scene_plan_run: 'scene-plan', continuity_render: 'scene-review',
    thumb_images: 'images', scene_clips_batch: 'motion-review', video_assembly: 'video-assembly', youtube_upload: 'upload/publish',
  }
  for (const [type, page] of Object.entries(cases)) {
    assert.equal(jobWorkspaceLink({ ...failed, type })?.to, `/projects/terranash-sleep-stories/${page}?episode_id=TN0354`)
    assert.ok(existsSync(new URL(`../pages/projects/[slug]/${page}.vue`, import.meta.url)))
  }
  assert.equal(jobWorkspaceLink({ ...failed, type: 'image_prompts', params: { mode: 'scenes' } })?.label, 'Open Scene Plan')
  assert.equal(jobWorkspaceLink({ ...failed, type: 'image_prompts', params: { mode: 'thumbnails' } })?.label, 'Open Thumbnail Prompts')
  assert.equal(jobWorkspaceLink({ ...failed, type: 'idea_campaign', episode_id: null })?.to, '/projects/terranash-sleep-stories/ideas')
})

test('both job lists render a navigation link with an episode-specific accessible label', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url), 'utf8')
  const links = page.match(/<NuxtLink\s+v-if="jobWorkspaceLink\(job\)"[\s\S]*?<\/NuxtLink>/g) || []
  assert.equal(links.length, 2)
  for (const link of links) {
    assert.match(link, /:to="jobWorkspaceLink\(job\)!.to"/)
    assert.match(link, /:aria-label="jobWorkspaceLink\(job\)!.ariaLabel"/)
    assert.doesNotMatch(link, /@click|retryJob|repairJob/)
  }
})


test('pool and bulk tasks never select a resource ID as an episode', () => {
  for (const job of [
    { ...failed, type: 'idea_campaign', episode_id: 'ideas' },
    { ...failed, type: 'image_pool_generate', episode_id: 'pool-a' },
    { ...failed, type: 'music_generate', episode_id: 'music-pool-a' },
    { ...failed, type: 'youtube_thumbnail_refresh', episode_id: '_thumbnail_refresh_' },
  ]) {
    assert.ok(!jobWorkspaceLink(job)?.to.includes('episode_id='))
    assert.ok(!jobWorkspaceLink(job)?.ariaLabel.includes(' for '))
  }
})
