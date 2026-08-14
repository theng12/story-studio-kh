import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

const { useApi } = await import('../composables/useApi.js')

beforeEach(() => {
  window.location.href = 'http://127.0.0.1/content-store'
})

describe('useApi authentication boundary', () => {
  test('keeps a desktop Content Store scope refusal on the Content Store page', async () => {
    ;(globalThis as any).$fetch = async () => {
      const error: any = new Error('The active key needs content:read')
      error.status = 401
      error.data = {
        code: 'CONTENT_STORE_SCOPE_REQUIRED',
        detail: 'The active GenStudio key was not accepted for required content:read access.',
      }
      throw error
    }

    await assert.rejects(useApi().get('/content-store'))

    assert.equal(window.location.pathname, '/content-store')
  })

  test('keeps a remote Content Store scope refusal on the Content Store page', async () => {
    window.location.href = 'https://story.example/content-store'
    ;(globalThis as any).$fetch = async () => {
      const error: any = new Error('The active key needs content:read')
      error.status = 401
      error.data = {
        code: 'CONTENT_STORE_SCOPE_REQUIRED',
        detail: 'The active GenStudio key was not accepted for required content:read access.',
      }
      throw error
    }

    await assert.rejects(useApi().get('/content-store'))

    assert.equal(window.location.pathname, '/content-store')
  })

  test('still sends an unauthenticated remote Story session to login', async () => {
    window.location.href = 'https://story.example/projects/example'
    ;(globalThis as any).$fetch = async () => {
      const error: any = new Error('Authentication required')
      error.status = 401
      error.data = { detail: 'Authentication required' }
      throw error
    }

    await assert.rejects(useApi().get('/projects/example'))

    assert.equal(window.location.pathname, '/login')
  })
})
