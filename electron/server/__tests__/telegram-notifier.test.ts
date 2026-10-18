/**
 * Tests for the Telegram notification formatter + sender.
 *
 * Focus (owner request 2026-10-18, follow-up to the episode-detail fix): the
 * text that leaves `formatTelegramText()` must stay within Telegram's 4096-char
 * limit AFTER HTML escaping, and the sender's `truncateChars(text, 4096)`
 * backstop must never have to cut through an entity (`&amp;`) or a tag — a cut
 * there makes Telegram reject the whole message as invalid HTML.
 *
 * No network: `sendTelegramMessage` is driven through a captured `fetch` stub,
 * and the token/chat guard cases assert fetch is never reached.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatTelegramText,
  sendTelegramMessage,
  TELEGRAM_TEXT_LIMIT,
} from '../services/telegram-notifier.js'
import { isWellFormedText } from '../lib/well-formed-text.js'
import type { NotificationPayload } from '../services/job-notifier.js'

/** A bare `&` (one that does not open a known entity) means the escape broke. */
function hasBareAmpersand(text: string): boolean {
  return /&(?!(?:amp|lt|gt);)/.test(text)
}

/** Remove the only two tags we emit; any `<`/`>` left is a broken tag/entity. */
function hasStrayAngle(text: string): boolean {
  return /[<>]/.test(text.replace(/<\/?b>/g, ''))
}

/** A fetch stub that records each request and answers 200/ok. */
function stubFetch(): { calls: Array<{ url: string; body: any }>; restore: () => void } {
  const original = globalThis.fetch
  const calls: Array<{ url: string; body: any }> = []
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true }) } as any
  }) as any
  return { calls, restore: () => { globalThis.fetch = original } }
}

describe('formatTelegramText — escaping', () => {
  test('escapes &, < and > and keeps Khmer text intact', () => {
    const text = formatTelegramText({
      title: 'ព្រះអាទិត្យ & <មាស>',
      body: 'DM0013 — Lost & Found <script>',
    })
    assert.equal(
      text,
      '<b>ព្រះអាទិត្យ &amp; &lt;មាស&gt;</b>\nDM0013 — Lost &amp; Found &lt;script&gt;',
    )
    assert.ok(!hasBareAmpersand(text))
    assert.ok(!hasStrayAngle(text))
    assert.ok(text.endsWith('</b>') || text.includes('</b>'))
  })

  test('a normal payload is returned unchanged by the bound', () => {
    const payload: NotificationPayload = {
      title: 'Done: Chapter expansion — Domnak Kmouch',
      body: 'DM0013 — The Lost Temple — 9m 44s',
    }
    assert.equal(
      formatTelegramText(payload),
      '<b>Done: Chapter expansion — Domnak Kmouch</b>\nDM0013 — The Lost Temple — 9m 44s',
    )
  })

  test('an empty payload still closes the bold tag', () => {
    assert.equal(formatTelegramText({ title: '', body: '' }), '<b></b>')
  })
})

