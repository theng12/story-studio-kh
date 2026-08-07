/**
 * v1.0.795 — the project-level default Style Bible (lib/style-bible.ts:
 * readProjectStyleBible / readEpisodeStyleBible / resolveStyleBible).
 *
 * A channel's look lives in the Style Bible, but that field is PER EPISODE
 * (continuity.json). A channel whose look never changes had to re-apply it to
 * every new episode, and when that step was skipped the style resolved to
 * nothing — no art direction reached the prompt writer at all, and the writer
 * defaulted to describing a photograph. That is a correctness problem, not only
 * a matter of taste: asked for a photograph an image model RETRIEVES
 * photographic references, and photographic references of a historical place
 * are modern photographs of it (a present-day alley standing in for a
 * 6th-century street, a tourist replica standing in for a period ship). Asked
 * for a painting it COMPOSES, and the anachronism has nowhere to enter from.
 *
 * So `config.json.default_style_bible` is a FALLBACK TIER on the existing
 * field, not a second style field. Four things are locked down here:
 *
 *   1. Precedence: per-run style > episode Style Bible > project default >
 *      nothing. The episode tier must keep winning over the project tier, or
 *      an episode that deliberately breaks format silently stops doing so.
 *
 *   2. Inert by default: a project with no `default_style_bible` resolves to
 *      exactly what it resolved to before this shipped, so no existing
 *      project's prompts move just because this exists.
 *
 *   3. One resolver, two readers — the planner (generators/scene-plan.ts) and
 *      the renderer (generators/continuity-render.ts) must BOTH go through
 *      `resolveStyleBible`. Otherwise the text baked into a visual_prompt at
 *      plan time and the text appended at render time become two different
 *      looks: the "two places answering one question" failure this codebase
 *      keeps hitting.
 *
 *   4. Hostile config values can never reach a prompt. config.json is a
 *      passthrough document that hand edits and older clients write to.
 *
 * IMPORTANT — module-load ordering: STORY_STUDIO_DATA_DIR must be set (via
 * useTempDataDir) before project-manager import, so PROJECTS_ROOT points at
 * the temp dir. Same constraint as art-style-resolver.test.ts.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { useTempDataDir } from './_helpers.js'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Does this source READ config.json's `default_style_bible` itself, rather than
 * going through lib/style-bible.ts? Property access and index access only — a
 * comment naming the key is documentation, not a second source of truth.
 */
