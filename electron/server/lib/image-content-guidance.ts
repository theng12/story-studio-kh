/**
 * Content-aware guidance for every LLM that WRITES an image prompt.
 *
 * Image providers apply their own content filters, and ordinary subject matter
 * brushes against them innocently and constantly: conflict and its aftermath,
 * death, plague and famine, children in a scene, classical art nudity,
 * anatomical and medical illustration.
 *
 * v1.4.11 — this block used to open by ASSERTING "This is a history and
 * documentary channel", and steered the hardest subjects towards woodcut and
 * engraving. Every channel got it: *"also make the don't make it all history
 * and documentary channel."* His eleven channels include fungi, plants,
 * insects, motivation, prayer, preaching and business economics, and each one
 * was being told what it was and what it should look like by a helper whose job
 * is neither. What survives is the TECHNIQUE — how to describe a difficult
 * subject so a provider renders it — which is what earns the block its place.
 * A channel that genuinely wants a period-illustration look says so in its own
 * visual style, which is editable and belongs to the channel.
 *
 * Providers vary and their policies are not ours to track, so the fix lives at
 * the PROMPT, on our side: a prompt that never trips a filter beats any amount
 * of reacting to one that did. This module is the single place that guidance is
 * written; every prompt-writing path imports it rather than restating it.
 *
 * It is written as CRAFT guidance ("describe it this way and it renders
 * better"), not as a list of prohibitions, and it says so out loud in the text:
 * the historical substance must survive. The failure mode being guarded against
 * is a writer that sanitises the era into a blander scene — that would be a
 * worse outcome than a refusal.
 *
 * Consumed by:
 *   - services/scene-planner.ts      — buildScenePlannerPrompt (one-pass +
 *                                      windowed planner), generateVisualPromptOnly
 *   - generators/scene-plan.ts       — the packed visual-prompt writer
 *   - generators/prompt-director.ts  — the guide + scene Visual Recipe compositors
 *   - generators/image-prompts.ts    — thumbnail briefs
 *   - routes/image-prompts-edit.ts   — per-row regenerate / reword
 *
 * Motion prompts do NOT consume this: they describe camera and ambient movement
 * over an already-approved still, and never introduce subject matter of their
 * own.
 *
 * ── Legible text in SCENE images only ───────────────────────────────────────
 * `AVOID_LEGIBLE_TEXT_GUIDANCE` / `legibleTextGuidanceBlock` is a SEPARATE,
 * opt-in block (default off — see `resolveAvoidLegibleText`) for one narrow
 * problem: a fast image model asked to render a scroll, ledger, or sign
 * usually renders confident-looking gibberish instead of real words. Channels
 * depict written surfaces constantly and legitimately — a scribe at work, a
 * field notebook, a shop sign — so the fix is never "stop showing documents."
 * It is: when a prompt-writing pass has
 * this switched on, describe lettering as indistinct marks/texture rather
 * than as specific readable words, so the renderer stops attempting words it
 * will get wrong.
 *
 * Deliberately a SEPARATE block from `IMAGE_CONTENT_GUIDANCE`, not folded
 * into it: the content-safety guidance applies to every prompt-writing path
 * unconditionally, while this one must reach scene prompts only and must
 * never reach the Thumbnail path — a YouTube thumbnail's whole job is a
 * legible in-image title (see `buildThumbnailPrompt` in
 * generators/image-prompts.ts, which requires the opposite: "Render the
 * exact episode title as legible in-image typography"). Keeping this as an
 * independent opt-in call means a caller has to ask for it by name; nothing
 * about calling `imagePromptGuidanceBlock()` for the shared content-safety
 * guidance can accidentally pull this in too.
 *
 * Per-project toggle (config.json `avoid_legible_text_in_scenes`, default ON
 * — see `resolveAvoidLegibleText`): the local fleet's fast model is the
 * primary scene renderer and is the one that garbles lettering; a project
 * whose scenes render on a higher-quality model (GPT Image 2, Nano Banana
 * Pro) that gets real words right can turn this off in Scene Plan settings.
 *
 * ── On rewriting after a refusal ────────────────────────────────────────────
 * `IMAGE_PROMPT_REWORD_DIRECTIVE` powers a MANUAL, user-invoked reword only.
 * GenStudio's exact terminal `IMAGE_CONTENT_REFUSED` code can identify that
 * one refusal in job diagnostics. Pattern-matching provider error text remains
 * forbidden — it would break the first time a provider reworded its message.
 * The code can offer this existing action, but must never invoke it on the
 * customer's behalf; every other failure stays unknown.
 */

/**
 * How to describe difficult subject matter so it renders.
 *
 * Appended to the SYSTEM/instruction side of an image-prompt-writing call.
 * Deliberately opens and closes by insisting the substance is kept intact.
 *
 * Says nothing about what KIND of channel this is and nothing about what it
 * should look like — see the v1.4.11 note at the top of this file. Both are the
 * channel's to decide, and both used to be asserted here to all of them.
 */
