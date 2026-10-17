import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const settings = read('../pages/projects/[slug]/settings.vue')
const serverMode = read('../components/ServerModeSettingsPanel.vue')
/** Template text outside any <details> block — what the owner reads without clicking. */
const visible = (source: string) => source.split('<script')[0]!.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<!--[\s\S]*?-->/g, '')

test('Settings advanced panels speak plain English; the technical wording sits in a collapsed Details', () => {
  for (const [name, source] of [['settings', settings], ['server mode', serverMode]] as const) {
    const text = visible(source)
    for (const jargon of [/subject lanes?/i, /SHA-256/, /aggregate credit ceiling/, /Session TTL/, /Polls <code>/, /binds <code>/]) {
      assert.doesNotMatch(text, jargon, `${name}: ${jargon} is visible without opening Details`)
    }
  }
  assert.match(settings, /<details[^>]*class="settings-tech-details disclosure">\s*<summary>Details<\/summary>[\s\S]*?aggregate credit ceiling/)
  // The per-channel "verify clears SHA-256" Details was deliberately removed with the
  // duplicated per-channel cleanup tools (1.4.317 two-button cleanup). No product panel
  // promises that comparison any more, so this clause is retired rather than the panel restored.
  assert.match(serverMode, /<details class="ssm-details disclosure">\s*<summary>Details — port and network address<\/summary>/)
})
