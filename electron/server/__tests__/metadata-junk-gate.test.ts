/**
 * The metadata document must not become the video (v1.4.84).
 *
 * Three scheduled uploads were published with the model's own list heading as
 * their title — `# SEO-Optimized Video Titles — EP0061` — because the title
 * parser stripped `-`, digits, `.`, `)` and quotes from each line and had
 * nothing to say about `#`. Descriptions went out carrying `**AI DISCLOSURE:**`
 * and `🎬 EPISODE EP0057 — …`, which YouTube prints exactly as written.
 *
 * CALIBRATION. Every rule here was measured against all 857 metadata packages
 * across ten real channels before it was trusted, per the standing rule that a
 * new checker's findings are hypotheses until it clears a known-good corpus.
 * The numbers that came back:
 *
 *   - `isScaffoldTitleLine` flagged 4 of 857 titles: the 3 known failures and
 *     one package whose title was genuinely empty on disk. 853 good titles
 *     passed. Zero false positives.
 *   - The gate found 4 bad titles and 91 bad descriptions in what the shipped
 *     build would have published.
 *   - After the recovery and the strip, 0 descriptions and 0 titles trip it
 *     (the empty one excepted, and the upload path substitutes the idea title
 *     for that before the gate ever sees it).
 *   - Of 857 descriptions, exactly 3 lost a word to the strip, and every lost
 *     word was scaffolding: `EPISODE`, `EP0052`, `EP0057`, `EP0040`. No prose
 *     was removed anywhere in the corpus.
 *
 * ONE RULE WAS REJECTED BY THAT PASS, which is the whole point of running it:
 * "a title must not contain an episode code" would have refused four correct
 * titles that end in one on purpose — `A Prayer for the Sermon I Heard Today |
 * EP0339` and three like it. The scaffold rule is anchored to the start of the
 * title, and the fixture below holds that shape so it stays anchored.
 *
 * The fixtures reproduce the SHAPES found in the corpus. The words are
 * invented; nothing here is anyone's channel or episode.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertPublishableMetadata,
  findMetadataJunk,
  isScaffoldTitleLine,
  stripMarkdownScaffold,
  stripTitleScaffold,
} from '../lib/metadata-scaffold.js'
import { snippetFromMeta } from '../lib/upload-metadata.js'

// ── The three shapes the model actually produced ──────────────────────────

/** EP0056 / EP0062's shape: a bare heading above the list. */
const HEADING_FIRST = [
  '# SEO-Optimized Video Titles — EP0042',
  'The Harbour That Waited Nine Hundred Years',
  'Why Every Map of This Coast Was Wrong',
  'The Vow That Built a Cathedral',
  'What the Pilots Never Wrote Down',
  'The Storm Nobody Survived Twice',
].join('\n')

/** EP0061's shape: the heading counts the list too. */
const HEADING_WITH_COUNT = [
  '# 5 SEO-Optimized Video Titles — EP0042',
  'When a Queen Outlasted Two Kings',
  'The Rebellion That Never Reached the Chronicles',
  'How One Letter Emptied a Treasury',
  'Inside the Winter Nobody Recorded',
  'The Year the Roads Stayed Closed',
].join('\n')

/** The good shape — the overwhelming majority of the corpus. */
const CLEAN_LIST = [
  'The Harbour That Waited Nine Hundred Years',
  'Why Every Map of This Coast Was Wrong',
  'The Vow That Built a Cathedral',
].join('\n')

/** How the shipped parser cleaned each line, reproduced exactly. */
function legacyLineClean(raw: string): string[] {
  return raw.split('\n')
    .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
}

