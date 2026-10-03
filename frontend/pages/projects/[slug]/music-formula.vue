<!--
  Music Formula (music format phase 1, mockup 01). The recipe every song brief is written from,
  plus the starting values a new episode begins with. Saved into this project's Series Formula as
  `musicFormat.songFormula` / `musicFormat.episodeDefaults` (a built-in is copied first, so the
  original is never changed). Every list is editable and weighted; nothing here is a hidden default.
-->
<template>
  <div class="workspace-page">
    <WorkspaceHero eyebrow="Series Formula · Music channel" :title="niche?.name || 'Music Formula'"
      description="The recipe every song brief is written from. Code decides which combination each song gets so the pool stays varied; the writing model you pick at generation time only writes the words.">
      <template #aside>
        <div class="mp-row" style="align-items: flex-start">
          <div class="mp-btnhint">
            <button type="button" class="btn btn-secondary" :disabled="!niche || busy" @click="duplicate">Duplicate As New Channel…</button>
            <span class="mp-hint">A named copy a new project can pick. This one stays as it is.</span>
          </div>
          <div class="mp-btnhint">
            <button type="button" class="btn btn-primary" :disabled="!niche || busy || !!invalid" @click="save">{{ busy ? 'Saving…' : 'Save Formula' }}</button>
            <span class="mp-hint">{{ invalid || (!saved ? 'Starting values — save to use them.' : dirty ? 'You have changes that are not saved yet.' : 'Saved.') }}</span>
          </div>
        </div>
      </template>
    </WorkspaceHero>

    <p v-if="loadError" class="error-box" role="alert">{{ loadError }}</p>
    <WorkspaceNotice v-else-if="loaded && !niche" title="This project is not a music channel" tone="warning" style="margin-top: 14px">
      Pick a music formula (one with a music format, such as Music Mix) for this project in Channel Identity, then come back here.
    </WorkspaceNotice>

    <div v-if="niche" class="mp-grid2" style="margin-top: 18px">
      <div style="display: flex; flex-direction: column; gap: 18px">
        <section class="card workspace-section mp-card">
          <h3>1. Channel sound</h3>
          <p class="mp-hint">Every list is yours to edit. Numbers are weights (how often a value is chosen), not rules. Weight 0 keeps a value but never picks it.</p>
          <div v-for="axis in weightedAxes" :key="axis.key" style="margin-top: 14px">
            <span class="mp-lbl">{{ axis.label }}</span>
            <div class="mp-row">
              <span v-for="(v, i) in f[axis.key]" :key="i" class="mp-chip" :class="{ on: v.weight > 0 }">
                {{ v.value }} <input v-model.number="v.weight" type="number" min="0" :aria-label="`Weight for ${v.value}`">
                <button type="button" class="mp-x" :aria-label="`Remove ${v.value}`" @click="f[axis.key].splice(i, 1)">×</button>
              </span>
              <AddChip :placeholder="`New ${axis.label.toLowerCase()} value`" @add="v => addWeighted(axis.key, v)" />
            </div>
            <p v-if="axis.hint" class="mp-hint">{{ axis.hint }}</p>
          </div>

          <div style="margin-top: 14px">
            <span class="mp-lbl">Tempo bands</span>
            <div class="mp-row">
              <span v-for="(b, i) in f.tempo_bands" :key="i" class="mp-chip" :class="{ on: b.weight > 0 }">
                <input v-model="b.label" class="mp-band-name" aria-label="Band name">
                <input v-model.number="b.min_bpm" type="number" aria-label="From BPM">–<input v-model.number="b.max_bpm" type="number" aria-label="To BPM">
                <em>·</em><input v-model.number="b.weight" type="number" min="0" aria-label="Weight">
                <button type="button" class="mp-x" :aria-label="`Remove ${b.label}`" @click="f.tempo_bands.splice(i, 1)">×</button>
              </span>
              <button type="button" class="mp-chip" @click="addBand">+ Add band</button>
            </div>
            <p class="mp-hint">Name, BPM range and weight. BPM is asked for; the model follows it reasonably.</p>
          </div>
          <div class="mp-grid2b" style="margin-top: 14px">
            <div>
              <span class="mp-lbl">Keys</span>
              <div class="mp-seg">
                <button type="button" :class="{ on: keyMode === 'all' }" @click="setKeys('all')">All 24</button>
                <button type="button" :class="{ on: keyMode === 'minor' }" @click="setKeys('minor')">Minor only</button>
                <button type="button" :class="{ on: keyMode === 'major' }" @click="setKeys('major')">Major only</button>
                <button type="button" :class="{ on: keyMode === 'pick' }" @click="pickingKeys = !pickingKeys">Pick…</button>
              </div>
              <div v-if="pickingKeys" class="mp-row" style="margin-top: 8px">
                <button v-for="k in ALL_KEYS" :key="k" type="button" class="mp-chip sm" :class="{ on: keyOn(k) }" style="cursor: pointer" @click="toggleKey(k)">{{ k }}</button>
              </div>
              <p class="mp-hint">Keys are requested, not guaranteed — used as a soft preference when ordering.</p>
            </div>
            <div>
              <span class="mp-lbl">Song length</span>
              <div class="mp-row">
                <input v-model="minText" class="mp-inp narrow" aria-label="Shortest song (m:ss)"> to <input v-model="maxText" class="mp-inp narrow" aria-label="Longest song (m:ss)">
              </div>
              <p class="mp-hint">Random within the range. The song model's own limit is shown when you generate.</p>
            </div>
          </div>

          <div style="margin-top: 14px">
            <span class="mp-lbl">Never use</span>
            <div class="mp-row">
              <span v-for="(w, i) in f.never" :key="i" class="mp-chip">{{ w }} <button type="button" class="mp-x" :aria-label="`Remove ${w}`" @click="f.never.splice(i, 1)">×</button></span>
              <AddChip placeholder="Word or instrument" @add="v => addUnique(f.never, v)" />
            </div>
            <p class="mp-hint">Words and instruments that may not appear in a title, line, scene idea or prompt.</p>
          </div>
        </section>

        <section class="card workspace-section mp-card">
          <h3>2. Variety rules</h3>
          <p class="mp-hint">Checked by code after the model answers. A brief that fails is rewritten once, then dropped and reported.</p>
          <label class="mp-check"><input v-model="f.variety.unique_combos" type="checkbox"> Every song gets a combination the pool doesn't have yet</label>
          <p class="mp-hint mp-indent">Ensemble × mood × tempo × key × structure. {{ combos.toLocaleString() }} combinations available.</p>
          <label class="mp-check"><input v-model="f.variety.spread_least_filled" type="checkbox"> Spread new songs over what the pool has least of</label>
          <p v-if="thinnest" class="mp-hint mp-indent">Today the pool is short on {{ thinnest }} — new batches lean that way.</p>
          <label class="mp-check">
            <input type="checkbox" checked disabled> Titles unique; no title word in more than
            <input v-model.number="sharePct" type="number" min="1" max="100" class="mp-inp" style="width: 64px"> % of titles
          </label>
          <label class="mp-check">
            <input type="checkbox" checked disabled> Rewrite a brief that reads like one already in the pool (similarity above
            <input v-model.number="simPct" type="number" min="5" max="100" class="mp-inp" style="width: 64px"> %)
          </label>
          <label class="mp-check">
            <input v-model="f.variety.trim_silence" type="checkbox"> Trim silence at start/end; flag songs with a gap longer than
            <input v-model.number="f.variety.flag_gap_s" type="number" min="1" class="mp-inp" style="width: 64px"> s
          </label>
        </section>

        <section class="card workspace-section mp-card">
          <h3>3. Episodes</h3>
          <p class="mp-hint">Starting values for a new episode. Every one can be changed per episode in the Episode Builder.</p>
          <div class="mp-grid3" style="margin-top: 12px">
            <div>
              <label class="mp-lbl" for="mf-target">Target length</label>
              <div class="mp-row"><input id="mf-target" v-model.number="targetMin" type="number" min="1" class="mp-inp narrow"> min</div>
              <p class="mp-hint">The last song plays to its end, so episodes run slightly long.</p>
            </div>
            <div>
              <label class="mp-lbl" for="mf-window">Don't repeat a song for</label>
              <div class="mp-row"><input id="mf-window" v-model.number="e.no_repeat_episodes" type="number" min="0" class="mp-inp narrow"> episodes</div>
              <p class="mp-hint">Counted in episodes of this channel, not days.</p>
            </div>
            <div>
              <span class="mp-lbl">Loudness</span>
              <div class="mp-row">
                <input v-model.number="e.loudness_lufs" type="number" step="0.5" class="mp-inp narrow" aria-label="Target LUFS"> LUFS
                <input v-model.number="e.true_peak_db" type="number" step="0.5" class="mp-inp narrow" aria-label="True peak dBTP"> dBTP
              </div>
              <p class="mp-hint">Evened per song when stitched. YouTube plays at about −14 LUFS.</p>
            </div>
          </div>

          <span class="mp-lbl" style="margin-top: 12px">Scenes</span>
          <div class="mp-row">
            <div class="mp-seg">
              <button v-for="m in sceneModes" :key="m.id" type="button" :class="{ on: e.scenes.mode === m.id }" @click="e.scenes.mode = m.id">{{ m.label }}</button>
            </div>
            <input v-if="e.scenes.mode === 'count'" v-model.number="e.scenes.count" type="number" min="1" class="mp-inp narrow" aria-label="Scenes per episode">
            <span v-if="e.scenes.mode === 'every-minutes'" class="mp-row"><input v-model.number="e.scenes.minutes" type="number" min="1" class="mp-inp narrow" aria-label="Minutes per scene"> min</span>
          </div>
          <p class="mp-hint">Scene changes always land on a song boundary.</p>

          <div class="mp-grid3" style="margin-top: 12px">
            <div>
              <span class="mp-lbl">Scene theme</span>
              <div class="mp-row">
                <span v-for="(t, i) in e.scene_themes" :key="t" class="mp-chip on">{{ t }} <button type="button" class="mp-x" :aria-label="`Remove ${t}`" @click="e.scene_themes.splice(i, 1)">×</button></span>
                <AddChip label="From worlds…" placeholder="A world or your own words" @add="v => addUnique(e.scene_themes, v)" />
              </div>
            </div>
            <div>
              <span class="mp-lbl">Scene change</span>
              <div class="mp-row">
                <input v-model="e.scene_change.transition" class="mp-inp" style="width: 110px" aria-label="Transition"> ·
                <input v-model.number="e.scene_change.seconds" type="number" min="0" step="0.5" class="mp-inp" style="width: 64px" aria-label="Seconds"> s
              </div>
              <p class="mp-hint">Any of Video Assembly's transitions.</p>
            </div>
            <div>
              <span class="mp-lbl">Joins between songs</span>
              <div class="mp-seg">
                <button v-for="j in joins" :key="j.id" type="button" :class="{ on: e.join.style === j.id }" @click="e.join.style = j.id">{{ j.label }}</button>
              </div>
              <div v-if="e.join.style !== 'butt'" class="mp-row" style="margin-top: 6px">
                <input v-model.number="e.join.seconds" type="number" min="0" step="0.5" class="mp-inp" style="width: 64px" aria-label="Join seconds"> s
              </div>
              <p class="mp-hint">Crossfade is the starting value; butt-join or a short silence also available.</p>
            </div>
          </div>

          <div class="mp-grid3" style="margin-top: 12px">
            <div>
              <span class="mp-lbl">Picture</span>
              <div class="mp-row">
                <div class="mp-seg">
                  <button type="button" :class="{ on: e.resolution === '720p' }" @click="e.resolution = '720p'">720p</button>
                  <button type="button" :class="{ on: e.resolution === '1080p' }" @click="e.resolution = '1080p'">Upscale to 1080p</button>
                </div>
                <input v-model.number="e.frame_rate" type="number" min="1" max="120" class="mp-inp" style="width: 64px" aria-label="Frames per second"> fps
              </div>
            </div>
            <div style="grid-column: span 2">
              <span class="mp-lbl">Starting effects look</span>
              <div class="mp-row">
                <span v-for="(x, i) in e.effects_look" :key="x" class="mp-chip">{{ x }} <button type="button" class="mp-x" :aria-label="`Remove ${x}`" @click="e.effects_look.splice(i, 1)">×</button></span>
                <button v-for="x in STACKS.filter(id => !e.effects_look.includes(id))" :key="x" type="button" class="mp-chip" @click="addUnique(e.effects_look, x)">+ {{ x.replace(/^stack-/, '').replace(/-/g, ' ') }}</button>
                <AddChip label="+ Saved Preset…" placeholder="Saved effect stack preset id" @add="v => addUnique(e.effects_look, v)" />
              </div>
              <p class="mp-hint">Effect stack presets from the Effects Library, laid over a new episode once; the episode's own edits always win.</p>
            </div>
          </div>
        </section>
      </div>

      <div style="display: flex; flex-direction: column; gap: 18px">
        <section class="card workspace-section mp-card">
          <h3>What this pool needs</h3>
          <p class="mp-hint">From your settings above.</p>
          <div class="mp-kpis" style="margin-top: 10px">
            <div class="mp-kpi"><span>Songs per episode</span><b>{{ perEpisode ? `≈ ${perEpisodeText}` : '—' }}</b></div>
            <div class="mp-kpi"><span>Needed for {{ e.no_repeat_episodes }}-episode window</span><b>{{ needed ?? '—' }}</b></div>
            <div class="mp-kpi" data-tone="warning"><span>In pool now</span><b>{{ pool?.stats?.songs ?? '—' }}</b></div>
            <div class="mp-kpi" data-tone="info"><span>Still to make</span><b>{{ stillToMake ?? '—' }}</b></div>
          </div>
          <div class="mp-meter" style="margin-top: 12px"><div :style="{ width: `${needPct}%` }" /></div>
          <p class="mp-hint">{{ needed ? `${pool?.stats?.songs ?? 0} of ${needed}. ` : 'Shown once the pool has measured songs. ' }}Building an episode never makes songs — this is only a reminder.</p>
          <div class="mp-btnhint" style="margin-top: 8px">
            <NuxtLink :to="`/projects/${slug}/song-pool${stillToMake ? `?generate=${stillToMake}` : ''}`" class="btn btn-primary" :class="{ disabled: dirty }">
              {{ stillToMake ? `Generate ${stillToMake} Songs…` : 'Open Song Pool' }}
            </NuxtLink>
            <span class="mp-hint">{{ dirty ? 'Save the formula first, so the songs use it.' : 'Opens the start dialog; you pick the writing model there.' }}</span>
          </div>
        </section>

        <section v-if="pool?.coverage" class="card workspace-section mp-card">
          <h3>Coverage of the pool</h3>
          <p class="mp-hint">Songs per mood × tempo. Empty cells get filled first.</p>
          <table class="mp-tbl" style="margin-top: 8px">
            <thead><tr><th></th><th v-for="c in pool.coverage.cols" :key="c" class="mp-num">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in pool.coverage.rows" :key="r">
                <td>{{ r }}</td>
                <td v-for="(n, j) in pool.coverage.grid[i]" :key="j" class="mp-num" :class="{ 'mp-warn': n === 0 }">{{ n }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="worlds.length" class="card workspace-section mp-card">
          <h3>Scene worlds</h3>
          <p class="mp-hint">From this formula's {{ worlds.length }} worlds — each song's scene idea is written in one of these.</p>
          <div class="mp-row" style="margin-top: 8px">
            <button v-for="w in shownWorlds" :key="w" type="button" class="mp-chip" :class="{ on: e.scene_themes.includes(w) }" @click="toggleTheme(w)">{{ w }}</button>
            <button v-if="worlds.length > shownWorlds.length" type="button" class="mp-chip" @click="allWorlds = true">+ {{ worlds.length - shownWorlds.length }} more</button>
          </div>
        </section>
      </div>
    </div>

    <Modal :visible="dupOpen" size="sm" labelledby="mf-dup-title" @close="dupOpen = false">
      <h2 id="mf-dup-title" style="margin: 0 0 6px">Duplicate As New Channel</h2>
      <p class="mp-hint">A copy of this whole formula under a new name, for a new channel. This project keeps its own.</p>
      <input v-model="dupName" class="mp-inp" style="width: 100%; margin-top: 10px" aria-label="New channel name" @keydown.enter="confirmDuplicate">
      <div class="mp-row" style="justify-content: flex-end; margin-top: 14px">
        <button type="button" class="btn btn-secondary" @click="dupOpen = false">Cancel</button>
        <button type="button" class="btn btn-primary" :disabled="!dupName.trim()" @click="confirmDuplicate">Create Copy</button>
      </div>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AddChip from '~/components/music/AddChip.vue'
import { BUILT_IN_EFFECT_STACKS } from '@shared/scene-effect-presets'
import { ALL_KEYS, STARTING_EPISODE_DEFAULTS, STARTING_SONG_FORMULA, comboCount, poolNeeds } from '../../../../electron/server/contracts/song-formula'

definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })
useAppTitle('Music Formula')
const route = useRoute()
const slug = computed(() => String(route.params.slug || ''))
const { get, post, patch } = useApi()
const { success, error: showError } = useToast()

