import type { ContentPackItemKind } from './types.js'

export interface ContentPackMissingRequirement {
  pack_id: string
  version: string
  item_ids: string[]
  item_kinds: ContentPackItemKind[]
}

/**
 * The one user-facing answer for "the exact Content Pack version this needs is
 * not usable here". It deliberately names only the pack id and version.
 *
 * It lives in its own module rather than beside its main consumer because the
 * INSTALLER has to be able to throw it too, and the installer is imported by
 * that consumer. A raw `Error` thrown from the verification path used to escape
 * unconverted, which had two consequences worth stating plainly:
 *
 *   • the sub-cases stopped behaving alike — an uninstalled directory failed
 *     differently from a recalled, mismatched, or corrupted one, even though
 *     from the caller's side they are the same event
 *   • the message carried `install_path`, so an ABSOLUTE FILESYSTEM PATH reached
 *     a user-facing string. Nothing identifying may ship, and a path names the
 *     machine, the account, and often the drive
 *
 * Anything thrown from verification that a customer can see therefore goes
 * through here. Diagnostics keep their detail in the log line, not the message.
 */
export class ContentPackMissingError extends Error {
  readonly code = 'content-pack-missing' as const
  readonly statusCode = 409
  readonly expose = true
  constructor(readonly requirements: ContentPackMissingRequirement[]) {
    super(`Required Content Pack version is unavailable: ${requirements
      .map(requirement => `${requirement.pack_id}@${requirement.version}`)
      .join(', ')}`)
    this.name = 'ContentPackMissingError'
  }
}
