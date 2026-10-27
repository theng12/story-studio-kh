/**
 * Local duplicate screening — the policy half.
 *
 * OPTIONAL, IN-APP, and always a warning (owner, 2026-10-27). Story runs
 * EmbeddingGemma 2 on THIS Mac, in its own process, to answer two questions:
 *
 *   1. do two scene images in one episode look like the same picture?
 *   2. does a new title look like one the channel already has?
 *
 * Both answers are advice. Nothing here blocks, refuses, or gates anything:
 * uploading without the feature works exactly as it does today.
 *
 * Zero-dependency on purpose — the frontend imports this module too, so the
 * page and the server cannot disagree about what a score means.
 *
 * **A zero that means two things is a defect (§6).** "These are different"
 * and "I could not measure this" are separate values here (`measured` vs
 * `unmeasurable`), and the screen reports `not_checked` — by name, with a
 * reason — whenever no comparison happened. A model that is switched off, not
 * downloaded, or broken never reads as a pass.
 */

/**
 * Where the model and its runtime come from. Pinned to one immutable Hugging
 * Face revision so a re-download cannot silently change the numbers, and every
 * file is verified by SHA-256 before it is used.
 *
 * This is the ONE named exception to AGENTS.md §7's single-endpoint rule: a
 * model-FILE download only. It is not a model endpoint, no generation request
 * is ever sent to it, and nothing about it is used to dispatch anything.
 */
export const LOCAL_EMBEDDING_MODEL = {
  /** The published model this feature was qualified against. */
  model_id: 'google/embeddinggemma-2',
  /** The ONNX export the app actually runs. */
  onnx_repo: 'onnx-community/embeddinggemma-2-ONNX',
  /** Immutable revision — a branch name would not be pinned at all. */
  revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
  license: 'Apache-2.0',
  /** Native inference runtime, fetched with the model for the same reason. */
  runtime: {
    package: 'onnxruntime-node',
    version: '1.31.1',
    /**
     * Where each fetched file lives inside the published package. The local
     * filename is the LAST segment, and for the dylib that name is required by
     * the binding's `@rpath` entry — see `LOCAL_RUNTIME_FILES`.
     */
    sources: {
      'onnxruntime_binding.node': 'bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
      'libonnxruntime.1.dylib': 'bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
    },
  },
} as const

/** Where each file comes from, given the pinned revision. */
export function modelFileUrl(file: string): string {
  return `https://huggingface.co/${LOCAL_EMBEDDING_MODEL.onnx_repo}/resolve/${LOCAL_EMBEDDING_MODEL.revision}/${file}`
}

export function runtimeFileUrl(file: string): string {
  const source = (LOCAL_EMBEDDING_MODEL.runtime.sources as Record<string, string>)[file]
  if (!source) throw new Error(`No published source is pinned for runtime file ${file}.`)
  return `https://unpkg.com/${LOCAL_EMBEDDING_MODEL.runtime.package}@${LOCAL_EMBEDDING_MODEL.runtime.version}/${source}`
}

export interface ModelFileSpec {
  /** Path inside the model directory on disk. */
  path: string
  /** Expected size in bytes, so a truncated download is caught before it is hashed. */
  bytes: number
  /** SHA-256 of the exact bytes the pinned revision serves. */
  sha256: string
}

/**
 * The files this feature downloads, with the size and hash each one must have.
 *
 * Text is `q8` and vision is `fp32`, deliberately: measured on the owner's
 * Mac, q8 vision scored 0.984 cosine against the prototype's reference while
 * q8 text scored 0.99983 — well clear of the 0.999 bar — and fp32 vision is
 * the only precision that reproduces the prototype's picture scores. fp32
 * text would be exact but doubles the resident set for a difference text
 * does not have. `float16` is refused outright: it produces NaNs here.
 */
export const LOCAL_EMBEDDING_FILES: ModelFileSpec[] = [  { path: 'config.json', bytes: 5031, sha256: '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d' },
  { path: 'preprocessor_config.json', bytes: 560, sha256: '9344893f8d0573a46ebb2ca54c03f56d044cea194c8dcfb1f4d652240ac21daa' },
  { path: 'processor_config.json', bytes: 1788, sha256: '168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c' },
  { path: 'tokenizer.json', bytes: 32170510, sha256: '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4' },
  { path: 'tokenizer_config.json', bytes: 1599, sha256: '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874' },
  { path: 'chat_template.jinja', bytes: 1016, sha256: '4b852efc0b9960283e735363331e6f325b33bc74bdbaa076f595bc4e9b94d85e' },
  { path: 'onnx/model_quantized.onnx', bytes: 495165, sha256: 'd06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953' },
  { path: 'onnx/model_quantized.onnx_data', bytes: 313724928, sha256: '278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b' },
  { path: 'onnx/vision_encoder.onnx', bytes: 121253, sha256: 'a3fb44f8b5b152cfee6afe16e2cd69e774b7e1d3b822d1db1190ddf7b08b575e' },
  { path: 'onnx/vision_encoder.onnx_data', bytes: 671026176, sha256: 'ca8d28c99feb8129618f141978a27adae25090e0dadb68a30c235e191c01e37e' },
]

