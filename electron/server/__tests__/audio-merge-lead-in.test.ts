/**
 * Music intro lead-in (v1.0.397) — the volume envelope is built as an FFmpeg
 * per-frame expression that can't be exercised without running FFmpeg, so we
 * pin the pure string builder here: full during the lead-in, a linear duck
 * over the fade, the during-narration level under the voice, then post-volume.
 *
 * audio-merge.ts pulls in project-manager.js transitively (PROJECTS_ROOT is
 * evaluated at module-load), so set STORY_STUDIO_DATA_DIR via useTempDataDir()
 * before the dynamic import.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let buildMusicLeadInVolumeExpr: typeof import('../generators/audio-merge.js').buildMusicLeadInVolumeExpr

before(async () => {
  await useTempDataDir()
  const mod = await import('../generators/audio-merge.js')
  buildMusicLeadInVolumeExpr = mod.buildMusicLeadInVolumeExpr
})

describe('buildMusicLeadInVolumeExpr', () => {
  test('three phases: full → linear duck → during-narration → post', () => {
    // 8s intro, 0.6s duck fade, 120s narration, duck to 0.15, post 0.40.
    const expr = buildMusicLeadInVolumeExpr(8, 0.6, 120, 0.15, 0.4)
    assert.equal(
      expr,
      'if(lt(t,8.000),1.0,'
      + 'if(lt(t,8.600),1.0+(0.150-1.0)*(t-8.000)/0.600,'
      + 'if(lt(t,128.000),0.150,0.400)))',
    )
  })

  test('full volume during the lead-in window', () => {
    const expr = buildMusicLeadInVolumeExpr(5, 0.5, 60, 0.2, 0.5)
    // First branch keeps gain at 1.0 until t reaches the lead-in length.
    assert.ok(expr.startsWith('if(lt(t,5.000),1.0,'), `expected full-volume lead-in, got: ${expr}`)
  })

  test('handles a muted background (duckVol = 0) without NaN/Infinity', () => {
    const expr = buildMusicLeadInVolumeExpr(10, 0.6, 90, 0, 0.3)
    // Intro still full; ducks to 0.000 under the voice — no division blowups.
    assert.ok(expr.includes('1.0+(0.000-1.0)*(t-10.000)/0.600'))
    assert.ok(expr.includes('if(lt(t,100.000),0.000,0.300)'))   // narrEnd 10+90=100; duck 0, post 0.3
    assert.ok(!/NaN|Infinity/.test(expr))
  })
})
