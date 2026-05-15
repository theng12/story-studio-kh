/**
 * usePresetPathValidation — apply-time check for path fields inside a preset.
 *
 * v1.0.93+ — when a preset is applied (whether from this device or another),
 * we round-trip every path-bearing field through `/api/system/validate-path`
 * to find out which ones don't exist on the current Mac. The page surfaces
 * the result as a banner with "Pick replacement" buttons wired to the
 * page's existing file pickers.
 *
 * Why not run this on every form change? Because the form's state already
 * matches what the user just saw on disk (they picked the file via a Browse
 * button). Validation is only useful at the transition moments:
 *   - A preset was applied (paths came from a saved snapshot)
 *   - The user just opened the page (auto-apply of the last-active preset)
 * Stale-file detection between those moments isn't worth the polling cost.
 *
 * Usage:
 *   const { validate } = usePresetPathValidation()
 *   const result = await validate(presetData, [
 *     { key: 'intro.file' },
 *     { key: 'music.files[]' },         // dotted path; [] denotes array
 *     { key: 'ambient_tracks[].source_path' },
 *   ])
 *   // result.invalid = [{ key, index, value, reason }, ...]
 *
 * The `key` syntax is intentionally simple:
 *   - 'a.b.c'    → object property walk
 *   - 'a[]'      → "iterate every element of array a"
 *   - 'a[].b'    → "iterate array a, then look at .b on each element"
 *
 * One layer of array nesting is supported (every path-bearing preset on
 * this codebase fits in that). If a future preset shape needs deeper
 * nesting, generalise this walker — don't sprinkle ad-hoc loops at call
 * sites.
 */
import { useApi } from './useApi.js'

export interface PathFieldSpec {
  /** Dotted path inside the preset data. Use `[]` to descend into arrays. */
  key: string
  /** When true, validate as a directory (must_be_dir = true). Defaults to
   *  file-mode (just must_exist). */
  mustBeDir?: boolean
}

export interface InvalidPath {
  /** The original spec key (e.g. `'ambient_tracks[].source_path'`). */
  key: string
  /** Index in the array, or null when the field is scalar. */
  index: number | null
  /** The actual path value that failed validation. */
  value: string
  /** Backend's reason ('path does not exist', 'path is empty', etc.). */
  reason: string
}

export interface ValidatePathsResult {
  /** Paths that exist + match the spec. Useful for telemetry / debug. */
  valid: string[]
  /** Paths that need user attention. */
  invalid: InvalidPath[]
}

/** Internal: yield every leaf path-value pair for a single spec, given the
 *  preset data. `(key, index, value)` triples where `index` is the array
 *  position when the spec contained `[]`, otherwise null. */
function* iterPathFields(
  data: any,
  spec: PathFieldSpec,
): Generator<{ index: number | null; value: string }> {
  // Pre-tokenise the spec: 'a.b[].c' → ['a', 'b', '[]', 'c'].
  const tokens = spec.key
    .replace(/\[\]/g, '.[]')
    .split('.')
    .filter(t => t.length > 0)

  function walk(node: any, i: number, arrayIndex: number | null): Generator<{ index: number | null; value: string }> {
    return (function* () {
      if (node == null) return
      if (i >= tokens.length) {
        // Reached the leaf — only yield strings (path fields are strings).
        if (typeof node === 'string' && node.length > 0) {
          yield { index: arrayIndex, value: node }
        }
        return
      }
      const tok = tokens[i]
      if (tok === '[]') {
        // Array hop: iterate every element, remember the index.
        if (!Array.isArray(node)) return
        for (let j = 0; j < node.length; j++) {
          yield* walk(node[j], i + 1, j)
        }
        return
      }
      // Object property hop.
      if (typeof node !== 'object') return
      yield* walk(node[tok], i + 1, arrayIndex)
    })()
  }

  yield* walk(data, 0, null)
}

export function usePresetPathValidation() {
  const { post } = useApi()

  async function validateOne(p: string, mustBeDir: boolean): Promise<{ valid: boolean; reason?: string }> {
    try {
      const r = await post<{ valid: boolean; reason?: string }>(`/system/validate-path`, {
        path: p,
        must_be_dir: mustBeDir,
        must_exist: true,
      })
      return { valid: !!r?.valid, reason: r?.reason }
    } catch (e: any) {
      // Network / 500 — treat as invalid so the user gets prompted to
      // reselect rather than silently rendering against a broken path.
      return { valid: false, reason: e?.data?.detail || e?.message || 'validation failed' }
    }
  }

  async function validate(data: any, fields: PathFieldSpec[]): Promise<ValidatePathsResult> {
    const checks: Array<Promise<void>> = []
    const valid: string[] = []
    const invalid: InvalidPath[] = []

    for (const spec of fields) {
      for (const { index, value } of iterPathFields(data, spec)) {
        checks.push(
          validateOne(value, spec.mustBeDir === true).then(r => {
            if (r.valid) valid.push(value)
            else invalid.push({
              key: spec.key,
              index,
              value,
              reason: r.reason || 'unknown',
            })
          }),
        )
      }
    }

    // Promise.all so a 7-path preset takes one wall-clock round-trip rather
    // than seven serial ones. The backend route is a thin fs.stat, so the
    // parallel load is negligible.
    await Promise.all(checks)
    return { valid, invalid }
  }

  return { validate }
}
