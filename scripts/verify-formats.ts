/**
 * Smoke test: load every format JSON via the loader, confirm schema validates
 * and the default narrator-style id resolves. Run after authoring new formats.
 */
import { listFormats } from '../electron/server/services/format-loader.js'

const all = await listFormats()
console.log(`Loaded ${all.length} formats:`)
for (const f of all) {
  console.log(
    `  ${f.id.padEnd(18)} — ${f.name.padEnd(22)} | ` +
    `${f.script.narratorStyles.length} narrators, ` +
    `${f.script.defaultChapterCount} default chapters, ` +
    `${f.imagePrompts.defaultScenesTotalRange.join('-')} scenes, ` +
    `${f.metadata.broadKeywords.length} broad keywords`,
  )
}
for (const f of all) {
  const ns = f.script.narratorStyles.find(s => s.id === f.script.defaultNarratorStyleId)
  if (!ns) throw new Error(`${f.id}: defaultNarratorStyleId '${f.script.defaultNarratorStyleId}' not found`)
}
console.log('\nAll formats valid. Default narrator-style ids resolve. ✓')