const niche = ref<any>(null)
const pool = ref<any>(null)
const loaded = ref(false)
const loadError = ref('')
const busy = ref(false)
const saved = ref(false)
const pickingKeys = ref(false)
const allWorlds = ref(false)
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
// The Effects Library's built-in stack presets (feat/music-effects, INTERFACES.md 2026-10-03).
// The built-in effect stacks come from the Effects Library, so this list can't drift from it.
const STACKS = BUILT_IN_EFFECT_STACKS.map(stack => stack.id)
const f = reactive<any>(clone(STARTING_SONG_FORMULA))
const e = reactive<any>(clone(STARTING_EPISODE_DEFAULTS))
let snapshot = ''

const weightedAxes = [
  { key: 'ensembles', label: 'Ensemble', hint: 'Songs are instrumental.' },
  { key: 'moods', label: 'Mood' },
  { key: 'textures', label: 'Texture / production' },
  { key: 'structures', label: 'Structure' },
]
const sceneModes = [{ id: 'per-song', label: 'One per song' }, { id: 'count', label: 'Fixed count' }, { id: 'every-minutes', label: 'Every N minutes' }, { id: 'manual', label: 'Manual' }]
const joins = [{ id: 'crossfade', label: 'Crossfade' }, { id: 'butt', label: 'Butt-join' }, { id: 'silence', label: 'Short silence' }]

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const parseClock = (t: string) => { const m = /^\s*(\d+):(\d{1,2})\s*$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN }
const minText = ref('3:00')
const maxText = ref('4:30')
const targetMin = computed({ get: () => Math.round(e.target_length_s / 60), set: (v: number) => { e.target_length_s = Math.round(Number(v) * 60) } })
const sharePct = computed({ get: () => Math.round(f.variety.max_title_word_share * 1000) / 10, set: (v: number) => { f.variety.max_title_word_share = Number(v) / 100 } })
const simPct = computed({ get: () => Math.round(f.variety.max_similarity * 100), set: (v: number) => { f.variety.max_similarity = Number(v) / 100 } })