export const IMAGE_CONTENT_GUIDANCE = `DIFFICULT SUBJECTS — how to describe them so they render:

Some scenes brush against an image provider's content filters innocently: conflict and its aftermath, death, plague and famine, medicine and anatomy, classical art. Every prompt must stay vivid, specific, and true to its subject. Do NOT sanitise the scene, soften the stakes, or retreat to a safer subject. Write the SAME scene, described differently:

- Show the AFTERMATH or the CONSEQUENCE rather than the violent act itself. "A battlefield at dawn, abandoned shields in the churned mud" carries the same narrative beat as depicting the killing, and renders far better.
- Convey suffering through ENVIRONMENT and POSTURE, not injury. A bowed figure and an empty grain store tells a famine. No wounds, no blood, no bodily detail.
- Never put an explicit age marker on a figure. Write "a young apprentice at the workbench", not a stated age or a child's physical size. Children in a scene are entirely legitimate subjects; it is the explicit marker that is left out.
- Dress every figure in full, formal clothing appropriate to the setting, including where a source artwork was nude.
- For medical and anatomical beats, show the diagram, the instruments, the physician's room, or the apothecary's shelves — not a procedure carried out on a body.

These are choices of framing, not of subject. The substance, the setting, and the specificity must be preserved in full. Follow the channel's own visual style for how the image should LOOK; nothing here overrides it.`

/**
 * Extra steering for a user-invoked reword of ONE prompt that did not render.
 *
 * Always sent together with `IMAGE_CONTENT_GUIDANCE` (it refers to it), and
 * asks for a genuinely different angle rather than a re-shuffle of the wording
 * that already failed.
 */
export const IMAGE_PROMPT_REWORD_DIRECTIVE = `REWORD REQUEST — the user has asked for this prompt to be rewritten because it did not render.

Write a genuinely DIFFERENT description of the SAME narrative beat: pick another moment inside that beat, another vantage point, or another subject in the scene that carries the same story point. Do not simply re-order or re-word the sentences you were given — a near-identical prompt is a wasted rewrite.

Equally, do not retreat to a vaguer, emptier, or more generic scene. The setting, the substance, and the level of concrete detail must all survive the rewrite; only the angle changes.

Apply the difficult-subjects guidance above in full: aftermath over act, environment and posture over injury, clothing appropriate to the setting, and no explicit age markers. Keep the channel's own visual style unchanged — the rewrite changes the angle, never the look.`

/**
 * The guidance as a block to splice into a prompt, with leading/trailing
 * separation. `include: false` yields an empty string so callers can wire it in
 * unconditionally.
 */
export function imageContentGuidanceBlock(include = true): string {
  return include ? `\n\n${IMAGE_CONTENT_GUIDANCE}` : ''
}

/**
 * The guidance plus, when a reword was asked for, the different-angle
 * directive. This is the single entry point every prompt-writing path uses, so
 * a reword can never be steered without the guidance that makes it useful.
 */
export function imagePromptGuidanceBlock(opts: { reword?: boolean } = {}): string {
  return opts.reword
    ? `\n\n${IMAGE_CONTENT_GUIDANCE}\n\n${IMAGE_PROMPT_REWORD_DIRECTIVE}`
    : `\n\n${IMAGE_CONTENT_GUIDANCE}`
}

/**
 * How to describe lettering so it renders as a plausible written surface
 * instead of garbled pseudo-text. SCENE prompt-writers only — see the
 * "Legible text in SCENE images only" note at the top of this file for why
 * this is intentionally a separate, opt-in block rather than folded into
 * `IMAGE_CONTENT_GUIDANCE` (which every path, including thumbnails, gets
 * unconditionally).
 */
export const AVOID_LEGIBLE_TEXT_GUIDANCE = `AVOID LEGIBLE TEXT: When this scene includes a scroll, ledger, page, inscription, sign, banner, or any other lettered surface, describe its writing as indistinct marks, weathered script, or dense linework — texture, not language. Never specify a word, phrase, name, or quoted line that must appear rendered and readable in the image. The document, sign, or inscription stays a fully legitimate subject in full period detail; only the individual letters should read as suggestion rather than as legible text, because an image model asked for specific words usually renders confident-looking gibberish instead.`

/**
 * The legible-text block to splice into a SCENE prompt-writer's instructions.
 * `include` defaults to false — callers must opt in by name (see
 * `resolveAvoidLegibleText` for the per-run / per-project toggle this powers)
 * so nothing pulls this in by accident the way `imagePromptGuidanceBlock()`
 * pulls in the content-safety guidance unconditionally.
 */
export function legibleTextGuidanceBlock(include = false): string {
  return include ? `\n\n${AVOID_LEGIBLE_TEXT_GUIDANCE}` : ''
}

/**
 * Resolve whether a SCENE prompt-writing call should suppress legible text.
 * An explicit per-run value (the "Avoid readable text in images" toggle's
 * current state, submitted with the request) always wins; otherwise falls
 * back to the project's saved default (config.json
 * `avoid_legible_text_in_scenes`). Unset (both undefined, e.g. a project that
 * predates this setting) resolves to ON: the local fleet's fast model is the
 * primary scene renderer across these channels and is the one that garbles
 * lettering, so the safer default is to describe it as texture. A project on
 * a higher-quality model that renders real words correctly can turn this off
 * once in Scene Plan settings — see frontend/pages/projects/[slug]/scene-plan.vue.
 */
export function resolveAvoidLegibleText(explicit?: boolean | null, projectDefault?: boolean | null): boolean {
  if (explicit != null) return explicit
  return projectDefault !== false
}
