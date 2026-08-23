/**
 * v1.4.37 — the Music Library page, and the Music Mix formula behind it.
 *
 * The page is organised around ONE property: which buttons spend money. Exactly
 * one action here buys anything. Preview and Build read the library and buy
 * nothing, and both say so on screen — because a button that spends as a side
 * effect of doing something else is the v1.0.114 "Repair & Retry all" bug that
 * charged the owner twice.
 *
 * The formula is asserted too, because its whole point is that the fifty worlds
 * are DATA. If they ever become code, the owner can no longer add one without
 * asking, which is his standing rule.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { describe } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const page = read('../pages/projects/[slug]/music.vue')
const formula = JSON.parse(read('../../electron/server/niches/music-mix.json'))

describe('the page tells you what costs money', () => {
  test('exactly one action is flagged as costing credits', () => {
    assert.equal((page.match(/class="cost-flag"/g) || []).length, 1,
      'if two things cost money the flag stops meaning anything')
    assert.match(page, /Add songs <span class="cost-flag">costs credits<\/span>/)
  })

  test('building a video is flagged free, because it is', () => {
    assert.match(page, /Build a video <span class="free-flag">free<\/span>/)
    assert.match(page, /Never buys anything/)
  })

  test('the top-up says how many it is ordering before you press it', () => {
    assert.match(page, /Add \$\{count\} song\(s\)/,
      'a paid button must name the quantity, not just say "Generate"')
  })

  test('a preview exists, so the tracklist is visible BEFORE committing', () => {
    assert.match(page, /Preview the tracklist/)
    assert.match(page, /music-library\/preview-mix/)
  })

  test('the render toast states that nothing was charged', () => {
    assert.match(page, /Nothing was charged/,
      'a free action that looks like a paid one is why Repair and Retry had to be split')
  })
})

describe('the page surfaces the things that quietly break a mix', () => {
  test('tracks with no measured length are reported, not hidden', () => {
    // The mix builder skips them. Without this line the owner sees a library
    // that looks full and a video that comes out short.
    assert.match(page, /have no measured length, so a mix will skip them/)
  })

  test('siblings are labelled, so "take 2" is not mistaken for a duplicate', () => {
    assert.match(page, /Came from the same request as another track/)
  })

  test('the library folder is shown, because Finder is a supported way in', () => {
    assert.match(page, /drop audio files into/)
    assert.match(page, /library\.folder/)
  })
})

describe('the Music Mix formula', () => {
  test('it declares itself as music, rather than pretending to have a script', () => {
    // The discriminator is the PRESENCE of `musicFormat`, not a `kind` of its
    // own. `kind` is reserved by the content-pack system, which requires every
    // formula to read 'series-formula' — setting it to 'music' broke that
    // invariant and was caught by idea-campaign-planner's existing assertion.
    assert.ok(formula.musicFormat, 'the music format block is the marker')
    assert.ok(!('kind' in formula), 'kind belongs to the content-pack system, not to this format')
    for (const scriptField of ['narratorStyles', 'scriptStructure', 'scriptSystemPromptRole', 'titleShapeRules']) {
      assert.ok(!(scriptField in formula),
        `${scriptField} describes a narrator reading a written episode. A music mix has no `
        + 'narrator and no script, and filling it with plausible nonsense would mislead every '
        + 'future reader — including the sellable pack copies.')
    }
  })

  test('it still satisfies the loader\'s required shape', () => {
    // id, name, description, schemaVersion: 1, exampleTopics — everything else
    // is optional, which is what lets the script fields be honestly absent.
    assert.equal(typeof formula.id, 'string')
    assert.equal(typeof formula.name, 'string')
    assert.equal(typeof formula.description, 'string')
    assert.equal(formula.schemaVersion, 1)
    assert.ok(Array.isArray(formula.exampleTopics) && formula.exampleTopics.length > 0)
  })

  test('the fifty worlds are DATA, so the owner can add one without a code change', () => {
    const worlds = formula.musicFormat?.worlds
    assert.ok(Array.isArray(worlds))
    assert.equal(worlds.length, 50)
    for (const world of worlds) {
      assert.ok(world.id && world.name && world.sight, `${world.id} is incomplete`)
      assert.ok(Array.isArray(world.scenes) && world.scenes.length >= 2,
        `${world.id} needs scene variations — every video gets its own background`)
      assert.ok(Array.isArray(world.music) && world.music.length >= 1,
        `${world.id} must name the music it suits`)
    }
  })

  test('world ids are unique, so a channel pins one unambiguously', () => {
    const ids = formula.musicFormat.worlds.map((w: any) => w.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  test('every world belongs to a declared register', () => {
    const registers = Object.keys(formula.musicFormat.registers)
    for (const world of formula.musicFormat.worlds) {
      assert.ok(registers.includes(world.register),
        `${world.id} is in register "${world.register}", which is not declared`)
    }
  })

  test('the approved starting world is present and unchanged', () => {
    const coast = formula.musicFormat.worlds.find((w: any) => w.id === 'vast-coast')
    assert.ok(coast, 'the owner approved Vast Coast as the first channel')
    assert.equal(coast.register, 'massive')
    assert.ok(coast.music.includes('classical adagio'))
  })

  test('the description states the one-world rule, because it is the whole format', () => {
    assert.match(formula.description, /Pick ONE world/)
    assert.match(formula.description, /every video gets its own background/)
  })
})

describe('the library has a home in the app', () => {
  test('it is in the project flow, and marked optional', () => {
    const flow = read('../composables/useProjectFlow.ts')
    assert.match(flow, /musicLibrary: \{ key: 'music'/)
    assert.match(flow, /path: '\/music'/)
    assert.match(flow, /optional: true/,
      'a scripted channel never opens it; a music channel opens almost nothing else')
  })
})
