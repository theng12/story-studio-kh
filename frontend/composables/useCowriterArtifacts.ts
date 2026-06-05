/**
 * Co-writer reusable artifacts — localStorage-backed, per-project (v1.0.283).
 *
 * The Co-writer chat is great for developing ideas in conversation, but
 * everything you discovered during the chat — visual styles, character
 * descriptions, thumbnail aesthetics — used to evaporate when you switched
 * tabs or finished the episode. v1.0.282 saved the chat thread itself; this
 * composable adds a layer for the REUSABLE descriptive artifacts that
 * accumulate during many chats and stay useful across episodes.
 *
 * Four artifact types are supported (descriptive, channel-level — not
 * episode-specific):
 *
 *   - `thumbnail-style`     Description of a thumbnail aesthetic — colors,
 *                           composition, mood, typography vibe.
 *   - `scene-style`         Description of a scene-image aesthetic — art
 *                           style, framing convention, palette.
 *   - `style-notes`         Free-form notes (anything that doesn't fit the
 *                           above).
 *   - `character`           Character description, sendable to the project's
 *                           Character Library via `POST /api/projects/:slug/
 *                           characters`.
 *
 * Episode-specific artifacts (idea / outline / script) deliberately do NOT
 * live here — they have their own one-shot commit flow in the existing
 * "Send to pipeline" panel and don't benefit from being saved long-term.
 *
 * Storage:
 *   - `localStorage["cowriter:<slug>:artifacts"]` — JSON array of items
 *   - Per-project keyed (just like the chat history store)
 *   - Per-machine only — does NOT sync across Macs via iCloud. If the user
 *     ever asks for cross-machine artifacts, the upgrade path is a backend
 *     sidecar at `<project>/.cowriter/artifacts.json` without changing
 *     this composable's call sites.
 *
 * Module-scoped Map cache keyed by slug so multiple page mounts share the
 * same reactive state without re-parsing localStorage.
 */

import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'

export type CowriterArtifactType =
  | 'thumbnail-style'
  | 'scene-style'
  | 'style-notes'
  | 'character'

export interface CowriterArtifact {
  /** Stable id (uuid-ish, generated client-side). */
  id: string
  type: CowriterArtifactType
  /** User-given short name (e.g. "Calm Watercolor", "Old Thomas"). */
  name: string
  /** Free-form Markdown body. */
  body: string
  /** Unix ms — never displayed, used for default sort + watch invalidation. */
  createdAt: number
  updatedAt: number
}

export interface CowriterArtifactStore {
  /** All artifacts as a flat reactive array. */
  all: Ref<CowriterArtifact[]>
  /** Grouped by type — keys are CowriterArtifactType. Newest first. */
  byType: ComputedRef<Record<CowriterArtifactType, CowriterArtifact[]>>
  /** Create a new artifact. Returns the inserted item. */
  add: (init: Pick<CowriterArtifact, 'type' | 'name' | 'body'>) => CowriterArtifact
  /** Update an existing artifact by id. No-op if id not found. */
  update: (id: string, patch: Partial<Pick<CowriterArtifact, 'name' | 'body'>>) => void
  /** Remove an artifact by id. */
  remove: (id: string) => void
  /** Look up by id. */
  get: (id: string) => CowriterArtifact | undefined
}

const storesBySlug = new Map<string, CowriterArtifactStore>()

// Per-project storage cap. Artifacts are short text bodies (~1KB each
// typical, larger for big style sheets); 100 is plenty for a single
// channel's reusable library and stays well under the ~5MB localStorage
// quota. Hitting the cap drops the OLDEST first.
const MAX_ARTIFACTS = 100

function safeLoad(slug: string): CowriterArtifact[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(`cowriter:${slug}:artifacts`)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (a): a is CowriterArtifact =>
        a && typeof a === 'object'
        && typeof a.id === 'string'
        && (
          a.type === 'thumbnail-style'
          || a.type === 'scene-style'
          || a.type === 'style-notes'
          || a.type === 'character'
        )
        && typeof a.name === 'string'
        && typeof a.body === 'string'
        && typeof a.createdAt === 'number'
        && typeof a.updatedAt === 'number',
    )
  } catch {
    return []
  }
}

function safeSave(slug: string, items: CowriterArtifact[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    // Trim from the front (oldest) if over cap. Save chronologically — most
    // recent are inserted at the end and surface at the top of byType groups
    // via the descending updatedAt sort.
    const trimmed = items.length > MAX_ARTIFACTS
      ? items.slice(items.length - MAX_ARTIFACTS)
      : items
    localStorage.setItem(`cowriter:${slug}:artifacts`, JSON.stringify(trimmed))
  } catch {
    /* quota exceeded or storage disabled — best-effort. The in-memory state
     * still works; only persistence is degraded. */
  }
}

