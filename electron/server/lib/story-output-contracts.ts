import type { TextOutputContract } from './json-output-contract.js'

/** Narrow on purpose, not `TextOutputContract`: two builders below spread this
 *  result and add `accept`, which only the `json_object` arm carries. */
type JsonObjectContract = Extract<TextOutputContract, { mode: 'json_object' }>

/**
 * Story workflows ask GenStudio language products for a JSON object and state
 * the required structure in the request instructions. The schema is retained on
 * the contract so the returned object is validated LOCALLY, and so the required
 * shape can be described to the product. GenStudio language products are never
 * required to enforce a provider-native strict JSON schema.
 */
function localSchema(name: string, schema: Record<string, unknown>): JsonObjectContract {
  return { mode: 'json_object', name, schema }
}

/**
 * One batch of thumbnail briefs for a single episode.
 *
 * WHAT IS ASKED FOR is unchanged in substance: exactly one entry per requested
 * thumbnail slot, a headline and a prompt on each. `number` is now DECLARED
 * rather than forbidden, which fixes a contradiction that could only ever
 * destroy paid work: `buildThumbnailPrompt` shows the model the literal shape
 * `{"number": N, "title": …, "prompt": …}` and tells it "return entries for
 * thumbnail numbers 2, 5, 7 in that order", while this schema listed only
 * `title` + `prompt` under `additionalProperties: false`. A model that obeyed
 * the prompt was rejected for an "unexpected key" it had been explicitly asked
 * to send. Story Studio still IGNORES the returned value (see below); it is
 * declared so that following the instructions is not a failure.
 *
 * WHAT IS ACCEPTED is the envelope, and the slot→prompt guarantee does not live
 * here — it cannot, because the model never addresses a slot. Numbering is
 * assigned by Story Studio in `generators/image-prompts.ts`:
 *
 *   1. `targetNumbers` is computed locally as the slots 1..count that are NOT
 *      already verified on disk. It is the only source of thumbnail numbers.
 *   2. `normalizeGeneratedPromptItems` drops any item without a non-empty
 *      string `prompt`, and slices to `targetNumbers.length`, so an over-long
 *      or half-formed batch cannot overflow the requested slots.
 *   3. The caller then stamps `number: targetNumbers[index]`, so a returned row
 *      can only ever land on a slot this run asked for — and the episode is
 *      fixed by the job, never by the response.
 *
 * COMPLETENESS is enforced after that, from the merged set: `missing` is
 * recomputed over 1..count and handed to `requireJobCompletion`, and the
 * `fill_gaps` path re-requests exactly the missing slots. A short batch is
 * therefore already a first-class outcome — k prompts saved, count-k reported
 * and repairable. Demanding exactly `count` items here could only convert that
 * into zero prompts saved and nothing to repair.
 */
export function thumbnailPromptsOutputContract(count: number): TextOutputContract {
  return {
    ...localSchema('story_thumbnail_prompts', {
      type: 'object',
      properties: {
        thumbnails: {
          type: 'array',
          minItems: count,
          maxItems: count,
          items: {
            type: 'object',
            properties: {
              // Asked for, echoed back, and then deliberately overwritten with
              // the locally computed slot. Declared with no `maximum`: under
              // `fill_gaps` the requested slots are sparse (2, 5, 7 of 8) and
              // legitimately exceed `count`, which is the number of slots still
              // outstanding, not the highest slot.
              number: { type: 'integer', minimum: 1 },
              title: { type: 'string', minLength: 1, maxLength: 200 },
              prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
            },
            required: ['title', 'prompt'],
            additionalProperties: false,
          },
        },
      },
      required: ['thumbnails'],
      additionalProperties: false,
    }),
    // A batch with no usable row at all is still refused here, loudly. The
    // generator would otherwise report `count` silent omissions instead of one
    // empty answer.
    accept: {
      type: 'object',
      properties: { thumbnails: { type: 'array', minItems: 1 } },
      required: ['thumbnails'],
    },
  }
}

