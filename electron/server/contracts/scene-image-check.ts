/**
 * The scene-image checks' shared policy, used by the server, the page that
 * shows the switches, and the offline bake-off tool.
 *
 * Zero-dependency on purpose: the frontend runtime imports this module too, so
 * both sides agree on WHEN the auto-remake switches unlock, on the rubric a
 * vision model is asked to apply, and on how its answer is read — without
 * either keeping its own copy.
 *
 * TWO CHECKS, deliberately separate (owner 2026-10-27):
 *   1. the FREE Florence check (`services/scene-image-quality-check.ts`), which
 *      answers "is a figure here, and is the picture on prompt" for $0, and
 *   2. the OPT-IN stronger vision check (`services/scene-image-vision-check.ts`),
 *      which asks a vision-capable chat product about anatomy, faces and text.
 * They record beside each other. Neither ever stands in for the other, and a
 * paid answer that could not be read is `could_not_check` — never a pass (§6).
 */

export const SCENE_IMAGE_CHECK_SHADOW_UNTIL = '2026-11-30T23:59:59.999Z'

/** True once the shadow phase is over (past shadow_until), so the auto-remake switch may be turned on. */
export function sceneImageCheckShadowOver(shadowUntil: string, now = Date.now()): boolean {
  const until = Date.parse(shadowUntil || SCENE_IMAGE_CHECK_SHADOW_UNTIL)
  return Number.isFinite(until) && now > until
}

// ── The opt-in stronger check ────────────────────────────────────────────────

/** The three defects the stronger check judges, one switch each for auto-remake. */
export const SCENE_VISION_AXES = ['anatomy', 'face', 'text'] as const
export type SceneVisionAxis = (typeof SCENE_VISION_AXES)[number]

/**
 * One axis's answer. These are four different facts and are never folded
 * together (AGENTS.md §6):
 *
 * - `pass`            the axis was measured and nothing was wrong
 * - `fail`            the axis was measured and a named defect was found
 * - `not_visible`     the axis does not apply to THIS picture (no people, no
 *                     face, no text) — a legitimate answer, not a pass
 * - `could_not_check` the axis could not be measured (unreadable answer, a
 *                     script no general vision model can be trusted with)
 *
 * The check as a whole has a fifth value, `not_checked`, used by the service
 * when no call happened at all (switch off, no model, provider failure).
 */
export type SceneVisionVerdict = 'pass' | 'fail' | 'not_visible' | 'could_not_check'

export interface SceneVisionAxisResult {
  verdict: SceneVisionVerdict
  /** Named defects. A `fail` always carries at least one — see `parseSceneVisionAnswer`. */
  findings: string[]
  /** Text axis only: what the model says it read off the picture. */
  transcription?: string
}

export interface SceneVisionAnswer {
  axes: Record<SceneVisionAxis, SceneVisionAxisResult>
  /** The model's own confidence, 0..1, or null when it did not state one. */
  confidence: number | null
}

/** More than this many findings is noise, and output tokens are what cost money. */
export const SCENE_VISION_MAX_FINDINGS = 5

/**
 * The rubric. Written from the published evidence (FINDINGS §2/§3): VLMs are
 * systematically LENIENT on hands, so the model is made to COUNT before it
 * judges, and a pass without a count is not allowed. Nothing here is a story or
 * a product fact — it is an instruction about how to look at a picture.
 */
const SCENE_VISION_MODEL_RUBRIC = [
  'You are a quality inspector for AI-generated story scene images.',
  'Judge exactly three axes and nothing else: anatomy, face, text.',
  '',
  'ANATOMY — before you judge, COUNT. For every person in the picture:',
  'count the fingers on each hand (five on each, one thumb), the arms, the legs,',
  'and the eyes. Then name any defect: fused fingers, an extra finger, a missing',
  'finger, two thumbs, an extra limb, a missing limb, a limb joined to the wrong',
  'body part, a hand with no arm. You may not answer "pass" without having counted',
  'hands and limbs. If no person or animal is visible, answer "not_visible".',
  '',
  'FACE — is each visible face structurally plausible? Look for asymmetric eyes,',
  'a melted or duplicated feature, impossible teeth, a warp across the face.',
  'If no face is visible, answer "not_visible".',
  '',
  'TEXT — transcribe every readable word exactly as drawn into "transcription".',
  'Then judge only whether the glyphs are real characters in a real script, not',
  'whether the sentence makes sense. Garbled pseudo-script, repeated or melting',
  'characters, and letters that are not letters are a defect. If no text is',
  'visible, answer "not_visible" and leave "transcription" empty.',
  '',
  'Rules:',
  '- Judge only what you can see. Never guess at something cut off or too small.',
  `- At most ${SCENE_VISION_MAX_FINDINGS} findings per axis, each one short, plain and specific`,
  '  ("left hand has six fingers"), never a generic complaint.',
  '- A defect must be named. Never fail an axis without a finding.',
  '- "confidence" is your own 0..1 confidence in the whole answer.',
  '- Answer with ONE JSON object and nothing else.',
].join('\n')

/** The JSON shape asked for, appended to the rubric so a prose-only product still knows it. */
const SCENE_VISION_ANSWER_SHAPE = '{"anatomy":{"verdict":"pass|fail|not_visible","findings":[]},'
  + '"face":{"verdict":"pass|fail|not_visible","findings":[]},'
  + '"text":{"verdict":"pass|fail|not_visible","transcription":"","findings":[]},'
  + '"confidence":0.0}'

export function sceneVisionSystemPrompt(): string {
  return `${SCENE_VISION_MODEL_RUBRIC}\n\nReturn exactly this shape:\n${SCENE_VISION_ANSWER_SHAPE}`
}