/**
 * The runtime files, verified the same way the model files are.
 *
 * Only two files are needed — the N-API binding and the libonnxruntime dylib
 * it links. The npm package ships all five platforms (307 MB unpacked); these
 * two are the whole of the darwin-arm64 slice.
 *
 * The dylib's filename is load-bearing: `otool -L` on the binding shows
 * `@rpath/libonnxruntime.1.dylib`, so it must be saved under exactly that name
 * even though the package also ships an identically-hashed
 * `libonnxruntime.1.31.1.dylib`. These hashes are the bytes published as
 * onnxruntime-node@1.31.1, checked against the npm package after download.
 */
export const LOCAL_RUNTIME_FILES: ModelFileSpec[] = [
  {
    path: 'onnxruntime_binding.node',
    bytes: 323512,
    sha256: '95ab5698fbcb34d035ea98266156ad5a06b76d0ee739ea42d660df6901df390a',
  },
  {
    path: 'libonnxruntime.1.dylib',
    bytes: 45331560,
    sha256: '9a362365243b56da98a2ad65128a32d6f8066d1f39ce697e0fce997adf0586dc',
  },
]

export function totalModelBytes(): number {
  return LOCAL_EMBEDDING_FILES.reduce((sum, file) => sum + file.bytes, 0)
}

export function totalRuntimeBytes(): number {
  return LOCAL_RUNTIME_FILES.reduce((sum, file) => sum + file.bytes, 0)
}

/** Human size for the "Download (≈N GB)" button. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

// ── Thresholds — Story policy, not model facts ──────────────────────────────
//
// These are NOT catalogue values and never will be (§1): they are not
// something GenStudio publishes, they are a judgement about what this app
// should point out to the owner. They were calibrated against 85 real scene
// images and 48 real titles from this repo's own channels, and they live here
// so the badge, the tests, and any future tuning read ONE number.
//
// Above the line the app says "looks like scene N" and shows the score; it
// never refuses, and a person decides what to do.

/** Two scene images at or above this cosine are near-duplicates. */
export const SCENE_NEAR_DUPLICATE_SCORE = 0.915
/** At or above this, and below the duplicate line, they merely look similar. */
export const SCENE_SIMILAR_SCORE = 0.88
/** Two titles at or above this cosine are the same idea, once the channel's formula is stripped. */
export const TITLE_DUPLICATE_SCORE = 0.85

// model-drift-allow: Story's own screening thresholds, calibrated on this repo's scenes and titles, not catalogue values.

/**
 * How many of the channel's recent episodes a scene is also compared against.
 * 0 would be "this episode only"; the owner asked for the channel's recent
 * history as an option, so the default is a small window and the per-channel
 * setting can turn it off.
 */
export const RECENT_EPISODE_WINDOW = 3

// ── The measured/unmeasurable split (§6) ────────────────────────────────────

/**
 * A comparison that happened, or an honest statement that it did not.
 *
 * `measured` carries a score. `unmeasurable` carries the reason, and that
 * reason reaches the screen — "not checked" on its own would be the silent
 * zero this repo has been bitten by before.
 */
export type ScreeningMeasurement<T> =
  | { state: 'measured'; value: T }
  | { state: 'unmeasurable'; reason: string }

export type DuplicateStrength = 'duplicate' | 'similar'

export interface SceneDuplicateMatch {
  /** The scene this one looks like. */
  scene_id: string
  scene_index: number
  /** Cosine similarity, so the badge can print it. */
  score: number
  strength: DuplicateStrength
  /** True when the match came from another episode rather than this one. */
  other_episode?: { episode_code: string; title?: string }
}

export interface SceneDuplicateResult {
  scene_id: string
  state: 'checked' | 'not_checked'
  /** Present only when `state` is `checked`. */
  matches: SceneDuplicateMatch[]
  /** Why nothing was checked, in words a person can act on. */
  reason?: string
}

export interface TitleDuplicateMatch {
  idea_id?: string
  episode_code?: string
  title: string
  /** The topic part — the channel's formula/prefix/suffix removed. */
  topic: string
  score: number
}

export interface TitleDuplicateResult {
  state: 'checked' | 'not_checked'
  matches: TitleDuplicateMatch[]
  reason?: string
}

/**
 * Which band a scene-pair score falls in, or `null` when it is below both.
 * One function so the badge, the API and the tests cannot disagree.
 */
export function sceneDuplicateStrength(score: number): DuplicateStrength | null {
  if (!Number.isFinite(score)) return null
  if (score >= SCENE_NEAR_DUPLICATE_SCORE) return 'duplicate'
  if (score >= SCENE_SIMILAR_SCORE) return 'similar'
  return null
}

/** The words the badge uses. A `similar` match is never called a duplicate. */
export function describeSceneMatch(match: SceneDuplicateMatch): string {
  const where = match.other_episode
    ? `scene ${match.scene_index} of ${match.other_episode.episode_code}${match.other_episode.title ? ` (${match.other_episode.title})` : ''}`
    : `scene ${match.scene_index}`
  const verb = match.strength === 'duplicate' ? 'looks like a duplicate of' : 'looks similar to'
  return `${verb} ${where} · ${match.score.toFixed(3)}`
}