/**
 * One pack of scene prompts, asked for by exact scene id.
 *
 * WHAT IS ASKED FOR (`schema`) IS UNCHANGED, and deliberately strict: exactly
 * one row per requested id, the id drawn from an enum of precisely the ids sent
 * in this pack, and no extra keys. All of it is rendered into the request
 * instructions, so the model is told exactly which ids exist and how many rows
 * to produce. Weakening that would make a mis-numbered row MORE likely, not
 * less, so none of it is weakened.
 *
 * WHAT IS ACCEPTED (`accept`) IS THE ENVELOPE ONLY, and this is the fix for a
 * real incident. A 40-scene pack came back with 39 perfect rows and one row
 * that wrote `"scene"` where the contract says `"scene_id"`. The atomic local
 * check rejected the whole object, so 39 correct prompts the owner had already
 * been charged for were discarded, and — because the rejection surfaced as a
 * thrown request error rather than a partial result — the generator's automatic
 * repair pass never ran either. All-or-nothing turned one bad row into zero
 * rows AND no recovery.
 *
 * ACCEPTING THE ENVELOPE DOES NOT WEAKEN THE ID→MOMENT GUARANTEE. A prompt
 * reaches disk only past three independent per-item guards, all in
 * `generators/scene-plan.ts`, none of which this contract feeds:
 *
 *   1. `parseDirectPackResults` keeps a row only if `allowed.has(id)`, where
 *      `allowed` is exactly the ids requested. A hallucinated, mis-numbered, or
 *      id-less row is dropped there and can never become a prompt.
 *   2. `checkpointPackPromptResults` refuses any id outside `expectedIds` and
 *      records it as an error rather than persisting it.
 *   3. `persistPrompt` throws for any id outside the run's `targetIds`.
 *
 * COMPLETENESS IS ALSO STILL ENFORCED, and enforced better: by
 * `auditScenePromptCompletion`, which re-reads the saved plan FROM DISK and
 * reports the ids that are genuinely missing. That audit — not a count at the
 * transport boundary — is what gates the stage and what drives the bounded
 * repair request for exactly the missing ids. A count check here can only
 * convert "39 saved, repair the 40th" into "0 saved, repair nothing".
 */
export function scenePromptPackOutputContract(
  sceneIds: readonly string[],
  kind: 'visual' | 'motion',
): TextOutputContract {
  const promptKey = kind === 'motion' ? 'motion_prompt' : 'visual_prompt'
  return {
    ...localSchema('story_scene_prompt_pack', {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          minItems: sceneIds.length,
          maxItems: sceneIds.length,
          items: {
            type: 'object',
            properties: {
              scene_id: { type: 'string', enum: [...sceneIds] },
              [promptKey]: { type: 'string', minLength: 1, maxLength: 20_000 },
            },
            required: ['scene_id', promptKey],
            additionalProperties: false,
          },
        },
      },
      required: ['results'],
      additionalProperties: false,
    }),
    // A response with no usable rows at all is still refused here, loudly — the
    // reader downstream would otherwise report 40 silent omissions instead of
    // one empty answer.
    accept: {
      type: 'object',
      properties: { results: { type: 'array', minItems: 1 } },
      required: ['results'],
    },
  }
}

/**
 * Contextual cue proposals.
 *
 * Same shape of exposure as the scene prompt pack, milder: no exact count and
 * no id enum, but `additionalProperties: false` on each cue and a 100-item cap
 * meant one volunteered key — or a 101st proposal — discarded every cue in the
 * batch. `generators/contextual-cues.ts` already vets each cue on its own:
 * `parseCandidates` keeps only rows with a string `scene_id` and `title`, and
 * `safeCandidate` resolves that `scene_id` against the saved plan and returns
 * null when it names no real scene. So a cue can no more land on the wrong
 * moment than a prompt can — and, unlike the pack, an EMPTY list is a
 * legitimate answer here ("prefer no cue when uncertain"), so `accept` sets no
 * minimum.
 */
export const CONTEXTUAL_CUES_OUTPUT_CONTRACT: TextOutputContract = {
  ...localSchema(
    'story_contextual_cues',
    {
      type: 'object',
      properties: {
        cues: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              scene_id: { type: 'string', minLength: 1, maxLength: 128 },
              title: { type: 'string', minLength: 1, maxLength: 80 },
              subtitle: { type: 'string', maxLength: 100 },
              kind: {
                type: 'string',
                enum: ['location_date', 'historical_context', 'person', 'chapter'],
              },
              template: {
                type: 'string',
                enum: ['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate'],
              },
              anchor_offset_sec: { type: 'number', minimum: 0 },
            },
            required: ['scene_id', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['cues'],
      additionalProperties: false,
    },
  ),
  accept: {
    type: 'object',
    properties: { cues: { type: 'array' } },
    required: ['cues'],
  },
}

/**
 * A generated idea batch.
 *
 * The array is WRAPPED in an object on purpose. A bare top-level array cannot
 * be requested through this mechanism — `json_object` validation requires one
 * object, and the schema instruction builder describes an object — so the
 * shape asked for and the shape validated would disagree. The prompts ask for
 * the same wrapper, and every reader of this response takes the array by
 * slicing from the first `[` to the last `]`, which the wrapper preserves.
 *
 * Item keys are typed but their EDITORIAL rules (length, voice, chapter-count
 * consistency) stay in the prompt, which is their single source of truth.
 *
 * NO item-count bound, deliberately. The requested count is stated in the
 * prompt, and both readers already handle a long batch (they slice) and a
 * short one (they re-prompt for the shortfall). Enforcing the count here would
 * throw away a usable batch the customer has already been charged for.
 */
export function ideaBatchOutputContract(): TextOutputContract {
  return localSchema('story_idea_batch', {
    type: 'object',
    properties: {
      ideas: {
        type: 'array',
        minItems: 1,
        items: ideaItemSchema(),
      },
    },
    required: ['ideas'],
    additionalProperties: false,
  })
}

/** Idea Campaign: one idea per reserved assignment, keyed by `idea_key`. */
export function ideaCampaignOutputContract(ideaKeys: readonly string[]): TextOutputContract {
  const item = ideaItemSchema()
  return localSchema('story_idea_campaign', {
    type: 'object',
    properties: {
      ideas: {
        type: 'array',
        minItems: 1,
        items: {
          ...item,
          properties: {
            idea_key: { type: 'string', enum: [...ideaKeys] },
            ...(item.properties as Record<string, unknown>),
          },
          required: ['idea_key', 'title', 'logline'],
        },
      },
    },
    required: ['ideas'],
    additionalProperties: false,
  })
}

function ideaItemSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 300 },
      logline: { type: 'string', minLength: 1, maxLength: 2_000 },
      themes: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 200 } },
      suggested_chapters: { type: 'integer', minimum: 1, maximum: 100 },
      suggested_length: { type: 'string', maxLength: 100 },
      mood: { type: 'string', maxLength: 200 },
    },
    required: ['title', 'logline'],
  }
}

