/**
 * A lone surrogate must never leave Story Studio.
 *
 * THE INCIDENT (1.4.9). A YouTube Finalizer run on EP0078 died with
 *
 *   GenStudio KH rejected the product request before generation:
 *   'utf-8' codec can't encode character '\ud83e' in position 651:
 *   surrogates not allowed.
 *
 * It was blamed on the model — DeepSeek V4 Flash failed, Gemini 3.1 succeeded,
 * so DeepSeek looked flaky. It was not the model. `\ud83e` is the FIRST half of
 * the surrogate pair that encodes an emoji, and `String.prototype.slice` counts
 * UTF-16 code units, so `raw.slice(0, maxChars)` in the metadata generator cut
 * straight through a pair whenever an emoji happened to straddle the cap. The
 * apparent flakiness WAS the tell: regenerate, the text changes, the emoji
 * moves, the same model succeeds.
 *
 * These tests pin the real shape — a cut that lands exactly between the two
 * halves — and assert WELL-FORMEDNESS, not length. A length assertion passes
 * with the bug fully intact.
 *
 * ZERO paid calls: `fetch` is stubbed for the end-to-end case.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isWellFormedText,
  toWellFormedDeep,
  toWellFormedText,
  truncateChars,
  wellFormedJson,
} from '../lib/well-formed-text.js'
import { __sanitize } from '../lib/upload-metadata.js'
import { callChatWithGenStudio } from '../lib/genstudio-client.js'

/** U+1F9E0 BRAIN — the character whose high half was in his error. */
const BRAIN = '\u{1F9E0}'
/** The bare high surrogate, as a model can emit it directly. */
const LONE_HIGH = '\uD83E'
/** A bare low surrogate — the other half, equally unencodable. */
const LONE_LOW = '\uDDE0'
const REPLACEMENT = '�'

/**
 * Explicit surrogate scan. Deliberately NOT `isWellFormed()` — this is the
 * independent check, so a bug in the helper cannot make its own test pass.
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

/**
 * The native ES2024 check, reached through a cast: the project compiles at
 * target ES2022 even though Electron 43 runs Node 24, where this exists. It is
 * called here as the second opinion alongside `hasLoneSurrogate` above.
 */
function nativeIsWellFormed(text: string): boolean {
  return (text as unknown as { isWellFormed(): boolean }).isWellFormed()
}

