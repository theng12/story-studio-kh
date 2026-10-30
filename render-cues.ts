import { buildContextualCueDrawtextFilters } from './electron/server/lib/contextual-cue-filters.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const ff = '/build/Library/Application Support/StudioHub Standalone/hub/trash/2026-10-26/previous-app-24AEAD10/Studio Hub.app/Contents/Resources/render-tools/ffmpeg'
const root = '/build/Developer/_orchestra/explainer-style-20261030'
const out = join(root, 'labels')
mkdirSync(out, { recursive: true })
const images = ['1-hero', '2-quiet-b', '3-hard-b']
const templates = ['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate'] as const
function run(args: string[]) { execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }) }
for (const image of images) for (const template of templates) {
  const cue = { id:'sample', scene_id:'1', start_sec:0.5, end_sec:3.5, title:'Amazon Basin, Brazil', subtitle:'The world’s largest tropical rainforest', kind:'location_date' as const, placement:'top-left' as const, template, entrance:'fade' as const, exit:'fade' as const, status:'approved' as const, created_at:'', updated_at:'' }
  const filters = buildContextualCueDrawtextFilters(cue).join(',')
  const mp4 = join(out, `${image}-${template}.mp4`)
  run(['-loop','1','-framerate','25','-i',join(root,`${image}.png`),'-t','4','-vf',`scale=1280:720,${filters}`,'-c:v','libx264','-pix_fmt','yuv420p',mp4])
  run(['-ss','2','-i',mp4,'-frames:v','1',join(out,`${image}-${template}.png`)])
  console.log(`${image} ${template} complete`)
}
const inputs = images.flatMap(image => templates.flatMap(template => ['-i',join(out,`${image}-${template}.png`)]))
const graph = images.flatMap((image, i) => templates.map((template,j) => `[${i*4+j}:v]scale=320:180[v${i*4+j}]`)).join(';') + ';' + Array.from({length:12},(_,i)=>`[v${i}]`).join('') + 'xstack=inputs=12:layout=' + Array.from({length:12},(_,i)=>`${i%4*320}_${Math.floor(i/4)*180}`).join('|')
run([...inputs,'-filter_complex',graph,'-frames:v','1',join(out,'contact-sheet.png')])
