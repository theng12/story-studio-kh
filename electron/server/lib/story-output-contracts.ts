import type { TextOutputContract } from './json-output-contract.js'

/**
 * Story workflows ask GenStudio language products for a JSON object and state
 * the required structure in the request instructions. The schema is retained on
 * the contract so the returned object is validated LOCALLY, and so the required
 * shape can be described to the product. GenStudio language products are never
 * required to enforce a provider-native strict JSON schema.
 */
function localSchema(name: string, schema: Record<string, unknown>): TextOutputContract {
  return { mode: 'json_object', name, schema }
}

export function thumbnailPromptsOutputContract(count: number): TextOutputContract {
  return localSchema('story_thumbnail_prompts', {
    type: 'object',
    properties: {
      thumbnails: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          properties: {
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
  })
}

export function videoPromptsOutputContract(count: number): TextOutputContract {
  return localSchema('story_video_prompts', {
    type: 'object',
    properties: {
      scenes: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          properties: {
            number: { type: 'integer', minimum: 1, maximum: count },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
          },
          required: ['number', 'title', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['scenes'],
    additionalProperties: false,
  })
}

export function scenePromptPackOutputContract(
  sceneIds: readonly string[],
  kind: 'visual' | 'motion',
): TextOutputContract {
  const promptKey = kind === 'motion' ? 'motion_prompt' : 'visual_prompt'
  return localSchema('story_scene_prompt_pack', {
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
  })
}

export const CONTEXTUAL_CUES_OUTPUT_CONTRACT: TextOutputContract = localSchema(
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
)

/**
 * Prompt Director rewrite batch.
 *
 * `id` is an enum of the ids actually sent in this batch: the caller matches
 * results back by id, so an invented id is silently dropped work. Item keys
 * beyond these are tolerated — the batch is matched by id, not by shape.
 */
export function promptDirectorOutputContract(sceneIds: readonly string[]): TextOutputContract {
  return localSchema('story_prompt_director', {
    type: 'object',
    properties: {
      scenes: {
        type: 'array',
        maxItems: sceneIds.length,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: [...sceneIds] },
            prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
            emotion: { type: 'string', maxLength: 200 },
          },
          required: ['id', 'prompt'],
        },
      },
    },
    required: ['scenes'],
    additionalProperties: false,
  })
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

export function outlineOutputContract(chapterCount: number): TextOutputContract {
  return localSchema('story_outline', {
    type: 'object',
    properties: {
      chapters: {
        type: 'array',
        minItems: chapterCount,
        maxItems: chapterCount,
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', minimum: 1, maximum: chapterCount },
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
