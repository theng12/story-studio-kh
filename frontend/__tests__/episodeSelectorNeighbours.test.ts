/** ← → in EpisodeSelector walk the list as shown and go through the same guarded onSelect. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { adjacentEpisodeCodes } from '../utils/episode-neighbours.ts'

test('previous / next follow the shown list and stop at its ends', () => {
  const codes = ['EP0001', 'EP0002', 'EP0003']
  assert.deepEqual(adjacentEpisodeCodes(codes, 'EP0002'), { previous: 'EP0001', next: 'EP0003' })
  assert.deepEqual(adjacentEpisodeCodes(codes, 'EP0001'), { previous: null, next: 'EP0002' })
  assert.deepEqual(adjacentEpisodeCodes(codes, 'EP0003'), { previous: 'EP0002', next: null })
  assert.deepEqual(adjacentEpisodeCodes(codes, ''), { previous: null, next: 'EP0001' }, 'nothing chosen: → picks the first')
  assert.deepEqual(adjacentEpisodeCodes(codes, 'EP0009'), { previous: null, next: 'EP0001' }, 'filtered out of the list: → picks the first shown')
  assert.deepEqual(adjacentEpisodeCodes([], 'EP0001'), { previous: null, next: null })
})

test('the buttons use the filtered list and the guarded onSelect', () => {
  const source = readFileSync(new URL('../components/EpisodeSelector.vue', import.meta.url), 'utf8')
  assert.match(source, /adjacentEpisodeCodes\(filteredEpisodes\.value\.map\(ep => ep\.episode_code\), props\.modelValue\)/)
  assert.match(source, /aria-label="Previous episode"\s*@click="previousCode && onSelect\(previousCode\)"/)
  assert.match(source, /aria-label="Next episode"\s*@click="nextCode && onSelect\(nextCode\)"/)
})
