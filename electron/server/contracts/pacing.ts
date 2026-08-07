/**
 * Continuity Engine default scene pacing (v1.0.792+).
 *
 * The single source of truth for the scene-pacing band a continuity-chain
 * project gets when it declares no pacing of its own: no saved
 * `continuity.json`, or one whose `pacing` is missing/invalid. A Character
 * Sheet or Series Formula range always overrides this — it is only the floor
 * for a project that has picked neither. See `PACING_PRESETS` in
 * `frontend/composables/useContinuityConfig.ts` for the full menu of pacing
 * bands a customer can choose instead; this constant is only the unset case.
 *
 * Every site that decides that fallback — `electron/server/generators/
 * scene-plan.ts`, `electron/server/routes/continuity.ts` (both the fresh-config
 * default and the `PUT` coercion fallback), and the frontend's
 * `useContinuityConfig.ts` / `scene-plan.vue` — must import this rather than
 * hardcoding the pair. Commit a3d0925 changed two of those four hardcoded
 * copies from 1–4s to 1–3s and left the other two behind, because nothing
 * forced all four to agree. `frontend/__tests__/characterSheetWorkspace.test.ts`
 * sweeps the source tree for exactly that regression: a literal `min_sec` /
 * `max_sec` pacing pair anywhere outside this file.
 *
 * Deliberately its own file, sibling to `contracts/index.ts` rather than
 * folded into it: `index.ts` imports `zod` for its wire schemas, and the
 * frontend reaches `@shared/contracts` only via `import type` so that zod
 * runtime never ships to the renderer bundle (see `frontend/nuxt.config.ts`).
 * This constant is consumed as a real VALUE by frontend runtime code
 * (`continuityDefaults()`, `scene-plan.vue`'s display fallback), so it needs
 * a module with zero dependencies of its own to import safely — pulling a
 * value out of `index.ts` would drag the whole zod-schema module (and zod
 * itself) into the browser bundle along with it.
 */
export const DEFAULT_SCENE_PACING = { min_sec: 1, max_sec: 3 } as const
