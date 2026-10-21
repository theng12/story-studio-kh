import type { Request, Response } from 'express'

import type { ContentPackRegistryOptions } from '../content-packs/registry.js'

/** The same 50 MiB ceiling applies to a chosen `.sspack` and a Gateway download. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

export function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function routeOptions(req: Request): ContentPackRegistryOptions {
  return req.app.locals.contentPackOptions ?? {}
}

// Local-storage failures are the server's problem, not the archive's. Only the
// code is inspected; no filesystem path or raw message is ever returned.
const IMPORT_STORAGE_EXHAUSTED_CODES = new Set(['ENOSPC', 'EDQUOT'])
const IMPORT_STORAGE_UNAVAILABLE_CODES = new Set([
  'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN', 'ENOTDIR', 'ELOOP',
])
// A valid package that conflicts with local state, rather than a damaged archive.
const IMPORT_CONFLICT_MESSAGE = /Content Pack version is immutable|Content Pack version is pending removal|recalled Content Pack version|Content Pack immutable orphan conflicts with candidate/i
// Refusals that name only the pack, version and required app version.
const IMPORT_VERIFICATION_MESSAGE = /requires Story Studio \d+\.\d+\.\d+ or newer|Content Pack dependency (?:is not installed exactly|cycle)|Content Pack immutable archive identity does not match state|Content Pack signed manifest does not match the expected remote pack identity|Content Pack archive SHA-256 does not match the expected digest/

export function importFailure(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : ''
  const rawCode = (error as NodeJS.ErrnoException)?.code
  const code = typeof rawCode === 'string' ? rawCode : ''

  if (/archive exceeds \d+ byte limit/i.test(message)) {
    res.status(413).json({ detail: `Content Pack archive exceeds the ${MAX_IMPORT_BYTES} byte limit.` })
    return
  }
  if (IMPORT_CONFLICT_MESSAGE.test(message)) {
    res.status(409).json({ detail: message })
    return
  }
  if (IMPORT_STORAGE_EXHAUSTED_CODES.has(code)) {
    res.status(503).json({ detail: 'Story Studio could not store this Content Pack because the disk is full.' })
    return
  }
  if (IMPORT_STORAGE_UNAVAILABLE_CODES.has(code)) {
    res.status(500).json({ detail: 'Story Studio could not write this Content Pack to local storage.' })
    return
  }
  if (message.startsWith('Invalid content-pack archive:')) {
    res.status(400).json({
      detail: 'This Content Pack archive could not be verified. It may be damaged, tampered with, or incompatible with this version of Story Studio.',
    })
    return
  }
  if (IMPORT_VERIFICATION_MESSAGE.test(message)) {
    res.status(400).json({ detail: message })
    return
  }
  // Anything else is a local failure — a missing verification resource, an
  // unreadable keyring, corrupt retained state — never the uploaded archive.
  res.status(500).json({ detail: 'Story Studio could not install this Content Pack because of an internal error.' })
}
