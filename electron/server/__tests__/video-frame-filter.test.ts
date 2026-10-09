import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoFrameFilter } from '../lib/video-frame-filter.js'

test('video frame graph scales 1080p-authored controls and masks corners', () => {
  const graph = buildVideoFrameFilter({
    inputLabel: '[in]', outputLabel: '[out]', prefix: 'frame',
    width: 1920, height: 1080, fps: 30,
    config: {
      enabled: true, inset_pct: 5, border_width: 12, corner_radius: 28,
      border_color: '#F2C14E', background_color: '#101820', fit: 'cover',
    },
  }).join(';')
  assert.match(graph, /scale=1788:948/)
  assert.match(graph, /drawbox=x=54:y=54:w=1812:h=972/)
  // 1.4.264: the corner mask is one looped frame of geq, merged per frame — never a per-frame geq over the video.
  assert.match(graph, /scale=1788:948:force_original_aspect_ratio=increase,crop=1788:948,format=rgba\[framergb\]/)
  assert.match(graph, /color=c=white:s=1788x948:r=30,trim=end_frame=1,format=gray,geq=lum='if\(lt\(X,28\)/)
  assert.match(graph, /loop=loop=-1:size=1\[framemask\]/)
  assert.match(graph, /\[framergb\]\[framemask\]alphamerge=shortest=1\[framemedia\]/)
  assert.doesNotMatch(graph, /geq=r=/)
  assert.match(graph, /overlay=66:66:shortest=1/)
  assert.match(graph, /\[out\]$/)
})

test('video frame graph sanitizes filter-injection colors', () => {
  const graph = buildVideoFrameFilter({
    inputLabel: '[in]', outputLabel: '[out]', prefix: 'safe',
    width: 1280, height: 720, fps: 24,
    config: {
      enabled: true, inset_pct: 4, border_width: 0, corner_radius: 0,
      border_color: 'red;movie=/tmp/bad', background_color: 'nope[]', fit: 'contain',
    },
  }).join(';')
  assert.doesNotMatch(graph, /movie=/)
  assert.match(graph, /color=#FFFFFF/)
  assert.match(graph, /color=c=#101820/)
  assert.match(graph, /force_original_aspect_ratio=decrease/)
})

test('video frame graph can use a looping media input as the board', () => {
  const graph = buildVideoFrameFilter({
    inputLabel: '[in]', backgroundInputLabel: '[2:v]', outputLabel: '[out]', prefix: 'media',
    width: 1920, height: 1080, fps: 30,
    config: {
      enabled: true, inset_pct: 4, border_width: 12, corner_radius: 28,
      border_color: '#FFFFFF', background_color: '#101820', background_path: '/tmp/paper.jpg', fit: 'cover',
    },
  }).join(';')
  assert.match(graph, /\[2:v\]setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080/)
  assert.doesNotMatch(graph, /color=c=#101820:s=1920x1080/)
})

test('the precomputed corner mask renders pixel-identical to the old per-frame geq, and ends with its input', async () => {
  const { spawnSync } = await import('node:child_process')
  const config = { enabled: true, inset_pct: 4, border_width: 18, corner_radius: 60, border_color: '#FFFFFF', background_color: '#101820', fit: 'cover' as const }
  const graph = buildVideoFrameFilter({ inputLabel: '[0:v]', outputLabel: '[out]', prefix: 'f', width: 640, height: 360, fps: 24, config })
  // The 1.4.263 media chain, verbatim apart from the radius it was given.
  const r = 20
  const old = graph.slice()
  old.splice(0, 3, `[0:v]scale=600:320:force_original_aspect_ratio=increase,crop=600:320,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,${r})*lt(Y,${r}),if(lte(pow(X-${r},2)+pow(Y-${r},2),${r * r}),255,0),if(gte(X,W-${r})*lt(Y,${r}),if(lte(pow(X-(W-${r}),2)+pow(Y-${r},2),${r * r}),255,0),if(lt(X,${r})*gte(Y,H-${r}),if(lte(pow(X-${r},2)+pow(Y-(H-${r}),2),${r * r}),255,0),if(gte(X,W-${r})*gte(Y,H-${r}),if(lte(pow(X-(W-${r}),2)+pow(Y-(H-${r}),2),${r * r}),255,0),255))))'[fmedia]`)
  assert.match(graph[0]!, /crop=600:320,format=rgba\[frgb\]/, 'same inner size as the old chain')
  const frames = (filter: string[]) => {
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=2',
      '-filter_complex', filter.join(';'), '-map', '[out]', '-f', 'framemd5', '-'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return run.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)!.trim())
  }
  const before = frames(old)
  const after = frames(graph)
  assert.equal(after.length, 48, 'the looped mask stops with the 2 s input')
  assert.deepEqual(after, before, 'every frame identical')
})
