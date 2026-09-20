/**
 * Is this filename one of the episode's final videos?
 *
 * The canonical name is `{code}_final_video.{ext}`. `upload-queue.ts:391-392`
 * writes a VERSIONED sibling, `{code}_final_video_v{N}.{ext}`, whenever the
 * canonical name is already taken — so versioned finals are a normal, expected
 * shape on disk.
 *
 * v1.4.201 — three separate matchers required `_final_video` to be followed
 * IMMEDIATELY by the extension dot:
 *
 *   services/storage-audit.ts:105        isFinalVideoName
 *   services/episode-media-cleanup.ts:307 isFinalName
 *   services/asset-status.ts:1045        hasFinalVideoFast
 *
 * so every versioned final video was invisible. Settings → Storage counted it as
 * 0 bytes, `hasFinalVideoFast` reported the episode as having no video, and media
 * cleanup would not reclaim it. Nothing announced the discrepancy: the file was
 * simply not seen, which is why this survived — every individual check looked
 * reasonable.
 *
 * Case-insensitive, because the cleanup gate already was and macOS resolves
 * these names case-insensitively anyway. The caller keeps its own extension test,
 * so this adds no opinion about which containers count as video.
 */
export function isFinalVideoFilename(code: string, filename: string): boolean {
  // An empty code would otherwise match ANY `_final_video.*` on disk. The
  // cleanup gate is the caller that must never see this, so it is refused here
  // rather than trusted to every call site.
  if (!code) return false
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return false
  const stem = filename.slice(0, dot).toUpperCase()
  const base = `${code}_final_video`.toUpperCase()
  if (!stem.startsWith(base)) return false
  const rest = stem.slice(base.length)
  return rest === '' || /^_V\d+$/.test(rest)
}
