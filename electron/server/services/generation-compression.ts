/**
 * "Smaller files" — the owner's on/off choice, per kind of generated asset, for asking
 * GenStudio to hand files back already compressed (music/narration as AAC `.m4a`, scene
 * and pool images as JPEG). The request field is `output_format`; ABSENT means today's
 * WAV/PNG, so switching a kind off (or an old Hub node ignoring the field) changes nothing
 * else. Thumbnails are off by default and are never asked for unless the owner turns them on.
 *
 * Resolution: a project's own value wins; a kind the project does not mention follows the
 * app-wide default (Settings → Files & maintenance); an unset default is the table below.
 */
import path from 'node:path'
import { getAppSetting, setAppSetting } from './app-settings.js'
import * as pm from './project-manager.js'
import { readJsonOr } from '../lib/atomic-store.js'

export const COMPRESSION_KINDS = ['music', 'narration', 'scene_images', 'image_pool', 'thumbnails'] as const
export type CompressionKind = typeof COMPRESSION_KINDS[number]
export type CompressionToggles = Record<CompressionKind, boolean>
export type CompressionOverride = Partial<CompressionToggles>

export const GENERATION_COMPRESSION_KEY = 'generation_compression'

export const COMPRESSION_DEFAULTS: Readonly<CompressionToggles> = {
  music: true, narration: true, scene_images: true, image_pool: true, thumbnails: false,
}

/** What is asked for when a kind is on. Fixed presets live in the Hub, there is no quality knob. */
export const COMPRESSION_FORMAT = {
  music: 'm4a', narration: 'm4a', scene_images: 'jpeg', image_pool: 'jpeg', thumbnails: 'jpeg',
} as const satisfies Record<CompressionKind, 'm4a' | 'jpeg'>
export type CompressionFormat<K extends CompressionKind> = typeof COMPRESSION_FORMAT[K]

/** Keep only known kinds with real booleans — hand-edited or future data never leaks through. */
export function sanitizeCompression(value: unknown): CompressionOverride {
  const out: CompressionOverride = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const kind of COMPRESSION_KINDS) {
    const v = (value as Record<string, unknown>)[kind]
    if (typeof v === 'boolean') out[kind] = v
  }
  return out
}

function strictCompression(value: unknown): CompressionOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Smaller files settings must be an object of on/off values.'), { statusCode: 400, expose: true })
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!(COMPRESSION_KINDS as readonly string[]).includes(key) || (v !== null && typeof v !== 'boolean')) {
      throw Object.assign(new Error(`"${key}" is not a valid smaller-files setting.`), { statusCode: 400, expose: true })
    }
  }
  return sanitizeCompression(value)
}

export async function getGlobalCompression(): Promise<CompressionToggles> {
  return { ...COMPRESSION_DEFAULTS, ...sanitizeCompression(await getAppSetting(GENERATION_COMPRESSION_KEY)) }
}

export async function setGlobalCompression(value: unknown): Promise<CompressionToggles> {
  const patch = strictCompression(value)
  const next = { ...await getGlobalCompression(), ...patch }
  await setAppSetting(GENERATION_COMPRESSION_KEY, next)
  return next
}

export async function getProjectCompressionOverride(slug: string): Promise<CompressionOverride> {
  const dir = pm.getProjectDir(slug)
  if (!dir) return {}
  const config = await readJsonOr<Record<string, unknown>>(path.join(dir, 'config.json'), {})
  return sanitizeCompression(config[GENERATION_COMPRESSION_KEY])
}

/** `null` for a kind removes the project's value so it follows the app default again. */
export async function setProjectCompressionOverride(slug: string, value: unknown): Promise<CompressionOverride | null> {
  const patch = strictCompression(value)
  const current = await getProjectCompressionOverride(slug)
  const next: CompressionOverride = { ...current }
  for (const [kind, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) delete next[kind as CompressionKind]
    else next[kind as CompressionKind] = patch[kind as CompressionKind]
  }
  if (!await pm.updateConfig(slug, { [GENERATION_COMPRESSION_KEY]: next } as any)) return null
  return next
}

export async function resolveCompression(slug: string | undefined, kind: CompressionKind): Promise<boolean> {
  const own = slug ? (await getProjectCompressionOverride(slug))[kind] : undefined
  return own ?? (await getGlobalCompression())[kind]
}

/** The `output_format` to send for this kind, or undefined (= native WAV/PNG, field omitted). */
export async function resolveOutputFormat<K extends CompressionKind>(
  slug: string | undefined, kind: K,
): Promise<CompressionFormat<K> | undefined> {
  return await resolveCompression(slug, kind) ? COMPRESSION_FORMAT[kind] : undefined
}
