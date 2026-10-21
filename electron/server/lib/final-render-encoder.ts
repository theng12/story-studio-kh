/**
 * The final video's audio encode (buildEncoderArgs). 384 kbit/s is YouTube's recommended stereo AAC rate
 * (1.4.281): at 192k the encoder's noise lifted the true peak of dense, noise-like beds 2–4 dB over the
 * WAV (Night Atlas Nature EP0005: +2.5 dBTP from a mix limited to -1.3), which no limiter can hold.
 */
export const FINAL_AAC_ARGS = ['-c:a', 'aac', '-b:a', '384k']

/**
 * Map a libx264 CRF value to an h264_videotoolbox `-q:v` value.
 *
 * libx264 uses CRF on a 0-51 scale (lower = better). videotoolbox uses
 * `-q:v` on a 0-100 scale (higher = better). The mapping below is
 * empirically calibrated against typical 1080p output for sleep-story
 * footage — slightly biased toward higher q:v than a strict linear map
 * because Apple's hardware encoder is more compression-efficient at the
 * upper quality end than libx264 is. Output: clamped to [25, 90].
 *
 *   CRF 18 (high)    → q:v 80   (visually transparent)
 *   CRF 23 (medium)  → q:v 65   (good for streaming / sleep videos)
 *   CRF 28 (low)     → q:v 50
 *   CRF 32 (drafty)  → q:v 38
 */
export function crfToVideotoolboxQ(crf: number): number {
  // Linear: q:v = 80 - (crf - 18) × 3, clamped.
  const raw = 80 - (crf - 18) * 3
  return Math.max(25, Math.min(90, Math.round(raw)))
}

/** A usable bitrate cap in kbit/s, or 0 for none (quality-based encode). */
export function videoBitrateCapKbps(value: unknown): number {
  const kbps = Number(value)
  return Number.isFinite(kbps) && kbps >= 500 ? Math.min(100_000, Math.round(kbps)) : 0
}

/**
 * Owner, 2026-10-09: "set up the hardware encoder for video assembly." With no saved
 * encoding effort the final encode uses the Media Engine (the existing `hardware`
 * path: q:v from the quality tier, libx264 fallback tier). A saved effort — even a
 * CPU preset — is the owner's choice and wins; so do HEVC and WebM, which this path
 * does not encode.
 */
export function defaultEncodingEffort(
  req: { encoding_effort?: string; codec?: string; format?: string },
  hw: { h264: boolean } | undefined,
): 'hardware' | undefined {
  if (req.encoding_effort || req.codec === 'h265' || req.format === 'webm' || !hw?.h264) return undefined
  return 'hardware'
}

/** `hardware (VideoToolbox h264)` or `software (libx264)`, read from the encode argv. */
export function encoderKind(argv: readonly string[]): string {
  const lastInput = argv.lastIndexOf('-i')
  const codecFlag = argv.lastIndexOf('-c:v')
  const codec = codecFlag > lastInput ? argv[codecFlag + 1] || 'unknown' : 'unknown'
  return codec.endsWith('_videotoolbox') ? `hardware (VideoToolbox ${codec.replace('_videotoolbox', '')})` : `software (${codec})`
}

/** The job line that says which encoder made the final video, and why software when hardware was wanted. */
export function describeEncoder(argv: readonly string[], hardwareWanted: boolean, failure?: { message?: string; stderr?: string } | null): string {
  const kind = encoderKind(argv)
  if (kind.startsWith('hardware') || !hardwareWanted) return `Encoder: ${kind}`
  const reason = (failure?.stderr || '').split('\n').map(line => line.trim()).filter(Boolean).at(-1)
    || failure?.message || 'the hardware encode did not finish'
  return `Encoder: ${kind} — hardware unavailable: ${reason.slice(0, 200)}`
}

export function buildEncoderArgs(opts: {
  codec: 'h264' | 'h265'
  format: 'mp4' | 'mov' | 'webm' | string
  crf: number
  effort: string
  /** Optional cap, kbit/s. Hardware targets it; software keeps CRF and caps peaks. */
  bitrateKbps?: number
}): string[] {
  const { codec, format, crf, effort } = opts
  const cap = videoBitrateCapKbps(opts.bitrateKbps)
  const capArgs = cap ? ['-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`] : []
  if (format === 'webm') {
    return [
      '-c:v', 'libvpx-vp9', '-crf', crf.toString(), '-b:v', '0',
      '-c:a', 'libopus',
    ]
  }
  // Hardware-accelerated path — h264_videotoolbox routes the encode
  // through Apple's Media Engine silicon, ~8-15× faster on M-series
  // Macs than libx264 medium. Quality at the same bitrate is ~5-10%
  // worse than libx264 (Apple trades compression efficiency for speed),
  // but for sleep-story footage — long, mostly static, low motion —
  // the difference is functionally invisible. Falls back to libx264
  // through the existing tier-2/3 recovery chain if videotoolbox fails
  // to initialise (e.g. very old Intel Macs without the right
  // hardware-encode entitlement). Only h264 is offered here; we don't
  // pair the hardware path with h265 because hevc_videotoolbox quality
  // varies more across hardware generations.
  if (effort === 'hardware') {
    return [
      '-c:v', 'h264_videotoolbox',
      // q:v drives quality on videotoolbox (no CRF support). The map
      // above tunes for parity with the operator's CRF expectations.
      // With a cap, the Media Engine targets that bitrate instead.
      ...(cap
        ? ['-b:v', `${cap}k`, '-maxrate', `${Math.round(cap * 1.5)}k`, '-bufsize', `${cap * 2}k`]
        : ['-q:v', crfToVideotoolboxQ(crf).toString()]),
      // No `-allow_sw` (1.4.264): Apple's own silent software encoder would
      // make "Encoder: hardware" untrue. If the Media Engine cannot start,
      // the encode fails and the libx264 tier takes over and says so.
      ...FINAL_AAC_ARGS,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ]
  }
  if (codec === 'h265') {
    // HEVC. `-tag:v hvc1` makes the .mp4 playable in QuickTime/Safari —
    // without the tag it plays in VLC only.
    return [
      '-c:v', 'libx265', '-crf', crf.toString(), '-preset', effort, ...capArgs,
      '-tag:v', 'hvc1',
      ...FINAL_AAC_ARGS,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ]
  }
  return [
    '-c:v', 'libx264', '-crf', crf.toString(), '-preset', effort, ...capArgs,
    ...FINAL_AAC_ARGS,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  ]
}
