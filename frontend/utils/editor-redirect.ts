/**
 * Where the retired Effects Library and Channel Characters pages send their
 * own bookmarks, in-app links and sidebar entries (JOB6).
 *
 * Both old addresses stay alive as redirect adapters so nothing that pointed
 * at them breaks; they land on the page that replaced them instead. Two rules
 * the redirects must keep:
 *
 * - CONTEXT IS PASSED ONLY WHEN IT IS REAL. The channel slug, episode and
 *   scene ride along as query parameters so the destination opens on the same
 *   work. A slug that is missing, literally "undefined"/"null" (Nuxt's
 *   unresolved dynamic param — see project-slug.ts) or otherwise not slug-
 *   shaped is dropped rather than guessed (AGENTS.md §4: an episode or
 *   channel that cannot be established is blanked, never inferred).
 * - A CHANNEL WE DO NOT HAVE GOES TO THE CHOOSER. `/` is the app's own
 *   channel list; the customer picks one there. Never fabricate a slug from
 *   a name, a path or a stale query value.
 */

import { projectSlug } from './project-slug'

export interface EditorRedirectContext {
  channel?: unknown
  /** The old sidebar link named the same channel twice (`channel` and `project`). */
  project?: unknown
  episode?: unknown
  scene?: unknown
}

export interface EditorRedirectTarget {
  path: string
  query: Record<string, string>
}

/** A channel slug is route-safe: letters, digits and inner hyphens, no spaces or slashes. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Valid channel slug, or '' — never a guess, never "undefined". */
export function validChannelSlug(value: unknown): string {
  const slug = projectSlug(value)
  return SLUG_PATTERN.test(slug) ? slug : ''
}

/** The channel a context names: `channel` first, then the old `project` alias. */
function contextChannel(ctx: EditorRedirectContext): string {
  return validChannelSlug(ctx.channel) || validChannelSlug(ctx.project)
}

/** Episode/scene ids are opaque strings; only the empty and unresolved values are rejected. */
function validId(value: unknown): string {
  const id = trimmed(value)
  return id && id !== 'undefined' && id !== 'null' ? id : ''
}

/**
 * Effects Library → Video Assembly, the step that now hosts the editor.
 * Without a channel there is no step to open: send the chooser.
 */
export function effectsLibraryRedirect(ctx: EditorRedirectContext): EditorRedirectTarget {
  const channel = contextChannel(ctx)
  if (!channel) return { path: '/', query: {} }
  const query: Record<string, string> = { step: '4' }
  const episode = validId(ctx.episode)
  const scene = validId(ctx.scene)
  if (episode) {
    query.episode_id = episode
    // With a real episode in hand the destination can open the editor itself,
    // which is what the old page was. Without one it must not guess (§4).
    query.effects = '1'
  }
  if (scene) query.scene = scene
  return { path: `/projects/${encodeURIComponent(channel)}/video-assembly`, query }
}

/**
 * Channel Characters → that channel's Character Sheet, which hosts the roster
 * and the shared record editor. Without a channel, the chooser.
 */
export function characterLibraryRedirect(ctx: EditorRedirectContext): EditorRedirectTarget {
  const channel = contextChannel(ctx)
  if (!channel) return { path: '/', query: {} }
  const query: Record<string, string> = {}
  const episode = validId(ctx.episode)
  if (episode) query.episode_id = episode
  return { path: `/projects/${encodeURIComponent(channel)}/character-sheet`, query }
}