const state = () => JSON.stringify({ f, e, minText: minText.value, maxText: maxText.value })
const dirty = computed(() => !!snapshot && state() !== snapshot)
const invalid = computed(() => {
  const a = parseClock(minText.value); const b = parseClock(maxText.value)
  if (!(a > 0 && b > 0)) return 'Write song lengths as m:ss, for example 3:00.'
  if (a > b) return 'The shortest song must not be longer than the longest.'
  for (const ax of weightedAxes) if (!f[ax.key].some((v: any) => v.weight > 0)) return `${ax.label} needs at least one value with a weight above 0.`
  if (!f.tempo_bands.some((b: any) => b.weight > 0)) return 'Add at least one tempo band with a weight above 0.'
  if (f.tempo_bands.some((b: any) => !(b.min_bpm <= b.max_bpm))) return 'A tempo band must not start above where it ends.'
  return ''
})
const combos = computed(() => { try { return comboCount(f) } catch { return 0 } })
const keyMode = computed(() => !f.keys.length ? 'all'
  : f.keys.length === 12 && f.keys.every((k: string) => k.endsWith('minor')) ? 'minor'
  : f.keys.length === 12 && f.keys.every((k: string) => k.endsWith('major')) ? 'major' : 'pick')
const keyOn = (k: string) => !f.keys.length || f.keys.includes(k)
function setKeys(mode: 'all' | 'minor' | 'major') { pickingKeys.value = false; f.keys = mode === 'all' ? [] : ALL_KEYS.filter(k => k.endsWith(mode)) }
function toggleKey(k: string) {
  const cur = f.keys.length ? [...f.keys] : [...ALL_KEYS]
  const next = cur.includes(k) ? cur.filter((x: string) => x !== k) : [...cur, k]
  f.keys = next.length === 24 ? [] : ALL_KEYS.filter(x => next.includes(x))
}

