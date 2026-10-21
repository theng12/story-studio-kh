export type FontSelectionEvent = {
  renderer: 'ass' | 'drawtext'
  filter_id: string | null
  raw_line: string
  status: 'resolved' | 'unresolved'
  requested: string | null
  path: string | null
  collection_index: number | null
  face: string | null
}

export type FontSelectionReport = {
  provider: string | null
  complete: boolean
  glyph_warning_present: boolean
  events: FontSelectionEvent[]
}

export type F2NativePhase = 'source_encode' | 'source_probe' | 'final_encode' | 'output_probe'

export type F2PhaseCounts = Record<F2NativePhase, number>

type ChildLike = {
  exitCode: number | null
  signalCode: string | null
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean
}

export class F2CaseOwner {
  readonly counts: F2PhaseCounts = {
    source_encode: 0, source_probe: 0, final_encode: 0, output_probe: 0,
  }

  private readonly active = new Set<Promise<void>>()
  private closed = false
  private readonly abort = () => this.stopLaunching()

  constructor(readonly signal: AbortSignal) {
    if (signal.aborted) this.closed = true
    else signal.addEventListener('abort', this.abort, { once: true })
  }

  assertCanLaunch(label: string): void {
    if (this.signal.aborted || this.closed) {
      throw Object.assign(new Error(`[F2 ownership] refused ${label}: case is aborted or closed`), {
        code: 'STORY_F2_CASE_CLOSED',
      })
    }
  }

  begin(phase: F2NativePhase): void {
    this.assertCanLaunch(phase)
    this.counts[phase] += 1
  }

  track<T>(work: Promise<T>): Promise<T> {
    const guarded = Promise.resolve(work).catch(error => {
      this.stopLaunching()
      throw error
    })
    let settlement: Promise<void>
    settlement = guarded.then(() => undefined, () => undefined).finally(() => {
      this.active.delete(settlement)
    })
    this.active.add(settlement)
    return guarded
  }

  stopLaunching(): void {
    this.closed = true
    this.signal.removeEventListener('abort', this.abort)
  }

  async settle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active])
  }
}

export async function runBoundedChild(
  owner: F2CaseOwner,
  phase: F2NativePhase,
  launch: () => ChildLike,
  options: { timeoutMs: number, killGraceMs: number, maxBufferBytes?: number },
): Promise<{ stdout: string, stderr: string }> {
  owner.begin(phase)
  let child: ChildLike
  try {
    child = launch()
  } catch (error) {
    owner.stopLaunching()
    throw error
  }
  const completion = new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let failure: Error | null = null
    let finished = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const maxBufferBytes = options.maxBufferBytes ?? 4 * 1024 * 1024
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = String(chunk)
      outputBytes += Buffer.byteLength(text)
      if (target === 'stdout') stdout += text
      else stderr += text
      if (outputBytes > maxBufferBytes) terminate(new Error(`${phase} exceeded ${maxBufferBytes} output bytes`))
    }
    const terminate = (error: Error) => {
      if (failure !== null || finished) return
      failure = error
      owner.stopLaunching()
      try { child.kill('SIGTERM') } catch { /* close/error supplies the terminal result */ }
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL') } catch { /* close/error supplies the terminal result */ }
        }
      }, options.killGraceMs)
      killTimer.unref()
    }
    const abort = () => terminate(new Error(`${phase} aborted before its child settled`))
    const timeout = setTimeout(() => terminate(new Error(`${phase} timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
    timeout.unref()
    owner.signal.addEventListener('abort', abort, { once: true })
    if (owner.signal.aborted) abort()
    child.stdout?.on('data', chunk => append('stdout', chunk))
    child.stderr?.on('data', chunk => append('stderr', chunk))
    child.once('error', error => {
      if (failure === null) failure = error
    })
    child.once('close', (code, signal) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (killTimer !== null) clearTimeout(killTimer)
      owner.signal.removeEventListener('abort', abort)
      if (failure !== null) reject(failure)
      else if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${phase} exited with code ${code} signal ${signal}: ${stderr}`))
    })
  })
  return owner.track(completion)
}

export function classifyFontSelectionReport(report: string): FontSelectionReport {
  const events: FontSelectionEvent[] = []
  let glyphWarningPresent = false
  for (const line of report.split(/\r?\n/)) {
    const filterId = line.match(/\[([^\] ]+)\s+@[^\]]*\]/)?.[1] || null
    const ass = /fontselect:\s*\(([^)]*)\)\s*->\s*(.+?)\s*$/i.exec(line)
    if (ass) {
      const selected = ass[2]!
      const selectedPath = selected.match(/((?:\/|[A-Za-z]:[\\/]).+?\.(?:ttf|ttc|otf))/i)?.[1] || null
      const collection = selectedPath === null
        ? null
        : selected.slice(selected.indexOf(selectedPath) + selectedPath.length)
          .match(/^,\s*(-?\d+)(?:,\s*(.+))?$/)
      const collectionIndex = collection === null ? null : Number(collection[1])
      const face = collection?.[2]?.trim() || null
      const reportedIndexIsBinding = collectionIndex === null || collectionIndex >= 0
      const selectionIsComplete = selectedPath !== null
        && reportedIndexIsBinding
        && (!selectedPath.toLowerCase().endsWith('.ttc') || (collectionIndex !== null && face !== null))
      events.push({
        renderer: 'ass', filter_id: filterId, raw_line: line,
        status: selectionIsComplete ? 'resolved' : 'unresolved',
        requested: ass[1]!.trim(), path: selectedPath,
        collection_index: collectionIndex, face,
      })
      continue
    }
    if (/Glyph .+ not found.+selecting one more font/i.test(line)) {
      glyphWarningPresent = true
      events.push({
        renderer: 'ass', filter_id: filterId, raw_line: line, status: 'unresolved',
        requested: line.match(/selecting one more font for \(([^)]*)\)/i)?.[1]?.trim() || null,
        path: null, collection_index: null, face: null,
      })
      continue
    }
    if (filterId?.toLowerCase().includes('drawtext') && /\bUsing\b/i.test(line)) {
      const selectedPath = line.match(/Using\s+"((?:\/|[A-Za-z]:[\\/])[^"]+\.(?:ttf|ttc|otf))"/i)?.[1] || null
      const requested = line.match(/font family\s+"([^"]+)"/i)?.[1]?.trim() || null
      const suffix = selectedPath === null
        ? null
        : line.slice(line.indexOf(selectedPath) + selectedPath.length + 1)
      const collection = suffix?.match(/^,\s*(-?\d+)(?:,\s*(.+))?$/) || null
      const collectionIndex = collection === null ? null : Number(collection[1])
      const face = collection?.[2]?.trim() || null
      const reportedIndexIsBinding = collectionIndex === null || collectionIndex >= 0
      const selectionIsComplete = selectedPath !== null
        && reportedIndexIsBinding
        && (!selectedPath.toLowerCase().endsWith('.ttc') || (collectionIndex !== null && face !== null))
      events.push({
        renderer: 'drawtext', filter_id: filterId, raw_line: line,
        status: selectionIsComplete ? 'resolved' : 'unresolved',
        requested, path: selectedPath, collection_index: collectionIndex, face,
      })
    }
  }
  const provider = report.match(/Using font provider ([^\r\n]+)/)?.[1]?.trim() || null
  return {
    provider,
    complete: provider !== null && events.length > 0 && events.every(event => event.status === 'resolved'),
    glyph_warning_present: glyphWarningPresent,
    events,
  }
}
