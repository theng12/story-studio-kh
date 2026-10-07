import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

/**
 * The PRODUCER AUDIT, made permanent.
 *
 * Tell 4 — "a declared option, rank, or control that nothing ever produces" —
 * has appeared four times in this feature: Phase 5's "Use Story Studio" button,
 * Phase 6's evidence rank 8, Phase 7's `viewsFor`, and Phase 8's
 * `scope_missing`, which sat in the type from the first commit and was produced
 * by nothing until a reviewer grepped for it.
 *
 * Both inputs are DERIVED, not hand-typed. The first version listed the states
 * and the files by hand and they already disagreed — a state declared in the
 * store was absent from the list while its only producer was absent from the
 * files, two omissions cancelling into a pass. That is the `limit_verified`
 * lesson again: a list that must agree with reality, maintained by hand,
 * eventually does not.
 */

const ROOT = path.join(import.meta.dirname, '..')

/**
 * The feature's files, found by PATTERN rather than listed.
 *
 * A pattern picks up a file added tomorrow; a hand-written list does not, and
 * the first version of this audit was already wrong because of that. Following
 * imports transitively was the other option and it reaches the whole server —
 * the states of unrelated modules are not this audit's business.
 */
const FEATURE_FILE = /youtube-(upload-center|analytics|comment|page-cursor|project-publishing|connection-store|client|credential)/

async function readTree(dirs: string[], match?: RegExp): Promise<Array<{ file: string, text: string }>> {
  const out: Array<{ file: string, text: string }> = []
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await fs.readdir(path.join(ROOT, dir))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue
      if (match && !match.test(entry)) continue
      const rel = path.join(dir, entry)
      out.push({ file: rel, text: await fs.readFile(path.join(ROOT, rel), 'utf8') })
    }
  }
  return out
}

/** Where states are DECLARED: this feature's files, matched by pattern. */
const featureSources = (): Promise<Array<{ file: string, text: string }>> =>
  readTree(['routes', 'services', 'lib'], FEATURE_FILE)

/**
 * Where a producer may LIVE: anywhere in the server.
 *
 * The asymmetry is the point, and it is the mistake the first version made in
 * reverse. `ListCommentThreadsOptions` declares `order: 'time' | 'relevance'`
 * in a feature file while the only site that produces 'relevance' is the legacy
 * `/upload` route — out of the feature, and so invisible to a feature-scoped
 * search. Narrowing BOTH sides produced a confident false positive.
 */
const producerSources = (): Promise<Array<{ file: string, text: string }>> =>
  readTree(['routes', 'services', 'lib', 'generators'])

