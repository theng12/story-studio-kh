/**
 * Shell picture + layout note in the thumbnail-template editor.
 *
 * Source-level pins, the repo's usual style: what the editor is wired to.
 * Cannot catch: layout, whether the buttons are reachable, or an analysis
 * failing at the Gateway — a screenshot and a live run are the proof there.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const editor = readFileSync(
  fileURLToPath(new URL('../components/ThumbnailTemplateEditor.vue', import.meta.url)),
  'utf8',
)

test('the Shell picture is previewed through preview.png, never a raw shellImage URL', () => {
  assert.match(editor, /\/preview\.png\?k=\$\{previewKey\.value\}/)
  // shellImage is a managed relative path — no img may ever point at it.
  assert.doesNotMatch(editor, /:src="[^"]*shellImage/)
  assert.doesNotMatch(editor, /src="[^"]*\$\{[^}]*shellImage/)
  assert.match(editor, /:src="canvasBgSrc"/)
  // Text-only template: the picture slot says so instead of faking a preview.
  assert.match(editor, /data-testid="tte-shell-pending"/)
  assert.match(editor, />Preview pending</)
  assert.match(editor, /Shell image unavailable/)
})

test('adding or replacing a picture goes through the live model list and analyses once', () => {
  assert.match(editor, /\/thumbnail-templates\/vision\/models/)
  assert.match(editor, /\/thumbnail-templates\/\$\{encodeURIComponent\(id\)\}\/analyze/)
  assert.match(editor, /source_path: picked\.path/)
  // Existing picker (native dialog, in-app browser when served remotely) —
  // the customer never types a path.
  assert.match(editor, /post<\{ path: string \| null \}>\('\/system\/pick-file'/)
  // A brand-new template is saved through the existing POST before analysis.
  assert.match(editor, /await ensureSavedId\(\)/)
  assert.match(editor, /isNew\.value && !savedId\.value/)
  // Analysis writes the library template only — never a channel's reference.
  assert.doesNotMatch(editor, /thumbnail_reference_asset/)
  assert.doesNotMatch(editor, /thumbnail-reference\/analyze/)
})

test('the layout note is editable, bounded, and required alongside a picture', () => {
  assert.match(editor, /v-model="workingTemplate\.layoutNote"/)
  assert.match(editor, /maxlength="4000"/)
  assert.match(editor, /layoutNote: ''/)
  assert.match(editor, /A Shell picture needs a layout note/)
  // Editing the note alone must never trigger an analysis.
  assert.doesNotMatch(editor, /@input="[^"]*analy/i)
  assert.match(editor, /editing it never re-runs the analysis/)
})
