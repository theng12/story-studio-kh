/**
 * Section names are instructions, not headings (v1.4.75).
 *
 * A Sleep Story description was published beginning `HOOK: In tonight's story,
 * we dive into a gentle journey…`. `HOOK` is what the prompt calls that
 * instruction; the model printed the name along with the paragraph.
 *
 * Both ends are pinned here: the prompt now tells the model those names are
 * internal, and `stripInternalSectionLabels` removes them from descriptions
 * already saved with the leak baked in. Twenty-five saved packages sampled
 * across ten channels held it in five, so the read side is not hypothetical.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripInternalSectionLabels,
  internalSectionNamesDirective,
  INTERNAL_SECTION_LABELS,
} from '../lib/metadata-label-leak.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'
import { METADATA_SECTION_LIST } from '../lib/metadata-sections.js'
import { snippetFromMeta } from '../lib/upload-metadata.js'

const section = (id: string, config: Record<string, any> = {}) => ({
  id, label: id, type: 'builtin', enabled: true, config,
})

describe('the leak the owner reported', () => {
  test('a description that opens with the HOOK instruction name loses it, keeping the paragraph', () => {
    const leaked = 'HOOK: In tonight\'s story, we dive into a gentle journey through a harbour at dusk.'
    assert.equal(
      stripInternalSectionLabels(leaked),
      'In tonight\'s story, we dive into a gentle journey through a harbour at dusk.',
    )
  })

  test('the name alone on its own first line is removed with the line', () => {
    const leaked = 'Hook:\nA simple cut. A few days ago, it was nothing.'
    assert.equal(stripInternalSectionLabels(leaked), 'A simple cut. A few days ago, it was nothing.')
  })

  test('the prompt tells the model HOOK is a name, not a heading', () => {
    const prompt = buildDescriptionPrompt('EP0001', 'A Harbour at Dusk', 'context', [section('hook', { characters: 220 })], 5000)
    assert.match(prompt, /internal instruction names, not headings/)
    assert.match(prompt, /\(HOOK\)/)
  })
})

describe('stripInternalSectionLabels — the labels found in saved packages', () => {
  // Every variant below was observed verbatim in a real saved description.
  const cases: Array<[string, string]> = [
    ['bold with a colon', '**SUBSCRIBE / LIKE CTA:**'],
    ['bold without a colon', '**SUBSCRIBE / LIKE CTA**'],
    ['bare, no colon', 'SUBSCRIBE / LIKE CTA'],
    ['a custom section the operator named', '**ABOUT ME:**'],
    ['an unknown bare name', 'DISCLAIMER'],
    ['a built-in name with no colon', 'HASHTAGS'],
    ['markdown heading syntax', '## HOOK'],
  ]
  for (const [label, line] of cases) {
    test(`removes ${label}`, () => {
      const out = stripInternalSectionLabels(`Opening paragraph.\n\n${line}\nThe copy underneath.`)
      assert.equal(out, 'Opening paragraph.\n\nThe copy underneath.')
    })
  }

  test('removes several leaked names from one description', () => {
    const leaked = [
      'A quiet tale for a winter night.',
      '',
      '**ABOUT ME:**',
      'Hello everyone, it is your host.',
      '',
      '**SUBSCRIBE / LIKE CTA:**',
      'Subscribe if this helped you drift off.',
      '',
      '**HASHTAGS:**',
      '#sleepstory #cozy',
    ].join('\n')
    assert.equal(stripInternalSectionLabels(leaked), [
      'A quiet tale for a winter night.',
      '',
      'Hello everyone, it is your host.',
      '',
      'Subscribe if this helped you drift off.',
      '',
      '#sleepstory #cozy',
    ].join('\n'))
  })

  test('is idempotent — a clean description is returned unchanged', () => {
    const clean = 'A quiet tale.\n\nSubscribe if this helped you drift off.\n\n#sleepstory'
    assert.equal(stripInternalSectionLabels(clean), clean)
    assert.equal(stripInternalSectionLabels(stripInternalSectionLabels(clean)), clean)
  })

  test('empty and blank input pass straight through', () => {
    assert.equal(stripInternalSectionLabels(''), '')
    assert.equal(stripInternalSectionLabels('   '), '   ')
  })
})

describe('stripInternalSectionLabels — what it must never touch', () => {
  test('keeps the headings the app itself asks for', () => {
    // These are what the reader is supposed to see. `applyEmojiPolicy` removes
    // the emoji from generated text by default, so each arrives bare — spelled
    // identically to an internal name, which is exactly why they need naming.
    for (const heading of ['MUSIC', 'PLAYLISTS:', 'AI DISCLOSURE:', 'MORE VIDEOS:', 'SUPPORT THE CHANNEL', 'CHAPTERS', 'SOURCES & FURTHER READING']) {
      const body = `Opening.\n\n${heading}\nThe section body.`
      assert.equal(stripInternalSectionLabels(body), body, `stripped a real heading: ${heading}`)
    }
  })

  test('keeps a credit line whose value is the content', () => {
    // The legacy metadata section asks for exactly these, as copy.
    const body = 'Opening.\n\nNarrator: Vincent\nCHANNEL: The Dozing Knight'
    assert.equal(stripInternalSectionLabels(body), body)
  })

  test('drops a hashtag that is only the section name, keeping the real tags', () => {
    // `#HASHTAGS` was published on seven of the hundred and eighteen
    // descriptions sampled — the model made a tag out of the instruction name.
    assert.equal(
      stripInternalSectionLabels('A quiet tale.\n\n#SleepStory #HASHTAGS #Cozy'),
      'A quiet tale.\n\n#SleepStory #Cozy',
    )
  })

  test('a bolded label hashtag takes its now-empty emphasis markers with it', () => {
    // `**#Hashtags**` must not leave `****` standing on the line.
    assert.equal(stripInternalSectionLabels('A tale.\n\n**#Hashtags**\n#SleepStory'), 'A tale.\n\n#SleepStory')
    assert.equal(stripInternalSectionLabels('A tale.\n\n**#HASHTAGS** #Cozy'), 'A tale.\n\n#Cozy')
  })

  test('real bold survives a line that lost a label hashtag', () => {
    assert.equal(
      stripInternalSectionLabels('A **really** good tale. #SleepStory #HASHTAGS'),
      'A **really** good tale. #SleepStory',
    )
  })

  test('keeps hashtags, dividers and ordinary prose', () => {
    const body = 'A quiet tale.\n\n──────\n\n#SleepStory #Cozy #Bedtime'
    assert.equal(stripInternalSectionLabels(body), body)
  })

  test('leaves the finalizer\'s managed blocks exactly as rendered', () => {
    const body = [
      'Opening paragraph.',
      '',
      '<!-- youtube:chapters:start -->',
      'CHAPTERS',
      '00:00 Arrival',
      '<!-- youtube:chapters:end -->',
    ].join('\n')
    assert.equal(stripInternalSectionLabels(body), body)
  })

  test('does not shorten a sentence that merely opens with a capitalised word', () => {
    const body = 'MUSIC plays softly as the harbour empties, and the lanterns come on one by one.'
    assert.equal(stripInternalSectionLabels(body), body)
  })
})

describe('the prompt names its own internal labels', () => {
  test('a section whose instruction quotes a real heading is NOT declared internal', () => {
    // Telling the model never to print MUSIC would delete the "🎵 MUSIC"
    // heading the same instruction just asked for.
    const prompt = buildDescriptionPrompt('EP1', 'T', 'ctx', [
      section('hook'),
      section('music', { title: 'Night Harbour', link: 'https://example.invalid' }),
      section('playlists', { playlists: [{ name: 'Sleep', url: 'https://example.invalid' }] }),
      section('ai-disclosure', { text: 'Made with AI.' }),
    ], 5000)
    // Only the parenthesised list of names, not the section instructions above it.
    const named = /The capitalised names above \(([^)]*)\)/.exec(prompt)?.[1]
    assert.equal(named, 'HOOK')
  })

  test('a custom section is declared internal under the name the operator gave it', () => {
    const prompt = buildDescriptionPrompt('EP1', 'T', 'ctx', [
      { id: 'custom-1', label: 'About Me', type: 'custom', enabled: true, config: { instructions: 'Introduce the host.' } },
    ], 5000)
    assert.match(prompt, /internal instruction names, not headings/)
    assert.match(prompt, /\(ABOUT ME\)/)
  })

  test('a section that contributed no instruction names nothing', () => {
    // An empty channels config produces no bullet, so there is no name to warn about.
    const prompt = buildDescriptionPrompt('EP1', 'T', 'ctx', [section('channels', { channels: [] })], 5000)
    assert.doesNotMatch(prompt, /internal instruction names/)
  })

  test('no sections at all means no directive', () => {
    assert.equal(internalSectionNamesDirective([]), '')
  })
})

describe('the registry declares what its instructions actually say', () => {
  // `promptLabel` is what both halves of the fix key off. If a buildInstruction
  // is reworded without updating it, the prompt warns about a name it no longer
  // uses and the strip misses the one it does.
  const exercising: Record<string, Record<string, any>> = {
    channels: { channels: [{ name: 'Main', url: 'https://example.invalid', kind: 'own' }] },
    playlists: { playlists: [{ name: 'Sleep', url: 'https://example.invalid' }] },
    support: { platforms: [{ kind: 'patreon', url: 'https://example.invalid' }] },
    metadata: { narrator_enabled: true, narrator_name: 'Vincent' },
  }
  for (const def of METADATA_SECTION_LIST) {
    if (!def.promptLabel) continue
    test(`${def.id} opens its bullet with "${def.promptLabel}:"`, () => {
      const cfg = { ...def.defaultConfig, ...(exercising[def.id] || {}) }
      const instruction = def.buildInstruction(cfg, {}, { id: def.id, label: def.label })
      assert.ok(instruction, `${def.id} produced no instruction to check`)
      assert.ok(
        instruction.startsWith(`\n- ${def.promptLabel}:`),
        `${def.id} declares promptLabel "${def.promptLabel}" but its bullet begins: ${instruction.slice(0, 60)}`,
      )
    })
  }

  test('sections that ask for a literal heading are excluded from the strip set', () => {
    for (const def of METADATA_SECTION_LIST) {
      if (!def.literalHeader || !def.promptLabel) continue
      assert.ok(
        !INTERNAL_SECTION_LABELS.includes(def.promptLabel),
        `${def.id} asks for a "${def.promptLabel}" heading but is on the strip list`,
      )
    }
    assert.ok(INTERNAL_SECTION_LABELS.includes('HOOK'))
    assert.ok(INTERNAL_SECTION_LABELS.includes('SUBSCRIBE / LIKE CTA'))
  })
})

describe('the publish path cleans a package saved before the fix', () => {
  // The Finalizer reuses a complete `existing_package` rather than respend
  // credits, so a description saved with the leak may never be regenerated.
  // This is the last gate before the YouTube Data API.
  test('snippetFromMeta strips a leaked label out of the description it uploads', () => {
    const snippet = snippetFromMeta({
      title: 'A Harbour at Dusk',
      description: 'HOOK: In tonight\'s story, we drift out past the harbour wall.\n\n**HASHTAGS:**\n#sleepstory',
      tags: ['sleep story'],
      thumbnailPath: '',
    })
    assert.equal(
      snippet.description ?? '',
      'In tonight\'s story, we drift out past the harbour wall.\n\n#sleepstory',
    )
  })

  test('it still leaves a real heading in the uploaded description', () => {
    const snippet = snippetFromMeta({
      title: 'A Harbour at Dusk',
      description: 'A quiet tale.\n\nAI DISCLOSURE:\nMade with the help of AI tools.',
      tags: [],
      thumbnailPath: '',
    })
    assert.match(snippet.description ?? '', /AI DISCLOSURE:/)
  })
})