describe('formatTelegramText — length bound + entity safety', () => {
  test('an ampersand-flooded title and body stay ≤ 4096 with no split entity', () => {
    const text = formatTelegramText({ title: '&'.repeat(3000), body: '&'.repeat(3000) })
    assert.ok(text.length <= TELEGRAM_TEXT_LIMIT, `got ${text.length}`)
    assert.ok(text.startsWith('<b>'))
    assert.ok(text.includes('</b>'))
    assert.ok(!hasBareAmpersand(text), 'every & must open a complete entity')
    assert.ok(!hasStrayAngle(text))
  })

  test('angle-flooded content keeps exactly the two bold tags and no stray brackets', () => {
    const text = formatTelegramText({ title: '<'.repeat(2000), body: '>'.repeat(2000) })
    assert.ok(text.length <= TELEGRAM_TEXT_LIMIT, `got ${text.length}`)
    assert.equal((text.match(/</g) || []).length, 2, 'only <b> and </b> may open a bracket')
    assert.equal((text.match(/>/g) || []).length, 2, 'only <b> and </b> may close a bracket')
    assert.ok(text.startsWith('<b>'))
    assert.ok(text.endsWith('</b>'))
  })

  test('a long Khmer body with emoji never yields a lone surrogate', () => {
    const title = 'ព្រះរាជាណាចក្រ'.repeat(40)
    const body = ('រឿងព្រេង🎬').repeat(400)
    const text = formatTelegramText({ title, body })
    assert.ok(text.length <= TELEGRAM_TEXT_LIMIT, `got ${text.length}`)
    assert.ok(isWellFormedText(text), 'the cut must not split a surrogate pair')
    assert.ok(text.includes('</b>'))
    assert.ok(!hasBareAmpersand(text))
  })

  test('the bound drops a surrogate pair whole at the cut, never half of it', () => {
    // With an empty title the whole budget goes to the body; place an emoji so
    // its high half is the last unit that fits and its low half is past the cut.
    const budget = TELEGRAM_TEXT_LIMIT - 8
    const filler = 'a'.repeat(budget - 1)
    const text = formatTelegramText({ title: '', body: `${filler}🎬zz` })
    assert.equal(text, `<b></b>\n${filler}`)
    assert.ok(!text.includes('🎬'))
    assert.ok(isWellFormedText(text))
    assert.ok(text.length <= TELEGRAM_TEXT_LIMIT)
  })
})

describe('sendTelegramMessage — captured fetch, no network', () => {
  test('posts the formatted text at the cap with HTML parse mode', async () => {
    const { calls, restore } = stubFetch()
    try {
      const payload: NotificationPayload = { title: '&'.repeat(3000), body: '<'.repeat(3000) }
      const text = formatTelegramText(payload)
      const r = await sendTelegramMessage('123:ABC', '42', text, { parseMode: 'HTML' })
      assert.equal(r.ok, true)
      assert.equal(calls.length, 1)
      assert.match(calls[0].url, /api\.telegram\.org\/bot123%3AABC\/sendMessage/)
      assert.equal(calls[0].body.parse_mode, 'HTML')
      assert.equal(calls[0].body.chat_id, '42')
      assert.equal(typeof calls[0].body.text, 'string')
      assert.ok(calls[0].body.text.length <= TELEGRAM_TEXT_LIMIT)
      // The backstop did NOT cut: what was sent is exactly what was formatted.
      assert.equal(calls[0].body.text, text)
      assert.ok(calls[0].body.text.includes('</b>'))
    } finally {
      restore()
    }
  })

  test('the sender backstop still caps an over-long raw payload (other callers unchanged)', async () => {
    const { calls, restore } = stubFetch()
    try {
      await sendTelegramMessage('t', 'c', 'x'.repeat(5000), { parseMode: 'HTML' })
      assert.equal(calls[0].body.text.length, 4096)
    } finally {
      restore()
    }
  })

  test('an empty token or chat id never reaches the network', async () => {
    const original = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any
    }) as any
    try {
      const noToken = await sendTelegramMessage('', 'c', 'hi')
      const noChat = await sendTelegramMessage('t', '', 'hi')
      assert.equal(noToken.ok, false)
      assert.equal(noChat.ok, false)
      assert.equal(called, false)
    } finally {
      globalThis.fetch = original
    }
  })

  test('an API error is returned, not thrown', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }),
    })) as any
    try {
      const r = await sendTelegramMessage('t', 'c', '<b>x</b>', { parseMode: 'HTML' })
      assert.equal(r.ok, false)
      assert.equal(r.status, 400)
      assert.match(String(r.error), /parse entities/)
    } finally {
      globalThis.fetch = original
    }
  })

  test('a network throw is returned, not thrown', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as any
    try {
      const r = await sendTelegramMessage('t', 'c', 'hi')
      assert.equal(r.ok, false)
      assert.equal(r.status, 0)
      assert.match(String(r.error), /ECONNREFUSED/)
    } finally {
      globalThis.fetch = original
    }
  })
})