const worlds = computed<string[]>(() => {
  const mf = niche.value?.musicFormat || {}
  return Array.isArray(mf.worlds) && mf.worlds.length ? mf.worlds.map((w: any) => w.name).filter(Boolean)
    : Object.values(mf.registers || {}).map((r: any) => r.label).filter(Boolean)
})
const shownWorlds = computed(() => (allWorlds.value ? worlds.value : worlds.value.slice(0, 4)))
function toggleTheme(w: string) { const i = e.scene_themes.indexOf(w); i >= 0 ? e.scene_themes.splice(i, 1) : e.scene_themes.push(w) }

const avgSong = computed(() => pool.value?.stats?.average_song_s || (parseClock(minText.value) + parseClock(maxText.value)) / 2 || 0)
const perEpisode = computed(() => (avgSong.value ? poolNeeds(e.target_length_s, e.no_repeat_episodes, avgSong.value).per_episode : 0))
const perEpisodeText = computed(() => { const lo = Math.floor(perEpisode.value); return lo === Math.ceil(perEpisode.value) ? String(lo) : `${lo}–${lo + 1}` })
const needed = computed(() => (avgSong.value ? poolNeeds(e.target_length_s, e.no_repeat_episodes, avgSong.value).needed : null))
const stillToMake = computed(() => (needed.value === null || !pool.value ? null : Math.max(0, needed.value - (pool.value.stats?.songs || 0))))
const needPct = computed(() => (needed.value ? Math.min(100, Math.round(((pool.value?.stats?.songs || 0) / needed.value) * 100)) : 0))
const thinnest = computed(() => {
  const c = pool.value?.coverage
  if (!c || !(pool.value?.stats?.songs > 0)) return ''
  const rowSum = c.rows.map((r: string, i: number) => [r, c.grid[i].reduce((a: number, b: number) => a + b, 0)] as const).sort((a: any, b: any) => a[1] - b[1])[0]
  const colSum = c.cols.map((col: string, j: number) => [col, c.grid.reduce((a: number, row: number[]) => a + row[j], 0)] as const).sort((a: any, b: any) => a[1] - b[1])[0]
  return `${rowSum[0]} and ${colSum[0]}`
})

