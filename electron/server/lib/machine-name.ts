import os from 'node:os'

/**
 * This Mac's name as the Gateway knows it: the host name without `.local`.
 *
 * One spelling for two uses, so they always agree: the `X-Caller: story-studio@<name>` header on
 * every Gateway call (the Gateway's queue and jobs show which Story Mac sent what) and the
 * instance identity in the update check-in. ASCII by construction, so it is a valid header value.
 */
export function machineName(): string {
  const name = os.hostname().replace(/\.local\.?$/i, '').replace(/[^A-Za-z0-9._ '()-]+/g, '-').slice(0, 100)
  return /^[A-Za-z0-9]/.test(name) ? name : `mac-${name}`.slice(0, 100)
}

export const STORY_CALLER = `story-studio@${machineName()}`
