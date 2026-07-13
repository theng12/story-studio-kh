/**
 * Singleton provider registry — central dispatch for all image, audio, and text providers.
 * Providers self-register at import time via registry.registerXxx().
 */

import type { ImageProvider, AudioProvider, TextProvider, VideoProvider, ProviderMeta } from './types.js'
import { resolveApiKey, AccountsError } from '../services/secrets-accounts.js'

class ProviderRegistry {
  private imageProviders = new Map<string, ImageProvider>()
  private audioProviders = new Map<string, AudioProvider>()
  private textProviders = new Map<string, TextProvider>()
  private videoProviders = new Map<string, VideoProvider>()

  // ── Registration ─────────────────────────────────────────────────────

  registerImage(provider: ImageProvider): void {
    this.imageProviders.set(provider.meta.id, provider)
  }

  registerAudio(provider: AudioProvider): void {
    this.audioProviders.set(provider.meta.id, provider)
  }

  registerText(provider: TextProvider): void {
    this.textProviders.set(provider.meta.id, provider)
  }

  registerVideo(provider: VideoProvider): void {
    this.videoProviders.set(provider.meta.id, provider)
  }

  // ── Lookup ───────────────────────────────────────────────────────────

  getImageProvider(providerId: string): ImageProvider | undefined {
    return this.imageProviders.get(providerId)
  }

  getAudioProvider(providerId: string): AudioProvider | undefined {
    return this.audioProviders.get(providerId)
  }

  getTextProvider(providerId: string): TextProvider | undefined {
    return this.textProviders.get(providerId)
  }

  getVideoProvider(providerId: string): VideoProvider | undefined {
    return this.videoProviders.get(providerId)
  }

  findVideoProviderForModel(modelId: string, providerParams?: Record<string, any>): VideoProvider | undefined {
    for (const provider of this.videoProviders.values()) {
      if (provider.supportsModel(modelId, providerParams)) return provider
    }
    return undefined
  }

  /**
   * Find which text provider handles a given model ID.
   * Used for backward-compat dispatch (model name → provider).
   */
  findTextProviderForModel(modelId: string): TextProvider | undefined {
    for (const provider of this.textProviders.values()) {
      if (provider.supportsModel(modelId)) return provider
    }
    return undefined
  }

  // ── Listing (for UI dropdowns & settings) ────────────────────────────

  listImageProviders(): ImageProvider[] {
    return Array.from(this.imageProviders.values())
  }

  listAudioProviders(): AudioProvider[] {
    return Array.from(this.audioProviders.values())
  }

  listTextProviders(): TextProvider[] {
    return Array.from(this.textProviders.values())
  }

  listVideoProviders(): VideoProvider[] {
    return Array.from(this.videoProviders.values())
  }
}

export const registry = new ProviderRegistry()

// ── Account-aware key resolution (Delivery 2) ──────────────────────────────

/**
 * Canonical secrets bucket id for a provider.
 *   - prefers explicit `meta.providerId`
 *   - falls back to slicing `meta.apiKeyField` before `_api_key`
 *     (so every existing provider works without editing its definition)
 *   - last resort: `meta.id`
 */
export function providerIdForMeta(meta: ProviderMeta): string {
  if (meta.providerId) return meta.providerId
  if (meta.apiKeyField?.endsWith('_api_key')) {
    return meta.apiKeyField.slice(0, -'_api_key'.length)
  }
  return meta.id
}

export interface ResolveContext {
  /** Specific account to use. Defaults to the provider's default account. */
  accountId?: string
  /** Model id being generated — surfaced in the log line for traceability. */
  model?: string
  /** Job id being run — surfaced in the log line for traceability. */
  jobId?: string
}

/**
 * Resolve the API key for a provider on a specific project. Emits a
 * `[accounts]` log line naming the provider, account id and label that
 * served the call — this is what Delivery 3's end-to-end test reads to
 * confirm default-account switching works.
 *
 * Returns `''` (not null) when the provider has no accounts, so callers
 * can keep their existing "no key configured" check unchanged:
 *     const apiKey = await resolveApiKeyForProvider(...)
 *     if (!apiKey) throw new Error('No API key configured...')
 */
export async function resolveApiKeyForProvider(
  slug: string,
  meta: ProviderMeta,
  ctx: ResolveContext = {},
): Promise<string> {
  return resolveApiKeyForProviderId(slug, providerIdForMeta(meta), ctx)
}

/**
 * Variant for call sites that don't have a `ProviderMeta` in hand
 * (e.g. `generators/audio.ts`, which routes by string id `fal|genaipro|elevenlabs`).
 */
export async function resolveApiKeyForProviderId(
  slug: string,
  providerId: string,
  ctx: ResolveContext = {},
): Promise<string> {
  let resolved: Awaited<ReturnType<typeof resolveApiKey>> = null
  try {
    resolved = await resolveApiKey(slug, providerId, ctx.accountId)
  } catch (e) {
    if (e instanceof AccountsError && e.code === 'account_not_found') {
      // Requested account id is gone — fall through to "no key" rather than
      // throwing out of the generator. The caller will surface a clean error.
      console.log(
        `[accounts] account_not_found providerId=${providerId} accountId=${ctx.accountId} model=${ctx.model ?? '-'} job=${ctx.jobId ?? '-'}`,
      )
      return ''
    }
    if (e instanceof AccountsError && e.code === 'unknown_provider') {
      // Delivery 2 only knows SECRET_PROVIDERS. Unknown id — no accounts path
      // possible, so fall through to "" and let the caller emit its error.
      return ''
    }
    throw e
  }
  if (!resolved) {
    console.log(
      `[accounts] no-account providerId=${providerId} model=${ctx.model ?? '-'} job=${ctx.jobId ?? '-'}`,
    )
    return ''
  }
  console.log(
    `[accounts] resolved providerId=${providerId} accountId=${resolved.accountId} label=${resolved.label} model=${ctx.model ?? '-'} job=${ctx.jobId ?? '-'}`,
  )
  // Record attribution on the job so the Jobs-page card shows "which account
  // served this run". Dynamic import + catch — attribution is bookkeeping
  // and must never fail a generation.
  if (ctx.jobId) {
    const jobId = ctx.jobId
    const account = { id: resolved.accountId, label: resolved.label }
    import('../services/job-queue.js')
      .then(jq => jq.recordAccountUsed(jobId, providerId, account))
      .catch(() => { /* noop */ })
  }
  return resolved.apiKey
}
