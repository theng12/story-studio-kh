/**
 * The startup line that says which language transport is live.
 *
 * THE INCIDENT THIS COMES FROM: GenStudio diagnosed a chapter-generation
 * failure as Story Studio "overriding its transport to completions". There was
 * no override — the running build simply predated the durable-route code, and
 * the fix was already written and unshipped. Nobody on either side could tell
 * which route a given install was using without reading source, so the wrong
 * conclusion was the only one available. Now the log answers it.
 *
 * ZERO paid calls: this file only reads a function and a source file.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  describeGenStudioChatTransport,
  genStudioChatTransportLogLine,
  resolveGenStudioChatTransport,
  GENSTUDIO_CHAT_TRANSPORT_ENV,
} from '../lib/genstudio-client.js'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

test('the default route is named as a DEFAULT, not as a setting somebody made', () => {
  const choice = describeGenStudioChatTransport({})
  assert.equal(choice.transport, 'responses')
  assert.equal(choice.source, 'default')
  assert.equal(choice.envValue, null)

  const line = genStudioChatTransportLogLine({})
  assert.match(line, /Language transport: responses/)
  assert.match(line, /durable job \+ poll/)
  assert.match(line, /built-in default/)
  assert.match(line, /STORY_STUDIO_GENSTUDIO_CHAT_TRANSPORT is not set/)
})

test('an environment override is named as an override, and quotes the value', () => {
  const env = { [GENSTUDIO_CHAT_TRANSPORT_ENV]: 'completions' }
  const choice = describeGenStudioChatTransport(env)
  assert.equal(choice.transport, 'completions')
  assert.equal(choice.source, 'environment')
  assert.equal(choice.envValue, 'completions')
  assert.equal(choice.envRecognised, true)

  const line = genStudioChatTransportLogLine(env)
  assert.match(line, /Language transport: completions/)
  assert.match(line, /rollback route/)
  assert.match(line, /Source: environment/)
  assert.match(line, /STORY_STUDIO_GENSTUDIO_CHAT_TRANSPORT="completions"/)
})

test('the env var set to the default route still reads as an override', () => {
  // "It says responses because nobody set it" and "it says responses because
  // somebody set it to responses" are different facts about a machine.
  const choice = describeGenStudioChatTransport({ [GENSTUDIO_CHAT_TRANSPORT_ENV]: 'responses' })
  assert.equal(choice.transport, 'responses')
  assert.equal(choice.source, 'environment')
  assert.match(genStudioChatTransportLogLine({ [GENSTUDIO_CHAT_TRANSPORT_ENV]: 'responses' }), /Source: environment/)
})

test('a value that is not a route name is reported instead of silently dropped', () => {
  const env = { [GENSTUDIO_CHAT_TRANSPORT_ENV]: 'complettions' }
  const choice = describeGenStudioChatTransport(env)
  assert.equal(choice.transport, 'responses')
  assert.equal(choice.envRecognised, false)
  const line = genStudioChatTransportLogLine(env)
  assert.match(line, /"complettions"/)
  assert.match(line, /not a route name/)
})

test('whitespace and casing do not change the answer', () => {
  assert.equal(
    describeGenStudioChatTransport({ [GENSTUDIO_CHAT_TRANSPORT_ENV]: '  COMPLETIONS  ' }).transport,
    'completions',
  )
  assert.equal(
    describeGenStudioChatTransport({ [GENSTUDIO_CHAT_TRANSPORT_ENV]: '   ' }).source,
    'default',
  )
})

test('the log and the live switch can never disagree', () => {
  // One would be worse than none: a log that names the wrong route is how the
  // original misdiagnosis happened.
  const saved = process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
  try {
    for (const value of [undefined, 'completions', 'responses', 'nonsense']) {
      if (value === undefined) delete process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
      else process.env[GENSTUDIO_CHAT_TRANSPORT_ENV] = value
      assert.equal(
        resolveGenStudioChatTransport(),
        describeGenStudioChatTransport().transport,
        `the log disagreed with the live route for ${String(value)}`,
      )
    }
  } finally {
    if (saved === undefined) delete process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
    else process.env[GENSTUDIO_CHAT_TRANSPORT_ENV] = saved
  }
})

test('the line never carries the API key or anything derived from it', () => {
  const saved = process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
  try {
    // Even if an operator pastes a key into the transport variable by mistake,
    // the line must not become a place a key can be read from a shared log.
    for (const env of [
      {},
      { [GENSTUDIO_CHAT_TRANSPORT_ENV]: 'completions' },
      { [GENSTUDIO_CHAT_TRANSPORT_ENV]: 'responses' },
    ]) {
      const line = genStudioChatTransportLogLine(env)
      assert.doesNotMatch(line, /gsk_/i, 'a Gateway key prefix reached the startup line')
      assert.doesNotMatch(line, /api[_-]?key/i, 'the startup line mentions an API key')
      assert.doesNotMatch(line, /Bearer/i)
      assert.doesNotMatch(line, /authorization/i)
      assert.doesNotMatch(line, /[0-9a-f]{32,}/i, 'a key-shaped digest reached the startup line')
    }
  } finally {
    if (saved === undefined) delete process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
    else process.env[GENSTUDIO_CHAT_TRANSPORT_ENV] = saved
  }
})

test('it is actually emitted at startup, to the console and the log file', () => {
  // Source-level because this is a boot-time side effect: the value of the
  // function is entirely in it being CALLED where a support engineer will find
  // the output.
  const app = source('../app.ts')
  assert.match(app, /genStudioChatTransportLogLine/, 'app.ts never builds the line')
  assert.match(app, /console\.log\(genStudioChatTransportLogLine\(\)\)/, 'the line never reaches the console')
  assert.match(app, /logLine\('info', 'genstudio\.transport'/, 'the line never reaches the log file')
  assert.match(app, /env_var: 'STORY_STUDIO_GENSTUDIO_CHAT_TRANSPORT'/)
  // And it runs unconditionally at boot, not behind the standalone-listen
  // branch — the packaged Electron build must log it too.
  const bootIndex = app.indexOf('genStudioChatTransportLogLine()')
  const listenIndex = app.indexOf('if (shouldListen)')
  assert.ok(bootIndex > 0 && bootIndex < listenIndex, 'the transport log is gated behind standalone listen')
})