/**
 * Cheap unique id — high-res timestamp + 6-char random suffix. Not RFC-uuid
 * compliant; doesn't need to be. Collision probability is negligible for a
 * single user's per-project artifact list.
 */
function newId(seedCounter: { n: number }): string {
  seedCounter.n += 1
  const t = (typeof performance !== 'undefined' && performance.now)
    ? Math.floor(performance.now() * 1000)
    : seedCounter.n
  const suffix = Math.random().toString(36).slice(2, 8)
  return `art-${t.toString(36)}-${suffix}`
}

export function useCowriterArtifacts(slug: string): CowriterArtifactStore {
  if (!slug) {
    // Defensive fallback — non-persisted ephemeral store. The page's slug
    // ref will eventually settle and re-call with the right slug.
    const all = ref<CowriterArtifact[]>([])
    return makeStore(all, '', { n: 0 })
  }

  const cached = storesBySlug.get(slug)
  if (cached) return cached

  const all = ref<CowriterArtifact[]>(safeLoad(slug))
  watch(all, (next) => { safeSave(slug, next) }, { deep: true })

  const store = makeStore(all, slug, { n: 0 })
  storesBySlug.set(slug, store)
  return store
}

function makeStore(
  all: Ref<CowriterArtifact[]>,
  _slug: string,
  seedCounter: { n: number },
): CowriterArtifactStore {
  const byType = computed<Record<CowriterArtifactType, CowriterArtifact[]>>(() => {
    const buckets: Record<CowriterArtifactType, CowriterArtifact[]> = {
      'thumbnail-style': [],
      'scene-style': [],
      'style-notes': [],
      'character': [],
    }
    for (const a of all.value) buckets[a.type].push(a)
    // Newest first within each bucket — matches how the user thinks about
    // "the one I just saved", which they're most likely to reference next.
    for (const k of Object.keys(buckets) as CowriterArtifactType[]) {
      buckets[k].sort((x, y) => y.updatedAt - x.updatedAt)
    }
    return buckets
  })

  function add(init: Pick<CowriterArtifact, 'type' | 'name' | 'body'>): CowriterArtifact {
    const now = Date.now()
    const item: CowriterArtifact = {
      id: newId(seedCounter),
      type: init.type,
      name: (init.name || '').trim() || 'Untitled',
      body: init.body || '',
      createdAt: now,
      updatedAt: now,
    }
    all.value.push(item)
    return item
  }

  function update(id: string, patch: Partial<Pick<CowriterArtifact, 'name' | 'body'>>): void {
    const i = all.value.findIndex((a) => a.id === id)
    if (i === -1) return
    const cur = all.value[i]
    if (!cur) return
    all.value[i] = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim() || cur.name } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      updatedAt: Date.now(),
    }
  }

  function remove(id: string): void {
    const i = all.value.findIndex((a) => a.id === id)
    if (i !== -1) all.value.splice(i, 1)
  }

  function get(id: string): CowriterArtifact | undefined {
    return all.value.find((a) => a.id === id)
  }

  return { all, byType, add, update, remove, get }
}

/**
 * Static label/UI metadata for each artifact type. Keep this here (not in
 * the page) so other surfaces can render artifact lists consistently.
 */
export const ARTIFACT_TYPE_META: Record<
  CowriterArtifactType,
  {
    label: string
    icon: string
    /** Short hint shown when the type's section is empty. */
    emptyHint: string
    /** When set, an extra "Send to …" button appears on each artifact of this
     *  type. The string is the button label. */
    commitLabel?: string
  }
> = {
  'thumbnail-style': {
    label: 'Thumbnail Styles',
    icon: '🖼️',
    emptyHint: 'Reusable thumbnail aesthetics — color, composition, typography vibe.',
  },
  'scene-style': {
    label: 'Scene Styles',
    icon: '🎨',
    emptyHint: 'Reusable scene-image looks — art style, framing convention, palette.',
  },
  'style-notes': {
    label: 'Style Notes',
    icon: '📝',
    emptyHint: 'Free-form notes — anything that doesn\'t fit the other types.',
  },
  'character': {
    label: 'Character Descriptions',
    icon: '👤',
    emptyHint: 'Recurring character profiles. Sendable to the project\'s Character Library.',
    commitLabel: 'Send to Character Library',
  },
}
