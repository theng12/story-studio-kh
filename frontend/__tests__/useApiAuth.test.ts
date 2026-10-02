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
        detail: 'The active Gateway key was not accepted for required content:read access.',
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
        detail: 'The active Gateway key was not accepted for required content:read access.',
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

describe('useApi when Story Studio’s own engine does not answer', () => {
  test('a request with no response says the engine is not answering, not "<no response> Failed to fetch"', async () => {
    const { NO_RESPONSE_MESSAGE } = await import('../composables/useApi.js')
    ;(globalThis as any).$fetch = async () => {
      const error: any = new Error('[GET] "/api/projects/a": <no response> Failed to fetch', { cause: new TypeError('Failed to fetch') })
      error.name = 'FetchError'
      throw error
    }
    await assert.rejects(useApi().get('/projects/a'), (error: any) => {
      assert.equal(error.message, NO_RESPONSE_MESSAGE)
      assert.doesNotMatch(error.message, /no response|Failed to fetch/)
      return true
    })
  })

  test('a deliberate abort and a real HTTP answer keep their own text', async () => {
    ;(globalThis as any).$fetch = async () => {
      const abort = new Error('This operation was aborted'); abort.name = 'AbortError'
      const error: any = new Error('[GET] "/api/x": <no response> This operation was aborted', { cause: abort })
      error.name = 'FetchError'
      throw error
    }
    await assert.rejects(useApi().get('/x'), /aborted/)
    ;(globalThis as any).$fetch = async () => {
      const error: any = new Error('[GET] "/api/x": 404 Not Found')
      error.name = 'FetchError'; error.response = { status: 404 }; error.data = { detail: 'Project not found' }
      throw error
    }
    await assert.rejects(useApi().get('/x'), /404 Not Found/)
  })

  test('a humanized error shows its hint where the message is shown', async () => {
    ;(globalThis as any).$fetch = async () => {
      const error: any = new Error('[POST] "/api/x": 503 Service Unavailable')
      error.name = 'FetchError'; error.response = { status: 503 }
      error.data = { detail: 'Could not reach the Gateway — is the Gateway app running?', hint: 'Open the Gateway app, then try again.' }
      throw error
    }
    await assert.rejects(useApi().post('/x', {}), (error: any) => {
      assert.equal(error.data.detail, 'Could not reach the Gateway — is the Gateway app running? Open the Gateway app, then try again.')
      return true
    })
  })
})
