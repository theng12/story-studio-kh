/**
 * Live-catalogue default LLM resolution.
 *
 * The audit (v1.0.669+ GenStudio-only pipeline) found several call sites
 * that fell back to a hardcoded external product id (e.g.
 * 'deepseek-v4-flash') whenever the caller didn't specify a model. Those
 * literals were treated as EXECUTION AUTHORITY — submitted straight to
 * GenStudio for generation — even though `lib/ai-client.ts` only
 * length-validates the model string and never checks catalogue membership.
 * A retired/renamed product id would then be submitted blind.
 *
 * GenStudio owns the product catalogue. Story Studio must never invent a
 * product id, and (2026-10-03) never CHOOSE one either: it submits only the
 * model the owner chose, after the live `/v1/chat/models` catalogue confirms
 * it is usable. This module is the single place that check lives.
 */

import { listChatModels } from '../lib/genstudio-client.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'

/**
 * "Choose a writing model on <where>" — the one sentence every writing step shows when nothing was
 * chosen. Story Studio never picks a model for the owner (coordinator decision 2026-10-03): the
 * gateway publishes every chat model as economy / 0 credits, so "the first usable economy model"
 * could silently be a PAID provider.
 */
export function noWritingModelChosenMessage(where: string): string {
  return `No writing model is chosen for this step. Choose one on ${where}, then run it again. `
    + 'Story Studio does not pick a writing model for you.'
}

/** A product is selectable when GenStudio marks it available, unlocked, and
 *  not qualification-gated. Never infer usability from the product's name. */
function isUsableChatModel(model: GenStudioChatModel): boolean {
  return model.available === true && model.qualification_only !== true && model.locked !== true
}

/**
 * The writing model the owner chose, confirmed against the live catalogue — or a plain error.
 *
 *  - Nothing chosen → error naming where to choose one. Nothing is picked on his behalf.
 *  - Chosen but removed, unavailable, qualification-only or locked → error naming the model.
 *    No other model is substituted, ever.
 *  - Catalogue unreachable → error; no literal id is guessed.
 */
export async function resolveChosenChatModel(
  apiKey: string,
  chosenModelId: string | null | undefined,
  where: string,
): Promise<string> {
  const chosen = chosenModelId?.trim() || ''
  if (!chosen) throw new Error(noWritingModelChosenMessage(where))

  let catalog: GenStudioChatModel[]
  try {
    catalog = await listChatModels(apiKey)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not check the writing model "${chosen}": the model list is unreachable (${message}). `
      + 'Check the connection in Settings → This Mac, then try again.',
    )
  }
  const match = catalog.find(model => model.id === chosen)
  if (match && isUsableChatModel(match)) return match.id
  const paid = match?.locked === true && match.lock_reason === 'requires_paid_account' ? ' It needs a paid account.' : ''
  throw new Error(
    `The writing model "${chosen}" isn't available right now.${paid} Pick another one on ${where}, or try again later. `
    + 'Story Studio did not switch to a different model.',
  )
}
