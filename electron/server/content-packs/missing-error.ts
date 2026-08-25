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

/**
 * "This installed version cannot be used." Raised by the installer's own
 * verification, and deliberately NOT a `ContentPackMissingError`.
 *
 * The two are different answers and the repository already depended on the
 * difference. `ContentPackMissingError` is a customer-facing 409 they can act
 * on — install it, or pick something else. This one reports that verification
 * REFUSED bytes on disk: an absent directory, a recalled version, an archive
 * whose hash disagrees with state, a materialised file that differs from the
 * verified archive. Tamper-detection tests read the reason out of the message,
 * and flattening all of it into "unavailable" destroys the only signal saying
 * a tamper was caught.
 *
 * What it does NOT carry, and this is the whole point of it existing, is a
 * filesystem path. Every one of these messages used to embed `install_path`,
 * and they escape as far as user-facing strings. A path names the machine, the
 * account, and often the drive. The path stays in the log line.
 *
 * It carries no `statusCode` and is not `expose`d, so a route that meets one
 * answers with its own generic failure. The layer that resolves an OWNER PIN
 * converts it to `ContentPackMissingError`, because there the customer really
 * did ask for exactly this version and is owed an answer about it.
 */
export class ContentPackUnusableError extends Error {
  readonly code = 'content-pack-unusable' as const
  constructor(
    message: string,
    readonly reason: string,
    readonly ref: { pack_id?: string; version?: string },
  ) {
    super(message)
    this.name = 'ContentPackUnusableError'
  }
}

/** True for anything the installer refused, whatever the reason. */
export function isContentPackUnusable(error: unknown): error is ContentPackUnusableError {
  return Boolean(error) && (error as { code?: unknown }).code === 'content-pack-unusable'
}