describe('isScaffoldTitleLine — what is furniture and what is a title', () => {
  test('the exact heading that reached YouTube is refused, in both forms', () => {
    for (const raw of [HEADING_FIRST, HEADING_WITH_COUNT]) {
      const lines = legacyLineClean(raw)
      assert.equal(isScaffoldTitleLine(lines[0]), true, `not caught: ${lines[0]}`)
      for (const line of lines.slice(1)) {
        assert.equal(isScaffoldTitleLine(line), false, `wrongly caught: ${line}`)
      }
    }
  })

  test('the heading survives the old line-clean, which is why it got through', () => {
    // `.replace(/^[\-\d\.\)]+\s*/, '')` eats the "5 " but not the "# ".
    const [first] = legacyLineClean(HEADING_WITH_COUNT)
    assert.equal(first, '# 5 SEO-Optimized Video Titles — EP0042')
    assert.equal(first.startsWith('#'), true)
  })

  test('every line of a well-formed list is kept', () => {
    for (const line of legacyLineClean(CLEAN_LIST)) {
      assert.equal(isScaffoldTitleLine(line), false, line)
    }
  })

  test('a title that ENDS with an episode code is legitimate and is kept', () => {
    // Four of the 857 packages do exactly this. A rule that refused them
    // would have been wrong about four good episodes to be right about three
    // bad ones.
    const real = [
      'A Prayer for the Sermon I Heard Today | EP0339',
      'Prayer for My Future • EP0341 – A Sacred Quiet Before Tomorrow',
      'A Prayer for When Friends Drift Apart — EP0342',
      'Forgotten Granaries of the South: The Silent Foundation EP0048',
      'The Economics of a High-Volume Car Wash: EP0002',
    ]
    for (const title of real) {
      assert.equal(isScaffoldTitleLine(title), false, title)
      assert.equal(findMetadataJunk({ title }).length, 0, title)
    }
  })

  test('a title that BEGINS with an episode label is furniture', () => {
    for (const title of ['EPISODE EP0042 — The Harbour', 'EP0042 - The Harbour', 'EP0042: The Harbour']) {
      assert.equal(isScaffoldTitleLine(title), true, title)
    }
  })

  test('an ordinary numbered or hashtagged title is not furniture', () => {
    for (const title of ['5 Things the Chronicles Left Out', 'The #1 Reason the Fleet Turned Back']) {
      assert.equal(isScaffoldTitleLine(title), false, title)
      assert.equal(findMetadataJunk({ title }).length, 0, title)
    }
  })

  test('a title that opens with a YEAR and a dash is not furniture', () => {
    // A channel about the past writes these constantly. An episode code has letters
    // in it; a year does not, and that is the whole difference between this
    // rule being useful and it refusing good work.
    for (const title of [
      '1917 — The Year Everything Changed',
      '1666: The Fire Nobody Planned For',
      '1348 - What the Chroniclers Left Out',
    ]) {
      assert.equal(isScaffoldTitleLine(title), false, title)
      assert.equal(findMetadataJunk({ title }).length, 0, title)
    }
  })
})

describe('stripMarkdownScaffold — take the marks, keep the words', () => {
  test('a bolded heading keeps its heading', () => {
    // 40 of the 89 bold runs in the corpus are this one label. The operator
    // wants the label; he does not want the asterisks.
    assert.equal(stripMarkdownScaffold('**🤖 AI DISCLOSURE:**'), '🤖 AI DISCLOSURE:')
    assert.equal(stripMarkdownScaffold('**SUBSCRIBE**'), 'SUBSCRIBE')
    assert.equal(stripMarkdownScaffold('**📋 PLAYLISTS:**'), '📋 PLAYLISTS:')
  })

  test('a markdown heading loses the hash and keeps the sentence', () => {
    assert.equal(
      stripMarkdownScaffold('# The Harbour That Waited Nine Hundred Years'),
      'The Harbour That Waited Nine Hundred Years',
    )
    assert.equal(stripMarkdownScaffold('## Chapter 01: The Quiet Harbour'), 'Chapter 01: The Quiet Harbour')
  })

  test('a hashtag is not a heading', () => {
    assert.equal(stripMarkdownScaffold('#History #Medieval'), '#History #Medieval')
  })

  test('the episode label goes, the emoji and the sentence stay', () => {
    assert.equal(
      stripMarkdownScaffold('🎬 EPISODE EP0042 — How the Engineers Dried the River'),
      '🎬 How the Engineers Dried the River',
    )
  })

  test('inline emphasis and code marks are unwrapped', () => {
    assert.equal(stripMarkdownScaffold('The *only* surviving `ledger` entry.'), 'The only surviving ledger entry.')
  })

  test('an unclosed bold marker is removed rather than left dangling', () => {
    assert.equal(stripMarkdownScaffold('**HOOK: the fleet turned back'), 'HOOK: the fleet turned back')
  })

  test('a fenced block loses its fences and keeps its lines', () => {
    assert.equal(stripMarkdownScaffold('before\n```\nkept\n```\nafter'), 'before\nkept\nafter')
  })

  test('arithmetic and snake_case are left alone', () => {
    assert.equal(stripMarkdownScaffold('2 * 3 * 4 and some_file_name'), '2 * 3 * 4 and some_file_name')
  })

  test('the finalizer owns what it renders — managed blocks pass through', () => {
    const description = [
      '**INTRO**',
      '',
      '<!-- youtube:chapters:start -->',
      '## Chapters',
      '00:00 **Opening**',
      '<!-- youtube:chapters:end -->',
    ].join('\n')
    const out = stripMarkdownScaffold(description)
    assert.equal(out.includes('## Chapters'), true)
    assert.equal(out.includes('00:00 **Opening**'), true)
    assert.equal(out.startsWith('INTRO'), true)
  })

  test('no line is deleted for its content', () => {
    const description = ['**A**', '', 'plain prose', '', '# B', 'more prose'].join('\n')
    const out = stripMarkdownScaffold(description)
    for (const word of ['A', 'plain prose', 'B', 'more prose']) {
      assert.equal(out.includes(word), true, word)
    }
  })
})

describe('stripTitleScaffold', () => {
  test('the published failure becomes the words it wrapped', () => {
    assert.equal(stripTitleScaffold('# 5 SEO-Optimized Video Titles — EP0042'), '5 SEO-Optimized Video Titles — EP0042')
  })

  test('a bolded title loses only the bold', () => {
    assert.equal(stripTitleScaffold('**The Harbour That Waited**'), 'The Harbour That Waited')
  })

  test('a good title is returned unchanged', () => {
    const title = 'The Harbour That Waited Nine Hundred Years'
    assert.equal(stripTitleScaffold(title), title)
  })
})

