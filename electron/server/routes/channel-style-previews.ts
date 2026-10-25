/**
 * The three previews for a CHANNEL's own custom styles.
 *
 *   GET  /api/projects/:slug/channel-style-previews
 *     200 : { styles: [{ preset_id, name, style_tag, source_hash, stale,
 *                        slots: [{ slot, url }], stored_files[], needs_previews }] }
 *     What every custom style of this channel shows right now, resolved. Reads
 *     nothing paid and writes nothing.
 *
 *   POST /api/projects/:slug/channel-style-previews
 *     body: { style_tag, model, aspect_ratio, tier?, slots?, force? }
 *     200 : { source_hash, slots, images, generated, skipped, failed,
 *             updated_preset_ids }
 *     Renders the previews this style text is missing, one image at a time, and
 *     records on this channel's presets that their previews describe that text.
 *
 * The images are stored ONCE PER DISTINCT STYLE TEXT, in the shared
 * content-addressed store that also holds the owner's own style previews
 * (`services/user-style-previews.ts`), under the key of the text's own hash. So
 * a slot already rendered for another channel with the same style is SKIPPED
 * rather than paid for again, and a retry regenerates only what is missing. The
 * three prompts are the same three framings a signed pack ships — hero, a quiet
 * wide scene with no figure in it, and the hardest legal case — built from the
 * style's own text on the server, never sent by the client.
 *
 * No model is chosen here: the caller sends the one the customer picked in the
 * picker, and it is resolved against GenStudio's live catalogue (§1).
 */

import { Router } from 'express'
import { z } from 'zod'

import { validateBody } from '../lib/validate.js'
import { generateImageWithGenStudio } from '../lib/genstudio-client.js'
import { resolvePreviewImageModel } from '../lib/preview-image-model.js'
import { getApiKey } from '../services/app-secrets-store.js'
import * as pm from '../services/project-manager.js'
import {
  channelStyleTagSourceHash,
  listChannelStylePreviewStates,
  markChannelStylePreviewsCurrent,
} from '../services/channel-style-previews.js'
import {
  USER_STYLE_PREVIEW_SLOTS,
  generateUserStylePreviews,
  sharedStylePreviewKey,
  sharedStylePreviewSlots,
  userStylePreviewPrompts,
  type UserStylePreviewSlot,
} from '../services/user-style-previews.js'

export const router = Router()

const GenerateSchema = z.object({
  style_tag: z.string().min(1).max(8000),
  model: z.string().min(1),
  aspect_ratio: z.string().min(1),
  /** Tier id for variable-priced models (nano-banana high/low etc.). */
  tier: z.string().optional(),
  /** Omitted means "the previews this style text is missing". */
  slots: z.array(z.enum(USER_STYLE_PREVIEW_SLOTS)).min(1).max(USER_STYLE_PREVIEW_SLOTS.length).optional(),
  /** Explicit reroll: ask the provider for new pixels rather than reusing the identity. */
  force: z.boolean().optional(),
})

router.get('/projects/:slug/channel-style-previews', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const styles = await listChannelStylePreviewStates(slug)
  res.json({ styles })
})

router.post('/projects/:slug/channel-style-previews', validateBody(GenerateSchema), async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const styleTag = (req.body.style_tag as string).trim()
  if (!styleTag) return res.status(400).json({ detail: 'style_tag is empty' })
  const modelName = req.body.model as string
  const aspectRatio = req.body.aspect_ratio as string
  const tier = (req.body.tier as string | undefined) || ''
  const slots = req.body.slots as UserStylePreviewSlot[] | undefined
  const force = req.body.force === true

  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    return res.status(400).json({
      detail: 'No Gateway API Key is saved. Add one in Settings → App & Connections.',
    })
  }

  const style = { style_bible: styleTag, negative_prompt: '' }
  const prompts = userStylePreviewPrompts(style)
  // Only the prompts this call would actually send are checked: a retry for one
  // slot must not be refused because a different slot is too long for the model.
  const requested = slots ?? USER_STYLE_PREVIEW_SLOTS
  const resolved = await resolvePreviewImageModel({
    apiKey,
    modelId: modelName,
    aspectRatio,
    prompts: requested.map(slot => ({ label: `this style's ${slot} preview prompt`, prompt: prompts[slot] })),
  })
  if ('refusal' in resolved) return res.status(resolved.refusal.status).json({ detail: resolved.refusal.detail })
  const selectedModel = resolved.model

  const sourceHash = channelStyleTagSourceHash(styleTag)
  const result = await generateUserStylePreviews({
    // The key IS the style text's hash, so every channel with this text shares
    // one entry: a second channel's run skips all three rather than rendering
    // them again.
    styleId: sharedStylePreviewKey(style),
    style,
    modelId: selectedModel.id,
    aspectRatio,
    tier,
    force,
    ...(slots ? { slots } : {}),
    async generate({ prompt, requestIdentity }) {
      const rendered = await generateImageWithGenStudio(apiKey, {
        prompt,
        modelId: selectedModel.id,
        aspectRatio,
        requiresAdmissionPermit: selectedModel.requires_admission_permit,
        requestIdentity,
      })
      // The Gateway hands back a data URL for this lane; anything else is not an
      // artifact this route knows how to keep.
      if (!rendered.url.startsWith('data:')) throw new Error('The Gateway returned an unsupported preview artifact')
      const bytes = Buffer.from(rendered.url.slice(rendered.url.indexOf(',') + 1), 'base64')
      if (!bytes.length) throw new Error('The Gateway returned zero bytes')
      return bytes
    },
  })

  const published = await sharedStylePreviewSlots(sourceHash)
  // Only a text with at least one stored preview gets a pointer written: an
  // entry that says "these previews describe this text" while nothing is on
  // screen would be a claim the files do not support (§8).
  const updatedPresetIds = published.length
    ? await markChannelStylePreviewsCurrent({
        slug,
        sourceHash,
        modelId: selectedModel.id,
        aspectRatio,
        tier,
      })
    : []

  res.json({
    source_hash: sourceHash,
    slots: published,
    images: published.map(entry => entry.url),
    generated: result.generated,
    // Asked for and already saved for this text: reported, so a caller never
    // reads "not in `generated`" as "nothing happened".
    skipped: result.skipped,
    failed: result.failed,
    updated_preset_ids: updatedPresetIds,
  })
})
