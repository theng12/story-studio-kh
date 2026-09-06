export const LEGACY_SETTINGS_HASHES: Readonly<Record<string, string>> = {
  app: 'connections',
  models: 'connections',
  youtube: 'connections',
  ffmpeg: 'maintenance',
  notifications: 'appearance',
  about: 'maintenance',
  channel: 'identity',
  format: 'production',
  niche: 'identity',
  styles: 'writing',
  standards: 'writing',
  folders: 'files',
  storage: 'files',
  confirmations: 'files',
  project: 'files',
}

export function resolveSettingsSectionHash(hash: string, sectionIds: readonly string[]): string | null {
  const requested = hash.toLocaleLowerCase().replace(/^#/, '')
  if (!requested) return null
  const target = LEGACY_SETTINGS_HASHES[requested] || requested
  return sectionIds.includes(target) ? target : null
}
