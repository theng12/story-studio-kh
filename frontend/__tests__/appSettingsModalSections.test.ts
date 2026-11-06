import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { useAppSettingsModal } from '../composables/useAppSettingsModal.js'

const modalSource = readFileSync(new URL('../components/AppSettingsModal.vue', import.meta.url), 'utf8')

describe('App Settings modal sections', () => {
  test('defaults to the complete modal and can open directly to connections', () => {
    const modal = useAppSettingsModal()
    modal.open()
    assert.equal(modal.section.value, 'all')
    modal.close()

    for (const section of ['connections', 'default-models', 'files', 'backup', 'appearance', 'performance'] as const) {
      modal.open(section)
      assert.equal(modal.section.value, section)
      modal.close()
    }

    assert.match(modalSource, /performance: 'Settings — Performance & recovery'/)
    assert.match(modalSource, /appearance: 'Settings — Appearance & app behavior'/)
  })
})
