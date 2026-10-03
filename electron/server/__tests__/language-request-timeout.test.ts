/**
 * v1.4.78 — how long ONE writing request may run is the owner's number.
 *
 * THE RULING (2026-08-29): *"keep the floor at 50 tps and raise the timeout
 * default to 30 minutes but also make it a setting i can dial."*
 *
 * It was `GENSTUDIO_LANGUAGE_SUBMIT_TIMEOUT_MS = 20 * 60_000`, a constant in
 * `lib/genstudio-client.ts`. Half a fix would have been to change the 20 to a
 * 30 and leave it in the code; the other half is that a number he might want
 * different is his to change, from a screen, without a rebuild.
 *
 * WHAT IS PINNED HERE:
 *   - 30 minutes when nothing is stored, and 30 minutes when what IS stored is
 *     garbage. A hand-edited `"thirty"` must behave like an unset value, not
 *     like zero — zero would abort every writing request instantly.
 *   - The value round-trips, and the CLIENT reads the stored one rather than a
 *     figure captured at import time. That is the difference between a dial
 *     and a decoration.
 *   - Out-of-range input is REFUSED OUT LOUD, with a 400 and a sentence, never
 *     quietly clamped. A clamped value that looks accepted is a lie he then
 *     plans around.
 *
 * ZERO paid calls: no network in this file at all.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { useTempDataDir } from './_helpers.js'

let temp: { dir: string; cleanup: () => Promise<void> }
before(async () => { temp = await useTempDataDir() })
after(async () => { await temp.cleanup() })

const settings = () => import('../services/app-settings.js')

describe('how long one writing request may run', () => {
  test('the default is 30 minutes when nothing is stored', async () => {
    const s = await settings()
    assert.equal(s.LANGUAGE_TIMEOUT_MINUTES_DEFAULT, 30)
    assert.equal(await s.getLanguageTimeoutMinutes(), 30)
    assert.equal(await s.getLanguageTimeoutMs(), 30 * 60_000)
  })

  test('it round-trips, and is read back as minutes and milliseconds', async () => {
    const s = await settings()
    assert.equal(await s.setLanguageTimeoutMinutes(45), 45)
    assert.equal(await s.getLanguageTimeoutMinutes(), 45)
    assert.equal(await s.getLanguageTimeoutMs(), 45 * 60_000)
    assert.equal(await s.setLanguageTimeoutMinutes(30), 30)
  })

  test('the bounds are refused out loud, never silently clamped', async () => {
    const s = await settings()
    for (const bad of [0, 1, 4, 241, 10_000, -30, 'thirty', null, NaN]) {
      await assert.rejects(
        () => s.setLanguageTimeoutMinutes(bad),
        (e: any) => {
          assert.equal(e.statusCode, 400, `${String(bad)} must be a 400, not a 500`)
          assert.equal(e.expose, true, 'the owner has to be able to read why')
          assert.match(String(e.message), /minutes/i)
          return true
        },
        `${String(bad)} was accepted`,
      )
    }
    // Refused means UNCHANGED. A rejected write must not have landed.
    assert.equal(await s.getLanguageTimeoutMinutes(), 30)
  })

  test('the edges of the range are accepted', async () => {
    const s = await settings()
    assert.equal(await s.setLanguageTimeoutMinutes(s.LANGUAGE_TIMEOUT_MINUTES_MIN), 5)
    assert.equal(await s.setLanguageTimeoutMinutes(s.LANGUAGE_TIMEOUT_MINUTES_MAX), 240)
    assert.equal(await s.setLanguageTimeoutMinutes(30), 30)
  })

  test('a corrupt stored value falls back to 30, it does not become zero', async () => {
    const s = await settings()
    // Bypass the setter the way a hand-edited app-settings.json would.
    for (const junk of ['thirty', '', null, {}, -5, 0, 2]) {
      await s.setAppSetting(s.LANGUAGE_TIMEOUT_MINUTES_KEY, junk)
      assert.equal(
        await s.getLanguageTimeoutMinutes(), 30,
        `stored ${JSON.stringify(junk)} must read back as the default`,
      )
    }
    // A stored value ABOVE the ceiling is capped rather than defaulted: it is a
    // number, just a pointless one, and the outer 4-hour job deadline binds it
    // anyway.
    await s.setAppSetting(s.LANGUAGE_TIMEOUT_MINUTES_KEY, 9_999)
    assert.equal(await s.getLanguageTimeoutMinutes(), 240)
    await s.setLanguageTimeoutMinutes(30)
  })
})

describe('the client actually uses the configured value', () => {
  test('languageSubmitTimeoutMs follows the setting, not a captured constant', async () => {
    const s = await settings()
    const { languageSubmitTimeoutMs } = await import('../lib/genstudio-client.js')
    assert.equal(await languageSubmitTimeoutMs(), 30 * 60_000)
    await s.setLanguageTimeoutMinutes(60)
    // Read AGAIN with no restart and no re-import. This is the whole point:
    // the previous behaviour was a module-scope constant, which would still
    // answer 30 here.
    assert.equal(await languageSubmitTimeoutMs(), 60 * 60_000)
    await s.setLanguageTimeoutMinutes(30)
    assert.equal(await languageSubmitTimeoutMs(), 30 * 60_000)
  })
})

describe('the dial is reachable from a screen, not only from a file', () => {
  /**
   * The sibling settings each spent a release stored in `app-settings.json`
   * with no route and no screen, and the owner's question was "where can that
   * settings be changed at?" — the honest answer being nowhere. A getter with
   * no route is the same defect wearing a different hat, so both directions
   * are pinned here rather than left to be noticed later.
   */
  test('both directions are wired through /app-settings/concurrency', async () => {
    const fs = await import('node:fs/promises')
    const url = await import('node:url')
    const route = await fs.readFile(
      url.fileURLToPath(new URL('../routes/app-settings.ts', import.meta.url)), 'utf8',
    )
    assert.match(route, /genstudio_language_timeout_minutes: await getLanguageTimeoutMinutes\(\)/)
    assert.match(route, /setLanguageTimeoutMinutes\(req\.body\.genstudio_language_timeout_minutes\)/)
    // The two speeds the Scene Plan warning needs, published rather than
    // copied, and settable rather than compiled in.
    assert.match(route, /language_floor_tokens_per_second: await getLanguageFloorTps\(\)/)
    assert.match(route, /language_preferred_tokens_per_second: await getLanguagePreferredTps\(\)/)
    assert.match(route, /setLanguageFloorTps\(req\.body\.language_floor_tokens_per_second\)/)
    assert.match(route, /setLanguagePreferredTps\(req\.body\.language_preferred_tokens_per_second\)/)
    // And a screen that offers it.
    const panel = await fs.readFile(
      url.fileURLToPath(new URL('../../../frontend/utils/performanceSettings.ts', import.meta.url)),
      'utf8',
    )
    assert.match(panel, /server: 'genstudio_language_timeout_minutes', label: 'Time limit for one writing request'/)
  })
})

