import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  inspectChapterAudioQuality,
} from '../services/audio-quality.js'
import {
  readAudioQualityProvenance,
  writeAudioQualityProvenance,
} from '../services/audio-quality-store.js'
import { hashSubtitleAudioSources } from '../services/subtitle-completion.js'
import { hashInput } from '../services/task-manifest.js'
import { normalizeForTts } from '../lib/tts-text.js'

const CODE = 'EP0111'
const SLUG = 'Chapter_01'
const SCRIPT = 'The workers walked home as the sun set behind the hills.'
const SRT = `1\n00:00:00,000 --> 00:00:05,000\n${SCRIPT}\n`
const roots: string[] = []

async function fixture() {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-quality-'))
  roots.push(episodeDir)
  const audioDir = path.join(episodeDir, `${CODE} - 07 Audio Assets`)
  const subtitlesDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
  const scriptDir = path.join(episodeDir, `${CODE} - 01 Script`)
  await Promise.all([fs.mkdir(audioDir), fs.mkdir(subtitlesDir), fs.mkdir(scriptDir)])
  const audioFile = `${CODE}_${SLUG}.mp3`
  await fs.writeFile(path.join(audioDir, audioFile), 'active-audio')
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    sections: [{ slug: SLUG, source_file: audioFile }],
  }))
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_${SLUG}.srt`), SRT)
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_stitched.srt`), SRT)
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_stitched.srt.json`), JSON.stringify({
    complete: true,
    sections: [{ slug: SLUG, source_srt: `${CODE}_${SLUG}.srt`, cues_added: 1 }],
  }))
  await fs.writeFile(path.join(scriptDir, `${CODE}_${SLUG}.md`), `## Chapter 01: Fixture\n\n${SCRIPT}\n`)
  const sourceAudioHash = await hashSubtitleAudioSources([path.join(audioDir, audioFile)])
  assert.ok(sourceAudioHash)
  await fs.writeFile(path.join(subtitlesDir, '.subtitle-recovery.json'), JSON.stringify({
    sections: { [`${CODE}_${SLUG}.srt`]: { sourceAudioHash } },
  }))
  return { episodeDir, audioDir, subtitlesDir, scriptDir, audioFile, sourceAudioHash }
}

function normalizedScriptHash(text = SCRIPT): string {
  return hashInput(normalizeForTts(text).text)
}

