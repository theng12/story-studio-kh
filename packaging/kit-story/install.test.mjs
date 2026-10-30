import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./Install Story Studio.command', import.meta.url))
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-kit-test-'))
  const kit = path.join(root, 'kit')
  const source = path.join(root, 'source.app')
  fs.mkdirSync(path.join(source, 'Contents'), { recursive: true })
  fs.mkdirSync(kit)
  fs.writeFileSync(path.join(source, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>')
  fs.copyFileSync(script, path.join(kit, 'Install Story Studio.command'))
  const pgrep = path.join(root, 'pgrep')
  fs.writeFileSync(pgrep, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const env = { ...process.env, STORY_STUDIO_INSTALL_TARGET: path.join(root, 'apps/Story Studio KH.app'), STORY_STUDIO_INSTALL_TRASH: path.join(root, 'trash'), STORY_STUDIO_DATA_DIR: path.join(root, 'data'), STORY_STUDIO_INSTALL_SOURCE: source, STORY_STUDIO_INSTALL_PGREP: pgrep, TMPDIR: root }
  const run = () => spawnSync('/bin/bash', [path.join(kit, 'Install Story Studio.command')], { env, encoding: 'utf8' })
  return { root, kit, env, run, pgrep }
}
function model(f, content = 'model bytes') {
  const relative = 'embedding-models/revision/onnx/model.onnx'
  const modelRoot = path.join(f.kit, 'EmbeddingGemma')
  const source = path.join(modelRoot, relative)
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, content)
  const hash = createHash('sha256').update('model bytes').digest('hex')
  fs.writeFileSync(path.join(modelRoot, 'SHA256SUMS'), `${hash}  ${relative}\n`)
  fs.writeFileSync(path.join(modelRoot, 'FILECOUNT'), '1\n')
  return { source, destination: path.join(f.env.STORY_STUDIO_DATA_DIR, relative) }
}
test('refuses a running app', () => {
  const f = fixture(); fs.writeFileSync(f.pgrep, '#!/bin/sh\nexit 0\n')
  const r = f.run(); assert.equal(r.status, 1); assert.match(r.stderr, /running/); assert.equal(fs.existsSync(f.env.STORY_STUDIO_INSTALL_TARGET), false)
})
test('installs the app and verified model', () => {
  const f = fixture(); const m = model(f); const r = f.run()
  assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(m.destination, 'utf8'), 'model bytes'); assert.match(r.stdout, /1 copied/)
})
test('names a corrupt file and keeps the installed app', () => {
  const f = fixture(); model(f, 'corrupt'); const r = f.run()
  assert.equal(r.status, 1); assert.match(r.stderr, /model\.onnx/); assert.ok(fs.existsSync(f.env.STORY_STUDIO_INSTALL_TARGET))
})
test('skips a model file already correct', () => {
  const f = fixture(); const m = model(f); fs.mkdirSync(path.dirname(m.destination), { recursive: true }); fs.writeFileSync(m.destination, 'model bytes'); fs.writeFileSync(m.source, 'corrupt')
  const r = f.run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 already correct/)
})
test('continues without a kit model', () => {
  const f = fixture(); const r = f.run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /download/)
})
test('reports a missing kit model file', () => {
  const f = fixture(); const m = model(f); fs.renameSync(m.source, `${m.source}.moved`)
  const r = f.run(); assert.equal(r.status, 1); assert.match(r.stderr, /missing: .*model\.onnx/); assert.ok(fs.existsSync(f.env.STORY_STUDIO_INSTALL_TARGET))
})
test('refuses an incomplete hash list', () => {
  const f = fixture(); model(f); fs.writeFileSync(path.join(f.kit, 'EmbeddingGemma/FILECOUNT'), '2\n')
  const r = f.run(); assert.equal(r.status, 1); assert.match(r.stderr, /expected 2/)
})
test('preserves the old app when replacing it', () => {
  const f = fixture(); assert.equal(f.run().status, 0); const r = f.run(); assert.equal(r.status, 0, r.stderr); assert.ok(fs.existsSync(path.join(f.env.STORY_STUDIO_INSTALL_TRASH, 'Story Studio KH 1.2.3.app')))
})
