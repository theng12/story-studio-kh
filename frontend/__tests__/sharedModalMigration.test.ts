/**
 * Every in-app dialog goes through the shared <Modal> (Escape, focus trap,
 * role="dialog", backdrop). The B-Roll, Ideas, Scripts, Settings, Audio Mix,
 * Video Assembly, Channel Characters and file-browser dialogs used to be
 * hand-rolled overlays: no Escape, no focus trap, and some (Audio Mix, Video
 * Assembly pickers) had no overlay styles at all. Dialogs where the owner
 * types never close on a stray backdrop click.
 *
 * Deliberate exceptions, not matched below: the full-screen image lightboxes
 * (ImagePreviewLightbox, ProjectStyleLibrary, Scene Review) own arrow-key
 * navigation, and NotificationCenter is a popover panel.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const template = (path: string) => { const s = read(path); return s.slice(0, s.indexOf('<script')) }

function vueFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? vueFiles(join(dir, entry.name)) : entry.name.endsWith('.vue') ? [join(dir, entry.name)] : [])
}

/** The opening `<Modal …>` tag whose `:visible` is exactly `visible`. */
function modalTag(path: string, visible: string): string {
  const tag = template(path).match(new RegExp(`<Modal\\b[^>]*:visible="${visible.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`))
  assert.ok(tag, `${path} should open ${visible} through <Modal>`)
  return tag[0]
}

test('no hand-rolled modal overlays remain outside Modal.vue', () => {
  for (const file of ['pages', 'components', 'layouts'].flatMap(vueFiles)) {
    if (file.endsWith(join('components', 'Modal.vue'))) continue
    assert.doesNotMatch(template(file), /class="[^"]*\b(modal-overlay|fbm-overlay|[\w-]+-backdrop)\b/, file)
  }
})

const typingDialogs: Array<[string, string]> = [
  ['pages/broll-library.vue', 'createModalOpen'],
  ['pages/broll-library.vue', 'editModalOpen'],
  ['pages/broll-library.vue', 'renameOneOpen'],
  ['pages/broll-library.vue', 'bulkRenameOpen'],
  ['pages/projects/[slug]/scripts.vue', 'showSaveStyle'],
  ['pages/projects/[slug]/settings.vue', 'showSavePreset'],
  ['pages/projects/[slug]/ideas.vue', 'importOpen'],
  ['pages/projects/[slug]/ideas.vue', 'pasteOpen'],
  ['pages/projects/[slug]/ideas.vue', 'editorOpen'],
  ['pages/character-library.vue', 'editorOpen'],
]

test('dialogs where the owner types do not close on a stray backdrop click', () => {
  for (const [file, visible] of typingDialogs) {
    assert.match(modalTag(file, visible), /:close-on-backdrop="false"/, `${file} ${visible}`)
  }
})

test('multi-field editors close on Escape only while nothing has been typed', () => {
  for (const [file, visible] of typingDialogs.filter(([, v]) => ['createModalOpen', 'editModalOpen', 'importOpen', 'pasteOpen', 'editorOpen'].includes(v))) {
    assert.match(modalTag(file, visible), /:close-on-escape="[^"]+"/, `${file} ${visible}`)
  }
})

test('pickers and previews use <Modal> too', () => {
  modalTag('pages/projects/[slug]/video-assembly.vue', 'showBackgroundPicker')
  modalTag('pages/projects/[slug]/video-assembly.vue', "showOverlayPickerForLayer === '__add__'")
  modalTag('pages/projects/[slug]/audio-merge.vue', 'showAmbientPicker')
  modalTag('pages/projects/[slug]/settings.vue', 'reseasonState.open')
  modalTag('pages/projects/[slug]/ideas.vue', 'compactState.open')
  // The file browser opens from inside other dialogs (Browse… in a form).
  assert.match(modalTag('components/FileBrowserModal.vue', 'picker.isOpen'), /:z-index="2100"/)
})

test('Content Store goes back through PlainBackLink and leaves Escape to its dialogs', () => {
  const store = read('pages/content-store.vue')
  const product = read('pages/content-store/[productId].vue')
  assert.match(store, /<PlainBackLink label="Back to Channels" fallback="\/" \/>/)
  assert.equal(product.match(/<PlainBackLink label="Back to Content Store" fallback="\/content-store" \/>/g)?.length, 2)
  for (const page of [store, product]) {
    assert.doesNotMatch(page, /<NuxtLink[^>]*>Back to/)
    assert.doesNotMatch(page, /'Escape'/)
  }
  for (const dialog of ['ContentPurchaseDialog.vue', 'ContentBatchPurchaseDialog.vue']) {
    assert.match(read(`components/content-store/${dialog}`), /<Modal[\s\S]*?@close="requestClose"/)
  }
})