describe('findMetadataJunk — the gate, and what it says', () => {
  test('the three published titles are each refused, by name', () => {
    for (const title of [
      '# SEO-Optimized Video Titles — EP0042',
      '# 5 SEO-Optimized Video Titles — EP0042',
      '# SEO-Optimized Video Titles — EP0043',
    ]) {
      const findings = findMetadataJunk({ title })
      assert.equal(findings.length >= 1, true, title)
      assert.equal(findings[0].field, 'title')
      // The refusal quotes the text at fault — the operator has to be able to
      // see what it is objecting to without opening a file.
      assert.equal(findings[0].problem.includes(title), true, findings[0].problem)
    }
  })

  test('an empty title is refused', () => {
    assert.equal(findMetadataJunk({ title: '   ' })[0].problem, 'the title is empty')
  })

  test('formatting marks in a title are refused and quoted', () => {
    const findings = findMetadataJunk({ title: 'The **Harbour** That Waited' })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].problem.includes('**'), true)
  })

  test('a leaked heading and leaked bold in a description are both refused', () => {
    const findings = findMetadataJunk({
      title: 'The Harbour That Waited',
      description: '# The Harbour That Waited\n\n**🎭 HOOK**\n\nShe was once queen of two countries.',
    })
    const fields = findings.map(f => f.field)
    assert.equal(fields.every(f => f === 'description'), true)
    assert.equal(findings.length >= 2, true)
  })

  test('the description scaffold prefix is refused', () => {
    const findings = findMetadataJunk({
      title: 'The Harbour That Waited',
      description: '🎬 EPISODE EP0042 — The Harbour That Waited\n\nA sentence a viewer reads.',
    })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].field, 'description')
  })

  test('a clean package passes', () => {
    assert.deepEqual(findMetadataJunk({
      title: 'The Harbour That Waited Nine Hundred Years',
      description: [
        '🌊 THE HARBOUR THAT WAITED NINE HUNDRED YEARS',
        '',
        'When the fleet faced destruction, one man made a vow.',
        '',
        '📺 SUBSCRIBE for more untold stories.',
        '#History #Medieval',
      ].join('\n'),
    }), [])
  })

  test('what the finalizer renders inside its own block is never second-guessed', () => {
    assert.deepEqual(findMetadataJunk({
      title: 'The Harbour That Waited',
      description: '<!-- youtube:chapters:start -->\n## Chapters\n00:00 **Opening**\n<!-- youtube:chapters:end -->',
    }), [])
  })
})

describe('assertPublishableMetadata — the refusal itself', () => {
  test('it says what is wrong, quotes the text, and names the episode', () => {
    assert.throws(
      () => assertPublishableMetadata({ title: '# SEO-Optimized Video Titles — EP0042' }, { episode_code: 'EP0042' }),
      (error: Error) => {
        assert.equal(error.message.includes('EP0042'), true)
        assert.equal(error.message.includes('# SEO-Optimized Video Titles — EP0042'), true)
        assert.equal(error.message.includes('Metadata page'), true)
        // Plain words only — no identifiers, no stack, no code names.
        assert.equal(/[A-Z_]{4,}_[A-Z_]{3,}/.test(error.message), false)
        return true
      },
    )
  })

  test('a clean package is not refused', () => {
    assert.doesNotThrow(() => assertPublishableMetadata({
      title: 'The Harbour That Waited',
      description: 'A sentence a viewer reads.',
    }))
  })
})

describe('snippetFromMeta — the whole path, end to end', () => {
  test('a package carrying the published defect comes out clean', () => {
    const snippet = snippetFromMeta({
      title: '# 5 SEO-Optimized Video Titles — EP0042',
      description: [
        '# The Harbour That Waited',
        '',
        '**🎭 HOOK**',
        '',
        'She was once queen of two countries.',
        '',
        '**🤖 AI DISCLOSURE:** This episode uses AI narration.',
      ].join('\n'),
      tags: ['history'],
      thumbnailPath: '',
    })
    // The title still needs choosing by a human — the strip cannot invent one
    // — but nothing markdown survives to YouTube from either field.
    assert.equal(snippet.title.includes('#'), false)
    assert.equal(snippet.description?.includes('**'), false)
    assert.equal(/^#{1,6}\s/m.test(snippet.description || ''), false)
    // And the words are all still there.
    assert.equal(snippet.description?.includes('She was once queen of two countries.'), true)
    assert.equal(snippet.description?.includes('AI DISCLOSURE:'), true)
    assert.equal(snippet.description?.includes('The Harbour That Waited'), true)
  })

  test('the cleaned output of a real-shaped package passes the gate', () => {
    const snippet = snippetFromMeta({
      title: 'The Harbour That Waited Nine Hundred Years',
      description: '**📋 PLAYLISTS:**\n\nMore stories from this era.\n\n🎬 EPISODE EP0042 — The Harbour',
      tags: ['history'],
      thumbnailPath: '',
    })
    assert.deepEqual(findMetadataJunk(snippet), [])
  })
})