/**
 * Metadata template placeholder extraction.
 *
 * Every requested placeholder is REQUIRED and non-empty. A blank value here
 * does not fail loudly on its own — it is substituted into a YouTube title or
 * description and published as a gap — so the missing value is refused at the
 * contract instead of travelling.
 */
export function metadataPlaceholderOutputContract(keys: readonly string[]): TextOutputContract {
  const properties: Record<string, unknown> = {}
  for (const key of keys) properties[key] = { type: 'string', minLength: 1, maxLength: 2_000 }
  return localSchema('story_metadata_placeholders', {
    type: 'object',
    properties,
    required: [...keys],
    additionalProperties: false,
  })
}

/** One regenerated scene/thumbnail image prompt. */
export function singleImagePromptOutputContract(): TextOutputContract {
  return localSchema('story_single_image_prompt', {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 300 },
      prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
    },
    required: ['prompt'],
    additionalProperties: false,
  })
}

/**
 * Image Pool "suggest prompts from a topic". Wrapped for the same reason as
 * the idea batch above; the route reads the array by slicing `[` … `]`. The
 * requested count lives in the prompt and the route slices to it, so no item
 * count is enforced here.
 */
export function imagePoolPromptsOutputContract(): TextOutputContract {
  return localSchema('story_image_pool_prompts', {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1, maxLength: 20_000 },
      },
    },
    required: ['prompts'],
    additionalProperties: false,
  })
}

/**
 * The chapter outline for one episode.
 *
 * THIS ONE STAYS STRICT, ON PURPOSE. It is the third contract in this file that
 * demands `minItems === maxItems`, and the only one where relaxing it would
 * make things worse rather than better. Three reasons, in order of weight:
 *
 * 1. A PARTIAL OUTLINE IS NOT PARTIAL WORK — IT IS A WRONG ANSWER. A scene
 *    prompt pack is 40 independent answers to 40 independent questions, so 39
 *    of them are worth 39/40. An outline is ONE answer: a single arc, planned
 *    as a whole, in which chapter 1 hooks, the middle develops and chapter N
 *    resolves (see `narrativeOutlinePrompt`). Seven of ten chapters is not
 *    seven-tenths of that arc; it is a different, truncated story whose ending
 *    is missing. Chapter numbering carries meaning here in a way a thumbnail
 *    slot does not.
 *
 * 2. THERE IS NO REPAIR MACHINERY TO RE-REQUEST THE MISSING CHAPTERS. Scene
 *    prompts have `auditScenePromptCompletion` and a bounded repair pack scoped
 *    to the missing ids; thumbnails have `fill_gaps` + `targetNumbers`.
 *    The outline stage has neither: `callForJsonArray`'s retry loop is disabled
 *    for hosted products, `withModelFallback` retries only a dead product id,
 *    and `job-retry-policy` makes `outline_only` MANUAL_ONLY. The only recovery
 *    is a human rebuilding the whole outline. Accepting a short one would
 *    therefore not buy a repairable partial — there is nothing to repair with.
 *
 * 3. A SHORT OUTLINE DOES NOT STAY SHORT — IT GETS PADDED. `buildOutline`
 *    backfills every uncovered slot with `{ n, title: "Chapter n" }` so callers
 *    keep `outline.length === totalChapters`. Those placeholders carry no
 *    synopsis, beats or hook; they are expanded into unanchored filler
 *    narration, written to disk, and then pass every completion audit
 *    (`requireJobCompletion` in `generators/episode.ts` compares against the
 *    padded length, and `inspectChunkedScriptCompletion` derives its expected
 *    numbers from the padded sidecar). Loosening `minItems` would convert this
 *    contract's loud, cheap, pre-expansion rejection into a full-length episode
 *    with hollow chapters that nothing downstream reports — trading one failed
 *    outline request for a whole expansion run's worth of wasted credits.
 *
 * The one thing that WAS wrong here is that reason 3 could already happen
 * without this contract noticing: `chapters` of the right LENGTH but with a
 * repeated or out-of-range `n` (`1,2,…,9,9`) satisfies every bound below, and
 * `buildOutline` deduplicated it into a silent placeholder. JSON Schema cannot
 * express "these `n` values are distinct and cover 1..N", so that check lives
 * where it can — `buildOutline` now names every slot it had to synthesise, in
 * the job log, instead of padding in silence.
 */
