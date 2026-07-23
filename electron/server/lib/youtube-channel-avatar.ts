const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const AVATAR_CACHE_TTL_MS = 60 * 60 * 1000
const AVATAR_FETCH_TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 3

export interface YouTubeChannelAvatar {
  bytes: Buffer
  contentType: string
}

interface CachedAvatar extends YouTubeChannelAvatar {
  expiresAt: number
}

const avatarCache = new Map<string, CachedAvatar>()

function isAllowedAvatarHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'yt3.ggpht.com'
    || host === 'yt3.googleusercontent.com'
    || host === 'lh3.googleusercontent.com'
}

function parseAllowedAvatarUrl(input: string, base?: string): URL {
  let url: URL
  try {
    url = base ? new URL(input, base) : new URL(input)
  } catch {
    throw new Error('YouTube channel icon URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || !isAllowedAvatarHost(url.hostname)) {
    throw new Error('YouTube channel icon URL is not from an approved Google image host.')
  }
  return url
}

function normalizeContentType(value: string | null): string {
  const contentType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
    throw new Error('YouTube channel icon response is not a supported image.')
  }
  return contentType
}

function rememberAvatar(key: string, avatar: YouTubeChannelAvatar): void {
  avatarCache.set(key, { ...avatar, expiresAt: Date.now() + AVATAR_CACHE_TTL_MS })
  while (avatarCache.size > 32) {
    const oldestKey = avatarCache.keys().next().value
    if (!oldestKey) break
    avatarCache.delete(oldestKey)
  }
}

export async function fetchYouTubeChannelAvatar(
  input: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<YouTubeChannelAvatar> {
  const initialUrl = parseAllowedAvatarUrl(input).toString()
  const cached = avatarCache.get(initialUrl)
  if (cached && cached.expiresAt > Date.now()) {
    return { bytes: cached.bytes, contentType: cached.contentType }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS)
  try {
    let currentUrl = initialUrl
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new Error('YouTube channel icon redirected too many times.')
        }
        currentUrl = parseAllowedAvatarUrl(location, currentUrl).toString()
        continue
      }
      if (!response.ok) {
        throw new Error(`YouTube channel icon request failed (${response.status}).`)
      }

      const contentType = normalizeContentType(response.headers.get('content-type'))
      const declaredSize = Number(response.headers.get('content-length') || 0)
      if (Number.isFinite(declaredSize) && declaredSize > MAX_AVATAR_BYTES) {
        throw new Error('YouTube channel icon is larger than the allowed size.')
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) {
        throw new Error(bytes.length
          ? 'YouTube channel icon is larger than the allowed size.'
          : 'YouTube channel icon response was empty.')
      }

      const avatar = { bytes, contentType }
      rememberAvatar(initialUrl, avatar)
      return avatar
    }
    throw new Error('YouTube channel icon could not be loaded.')
  } catch (error) {
    // A previously verified icon remains safe to show during a brief Google
    // outage even after its freshness window has elapsed.
    if (cached) return { bytes: cached.bytes, contentType: cached.contentType }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function _clearYouTubeChannelAvatarCacheForTests(): void {
  avatarCache.clear()
}
