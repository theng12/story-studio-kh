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
    // The flag follows the published price: a free (own-Mac) model is not labelled as paid.
    assert.match(page, /Add songs <span v-if="musicCost\.basis === 'free'" class="free-flag">free<\/span><span v-else class="cost-flag">may cost credits<\/span>/)
  })

  test('the paid action shows a real price, with a sale shown as a sale', () => {
    // The section used to carry the static "costs credits" badge and no
    // number at all, so a music sale was invisible: a customer on a
    // discounted rate could not tell, and one paying list could not tell
    // they had missed one. The badge stays — it marks WHICH action spends —
    // and the figure now sits beside it.
    assert.match(page, /describeMusicUnitCost/)
    assert.match(page, /class="notice notice-cost"/)
    assert.match(page, /musicCost\.text/)
    assert.match(page, /app-settings\/genstudio\/music-models/,
      'the price has to come from the published catalogue, never from a constant')
    // Priced for the model the backend will actually charge for, and named,
    // so the figure is never attached to an unnamed model.
    assert.match(page, /musicModel\.display_name/)
  })

  test('building a video is flagged free, because it is', () => {
    assert.match(page, /Build a video <span class="free-flag">free<\/span>/)
    assert.match(page, /Never buys anything/)
  })

  test('the top-up says how many it is ordering before you press it', () => {
    assert.match(page, /Add \$\{count\} Song\(s\)/,
      'a paid button must name the quantity, not just say "Generate"')
  })

  test('a preview exists, so the tracklist is visible BEFORE committing', () => {
    assert.match(page, /Preview the Tracklist/)
    assert.match(page, /music-library\/preview-mix/)
  })

  test('the render toast states that nothing was charged', () => {
    assert.match(page, /Nothing was charged/,
      'a free action that looks like a paid one is why Repair and Retry had to be split')
  })
})

describe('the page surfaces the things that quietly break a mix', () => {
  test('a failed library load stays visible with a retry', () => {
    assert.match(page, /const libraryLoadError = ref\(''\)/)
    assert.match(page, /v-if="libraryLoadError" class="error-box mt-2" role="alert"/)
    assert.match(page, /@click="load">Retry<\/button>/)
    assert.match(page, /Could not load the music library\./)
  })

  test('a route change cannot apply a late library response to the next project', () => {
    assert.match(page, /let libraryScopeEpoch = 0/)
    assert.match(page, /let libraryLoadSequence = 0/)
    assert.match(page, /request === libraryLoadSequence && scopeEpoch === libraryScopeEpoch && slug\.value === projectSlug/)
    assert.match(page, /watch\(slug, \(\) => \{\s*libraryScopeEpoch\+\+/)
  })

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

  test('the worlds are DATA, so the owner can add a pack without a code change', () => {
    // v1.4.50 — this asserted a flat 50, which is a count that goes stale the
    // first time he adds the packs he asked for. The invariant he actually
    // cares about is the SHAPE: whole packs of ten, every one complete.
    const worlds = formula.musicFormat?.worlds
    assert.ok(Array.isArray(worlds))
    const byRegister = new Map<string, number>()
    for (const world of worlds) byRegister.set(world.register, (byRegister.get(world.register) || 0) + 1)
    assert.equal(byRegister.size, Object.keys(formula.musicFormat.registers).length,
      'every declared register must have worlds, and every world a declared register')
    for (const [register, count] of byRegister) {
      assert.equal(count, 10, `${register} has ${count} worlds; a pack is ten`)
    }
    assert.equal(worlds.length, byRegister.size * 10)
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

  test('the packs he asked for are here, ten worlds each', () => {
    // "i also want soft sleep music types, or chinese, daosim calm or
    // meditation kinds too" — plus calm adventure. Four packs of ten.
    const registers = formula.musicFormat.registers
    for (const [id, label] of [
      ['sleep', 'Sleep'],
      ['eastern', 'Eastern Calm'],
      ['meditation', 'Meditation'],
      ['adventure', 'Calm Adventure'],
    ]) {
      assert.ok(registers[id], `${id} register missing`)
      assert.equal(registers[id].label, label)
      assert.equal(formula.musicFormat.worlds.filter((w: any) => w.register === id).length, 10)
    }
  })

  test('every world is complete enough to shoot and to score', () => {
    // A world with no scene variations gives every video the same background,
    // which is the one thing this format exists to avoid.
    for (const world of formula.musicFormat.worlds) {
      assert.ok(world.sight && world.sight.length > 30, `${world.id} has no usable sight`)
      assert.ok(Array.isArray(world.scenes) && world.scenes.length >= 2, `${world.id} needs scene variations`)
      assert.ok(Array.isArray(world.music) && world.music.length >= 1, `${world.id} names no music`)
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
