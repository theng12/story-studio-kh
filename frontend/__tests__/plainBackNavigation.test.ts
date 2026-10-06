/**
 * Sidebar-less pages (GenStudio credits, Remote) get a top-left Back that
 * returns to where the owner came from, plus Escape / ⌘[ (1.4.257). The old
 * credits page hid "← Back to Projects" among the right-hand buttons and it
 * always went to `/`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { wantsBack } from '../utils/plain-back.ts'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function key(init: KeyboardEventInit, target?: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (target) Object.defineProperty(event, 'target', { value: target })
  return event
}

test('Escape and ⌘[ go back; typing and dialogs keep Escape', () => {
  document.body.innerHTML = '<input id="field"><div id="page"></div>'
  const page = document.getElementById('page')!
  assert.equal(wantsBack(key({ key: 'Escape' }, page)), true)
  assert.equal(wantsBack(key({ key: '[', metaKey: true }, page)), true)
  assert.equal(wantsBack(key({ key: '[' }, page)), false, 'a plain [ is just a character')
  assert.equal(wantsBack(key({ key: 'Escape' }, document.getElementById('field')!)), false, 'Escape in a field stays with the field')
  assert.equal(wantsBack(key({ key: '[', metaKey: true }, document.getElementById('field')!)), true, '⌘[ still goes back from a field')
  const taken = key({ key: 'Escape' }, page)
  taken.preventDefault()
  assert.equal(wantsBack(taken), false, 'a handler that took the key wins')
  document.body.innerHTML = '<div role="dialog"></div>'
  assert.equal(wantsBack(key({ key: 'Escape' }, document.body)), false, 'an open dialog owns Escape')
})

test('the back link goes back in history, else home, and sits top-left on plain pages', () => {
  const link = source('../components/PlainBackLink.vue')
  assert.match(link, /window\.history\.state\?\.back\) router\.back\(\)/)
  assert.match(link, /else void router\.push\(props\.fallback\)/)
  assert.match(source('../pages/usage.vue'), /<header class="usage-header">\s*<div>\s*<PlainBackLink \/>/)
  assert.match(source('../pages/remote.vue'), /<header class="rm-head">\s*<PlainBackLink \/>/)
  assert.match(source('../layouts/default.vue'), /<NuxtLink to="\/" class="top-bar-brand">Story Studio KH<\/NuxtLink>/)
})