describe('the two speeds the batch warning is derived from', () => {
  /**
   * The owner set the floor at 50 on 2026-08-29 and corrected it the SAME DAY
   * to *"our floor is 25 tps, we prefer 50 tps+"*. Both are stored, because a
   * number he revised inside a day is data, not a constant — the version of
   * this that shipped them as `const` would have needed a rebuild to carry his
   * own correction.
   */
  test('the floor is 25 and the preference is 50, both settable', async () => {
    const s = await settings()
    assert.equal(s.LANGUAGE_FLOOR_TPS_DEFAULT, 25)
    assert.equal(s.LANGUAGE_PREFERRED_TPS_DEFAULT, 50)
    assert.equal(await s.getLanguageFloorTps(), 25)
    assert.equal(await s.getLanguagePreferredTps(), 50)
    assert.equal(await s.setLanguageFloorTps(40), 40)
    assert.equal(await s.getLanguageFloorTps(), 40)
    assert.equal(await s.setLanguagePreferredTps(120), 120)
    assert.equal(await s.getLanguagePreferredTps(), 120)
    await s.setLanguageFloorTps(25)
    await s.setLanguagePreferredTps(50)
  })

  test('a speed outside the range is refused out loud, and junk reads as the default', async () => {
    const s = await settings()
    for (const bad of [0, -25, 10_001, 'fast', null, NaN]) {
      await assert.rejects(() => s.setLanguageFloorTps(bad), (e: any) => {
        assert.equal(e.statusCode, 400)
        assert.equal(e.expose, true)
        assert.match(String(e.message), /tokens a second/)
        return true
      }, `${String(bad)} was accepted as a floor`)
      await assert.rejects(() => s.setLanguagePreferredTps(bad), (e: any) => e.statusCode === 400)
    }
    await s.setAppSetting(s.LANGUAGE_FLOOR_TPS_KEY, 'fast')
    assert.equal(await s.getLanguageFloorTps(), 25, 'a hand-edited junk value reads as the default')
    await s.setAppSetting(s.LANGUAGE_FLOOR_TPS_KEY, 0)
    assert.equal(await s.getLanguageFloorTps(), 25, 'zero would divide the warning by zero')
    await s.setLanguageFloorTps(25)
  })

  test('the default batch DOES warn at floor speed, and that is the honest answer', async () => {
    // 250 scenes x 300 tokens = 75,000 tokens. At the 25 tok/s floor that is
    // 50 minutes against a 30-minute timeout, so the shipped default batch
    // warns — correctly, because a provider running at the floor is a provider
    // he can genuinely be routed to. At his preferred 50 tok/s the same batch
    // lands in 25 minutes, which is why the sentence names both speeds instead
    // of just sounding an alarm.
    const s = await settings()
    const { SCENE_PROMPT_PACK_TUNING_DEFAULTS } = await import('../services/scene-prompt-batching.js')
    const tokens = SCENE_PROMPT_PACK_TUNING_DEFAULTS.batchSize
      * SCENE_PROMPT_PACK_TUNING_DEFAULTS.tokensPerScene
    const budgetSeconds = s.LANGUAGE_TIMEOUT_MINUTES_DEFAULT * 60
    assert.ok(
      tokens / s.LANGUAGE_FLOOR_TPS_DEFAULT > budgetSeconds,
      'at the hard floor the default batch must not silently look safe',
    )
    assert.ok(
      tokens / s.LANGUAGE_PREFERRED_TPS_DEFAULT <= budgetSeconds,
      'at the preferred speed it must fit, or the default batch is simply wrong',
    )
  })
})