async function inspect(dirs: Awaited<ReturnType<typeof fixture>>) {
  return inspectChapterAudioQuality({ ...dirs, episodeCode: CODE })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

test('fresh current source and an accepted correction report are no issue detected', async () => {
  const dirs = await fixture()
  await writeAudioQualityProvenance(dirs.episodeDir, {
    version: 1,
    chapters: {
      [SLUG]: {
        normalized_script_hash: normalizedScriptHash(),
        normalization: 'tts-v1',
        source_audio_hash: dirs.sourceAudioHash!,
        source_files: [dirs.audioFile],
        recorded_at: '2026-09-08T00:00:00.000Z',
      },
    },
  })

  const report = await inspect(dirs)

  assert.deepEqual(report.chapters, [{
    slug: SLUG,
    state: 'no_issue_detected',
    provenance: 'known',
    transcript_fresh: true,
    reason_code: 'fresh_alignment_accepted',
  }])
})

test('the sidecar stores only hashes and current audio provenance, never narration text', async () => {
  const dirs = await fixture()
  await writeAudioQualityProvenance(dirs.episodeDir, {
    version: 1,
    chapters: {
      [SLUG]: {
        normalized_script_hash: normalizedScriptHash(),
        normalization: 'tts-v1',
        source_audio_hash: dirs.sourceAudioHash!,
        source_files: [dirs.audioFile],
        recorded_at: '2026-09-08T00:00:00.000Z',
      },
    },
  })

  const saved = await readAudioQualityProvenance(dirs.episodeDir)

  assert.equal(saved.chapters[SLUG]!.normalized_script_hash, normalizedScriptHash())
  assert.doesNotMatch(JSON.stringify(saved), /workers walked home/i)
})

test('legacy, stale, and changed-script evidence remain neutral until fresh evidence is available', async t => {
  await t.test('legacy provenance', async () => {
    const dirs = await fixture()
    const report = await inspect(dirs)
    assert.deepEqual(report.chapters[0], {
      slug: SLUG,
      state: 'not_checked',
      provenance: 'legacy',
      transcript_fresh: true,
      reason_code: 'provenance_missing',
    })
  })

  await t.test('stale subtitle source', async () => {
    const dirs = await fixture()
    await writeAudioQualityProvenance(dirs.episodeDir, {
      version: 1,
      chapters: { [SLUG]: {
        normalized_script_hash: normalizedScriptHash(), normalization: 'tts-v1',
        source_audio_hash: dirs.sourceAudioHash!, source_files: [dirs.audioFile],
        recorded_at: '2026-09-08T00:00:00.000Z',
      } },
    })
    await fs.writeFile(path.join(dirs.audioDir, dirs.audioFile), 'changed-active-audio')

    const report = await inspect(dirs)
    assert.deepEqual(report.chapters[0], {
      slug: SLUG,
      state: 'not_checked',
      provenance: 'known',
      transcript_fresh: false,
      reason_code: 'subtitle_stale',
    })
  })

  await t.test('script changed after active audio', async () => {
    const dirs = await fixture()
    await writeAudioQualityProvenance(dirs.episodeDir, {
      version: 1,
      chapters: { [SLUG]: {
        normalized_script_hash: normalizedScriptHash(), normalization: 'tts-v1',
        source_audio_hash: dirs.sourceAudioHash!, source_files: [dirs.audioFile],
        recorded_at: '2026-09-08T00:00:00.000Z',
      } },
    })
    await fs.writeFile(path.join(dirs.scriptDir, `${CODE}_${SLUG}.md`),
      '## Chapter 01: Fixture\n\nA different narration was deliberately saved later.\n')

    const report = await inspect(dirs)
    assert.deepEqual(report.chapters[0], {
      slug: SLUG,
      state: 'not_checked',
      provenance: 'script_changed',
      transcript_fresh: true,
      reason_code: 'script_changed',
    })
  })
})

test('a corrected transcript cannot turn a raw script mismatch into no issue detected', async () => {
  const dirs = await fixture()
  await writeAudioQualityProvenance(dirs.episodeDir, {
    version: 1,
    chapters: { [SLUG]: {
      normalized_script_hash: normalizedScriptHash(), normalization: 'tts-v1',
      source_audio_hash: dirs.sourceAudioHash!, source_files: [dirs.audioFile],
      recorded_at: '2026-09-08T00:00:00.000Z',
    } },
  })
  const rawMismatch = 'A different speaker described an unrelated event in another place.'
  const rawSrt = `1\n00:00:00,000 --> 00:00:05,000\n${rawMismatch}\n`
  await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_${SLUG}.srt`), rawSrt)
  await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_stitched.srt`), rawSrt)

  const report = await inspect(dirs)

  const chapter = report.chapters[0]
  assert.equal(chapter?.slug, SLUG)
  assert.equal(chapter?.state, 'review_needed')
  assert.equal(chapter?.provenance, 'known')
  assert.equal(chapter?.transcript_fresh, true)
  assert.equal(chapter?.reason_code, 'script_audio_mismatch')
  assert.match(chapter?.inspected_at || '', /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(chapter?.review?.scope, 'chapter')
  assert.equal(chapter?.review?.start_sec, 0)
  assert.equal(chapter?.review?.end_sec, 5)
  assert.equal(chapter?.review?.excerpt, rawMismatch)
  assert.equal(chapter?.review?.script_excerpt, SCRIPT)
})
