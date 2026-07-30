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