function readsConfigKeyDirectly(src: string): boolean {
  return /\.default_style_bible\b/.test(src) || /\[\s*['"]default_style_bible['"]\s*\]/.test(src)
}

let pm: typeof import('../services/project-manager.js')
let sb: typeof import('../lib/style-bible.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

/** An episode dir carrying the given continuity.json `style_bible` value. */
async function episodeDirWith(name: string, styleBible: unknown | undefined): Promise<string> {
  const dir = path.join(tmp.dir, 'episodes', name)
  await fs.mkdir(dir, { recursive: true })
  if (styleBible !== undefined) {
    await fs.writeFile(path.join(dir, 'continuity.json'), JSON.stringify({ style_bible: styleBible }), 'utf-8')
  }
  return dir
}

describe('style-bible — project default', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    sb = await import('../lib/style-bible.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'),
      'projectsRoot() must point at temp dir — env was set too late')
  })

  after(async () => {
    await tmp.cleanup()
  })

  // ── episode tier ────────────────────────────────────────────────────────
  describe('episode tier — continuity.json', () => {
    test('returns the episode Style Bible, trimmed', async () => {
      const dir = await episodeDirWith('ep-ok', '  aged oil painting, visible brushwork  ')
      assert.equal(await sb.readEpisodeStyleBible(dir), 'aged oil painting, visible brushwork')
    })

    test('a missing continuity.json is "no style", not an error', async () => {
      assert.equal(await sb.readEpisodeStyleBible(await episodeDirWith('ep-absent', undefined)), '')
    })

    test('empty, whitespace, or non-string style_bible is "no style"', async () => {
      assert.equal(await sb.readEpisodeStyleBible(await episodeDirWith('ep-empty', '')), '')
      assert.equal(await sb.readEpisodeStyleBible(await episodeDirWith('ep-blank', '   ')), '')
      assert.equal(await sb.readEpisodeStyleBible(await episodeDirWith('ep-num', 42)), '')
      assert.equal(await sb.readEpisodeStyleBible(await episodeDirWith('ep-obj', { a: 1 })), '')
    })

    test('corrupt JSON never throws — a broken sidecar must not fail a 300-scene plan', async () => {
      const dir = path.join(tmp.dir, 'episodes', 'ep-corrupt')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'continuity.json'), '{ not json', 'utf-8')
      assert.equal(await sb.readEpisodeStyleBible(dir), '')
    })
  })

  // ── project tier ────────────────────────────────────────────────────────
  describe('project tier — config.json default_style_bible', () => {
    test('returns the saved default, trimmed', async () => {
      const proj = await pm.createProject({ name: 'StyleDefault' })
      await pm.updateConfig(proj.slug, { default_style_bible: '  painterly historical illustration  ' } as any)
      assert.equal(await sb.readProjectStyleBible(proj.slug), 'painterly historical illustration')
    })

    test('a project that never set one reads empty — the pre-existing behaviour', async () => {
      const proj = await pm.createProject({ name: 'StyleNoDefault' })
      assert.equal(await sb.readProjectStyleBible(proj.slug), '')
    })

    test('an unknown project is "no default", never a throw', async () => {
      assert.equal(await sb.readProjectStyleBible('__no_such_project__'), '')
    })

    test('a non-string default is ignored rather than stringified', async () => {
      const proj = await pm.createProject({ name: 'StyleBadType' })
      await pm.updateConfig(proj.slug, { default_style_bible: { text: 'oil painting' } } as any)
      assert.equal(await sb.readProjectStyleBible(proj.slug), '',
        'an object must not become "[object Object]" inside 333 prompts')
    })

    test('an over-long default is capped on READ, not only on write', async () => {
      const proj = await pm.createProject({ name: 'StyleTooLong' })
      await pm.updateConfig(proj.slug, { default_style_bible: 'x'.repeat(sb.STYLE_BIBLE_MAX_CHARS + 500) } as any)
      assert.equal((await sb.readProjectStyleBible(proj.slug)).length, sb.STYLE_BIBLE_MAX_CHARS)
      assert.equal(sb.STYLE_BIBLE_MAX_CHARS, 2000, 'must match the per-episode cap in routes/continuity.ts')
    })
  })

  // ── the setting has to survive a round trip ─────────────────────────────
  describe('getSafeConfig echoes the Scene Plan project settings', () => {
    // getSafeConfig is an ALLOWLIST: updateConfig persists anything (the schema
    // passes through), but the GET only returns fields the safe shape names.
    // Every Scene Plan project-level setting was missing from it, so the page
    // re-read its own default after every reload — and because the Scene Plan
    // form seeds its per-run parameters from these fields, and a per-run value
    // outranks the project default in the resolvers, a saved non-default was
    // not merely displayed wrong, it was actively overridden on every run.
    test('a saved default Style Bible survives the round trip', async () => {
      const proj = await pm.createProject({ name: 'StyleRoundTrip' })
      await pm.updateConfig(proj.slug, { default_style_bible: 'aged oil painting, visible brushwork' } as any)

      const safe = await pm.getSafeConfig(proj.slug)
      assert.equal((safe as any).default_style_bible, 'aged oil painting, visible brushwork',
        'the GET must return the saved style, or the page shows an empty box and can save over it')
    })

    test('the sibling scene settings survive too — non-default values, so a strip is visible', async () => {
      const proj = await pm.createProject({ name: 'SceneSettingsRoundTrip' })
      await pm.updateConfig(proj.slug, {
        motion_prompts_enabled: true,
        avoid_legible_text_in_scenes: false,
        skip_intro_scenes: true,
        default_motion_level: 4,
        visual_opening_mode: 'branded-opening',
        branded_opening_duration_sec: 22,
      } as any)

      const safe = await pm.getSafeConfig(proj.slug) as any
      assert.equal(safe.motion_prompts_enabled, true)
      assert.equal(safe.avoid_legible_text_in_scenes, false,
        'v1.0.794 shipped a toggle whose OFF state could never be read back')
      assert.equal(safe.skip_intro_scenes, true)
      assert.equal(safe.default_motion_level, 4)
      assert.equal(safe.visual_opening_mode, 'branded-opening')
      assert.equal(safe.branded_opening_duration_sec, 22)
    })

    test('a project that set none of them still reports undefined, not a fabricated value', async () => {
      const proj = await pm.createProject({ name: 'SceneSettingsUnset' })
      const safe = await pm.getSafeConfig(proj.slug) as any
      for (const key of [
        'default_style_bible', 'avoid_legible_text_in_scenes', 'motion_prompts_enabled',
        'skip_intro_scenes', 'default_motion_level', 'visual_opening_mode',
        'branded_opening_duration_sec',
      ]) {
        assert.equal(safe[key], undefined, `${key} must stay undefined so the existing default applies`)
      }
    })

    test('a wrong-typed value on disk is dropped rather than echoed', async () => {
      const proj = await pm.createProject({ name: 'SceneSettingsBadTypes' })
      await pm.updateConfig(proj.slug, {
        default_style_bible: 12,
        motion_prompts_enabled: 'yes',
        default_motion_level: 'high',
      } as any)

      const safe = await pm.getSafeConfig(proj.slug) as any
      assert.equal(safe.default_style_bible, undefined)
      assert.equal(safe.motion_prompts_enabled, undefined)
      assert.equal(safe.default_motion_level, undefined)
    })
  })

  // ── precedence ──────────────────────────────────────────────────────────
  describe('precedence — resolveStyleBible', () => {
    test('the episode Style Bible wins over the project default', async () => {
      const proj = await pm.createProject({ name: 'StylePrecedenceEpisode' })
      await pm.updateConfig(proj.slug, { default_style_bible: 'channel default look' } as any)
      const dir = await episodeDirWith('ep-override', 'this episode looks different')

      const resolved = await sb.resolveStyleBible({ slug: proj.slug, episodeDir: dir })
      assert.equal(resolved.text, 'this episode looks different',
        'an episode that deliberately breaks format must keep doing so')
      assert.equal(resolved.source, 'episode')
    })

    test('the project default fills in when the episode has none', async () => {
      const proj = await pm.createProject({ name: 'StylePrecedenceProject' })
      await pm.updateConfig(proj.slug, { default_style_bible: 'channel default look' } as any)
      const dir = await episodeDirWith('ep-inherits', undefined)

      const resolved = await sb.resolveStyleBible({ slug: proj.slug, episodeDir: dir })
      assert.equal(resolved.text, 'channel default look')
      assert.equal(resolved.source, 'project')
    })

    test('an EMPTY episode Style Bible falls through to the project default', async () => {
      // continuity.json is seeded with style_bible: '' by defaultContinuityConfig,
      // so "the file exists" must not count as "this episode chose a look".
      const proj = await pm.createProject({ name: 'StyleEmptyEpisode' })
      await pm.updateConfig(proj.slug, { default_style_bible: 'channel default look' } as any)
      const dir = await episodeDirWith('ep-seeded-empty', '')

      const resolved = await sb.resolveStyleBible({ slug: proj.slug, episodeDir: dir })
      assert.equal(resolved.text, 'channel default look')
      assert.equal(resolved.source, 'project')
    })

    test('neither tier set resolves to nothing — unchanged legacy behaviour', async () => {
      const proj = await pm.createProject({ name: 'StyleNeither' })
      const dir = await episodeDirWith('ep-nothing', undefined)

      const resolved = await sb.resolveStyleBible({ slug: proj.slug, episodeDir: dir })
      assert.equal(resolved.text, '')
      assert.equal(resolved.source, 'none')
    })
  })
})

