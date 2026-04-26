/**
 * Tests for the Pattern injection into the ideas-generation prompt
 * (routes/ideas.ts buildPrompt).
 *
 * The prompt builder is internal to routes/ideas.ts so we exercise it
 * via the route handler, but the LLM call gets stubbed via supertest +
 * a mock callAi at the module level — too involved. Simpler approach:
 * import the buildPrompt internals indirectly by calling the route
 * with a mocked ai-client through the existing aiClient module's named
 * export. But callAi is imported directly in the route, not injected.
 *
 * To keep this self-contained, we test the OBSERVABLE behaviour instead:
 * load a project, run the /generate/ideas route through supertest, and
 * verify the LLM call happens with a prompt containing pattern markers.
 *
 * Stubbing strategy: we monkey-patch the OpenAI provider's callText to
 * return a canned ideas JSON response and capture the prompt it was
 * called with. The route's Format/Pattern loaders use the real impls
 * (against the temp project dir), so the only mocked thing is the LLM
 * round-trip.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let pl: typeof import('../services/pattern-loader.js')
let registry: typeof import('../providers/registry.js')
let tmp: { dir: string; cleanup: () => Promise<void> }
let app: any

const SLUG = 'pattern-idea-test'

// Capture the prompt the LLM provider was called with so the test can
// assert on its contents without intercepting at the network layer.
let lastPrompt = ''
let mockResponse = ''

async function makeProject(): Promise<void> {
  // Write project + config files directly — bypasses createProject's
  // slug-derivation so the SLUG constant is the actual on-disk dir name.
  // Mirrors the setup in asset-importer.test.ts and other suites.
  const projDir = path.join(pm.PROJECTS_ROOT, SLUG)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Pattern Idea Test',
    episode_prefix: 'TN', episode_digits: 4,
    season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: path.join(projDir, 'episodes'),
    created_at: new Date().toISOString(),
  }))
  // Config carries the API key the route validates against the chosen model.
  await fs.writeFile(path.join(projDir, 'config.json'), JSON.stringify({
    openai_api_key: 'sk-test',
  }))
  // Empty ideas store so the auto-heal path is well-defined.
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [], next_episode_number: 1, recycled_numbers: [],
  }))
}

async function makeUserPattern(): Promise<void> {
  // A custom pattern with a unique titleTemplate the test can grep for
  // in the captured prompt. The shape mirrors the built-ins.
  await pl.saveUserPattern({
    id: 'unit-test-pattern',
    name: 'Unit test pattern {X}',
    description: 'Pattern used by ideas-generator-pattern.test.ts',
    titleTemplate: 'Unit test discovers {X}',
    subjectLabel: 'Subject',
    pov: 'second',
    openingDevice: 'Open with a calm welcome.',
    closingDevice: 'Close with a slow fade.',
    metadataKeywordAdditions: ['unit-test-keyword'],
  } as any)
}

describe('ideas generator: pattern injection', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    pl = await import('../services/pattern-loader.js')
    registry = await import('../providers/registry.js')

    // Load the OpenAI provider so it self-registers, then monkey-patch
    // its callText to return our canned response + capture the prompt.
    await import('../providers/text/openai.js')
    const openai = registry.registry.findTextProviderForModel('gpt-4o')
    assert.ok(openai, 'OpenAI provider must register')
    openai.callText = async (req: any) => {
      lastPrompt = req.userMessage || req.system || ''
      return mockResponse
    }

    // The express app self-imports + auto-listen-skips when
    // STORY_STUDIO_DISABLE_LISTEN=1 (set by the test harness in
    // package.json's test:backend script). Reuse it directly.
    const appMod = await import('../app.js')
    app = appMod.app

    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    pl._clearPatternCaches()
    lastPrompt = ''
    // Canned response with two ideas so the route's filtering doesn't
    // hit the retry-shortfall path.
    mockResponse = JSON.stringify([
      { title: 'Unit test discovers a Roman bathhouse', logline: 'l', themes: ['t'],
        suggested_chapters: 8, suggested_length: '30 min', mood: 'calm' },
      { title: 'Unit test discovers a sunken lighthouse', logline: 'l', themes: ['t'],
        suggested_chapters: 8, suggested_length: '30 min', mood: 'calm' },
    ])
    await makeProject()
  })

  test('without pattern_id: prompt has no TITLE STYLE block', async () => {
    const supertest = (await import('supertest')).default
    await supertest(app)
      .post(`/api/projects/${SLUG}/generate/ideas`)
      .send({
        genre: 'sleep', audience: 'adults', mood: 'calm',
        keywords: ['ocean'], count: 2, model: 'gpt-4o',
      })
      .expect(200)
    assert.ok(lastPrompt.length > 0, 'LLM was called')
    assert.ok(!lastPrompt.includes('TITLE STYLE (PATTERN PRESET)'),
      'no pattern block when pattern_id is absent')
  })

  test('with pattern_id: prompt embeds titleTemplate + opening device', async () => {
    const supertest = (await import('supertest')).default
    await makeUserPattern()
    await supertest(app)
      .post(`/api/projects/${SLUG}/generate/ideas`)
      .send({
        genre: 'sleep', audience: 'adults', mood: 'calm',
        keywords: ['ocean'], count: 2, model: 'gpt-4o',
        pattern_id: 'unit-test-pattern',
        pattern_subject: 'Topic',
      })
      .expect(200)
    assert.ok(lastPrompt.includes('TITLE STYLE (PATTERN PRESET)'),
      'pattern block injected')
    assert.ok(lastPrompt.includes('Unit test discovers {X}'),
      'titleTemplate appears verbatim')
    assert.ok(lastPrompt.includes('Open with a calm welcome'),
      'openingDevice appears in prompt')
    assert.ok(lastPrompt.includes('Topic'),
      'subjectLabel from pattern surfaces')
    assert.ok(lastPrompt.includes('unit-test-keyword'),
      'metadataKeywordAdditions appended to prompt')
  })

  test('unknown pattern_id is non-fatal — falls back to no-pattern flow', async () => {
    const supertest = (await import('supertest')).default
    await supertest(app)
      .post(`/api/projects/${SLUG}/generate/ideas`)
      .send({
        genre: 'sleep', audience: 'adults', mood: 'calm',
        keywords: ['ocean'], count: 2, model: 'gpt-4o',
        pattern_id: 'pattern-that-does-not-exist',
      })
      .expect(200)
    assert.ok(!lastPrompt.includes('TITLE STYLE (PATTERN PRESET)'),
      'no pattern block when load fails — request still succeeds')
  })

  test('pattern_subject surfaces as a hint when supplied', async () => {
    const supertest = (await import('supertest')).default
    await makeUserPattern()
    await supertest(app)
      .post(`/api/projects/${SLUG}/generate/ideas`)
      .send({
        genre: 'sleep', audience: 'adults', mood: 'calm',
        count: 2, model: 'gpt-4o',
        pattern_id: 'unit-test-pattern',
        pattern_subject: 'a Roman bathhouse',
      })
      .expect(200)
    assert.ok(lastPrompt.includes('a Roman bathhouse'),
      'pattern_subject hint embedded as concrete example')
  })
})
