/** Keep unattended Keychain reads out of Electron's cached encryption initialization. */
export interface KeychainGuard {
  setInteractionAllowed(allowed: boolean): number
  probe(service: string, account: string, interactive: boolean): number
}

export const CREDENTIALS_UNAVAILABLE = 'Credentials unavailable. Your saved credentials are unchanged. At this Mac, choose Help → Unlock credentials… in Story Studio, then allow Keychain access.'

export class CredentialsUnavailableError extends Error {
  constructor() {
    super(CREDENTIALS_UNAVAILABLE)
    this.name = 'CredentialsUnavailableError'
  }
}

export interface CredentialsStatus {
  state: 'not-checked' | 'available' | 'unavailable'
  message: string
}

export class KeychainAccess {
  private status: CredentialsStatus = { state: 'not-checked', message: '' }

  constructor(private readonly load: () => KeychainGuard, private readonly appName: string) {}

  getStatus(): CredentialsStatus { return { ...this.status } }

  private refuse(): never {
    this.status = { state: 'unavailable', message: CREDENTIALS_UNAVAILABLE }
    throw new CredentialsUnavailableError()
  }

  private preflight(interactive: boolean): KeychainGuard {
    try {
      const guard = this.load()
      const status = guard.probe(`${this.appName} Safe Storage`, `${this.appName} Key`, interactive)
      // A new installation may create its first key; denied access is never a missing key.
      if (status !== 0 && status !== -25300) return this.refuse()
      if (guard.setInteractionAllowed(false) !== 0) return this.refuse()
      return guard
    } catch { return this.refuse() }
  }

  run<T>(operation: () => T): T {
    this.preflight(false)
    try {
      const value = operation()
      this.status = { state: 'available', message: '' }
      return value
    } catch { return this.refuse() }
  }

  /** Called only by the native, attended menu action, never by HTTP or boot. */
  unlock(operation: () => void): void {
    this.preflight(true)
    this.run(operation)
  }
}
