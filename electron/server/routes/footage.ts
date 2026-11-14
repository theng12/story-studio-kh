/**
 * Footage client routes (1.4.402). Story is the client: the Gateway owns the
 * catalogue and store, this Mac keeps a copy of the clips it uses under the
 * configured `footage_root`.
 *
 *   GET  /projects/:slug/footage/search?q=&tag=   the Gateway catalogue + library + sources
 *   POST /projects/:slug/footage/resolve          { sha256, row? } local first, fetch on miss
 *   GET  /app-settings/footage-root               the configured root
 *   PUT  /app-settings/footage-root               { path } (a browse-picked path)
 */
import { Router } from 'express'
import { getFootageRoot, setFootageRoot } from '../services/app-settings.js'
import { fetchFootage, resolveFootage } from '../services/footage-library.js'
import { searchFootage } from '../lib/footage-client.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

const SHA256 = /^[0-9a-f]{64}$/

function handle(fn: (req: any) => Promise<unknown>) {
  return async (req: any, res: any) => {
    try {
      res.json(await fn(req))
    } catch (error: any) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
      res.status(status).json(humanizeBackendError(error, 'The footage request failed'))
    }
  }
}

router.get('/projects/:slug/footage/search', handle(async (req) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : ''
  if (!query && !tag) return { results: [], library: [], sources: [], note: 'Type a word or pick a tag to search the footage library.' }
  return searchFootage(query, tag)
}))

router.post('/projects/:slug/footage/resolve', handle(async (req) => {
  const sha256 = typeof req.body?.sha256 === 'string' ? req.body.sha256.trim().toLowerCase() : ''
  if (!SHA256.test(sha256)) throw Object.assign(new Error('The footage pick has no valid clip identifier.'), { statusCode: 400 })
  const local = await resolveFootage(sha256)
  if (local) return { path: local, sha256, local: true }
  const row = req.body?.row && typeof req.body.row === 'object' ? req.body.row : undefined
  const fetched = await fetchFootage(sha256, row)
  return { path: fetched, sha256, local: false }
}))

router.get('/app-settings/footage-root', handle(async () => ({ path: await getFootageRoot() })))

router.put('/app-settings/footage-root', handle(async (req) => {
  const value = typeof req.body?.path === 'string' ? req.body.path : ''
  await setFootageRoot(value)
  return { path: await getFootageRoot() }
}))
