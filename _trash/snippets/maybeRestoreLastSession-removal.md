# Removed: `maybeRestoreLastSession` (home-page auto-restore)

**Removed in:** v1.0.40 (commit pending)
**Original feature:** Auto-navigate to the last visited project page on
app launch — "you were on `/projects/foo/audio` last time, take me back
there".
**Why removed:** Auto-restore was switched to OFF in an earlier release;
the resume mechanism was preserved for a future opt-in "Resume where you
left off →" chip on the home page that never shipped. Two years on it's
clear that chip isn't coming, and the dead block is technical debt.

The underlying `/last-session` infrastructure is **NOT** being removed —
it's still load-bearing for the unclean-shutdown banner in
`frontend/layouts/dashboard.vue` (writer + reader) and the proactive
recovery sweep in `electron/server/boot/migrations.ts`. Only the
home-page reader is going away.

## What was removed

Original location: `frontend/pages/index.vue` lines ~2172-2233 + the
trailing block in `onMounted` (lines ~2235-2253).

### Block 1 — the auto-restore section (delete entire block)

```ts
// ── Auto-restore last open page ──────────────────────────────────────────
// Operator was on `/projects/foo/audio` when the app went away. On the next
// launch we land them back there instead of forcing them through the project
// list. A 24h cap keeps stale sessions from trapping someone on a project
// they were "done with" but never explicitly navigated away from.
const RESTORE_MAX_AGE_MS = 24 * 60 * 60 * 1000
// Mirrors the server-side allowlist in services/last-session.ts. Kept literal
// here (not imported from the plugin) so home-page restore can't accidentally
// follow a route the renderer-side plugin would refuse to save.
const RESTORABLE_SUBS = new Set([
  'ideas', 'pipeline', 'scripts', 'metadata', 'image-prompts', 'images',
  'video', 'audio', 'audio-merge', 'video-assembly', 'upload',
  'tiktok-upload', 'facebook-upload', 'presets', 'assets', 'jobs', 'settings',
])

function isRestorablePath(p: string): boolean {
  const m = /^\/projects\/([^/]+)(?:\/([^/?#]+))?\/?$/.exec(p)
  if (!m) return false
  const sub = m[2] ?? 'index'
  return sub === 'index' || RESTORABLE_SUBS.has(sub)
}

/**
 * Auto-restore must fire AT MOST ONCE per Electron launch. Without this gate
 * the loop is: user clicks "All Projects" in the sidebar → navigates to `/`
 * → onMounted → restore re-fires → bounced back to the project page they
 * just left. SessionStorage is the right scope — a per-tab key that resets
 * only on a new Electron-window launch, exactly the "fresh start" boundary
 * we want.
 *
 * The flag is set BEFORE the eligibility checks so even when restore
 * declines (no last session, stale, non-restorable route), we still don't
 * try again on the next visit. If the user explicitly wants to resume,
 * they pick the project from the list manually.
 */
const RESTORE_ATTEMPTED_KEY = 'story-studio:restore-attempted'

async function maybeRestoreLastSession(): Promise<boolean> {
  if (typeof sessionStorage !== 'undefined') {
    if (sessionStorage.getItem(RESTORE_ATTEMPTED_KEY) === '1') return false
    sessionStorage.setItem(RESTORE_ATTEMPTED_KEY, '1')
  }
  try {
    const last = await get<{
      projectSlug?: string; route?: string; ts?: number;
      unclean_shutdown?: boolean;
    }>('/last-session')
    if (!last?.route || !last?.ts) return false
    if (Date.now() - last.ts > RESTORE_MAX_AGE_MS) return false
    if (!isRestorablePath(last.route)) return false
    // Tell the dashboard layout this navigation came from a restore so it
    // can render the "Resumed where you left off" chip. Cleared by the chip
    // dismiss / by an explicit return-to-home click.
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('story-studio:restored', '1')
    }
    await navigateTo(last.route)
    return true
  } catch {
    return false
  }
}
```

### Block 2 — the dead trailing block inside `onMounted`

Original:

```ts
onMounted(async () => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent.toLowerCase() : ''
  isMac.value = ua.includes('mac')
  isLinux.value = ua.includes('linux') && !ua.includes('android')
  // Auto-restore is OFF by default — open the app, land on All Projects.
  // The unclean-shutdown banner in dashboard.vue still surfaces "you
  // crashed mid-render" so accidental shutdowns don't lose context, but
  // a normal launch goes home. The "resume" mechanism is preserved for
  // future opt-in via a "Resume where you left off →" chip on the home
  // page (TODO) — leaving `maybeRestoreLastSession` defined so that work
  // can call it without rebuilding the plumbing.
  loadData()
  // Also write the sessionStorage gate so later home-page mounts in this
  // window don't accidentally re-trigger the restore flow if it gets
  // re-enabled later in the same session.
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(RESTORE_ATTEMPTED_KEY, '1')
  }
})
```

Replaced with:

```ts
onMounted(async () => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent.toLowerCase() : ''
  isMac.value = ua.includes('mac')
  isLinux.value = ua.includes('linux') && !ua.includes('android')
  loadData()
})
```

## How to restore

If a "Resume where you left off →" chip is later wanted on the home
page:

1. Re-paste both blocks above into `frontend/pages/index.vue`.
2. Wire a button / chip that calls `await maybeRestoreLastSession()`
   and shows a fallback when it returns `false`.
3. Remove the unconditional `sessionStorage.setItem(RESTORE_ATTEMPTED_KEY, '1')`
   from `onMounted` — that gate was specifically to *prevent* auto-fire
   when the feature was off, but if it's now opt-in via a button, the
   gate isn't needed.

The server-side route + service didn't change, so no backend rework
is needed.