/**
 * What this picture was supposed to be, and — when Story itself drew the words
 * — the exact text they should read. The expected string is the objective
 * comparison the literature asks for; without it the model can only judge
 * whether the glyphs are real.
 */
export function sceneVisionUserPrompt(input: { visualPrompt: string; expectedText?: string | null }): string {
  const lines = [`The scene was asked for: ${input.visualPrompt.trim()}`]
  const expected = (input.expectedText || '').trim()
  if (expected) lines.push(`The text layer was drawn from this exact string: ${expected}`)
  return lines.join('\n')
}

export class SceneVisionMalformedAnswerError extends Error {
  constructor(message: string) { super(message); this.name = 'SceneVisionMalformedAnswerError' }
}

/**
 * `no_people`, `no face`, `n/a` … all mean the axis does not apply to this
 * picture. Deliberately NOT `none`: that word is just as likely to mean "no
 * defects", and reading it as "nothing to judge" would quietly hide a pass.
 * Anything ambiguous falls through to `could_not_check`, which is honest.
 */
const NOT_VISIBLE_WORDS = new Set(['no_people', 'no_person', 'no_face', 'no_text', 'not_applicable', 'not visible', 'n/a'])

function normalizeVerdict(raw: unknown): SceneVisionVerdict | null {
  if (typeof raw !== 'string') return null
  const token = raw.trim().toLowerCase()
  // The rubric's own spelling is accepted first: the answer is read with the
  // vocabulary it was asked in.
  if (token === 'not_visible') return 'not_visible'
  if (NOT_VISIBLE_WORDS.has(token)) return 'not_visible'
  if (token === 'pass' || token === 'passed' || token === 'ok') return 'pass'
  if (token === 'fail' || token === 'failed' || token === 'defect') return 'fail'
  if (token === 'could_not_check' || token === 'unmeasurable' || token === 'unknown') return 'could_not_check'
  return null
}

function readFindings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, SCENE_VISION_MAX_FINDINGS)
}

/**
 * Read one answer. **Never invents an axis, and never turns an unreadable
 * answer into a pass:** anything missing, misspelled or unreasoned is
 * `could_not_check` for that axis, which is the honest "I could not measure
 * this" (§6). Only a whole non-JSON answer throws, because then there is
 * nothing to attribute to any axis.
 */
export function parseSceneVisionAnswer(raw: string): SceneVisionAnswer {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: unknown
  try { value = JSON.parse(text) } catch {
    throw new SceneVisionMalformedAnswerError('The vision model did not return a JSON object.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SceneVisionMalformedAnswerError('The vision model returned a JSON value that is not an object.')
  }
  const row = value as Record<string, unknown>
  const axes = {} as Record<SceneVisionAxis, SceneVisionAxisResult>
  for (const axis of SCENE_VISION_AXES) {
    const entry = row[axis]
    const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null
    const findings = readFindings(source?.findings)
    let verdict = normalizeVerdict(source?.verdict)
    // A fail with no named defect is an unreasoned verdict. "Never a score
    // without a reason" — record what actually happened, not a pass.
    if (verdict === 'fail' && !findings.length) verdict = 'could_not_check'
    const transcription = axis === 'text' && typeof source?.transcription === 'string'
      ? source.transcription.trim().slice(0, 400)
      : undefined
    const result: SceneVisionAxisResult = { verdict: verdict ?? 'could_not_check', findings }
    if (transcription) result.transcription = transcription
    // Never trust a general vision model to READ Khmer (FINDINGS §1: Khmer CER
    // 67–99%). The glyphs may still be judged, but the reading is unmeasurable.
    if (axis === 'text' && hasMyanmarScript(transcription || '')) {
      result.verdict = 'could_not_check'
      result.findings = ['Khmer text cannot be read reliably by a general vision model, so this picture’s text was not checked.']
    }
    axes[axis] = result
  }
  const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence)
    ? Math.max(0, Math.min(1, row.confidence))
    : null
  return { axes, confidence }
}

/** Khmer (and Pali/Sanskrit written in Khmer) — U+1780–U+17FF. */
export function hasMyanmarScript(text: string): boolean {
  return /[ក-៿]/.test(text)
}

/** Strip what two renderings of the same words differ by that is not a difference in the words. */
function normalizeTextForComparison(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compare what the picture SAYS with the string Story drew it from.
 *
 * This is the only text verdict with real evidence behind it (FINDINGS §3):
 * no OCR trust is needed when the expected string is already known. Khmer is
 * unmeasurable for the same reason as above — say so rather than pretend.
 */
export function compareExpectedText(expected: string, transcription: string): SceneVisionAxisResult {
  const want = (expected || '').trim()
  if (!want) return { verdict: 'could_not_check', findings: ['No expected text was supplied, so the picture’s text could not be compared.'] }
  if (hasMyanmarScript(want)) {
    return {
      verdict: 'could_not_check',
      findings: ['Khmer text cannot be read reliably by a general vision model, so this picture’s text was not checked.'],
    }
  }
  const got = (transcription || '').trim()
  if (!got) {
    return { verdict: 'fail', findings: [`The picture was asked to show “${want.slice(0, 120)}” but no text was read from it.`] }
  }
  if (normalizeTextForComparison(want) === normalizeTextForComparison(got)) {
    return { verdict: 'pass', findings: [], transcription: got }
  }
  return {
    verdict: 'fail',
    findings: [`The picture should read “${want.slice(0, 120)}” but reads “${got.slice(0, 120)}”.`],
    transcription: got,
  }
}
