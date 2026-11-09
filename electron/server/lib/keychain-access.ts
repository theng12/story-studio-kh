/** Keep unattended Keychain reads out of Electron's cached encryption initialization. */
export interface KeychainGuard {
  setInteractionAllowed(allowed: boolean): number
  probe(service: string, account: string, interactive: boolean): number
}

export const CREDENTIALS_UNAVAILABLE = 'Credentials unavailable. Your saved credentials are unchanged. At this Mac, choose Help → Unlock credentials… in Story Studio, then allow Keychain access.'

/**
 * Every credential failure reported by this layer is one of these finite
 * values — plus, where the native guard returned one, an integer OS errSec*
 * code. Raw error messages, file paths, native diagnostics and ciphertext
 * never leave this layer (AGENTS §6: unknown must be distinguishable, and
 * never become a zero; diagnostics stay enumerable, never leak).
 */
export const CREDENTIAL_STAGES = [
  'guard-failed',
  'access-denied',
  'encryption-unavailable',
  'encrypt-failed',
  'decrypt-failed',
  'module-unavailable',
  'store-invalid',
  'store-unreadable',
  'operation-failed',
] as const
export type CredentialsStage = typeof CREDENTIAL_STAGES[number]

export class CredentialsUnavailableError extends Error {
  constructor(
    readonly stage: CredentialsStage = 'operation-failed',
    /** Integer native status from the failure that actually produced this error; never carried over. */
    readonly osCode?: number,
  ) {
    super(CREDENTIALS_UNAVAILABLE)
    this.name = 'CredentialsUnavailableError'
  }
}

export interface CredentialsStatus {
  state: 'not-checked' | 'available' | 'unavailable'
  /** Finite failure class; only present in the 'unavailable' state. */
  code?: CredentialsStage
  /** Integer errSec* from the native guard when it produced one; never a message. */
  os_code?: number
  message: string
}

export class KeychainAccess {
  private status: CredentialsStatus = { state: 'not-checked', message: '' }

  constructor(private readonly load: () => KeychainGuard, private readonly appName: string) {}

  getStatus(): CredentialsStatus { return { ...this.status } }

  private refuse(stage: CredentialsStage, osCode?: number): never {
    this.status = { state: 'unavailable', code: stage, ...(osCode !== undefined ? { os_code: osCode } : {}), message: CREDENTIALS_UNAVAILABLE }
    throw new CredentialsUnavailableError(stage, osCode)
  }

  private preflight(interactive: boolean): KeychainGuard {
    try {
      const guard = this.load()
      const status = guard.probe(`${this.appName} Safe Storage`, `${this.appName} Key`, interactive)
      // A new installation may create its first key; denied access is never a missing key.
      // The integer (errSec* / CSSM status) is recorded as-is: finite and safe,
      // it is what tells a denied ACL (-2147415734) from an absent key (-25300).
      if (status !== 0 && status !== -25300) return this.refuse('access-denied', status)
      const interaction = guard.setInteractionAllowed(false)
      if (interaction !== 0) return this.refuse('access-denied', interaction)
      return guard
    } catch (error) {
      // refuse() itself throws — a coded refusal must keep its stage, and only
      // a genuine load/answer failure from the guard becomes 'guard-failed'.
      if (error instanceof CredentialsUnavailableError) throw error
      return this.refuse('guard-failed')
    }
  }

  /**
   * A capability check. A refusal is recorded, but success NEVER claims usable
   * credentials: availability alone is not proof that the key decrypts.
   */
  probe<T>(operation: () => T): T {
    this.preflight(false)
    try {
      return operation()
    } catch (error) {
      // The stage and native code of the failure actually hit are kept;
      // anything else was the operation itself and stays generic — never a message.
      if (error instanceof CredentialsUnavailableError) return this.refuse(error.stage, error.osCode)
      return this.refuse('operation-failed')
    }
  }

  /** A real guarded encrypt/decrypt operation: success means the key worked. */
  run<T>(operation: () => T): T {
    const value = this.probe(operation)
    this.status = { state: 'available', message: '' }
    return value
  }

  /**
   * Called only by the native, attended menu action, never by HTTP or boot.
   * Returns whether credentials are usable now; it never throws, so the menu
   * layer cannot echo a raw diagnostic back to the screen.
   */
  unlock(operation: () => void): boolean {
    try {
      this.preflight(true)
      this.preflight(false) // recheck without interaction before Electron, exactly as an unattended read does
      operation()
      this.status = { state: 'available', message: '' }
      return true
    } catch (error) {
      const stage = error instanceof CredentialsUnavailableError ? error.stage : 'operation-failed'
      // Only the code from THIS failure: a stale code would misdiagnose the mini.
      const osCode = error instanceof CredentialsUnavailableError ? error.osCode : undefined
      this.status = { state: 'unavailable', code: stage, ...(osCode !== undefined ? { os_code: osCode } : {}), message: CREDENTIALS_UNAVAILABLE }
      return false
    }
  }
}