/**
 * v1.4.36 — THE FLOOR IS THE CONTRACT. THE CEILING IS HEADROOM.
 *
 * Everything argued above is about an outline that is too SHORT, and all of it
 * still stands. None of it applies to one that is too LONG: every chapter
 * asked for is present, nothing is padded, nothing expands into filler. There
 * is simply more.
 *
 * `maxItems` used to equal `chapterCount`, so a model that wrote an eleventh
 * chapter for a ten-chapter target had its entire answer rejected — after
 * GenStudio had completed the request and charged for it, with the retry
 * MANUAL. The owner paid for a complete outline and received nothing, because
 * it over-delivered. His ruling on seeing it (2026-08-23): "i embrace this
 * extra chapters... longer videos means more screen time more ads slot... we
 * must never have hardcoded maximum."
 *
 * `maxChapters` therefore comes from the owner's `outline_chapter_headroom`
 * setting rather than from this file. It is not a quality bar — it is a
 * runaway guard, because a malformed answer with 500 chapters becomes 500 paid
 * expansion calls. `n`'s upper bound moves with it for the same reason: leaving
 * it at `chapterCount` would have let an eleventh chapter through the array
 * bound and then rejected it one level down, which is the same bug wearing a
 * different hat.
 *
 * @param chapterCount the target — a FLOOR, and still exact in what it demands.
 * @param maxChapters  the ceiling. Defaults to the target when not supplied, so
 *   every caller that has not been taught about headroom behaves exactly as it
 *   did before this parameter existed.
 */
export function outlineOutputContract(chapterCount: number, maxChapters?: number): TextOutputContract {
  const ceiling = Math.max(chapterCount, Math.floor(maxChapters ?? chapterCount))
  return localSchema('story_outline', {
    type: 'object',
    properties: {
      chapters: {
        type: 'array',
        minItems: chapterCount,
        maxItems: ceiling,
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', minimum: 1, maximum: ceiling },
            title: { type: 'string', minLength: 1, maxLength: 300 },
            synopsis: { type: 'string', maxLength: 5_000 },
            hook_line: { type: 'string', maxLength: 2_000 },
            key_beats: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string', maxLength: 2_000 },
            },
            key_facts: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string', maxLength: 2_000 },
            },
          },
          required: ['n', 'title'],
          additionalProperties: false,
        },
      },
    },
    required: ['chapters'],
    additionalProperties: false,
  })
}

/** Covered-topics map delta (1.4.285): only additions, grouped. Counts merge server-side. */
export function coveredTopicsOutputContract(): TextOutputContract {
  const group = {
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, count: { type: 'integer', minimum: 1 } },
      required: ['name'],
      additionalProperties: false,
    },
  }
  return localSchema('story_covered_topics', {
    type: 'object',
    properties: {
      add: {
        type: 'object',
        properties: { subjects: group, people: group, places: group, eras: group, angles: group },
        additionalProperties: false,
      },
    },
    required: ['add'],
    additionalProperties: false,
  })
}

/** #3 (1.4.293): new Topic Pack subjects proposed by the idea helper model. */
export function grownSubjectsOutputContract(): TextOutputContract {
  return localSchema('story_grown_subjects', {
    type: 'object',
    properties: {
      subjects: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, why_it_fits: { type: 'string', maxLength: 300 } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    required: ['subjects'],
    additionalProperties: false,
  })
}

/** #5 (1.4.293): Wikipedia categories proposed for the owner to review. */
export function referenceCategoriesOutputContract(): TextOutputContract {
  return localSchema('story_reference_categories', {
    type: 'object',
    properties: { categories: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 120 } } },
    required: ['categories'],
    additionalProperties: false,
  })
}
