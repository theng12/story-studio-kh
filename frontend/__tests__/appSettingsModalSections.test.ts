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

    modal.open('connections')
    assert.equal(modal.section.value, 'connections')
    modal.close()

    assert.match(modalSource, /performance: 'Settings — Performance & recovery'/)
    assert.match(modalSource, /appearance: 'Settings — Appearance & app behavior'/)
  })
})
