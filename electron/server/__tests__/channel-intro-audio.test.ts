/**
 * Job3 (1.4.384) — an EXPLICIT channel-owned intro for Audio Assembly.
 *
 * What is pinned here:
 *   1. No selection = release/1.4.383 behavior. The legacy fallback lines are
 *      compared against the read-only release-383 source, and an isolated
 *      fixture run proves the no-selection merge carries no intro, no extra
 *      gap and no channel lines (no real projects, no Hub/model calls).
 *   2. An explicit selection is OWNED by the channel: adopted through the
 *      existing adopt route's own `adoptIntoChannel`, stored `${CHANNEL}/…`,
 *      frozen at the job boundary (bytes + sha256), prepended exactly once
 *      with exactly one gap — the audio opening counted once, never doubled
 *      against the video opening (which this file never touches).
 *   3. A missing optional channel intro obeys the existing `intro_audio`
 *      safety mode with a loud reason: Warn assembles without it, Block stops.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
const { generateAudioMerge, scanEpisodeAudioAssets } = await import('../generators/audio-merge.js')
const pm = await import('../services/project-manager.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { adoptIntoChannel, channelDirForEpisodesRoot } = await import('../services/channel-self-contained.js')
const { toPortablePath } = await import('../services/path-resolver.js')
const { freezeChannelIntro } = await import('../services/channel-intro-asset.js')

const service = await startMockGenStudioService()
await setGenStudioUrl(service.baseUrl)
await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
service.ttsModels = [{
  id: 'roomy-model', display_name: 'roomy-model', provider_id: 'p', provider_name: 'Mock provider', description: '',
  credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 4_000,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
}] as any
clearGenStudioCatalogCache()

test.after(async () => {
  clearGenStudioCatalogCache()
  await service.close()
  await temp.cleanup()
})

const BASELINE_383 = fileURLToPath(new URL('../../../../release-383/electron/server/generators/audio-merge.ts', import.meta.url))
const BASELINE_PRESENT = existsSync(BASELINE_383)

/** One episode, one 2-second chapter on disk — isolated fixture, ffmpeg sine only. */
async function episodeWithChapter() {
  const project = await pm.createProject({ name: `Channel intro ${Math.random().toString(36).slice(2, 7)}`, episode_prefix: 'EP', episode_digits: 3 })
  const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
  const narrationDir = path.join(outputRoot, 'EP001 - Test')
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One', 'The first chapter is short.',
  ].join('\n\n'))
  const audioDir = await resolveAudioDir(project.slug, await findNarrationFile(project.slug, 'EP001'), 'EP001')
  await fs.mkdir(audioDir, { recursive: true })
  assert.equal((await scanEpisodeAudioAssets(project.slug, 'EP001')).audio_dir, audioDir)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'libmp3lame', path.join(audioDir, 'EP001_Chapter_01.mp3')])
  const run = (params: Record<string, unknown> = {}, merge: (job: any) => Promise<unknown> = generateAudioMerge) => {
    const job: any = {
      job_id: `merge-${Math.random().toString(36).slice(2, 7)}`, project_slug: project.slug, type: 'audio_merge',
      episode_id: 'EP001', title: 'Audio Assembly', status: 'running', created_at: new Date().toISOString(),
      started_at: null, finished_at: null, error: null, output_lines: [],
      params: { episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false, ...params },
    }
    return merge(job).then(() => job)
  }
  const sine = async (seconds: number, name: string) => {
    const file = path.join(temp.dir, `${name}-${Math.random().toString(36).slice(2, 7)}.mp3`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=880:duration=${seconds}`,
      '-c:a', 'libmp3lame', file])
    return file
  }
  const completion = async () => {
    const hits: string[] = []
    const walk = async (dir: string) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) await walk(p)
        else if (ent.name === 'EP001_merged_audio.completion.json') hits.push(p)
      }
    }
    await walk(outputRoot)
    assert.equal(hits.length, 1, `expected exactly one completion record, found ${hits.length}`)
    return JSON.parse(await fs.readFile(hits[0]!, 'utf8'))
  }
  return { slug: project.slug, outputRoot, run, sine, completion }
}

void test('no selection: release/1.4.383 fallback stays intact and the fixture merges with no intro', {
  skip: BASELINE_PRESENT ? false : `release-383 baseline not present at ${BASELINE_383} — source comparison not checked`,
}, async () => {
  const baseline = readFileSync(BASELINE_383, 'utf8')
  const current = readFileSync(fileURLToPath(new URL('../generators/audio-merge.ts', import.meta.url)), 'utf8')
  // The lines that DEFINE the no-selection path must be byte-identical in
  // both releases: if a future edit changes today's output, it changes these.
  const anchors = [
    'const introEnabled = req.intro?.enabled && !!req.intro?.file',
    'let introPath = introEnabled && req.intro ? unescapeShellPath(req.intro.file)! : \'\'',
    'const message = avail.message || `Intro audio file not found: ${introPath}`',
    'if (await safetyMode(project_slug, \'intro_audio\') === \'block\') throw new Error(message)',
    'await safetyGate(project_slug, \'intro_audio\', job, `${message} Story assembles the narration without the intro.`)',
  ]
  for (const anchor of anchors) {
    assert.ok(baseline.includes(anchor), `release-383 baseline must still contain: ${anchor}`)
    assert.ok(current.includes(anchor), `current source must keep the release-383 line: ${anchor}`)
  }

  const ep = await episodeWithChapter()
  const plain = await ep.run()
  const plainRecord = await ep.completion()
  assert.equal(plainRecord.opening.intro, null, 'no selection must record no intro')
  assert.ok(plain.output_lines.some((l: string) => l === 'Opening recorded: no intro — narration only.'), plain.output_lines.join('\n'))
  assert.ok(!plain.output_lines.some((l: string) => /Channel intro|Intro prepended/.test(l)), 'no selection must add no intro lines')

  const legacyFile = await ep.sine(1, 'legacy-intro')
  const legacy = await ep.run({ intro: { enabled: true, file: legacyFile, volume: 1, gap_after: 0 } })
  const legacyRecord = await ep.completion()
  assert.equal(legacyRecord.opening.intro?.filename, path.basename(legacyFile), 'episode-owned intro keeps its own name')
  assert.equal(legacyRecord.opening.intro?.gap_after_sec, 0, 'legacy gap honored as configured')
  assert.ok(legacy.output_lines.some((l: string) => l.startsWith('Intro prepended (legacy-intro-')), legacy.output_lines.join('\n'))
  assert.ok(!legacy.output_lines.some((l: string) => l.includes('Channel intro frozen')), 'legacy path must not report a channel freeze')
})

void test('no selection: the ACTUAL release-383 generator and release-384 decode to byte-identical PCM', {
  skip: BASELINE_PRESENT ? false : `release-383 baseline not present at ${BASELINE_383} — actual generator comparison not run`,
}, async () => {
  const baseline = await import(pathToFileURL(BASELINE_383).href) as {
    generateAudioMerge: (job: any) => Promise<unknown>
  }
  assert.equal(typeof baseline.generateAudioMerge, 'function', 'the release-383 generator must load and run')

  // Same fixture, no intro choice on either side; separate projects so neither
  // run can see the other's output or sidecars.
  const ep383 = await episodeWithChapter()
  const job383 = await ep383.run({}, baseline.generateAudioMerge)
  const ep384 = await episodeWithChapter()
  const job384 = await ep384.run({})

  const merged = (job: any) => {
    const file = path.join(job.output_dir!, 'EP001_merged_audio.mp3')
    assert.ok(existsSync(file), `the merge must produce ${file}`)
    return file
  }
  for (const job of [job383, job384]) {
    assert.ok(!job.output_lines.some((l: string) => /Intro prepended|Channel intro/.test(l)),
      `no selection must add no intro on either release: ${job.output_lines.join(' | ')}`)
  }

  const probe = (file: string) => JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-of', 'json', file,
  ], { encoding: 'utf8' })).streams[0]
  assert.deepEqual(probe(merged(job383)), probe(merged(job384)), 'decoded audio format must match')

  const pcm = (file: string) => execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-',
  ], { maxBuffer: 128 * 1024 * 1024 })
  const pcm383 = pcm(merged(job383))
  const pcm384 = pcm(merged(job384))
  assert.ok(pcm383.length > 0, 'the decoded baseline PCM must not be empty')
  assert.equal(pcm383.length, pcm384.length, 'decoded sample bytes must have the same length')
  assert.equal(
    createHash('sha256').update(pcm383).digest('hex'),
    createHash('sha256').update(pcm384).digest('hex'),
    `decoded PCM differs between release-383 (${createHash('sha256').update(pcm383).digest('hex')}) `
    + `and release-384 (${createHash('sha256').update(pcm384).digest('hex')})`,
  )
  assert.ok(pcm383.equals(pcm384), 'no-selection PCM must be byte-identical')
})

void test('explicit selection: channel-owned, adopted, frozen at the boundary, one intro and one gap', async () => {
  const ep = await episodeWithChapter()
  const channelDir = channelDirForEpisodesRoot(ep.outputRoot)
  assert.ok(channelDir, 'the fixture project must be a real channel folder')

  // Registration = the SAME adoption the existing system/resolve-asset-path
  // route performs (FilePicker Browse calls it); no second registry.
  const picked = await ep.sine(1, 'brand-intro')
  const adopted = await adoptIntoChannel(channelDir, picked)
  assert.ok(adopted && adopted.copied, 'a file outside the channel must be copied into <channel>/assets/')
  const portable = adopted.stored
  assert.ok(portable.startsWith('${CHANNEL}/'), `channel-owned selection must store as the channel token, got ${portable}`)
  // The portable form the route would answer with — proves one adoption route.
  assert.equal(toPortablePath(adopted.copied!.target, ep.outputRoot), portable)

  const frozen = await freezeChannelIntro({ outputRoot: ep.outputRoot, file: portable, slug: ep.slug, episodeId: 'EP001' })
  assert.ok(frozen.file && existsSync(frozen.file), 'the chosen bytes must be frozen at the job boundary')
  const sourceBytes = await fs.readFile(picked)
  const frozenBytes = await fs.readFile(frozen.file!)
  assert.equal(createHash('sha256').update(frozenBytes).digest('hex'), frozen.sha256, 'identity is the hash of the frozen bytes')
  assert.deepEqual(frozenBytes, sourceBytes, 'frozen bytes must equal the chosen bytes')
  assert.equal(frozen.bytes, sourceBytes.length)
  assert.equal(frozen.name, path.basename(picked), 'the record must name the customer\'s file, not the hash')

  const job = await ep.run({ channel_intro: { ...frozen, volume: 1, gap_after: 1.5 } })
  const record = await ep.completion()
  const intro = record.opening.intro
  assert.ok(intro, 'the completion record must state the intro that was prepended')
  assert.equal(intro.filename, path.basename(picked), 'completion record names the chosen asset')
  assert.equal(intro.gap_after_sec, 1.5, 'the one configured gap is the one recorded')
  // Audio opening counted ONCE: lead-in ≈ intro duration + one gap (encoder
  // padding is small). A double-counted gap would land near 1 + 3 = 4s.
  assert.ok(intro.duration_sec !== null && intro.duration_sec > 0.9 && intro.duration_sec < 1.4, `intro duration measured: ${intro.duration_sec}`)
  const leadIn = record.opening.lead_in_sec as number
  assert.ok(leadIn > 2.3 && leadIn < 3.3, `audio opening must count intro + ONE gap once, got ${leadIn}s`)
  const prepends = job.output_lines.filter((l: string) => l.startsWith('Intro prepended ('))
  assert.equal(prepends.length, 1, `exactly one intro, got: ${prepends.join(' | ')}`)
  assert.ok(job.output_lines.some((l: string) => l.startsWith(`Channel intro frozen: ${path.basename(picked)}`)), job.output_lines.join('\n'))
  assert.ok(job.output_lines.some((l: string) => l.includes('Opening recorded: intro')), job.output_lines.join('\n'))
})

void test('missing optional channel intro obeys intro_audio safety: Warn assembles, Block stops', async () => {
  const ep = await episodeWithChapter()
  const gone = path.join(temp.dir, `missing-${Math.random().toString(36).slice(2, 7)}.mp3`)
  const selection = { source: gone, name: path.basename(gone), volume: 1, gap_after: 2 }

  // Default Warn: loud reason, merge continues WITHOUT the intro.
  const warned = await ep.run({ channel_intro: selection })
  const warnedRecord = await ep.completion()
  assert.equal(warnedRecord.opening.intro, null, 'a missing intro must not be recorded as present')
  assert.ok(warned.output_lines.some((l: string) => l.includes('Story assembles the narration without the intro.')), warned.output_lines.join('\n'))
  assert.ok(warned.output_lines.some((l: string) => l.includes('channel_intro.file not found')), warned.output_lines.join('\n'))

  await pm.updateConfig(ep.slug, { safety_checks: { chapter_audio_present: 'warn', intro_audio: 'block' } } as any)
  await assert.rejects(ep.run({ channel_intro: selection }), /channel_intro\.file not found/)
})

/** Adopt a sine file into the channel and freeze it — the normal host-Apply → job-boundary path. */
async function adoptedAndFrozen(ep: Awaited<ReturnType<typeof episodeWithChapter>>, name: string) {
  const channelDir = channelDirForEpisodesRoot(ep.outputRoot)
  assert.ok(channelDir, 'the fixture project must be a real channel folder')
  const picked = await ep.sine(1, name)
  const adopted = await adoptIntoChannel(channelDir, picked)
  assert.ok(adopted && adopted.copied, 'a file outside the channel must be copied into <channel>/assets/')
  const frozen = await freezeChannelIntro({ outputRoot: ep.outputRoot, file: adopted.stored, slug: ep.slug, episodeId: 'EP001' })
  assert.ok(frozen.file && frozen.sha256, 'the fixture must freeze successfully')
  return { picked, portable: adopted.stored, frozen }
}

void test('gap defaults: a new channel selection starts at 0, the legacy intro keeps its default 2', async () => {
  const ep = await episodeWithChapter()
  const { frozen } = await adoptedAndFrozen(ep, 'gap-channel-intro')

  await ep.run({ channel_intro: { ...frozen, volume: 1 } }) // no gap_after on the request
  const channelRecord = await ep.completion()
  assert.equal(channelRecord.opening.intro?.gap_after_sec, 0,
    'a NEW channel selection with no gap must default to 0, not 2')

  const legacyFile = await ep.sine(1, 'gap-legacy-intro')
  await ep.run({ intro: { enabled: true, file: legacyFile, volume: 1 } }) // no gap_after
  const legacyRecord = await ep.completion()
  assert.equal(legacyRecord.opening.intro?.gap_after_sec, 2,
    'the release/1.4.383 legacy default gap of 2 must be unchanged')
})

void test('freeze refuses a raw path that is not an adopted asset of this channel', async () => {
  const ep = await episodeWithChapter()
  const raw = await ep.sine(1, 'raw-temp-intro') // lives in the temp dir, outside the channel
  await assert.rejects(
    freezeChannelIntro({ outputRoot: ep.outputRoot, file: raw, slug: ep.slug, episodeId: 'EP001' }),
    /not an adopted asset of this channel/,
    'an arbitrary filesystem path must never be freezable as a channel intro',
  )
})

void test('same-size corrupt frozen data: freeze repairs the cache and the merge refuses it loudly', async () => {
  const ep = await episodeWithChapter()
  const { picked, frozen } = await adoptedAndFrozen(ep, 'corrupt-intro')
  const sourceBytes = await fs.readFile(picked)
  const frozenBytes = await fs.readFile(frozen.file!)
  assert.equal(frozenBytes.length, sourceBytes.length, 'the corruption under test keeps the size identical')
  const corrupt = Buffer.from(frozenBytes)
  corrupt[0] = corrupt[0]! ^ 0xff

  // 1) The freeze must not trust a same-size cache: hash it, rewrite when it differs.
  await fs.writeFile(frozen.file!, corrupt)
  const refrozen = await freezeChannelIntro({ outputRoot: ep.outputRoot, file: frozen.source!, slug: ep.slug, episodeId: 'EP001' })
  assert.equal(refrozen.file, frozen.file, 'content addressing keeps the same path')
  assert.deepEqual(await fs.readFile(refrozen.file!), sourceBytes, 'a same-size corrupt cache must be rewritten from the source')

  // 2) A corrupt frozen copy must never reach the merge: loud reason, no intro.
  await fs.writeFile(frozen.file!, corrupt)
  const warned = await ep.run({ channel_intro: { ...refrozen, volume: 1, gap_after: 0 } })
  const warnedRecord = await ep.completion()
  assert.equal(warnedRecord.opening.intro, null, 'corrupt frozen bytes must not be recorded as a prepended intro')
  assert.ok(warned.output_lines.some((l: string) => l.includes('integrity check')), warned.output_lines.join('\n'))
  assert.ok(warned.output_lines.some((l: string) => l.includes('Story assembles the narration without the intro.')), warned.output_lines.join('\n'))
  assert.ok(!warned.output_lines.some((l: string) => l.startsWith('Intro prepended (')), 'corrupt bytes must never be staged')
  assert.ok(!warned.output_lines.some((l: string) => l.includes('Channel intro frozen')), 'no freeze line without a verified consume')

  await pm.updateConfig(ep.slug, { safety_checks: { chapter_audio_present: 'warn', intro_audio: 'block' } } as any)
  await assert.rejects(ep.run({ channel_intro: { ...refrozen, volume: 1, gap_after: 0 } }), /integrity check/)
})

void test('a lost freeze fails loudly and never falls back to the mutable channel source', async () => {
  const ep = await episodeWithChapter()
  const { picked, frozen } = await adoptedAndFrozen(ep, 'lost-intro')
  assert.ok(existsSync(picked), 'the adopted source still exists — the trap is falling back to it')
  await fs.rm(frozen.file!)

  const selection = { ...frozen, volume: 1, gap_after: 0 } // file (gone), source (present), sha256
  const warned = await ep.run({ channel_intro: selection })
  const warnedRecord = await ep.completion()
  assert.equal(warnedRecord.opening.intro, null, 'a lost freeze must not become an intro from the mutable source')
  assert.ok(warned.output_lines.some((l: string) => l.includes('channel_intro.file not found')), warned.output_lines.join('\n'))
  assert.ok(!warned.output_lines.some((l: string) => l.startsWith('Intro prepended (')),
    'the merge must not consume the source while the frozen copy is missing')

  await pm.updateConfig(ep.slug, { safety_checks: { chapter_audio_present: 'warn', intro_audio: 'block' } } as any)
  await assert.rejects(ep.run({ channel_intro: selection }), /channel_intro\.file not found/)
})
