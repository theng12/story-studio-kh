/**
 * The editing lifecycle of a Video Assembly step popup: open on a full copy
 * of one scope's settings, edit the copy, and write only when the customer
 * presses Apply.
 *
 * Why a draft at all (AGENTS.md §4): a step popup edits one episode's own
 * settings — its scene files, its title text — while a different episode may
 * be open underneath by the time Apply is pressed. Three properties hold:
 *
 * - DETACHED. `begin` deep-copies the whole settings object, episode files
 *   included. This is deliberately NOT the preset sanitizer
 *   (`usePresets.excludeKeys`), which strips exactly the episode state a
 *   per-episode step owns (§5): a draft is a working copy, not a preset.
 * - SCOPED. The channel/episode/scene captured at `begin` is frozen, and it
 *   is the only scope a save ever receives. Switching episode under an open
 *   popup, or a save that resolves late, cannot write into the episode that
 *   is open now.
 * - WRITTEN ONCE. Apply validates the captured identity against the scope
 *   currently open, calls the existing persistence callback exactly once,
 *   and on a failed save keeps the draft and its plain error for a retry.
 *
 * The popup owns its own chrome: `Modal`/`PickerDialog` children render their
 * own Apply/Cancel footer, so no dialog component is needed here.
 */

export interface AssemblyStepScope {
  channel?: string
  episode?: string
  scene?: string
}

export type AssemblyStepDraftState = 'editing' | 'saving' | 'failed' | 'saved' | 'cancelled'

export interface AssemblyStepDraft<T> {
  /** Captured at begin and frozen — a save can only ever target this scope. */
  readonly scope: Readonly<AssemblyStepScope>
  /** The detached editable copy the popup is bound to. */
  value: T
  state: AssemblyStepDraftState
  /** Plain sentence shown when Apply fails; null otherwise. */
  error: string | null
}

/** The persistence the popup already owns (config write, job params…). */
export type AssemblyStepSave<T> = (value: T, scope: AssemblyStepScope) => void | Promise<void>

export type AssemblyStepApplyResult = { ok: true } | { ok: false; error: string }

const trim = (value?: string): string | undefined => {
  const clean = value?.trim()
  return clean ? clean : undefined
}

/** Identity of a step: same channel, episode and scene (trimmed, case kept — a mismatch must err towards refusing). */
export function sameAssemblyStepScope(a: AssemblyStepScope, b: AssemblyStepScope): boolean {
  return trim(a.channel) === trim(b.channel)
    && trim(a.episode) === trim(b.episode)
    && trim(a.scene) === trim(b.scene)
}

function scopeLabel(scope: AssemblyStepScope): string {
  const scene = trim(scope.scene)
  if (scene) return `scene ${scene}`
  const episode = trim(scope.episode)
  if (episode) return `episode ${episode}`
  const channel = trim(scope.channel)
  return channel ? `channel ${channel}` : 'another step'
}

/**
 * Open a step popup: a detached copy of `source` bound to `scope`.
 * Nothing here writes anywhere; the caller drops the draft on Cancel.
 */
export function beginAssemblyStepDraft<T>(source: T, scope: AssemblyStepScope): AssemblyStepDraft<T> {
  const captured = Object.freeze({
    channel: trim(scope.channel),
    episode: trim(scope.episode),
    scene: trim(scope.scene),
  })
  if (!captured.channel && !captured.episode && !captured.scene) {
    throw new Error('A step draft needs a channel, an episode or a scene to belong to.')
  }
  // JSON copy — settings are JSON-shaped (they persist as JSON). Nothing is
  // stripped: unlike a preset snapshot, episode files and title text stay.
  return {
    scope: captured,
    value: JSON.parse(JSON.stringify(source)) as T,
    state: 'editing',
    error: null,
  }
}

/**
 * Cancel discards without writes. A save already in flight cannot be
 * recalled and a saved draft was already written, so only an edit still
 * being made (or one kept after a failed Apply) is discarded.
 */
export function cancelAssemblyStepDraft<T>(draft: AssemblyStepDraft<T>): void {
  if (draft.state === 'editing' || draft.state === 'failed') {
    draft.state = 'cancelled'
    draft.error = null
  }
}

/**
 * Apply — the single write. Validates the captured identity against the
 * scope currently open, then calls `save` exactly once with the draft's value
 * and the CAPTURED scope. A refused Apply writes nothing; a failed Apply
 * keeps the draft (state `failed`, `error` set) so the customer can retry.
 */
export async function applyAssemblyStepDraft<T>(
  draft: AssemblyStepDraft<T>,
  currentScope: AssemblyStepScope,
  save: AssemblyStepSave<T>,
): Promise<AssemblyStepApplyResult> {
  if (draft.state === 'saving') return { ok: false, error: 'These settings are still saving.' }
  if (draft.state === 'saved') return { ok: false, error: 'These settings were already saved.' }
  if (draft.state === 'cancelled') return { ok: false, error: 'This edit was cancelled — nothing was saved.' }
  if (!sameAssemblyStepScope(draft.scope, currentScope)) {
    return {
      ok: false,
      error: `These edits belong to ${scopeLabel(draft.scope)}, but ${scopeLabel(currentScope)} is open now. `
        + 'Reopen the step there to save.',
    }
  }

  draft.state = 'saving'
  draft.error = null
  try {
    await save(draft.value, draft.scope)
  } catch (cause) {
    const error = `Could not save these settings: ${cause instanceof Error ? cause.message : String(cause)}`
    draft.state = 'failed'
    draft.error = error
    return { ok: false, error }
  }
  draft.state = 'saved'
  draft.error = null
  return { ok: true }
}