function addWeighted(key: string, v: string) {
  if (!f[key].some((x: any) => x.value.toLowerCase() === v.toLowerCase())) f[key].push({ value: v, weight: 1 })
}
function addUnique(list: string[], v: string) { if (!list.includes(v)) list.push(v) }
function addBand() { f.tempo_bands.push({ id: `band-${Date.now().toString(36)}`, label: 'New', min_bpm: 70, max_bpm: 84, weight: 1 }) }

async function load() {
  loadError.value = ''
  try {
    const r = await get<{ niche: any }>(`/projects/${slug.value}/effective-niche`)
    niche.value = r.niche?.musicFormat ? r.niche : null
    const mf = niche.value?.musicFormat || {}
    Object.assign(f, clone(mf.songFormula || STARTING_SONG_FORMULA))
    Object.assign(e, clone({ ...STARTING_EPISODE_DEFAULTS, ...(mf.episodeDefaults || {}) }))
    saved.value = !!mf.songFormula
    minText.value = clock(f.length_s.min); maxText.value = clock(f.length_s.max)
    if (niche.value) pool.value = await get(`/projects/${slug.value}/song-pool`).catch(() => null)
    snapshot = saved.value ? state() : 'unsaved'
  } catch (err: any) { loadError.value = err?.data?.detail || 'Could not load the formula.' }
  finally { loaded.value = true }
}