/** Every string reachable inside a parsed JSON value. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      collectStrings(item, out)
    }
  }
  return out
}

// ── The bug itself ────────────────────────────────────────────────────────

test('the reported failure reproduces with plain slice and not with truncateChars', () => {
  // The cap lands exactly between the two halves of the emoji: 10 characters
  // of prose, then the pair occupies units 10 and 11.
  const raw = `${'x'.repeat(10)}${BRAIN}${'y'.repeat(10)}`
  assert.equal(raw.charCodeAt(10), 0xd83e, 'unit 10 is the high half')
  assert.equal(raw.charCodeAt(11), 0xdde0, 'unit 11 is the low half')

  const broken = raw.slice(0, 11)
  assert.ok(hasLoneSurrogate(broken), 'slice() is what produced \\ud83e in his run')
  assert.equal(nativeIsWellFormed(broken), false)

  const fixed = truncateChars(raw, 11)
  assert.equal(hasLoneSurrogate(fixed), false)
  assert.equal(nativeIsWellFormed(fixed), true)
  assert.equal(fixed, 'x'.repeat(10), 'the whole emoji is dropped — never half of it')
  assert.equal(fixed.length, 10, 'one unit shorter than the cap, by design')
})

test('truncateChars only shortens when a pair would actually be split', () => {
  const raw = `${'x'.repeat(10)}${BRAIN}${'y'.repeat(10)}`
  // Cap AFTER the complete pair: the emoji survives intact.
  assert.equal(truncateChars(raw, 12), `${'x'.repeat(10)}${BRAIN}`)
  assert.equal(truncateChars(raw, 12).length, 12, 'the cap is still a code-unit cap')
  // Cap BEFORE the pair: ordinary truncation, untouched.
  assert.equal(truncateChars(raw, 10), 'x'.repeat(10))
  // Under the cap: returned verbatim.
  assert.equal(truncateChars(raw, 999), raw)
  assert.equal(truncateChars('', 100), '')
  assert.equal(truncateChars('abc', 0), '')
  assert.equal(truncateChars('abc', -5), '')
})

test('truncateChars never returns a lone surrogate at any cut point', () => {
  // Emoji-dense text: sweep every possible cap and assert well-formedness.
  const raw = `Sleep ${BRAIN} well ${BRAIN}${BRAIN} tonight ${BRAIN}.`
  for (let cap = 0; cap <= raw.length + 2; cap++) {
    const cut = truncateChars(raw, cap)
    assert.equal(hasLoneSurrogate(cut), false, `cap ${cap} produced a lone surrogate`)
    assert.ok(cut.length <= cap || cap > raw.length, `cap ${cap} was exceeded`)
  }
})

// ── The model emitting one directly ───────────────────────────────────────

test('a lone surrogate arriving from the model is replaced, not carried', () => {
  // No truncation involved. Providers do return these, and no truncation rule
  // can prevent it — this is what the boundary layer exists for.
  const fromModel = `A title ${LONE_HIGH} from the model`
  assert.ok(hasLoneSurrogate(fromModel))

  const repaired = toWellFormedText(fromModel)
  assert.equal(hasLoneSurrogate(repaired), false)
  assert.equal(repaired, `A title ${REPLACEMENT} from the model`)

  // A trailing low surrogate is just as unencodable.
  assert.equal(toWellFormedText(`tail ${LONE_LOW}`), `tail ${REPLACEMENT}`)
  // Correctly paired emoji are never touched.
  assert.equal(toWellFormedText(`Sleep ${BRAIN} well`), `Sleep ${BRAIN} well`)
  assert.equal(isWellFormedText(`Sleep ${BRAIN} well`), true)
  assert.equal(isWellFormedText(fromModel), false)
})

test('toWellFormedDeep repairs nested values and object keys', () => {
  const repaired = toWellFormedDeep({
    title: `Ten ${LONE_HIGH} Places`,
    tags: ['calm', `night ${LONE_LOW}`],
    nested: { [`key${LONE_HIGH}`]: `deep ${LONE_HIGH}` },
    count: 7,
    ok: true,
    nothing: null,
  })
  for (const value of collectStrings(repaired)) {
    assert.equal(hasLoneSurrogate(value), false, `${JSON.stringify(value)} still has one`)
  }
  assert.equal((repaired as { count: number }).count, 7, 'non-strings pass through')
  assert.equal((repaired as { nothing: null }).nothing, null)
})

// ── Why JSON.stringify alone is not the fix ───────────────────────────────

test('JSON.stringify escapes a lone surrogate but the receiver decodes it back', () => {
  // This is the trap. `JSON.stringify` has escaped lone surrogates since
  // ES2019, so the SERIALISED string looks fine and encodes to UTF-8 happily —
  // and then the receiving JSON parser faithfully turns `\ud83e` back into a
  // lone surrogate and fails on it. Exactly what GenStudio reported.
  const naive = JSON.stringify({ input: `x ${LONE_HIGH}` })
  assert.equal(nativeIsWellFormed(naive), true, 'the serialised form is deceptively clean')
  assert.ok(hasLoneSurrogate(JSON.parse(naive).input), 'but it decodes back to one')

  const safe = wellFormedJson({ input: `x ${LONE_HIGH}` })
  assert.equal(nativeIsWellFormed(safe), true)
  assert.equal(hasLoneSurrogate(JSON.parse(safe).input), false, 'the value itself was repaired')
})

// ── The GenStudio boundary, end to end ────────────────────────────────────

function chatCatalog() {
  return [{
    id: 'writer-alpha',
    display_name: 'Writer Alpha',
    available: true,
    qualification_only: false,
    context_window_tokens: 1_048_576,
    max_output_tokens: 65_536,
    controls: ['temperature', 'max_output_tokens', 'system_instruction'],
    activation_blockers: [],
    structured_output_mode: 'json_object',
    supports_structured_output: true,
  }]
}

function accountOverview() {
  return {
    paid_concurrency_limit: 5,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
  }
}

test('no chat request body can carry a lone surrogate to GenStudio', async () => {
  const originalFetch = globalThis.fetch
  let sentBody: string | null = null
  // Built with plain `slice` on purpose: this is the exact string the old
  // metadata generator would have handed to the client.
  const contextRaw = `Story context: ${'x'.repeat(10)}${BRAIN} and more`
  const splitEmoji = contextRaw.slice(0, contextRaw.indexOf(BRAIN) + 1)
  assert.ok(hasLoneSurrogate(splitEmoji), 'the fixture really is malformed')
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(chatCatalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      assert.ok(url.endsWith('/v1/chat/responses'), `unexpected call to ${url}`)
      sentBody = String(init?.body)
      return Response.json({
        id: 'job_wellformed_1',
        state: 'succeeded',
        operation: 'chat.response',
        dispatch_mode: 'synchronous',
        model_id: 'writer-alpha',
        output_text: '{"ok":true}',
        output_retained: true,
        finish_reason: 'stop',
        failure_code: null,
        routing_status_code: null,
        credit_cost: 1,
        remaining_credits: 900,
      })
    }

    await callChatWithGenStudio('surrogate-key', {
      modelId: 'writer-alpha',
      // Both halves of the failure in one request: a story excerpt that was
      // cut through the middle of an emoji (the metadata generator's shape),
      // and a lone surrogate the model handed us verbatim.
      system: splitEmoji,
      userMessage: `Write metadata ${LONE_HIGH} for EP0078`,
      outputContract: { mode: 'json_object' },
    })

    assert.ok(sentBody, 'the submission was made')
    const body = sentBody as unknown as string
    assert.equal(nativeIsWellFormed(body), true, 'the serialised body is encodable')
    for (const value of collectStrings(JSON.parse(body))) {
      assert.equal(
        hasLoneSurrogate(value), false,
        `GenStudio would decode a lone surrogate out of ${JSON.stringify(value)}`,
      )
    }
    // Buffer.from is what an HTTP client does to the body. It never throws, it
    // substitutes — which is precisely why this had to be caught before here.
    assert.equal(Buffer.from(body, 'utf-8').toString('utf-8'), body)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── The YouTube boundary ──────────────────────────────────────────────────

test('a YouTube title capped mid-emoji stays valid Unicode', () => {
  // YouTube titles cap at 100 characters and are the single most emoji-prone
  // string in the product.
  const title = `${'A'.repeat(98)}${BRAIN} tonight`
  const capped = __sanitize.capLength(title, 100, 'title')
  assert.equal(hasLoneSurrogate(capped), false)
  assert.ok(capped.length <= 100)

  // And a stray surrogate straight from the model is repaired on the way in.
  const cleaned = __sanitize.stripControl(`Ten Quiet Places ${LONE_HIGH}`)
  assert.equal(hasLoneSurrogate(cleaned), false)

  // PER_TAG_MAX is 30, so a pair straddling unit 30 is the cut that used to
  // break. Sweep the neighbourhood rather than pinning one lucky offset.
  for (let lead = 25; lead <= 34; lead++) {
    const [tag] = __sanitize.cleanTags([`${'b'.repeat(lead)}${BRAIN}${'c'.repeat(5)}`])
    assert.equal(hasLoneSurrogate(tag ?? ''), false, `lead ${lead} split the pair`)
  }
})
