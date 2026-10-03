import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const settings = read('../pages/projects/[slug]/settings.vue')
const serverMode = read('../components/ServerModeSettingsPanel.vue')
const topicPicker = read('../components/TopicPackPicker.vue')
/** Template text outside any <details> block — what the owner reads without clicking. */
const visible = (source: string) => source.split('<script')[0]!.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<!--[\s\S]*?-->/g, '')

test('Settings advanced panels speak plain English; the technical wording sits in a collapsed Details', () => {
  for (const [name, source] of [['settings', settings], ['server mode', serverMode], ['topic picker', topicPicker]] as const) {
    const text = visible(source)
    for (const jargon of [/subject lanes?/i, /SHA-256/, /aggregate credit ceiling/, /Session TTL/, /Polls <code>/, /binds <code>/]) {
      assert.doesNotMatch(text, jargon, `${name}: ${jargon} is visible without opening Details`)
    }
  }
  assert.match(settings, /<details[^>]*class="settings-tech-details">\s*<summary>Details<\/summary>[\s\S]*?aggregate credit ceiling/)
  assert.match(settings, /<details class="settings-tech-details">\s*<summary>Details<\/summary>[\s\S]*?SHA-256 is compared/)
  assert.match(serverMode, /<details class="ssm-details">\s*<summary>Details — port and network address<\/summary>/)
})