// ── one resolver, two readers ─────────────────────────────────────────────
describe('style-bible — source wiring', () => {
  test('the planner resolves style through the shared helper, not its own config read', async () => {
    const src = await fs.readFile(path.join(serverRoot, 'generators/scene-plan.ts'), 'utf-8')
    assert.match(
      src,
      /import \{ resolveStyleBible \} from '\.\.\/lib\/style-bible\.js'/,
      'scene-plan must import the shared resolver',
    )
    assert.match(
      src,
      /const resolved = await resolveStyleBible\(\{ slug, episodeDir \}\)/,
      'resolveEffectiveStyle must delegate both tiers to the shared resolver',
    )
    // Prose may NAME the key; code may not READ it. (Matching any mention would
    // only punish the comment that explains where the value comes from.)
    assert.ok(
      !readsConfigKeyDirectly(src),
      'the planner must never read the config key directly — that is the second-source failure',
    )
    // The per-run override must still short-circuit ahead of both tiers.
    assert.match(src, /if \(explicit && explicit\.trim\(\)\) return explicit\.trim\(\)/)
  })

  test('every plan-time style call site passes the project slug', async () => {
    const src = await fs.readFile(path.join(serverRoot, 'generators/scene-plan.ts'), 'utf-8')
    const calls = src.match(/resolveEffectiveStyle\(\s*params\.style_prompt, job\.project_slug,/g) || []
    assert.equal(
      calls.length, 5,
      'all 5 resolveEffectiveStyle call sites (bulk pack, reword, motion regen, re-plan, legacy plan) must pass the slug, or that path silently loses the project default',
    )
    assert.ok(
      !/resolveEffectiveStyle\(params\.style_prompt, paths\.episode_dir\)/.test(src),
      'no call site may keep the old two-argument shape',
    )
  })

  test('the renderer resolves style through the same helper', async () => {
    const src = await fs.readFile(path.join(serverRoot, 'generators/continuity-render.ts'), 'utf-8')
    assert.match(src, /import \{ resolveStyleBible \} from '\.\.\/lib\/style-bible\.js'/)
    assert.match(
      src,
      /const resolvedStyle = await resolveStyleBible\(\{ slug: job\.project_slug, episodeDir: paths\.episode_dir \}\)/,
      'render time must resolve the same two tiers the plan did',
    )
    assert.match(src, /const styleBible = resolvedStyle\.text/)
    assert.ok(
      !readsConfigKeyDirectly(src),
      'the renderer must never read the config key directly either',
    )
    // The composition itself is unchanged: still appended, still skipped when empty.
    assert.match(src, /if \(styleBible\) parts\.push\(`Style: \$\{styleBible\}`\)/)
  })

  test('the thumbnail art-style system is left alone — these are separate questions', async () => {
    // services/art-style-resolver.ts answers "what art style do THUMBNAILS and
    // img2img reference images use" (style_presets / active_style_preset_id).
    // It has never fed a scene's visual_prompt, and overloading it here would
    // merge two settings the user sees as different things.
    const src = await fs.readFile(path.join(serverRoot, 'services/art-style-resolver.ts'), 'utf-8')
    assert.ok(!src.includes('default_style_bible'))
    assert.ok(!src.includes('style-bible.js'))
  })

  test('the Series Formula is left alone — imagePrompts is a thumbnail concern', async () => {
    // format.imagePrompts.{purposeNote,defaultStyleTag,visualStyleHint} never
    // reaches the scene visual_prompt writer (generators/scene-plan.ts reads
    // only format.script.*), and formats/*.json is SHARED by every project on
    // the machine — writing a channel look there would silently restyle every
    // other project. Guarded so a future change cannot quietly route scene
    // style back through the shared format file.
    const src = await fs.readFile(path.join(serverRoot, 'generators/scene-plan.ts'), 'utf-8')
    assert.ok(!src.includes('imagePrompts'), 'the scene planner must not start reading format.imagePrompts')
  })
})