async function save() {
  busy.value = true
  try {
    f.length_s = { min: parseClock(minText.value), max: parseClock(maxText.value) }
    const r = await patch<{ niche: any }>(`/niches/${encodeURIComponent(niche.value.id)}/music-format?project_slug=${encodeURIComponent(slug.value)}`, { songFormula: f, episodeDefaults: e })
    niche.value = r.niche; saved.value = true; snapshot = state()
    pool.value = await get(`/projects/${slug.value}/song-pool`).catch(() => pool.value)
    success('Formula saved. New songs and episodes use it from now on.')
  } catch (err: any) { showError(err?.data?.detail || 'Could not save the formula') }
  finally { busy.value = false }
}

const dupName = ref('')
const dupOpen = ref(false)
function duplicate() { dupName.value = `${niche.value.name} copy`; dupOpen.value = true }
async function confirmDuplicate() {
  const name = dupName.value.trim()
  if (!name) return
  dupOpen.value = false
  busy.value = true
  try {
    await post(`/niches/${encodeURIComponent(niche.value.id)}/duplicate-music-channel`, { name })
    success(`Created "${name}". Pick it for a new project in Channel Identity.`)
  } catch (err: any) { showError(err?.data?.detail || 'Could not duplicate the formula') }
  finally { busy.value = false }
}

watch(slug, () => { void load() })
onMounted(load)
</script>

<style src="~/assets/css/music-pool.css"></style>
<style scoped>
.mp-check { display: flex; align-items: center; gap: 8px; font-size: 14px; margin-top: 12px; flex-wrap: wrap; }
.mp-indent { margin-left: 24px; }
.mp-grid2b { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 14px; }
.mp-chip .mp-band-name { width: 64px; color: var(--text-primary); font-weight: 400; }
.mp-x { border: 0; background: none; color: var(--text-muted); cursor: pointer; font: inherit; }
.btn.disabled { pointer-events: none; opacity: .6; }
</style>