/** Strip comments and comparisons so a READER is never scored as a producer. */
function producerLines(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    // `a === 'x'` and `a !== 'x'` READ the value. Only an assignment, a return
    // or a push PRODUCES it.
    .map(line => line.replace(/[!=]==?\s*'[^']*'/g, ''))
}

/** Every string-literal union member declared across the feature. */
function declaredStates(sources: Array<{ text: string }>): Set<string> {
  const states = new Set<string>()
  const add = (fragment: string): void => {
    for (const literal of fragment.matchAll(/'([a-z_]+)'/g)) states.add(literal[1]!)
  }
  for (const { text } of sources) {
    // A `|` list inside Omit<>, Pick<>, Exclude<> or Extract<> selects KEYS of a
    // type. Those are field names, not states a caller can observe, and reading
    // them as states produces confident nonsense — `connected_at` and
    // `updated_at` were reported as unproduced states on this file's first run
    // against the connection store.
    const isKeySelection = (line: string): boolean => /\b(Omit|Pick|Exclude|Extract)</.test(line)
    // Two or more quoted literals joined by `|` on one line.
    for (const line of text.split('\n')) {
      if (isKeySelection(line)) continue
      for (const match of line.matchAll(/'[a-z_]+'(?:\s*\|\s*'[a-z_]+')+/g)) add(match[0]!)
    }
    // ...and a union spelled one member per line, which is how a discriminated
    // union is written. `MetricValue` is declared this way, so a same-line
    // regex alone could not see the four states this whole phase is about.
    for (const line of text.split('\n')) {
      if (!isKeySelection(line) && /^\s*\|/.test(line)) add(line)
    }
    // Runtime arrays of valid values are NOT scanned. Tried, and it swept up
    // every internal key list in the store — state keys, reserved path
    // segments, metric names — none of which is a state a caller can observe,
    // and each of which then had to be explained away. The union types are the
    // declaration that matters, and `ANALYTICS_PARTIAL_REASONS` mirrors one
    // that is already scanned.
  }
  return states
}

function producersFor(state: string, sources: Array<{ file: string, text: string }>): string[] {
  const found: string[] = []
  for (const { file, text } of sources) {
    for (const line of producerLines(text)) {
      if (!line.includes(`'${state}'`)) continue
      if (/^\s*\|/.test(line)) continue
      if (/:\s*'[^']*'(\s*\|\s*'[^']*')+/.test(line)) continue
      // `?? 'x'` and `? 'x' :` produce a value just as surely as `return 'x'`.
      // `not_all_measured`'s only producer is a nullish-coalescing default, and
      // none of return/push/=/: matched it — so the audit could not see the
      // very state this phase had just added.
      if (/return|push\(|=\s|:\s*'|\?\?\s*'|\?\s*'/.test(line)) {
        found.push(`${file}: ${line.trim().slice(0, 90)}`)
      }
    }
  }
  return found
}

test('every declared state has a site that produces it', async () => {
  const declaring = await featureSources()
  const producing = await producerSources()
  assert.ok(declaring.length >= 6, `the feature scan found only ${declaring.length} files`)
  assert.ok(producing.length > declaring.length, 'producers are searched more widely than declarations')

  const states = declaredStates(declaring)
  assert.ok(states.size >= 10, `the union scan found only ${states.size} states`)
  // The states this phase is actually about must be among them, so a scan that
  // silently narrowed to nothing cannot pass.
  for (const required of [
    'scope_missing', 'not_fetched', 'report_truncated', 'channel_changed', 'not_all_measured',
  ]) {
    assert.ok(states.has(required), `the union scan missed ${required}`)
  }

  const orphans = [...states].filter(state => producersFor(state, producing).length === 0)
  assert.deepEqual(
    orphans, [],
    `declared but produced by nothing — wire each or delete it (tell 4): ${orphans.join(', ')}`,
  )
})

test('the audit can actually fail, and does not score a comparison as a producer', async () => {
  const sources = await producerSources()
  // A state nobody has ever written must find no producer. Without running the
  // matcher, a broken one would approve everything — the "mutation that cannot
  // reach the assertion" trap, applied to an audit.
  assert.deepEqual(producersFor('a_state_nobody_produces', sources), [])

  // And a line that only COMPARES must not count. This is the exact false
  // positive the first version had.
  const comparisonOnly = [{ file: 'x.ts', text: "if (metric.state === 'not_fetched') return null\n" }]
  assert.deepEqual(producersFor('not_fetched', comparisonOnly), [])
})

test('a token refresh carries the previous scope forward', async () => {
  // Google omits `scope` from most refresh responses. `refreshAccessToken`
  // carries `previous_scope` forward when given it — that mechanism has its own
  // tests — but `refreshAndPersist` did not pass it, so the stored grant lost
  // its scope on the first refresh. Everything that then ASKS what a token may
  // do got the wrong answer, including the analytics scope check, which would
  // have reported "grant analytics access" forever on a connection that had it.
  //
  // A source assertion rather than a behavioural one: the defect is a missing
  // ARGUMENT at one call site, and the behaviour it breaks only appears after a
  // real token refresh against Google. This is the smallest thing that fails
  // the moment the argument goes away again.
  const client = await fs.readFile(path.join(ROOT, 'lib', 'youtube-client.ts'), 'utf8')

  // The single registry refresh site must carry scope forward. The retired
  // per-project credential store is deliberately absent.
  const calls = [...client.matchAll(/fresh = await refreshAccessToken\(/g)]
  assert.equal(calls.length, 1, 'expected exactly one registry refresh site')
  for (const match of calls) {
    const body = client.slice(match.index!, client.indexOf('})', match.index!))
    assert.match(body, /previous_scope/, 'every refresh must carry the stored scope forward')
  }
})
