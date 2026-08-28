/**
 * Metadata formulas exist because the write-up had no shapes to pick from:
 *
 *   "there's no meta data formulas that we can pick from. it's all build from
 *    scratch and a lot of people can't afford to spend time figure that out
 *    right? so what can we do? can we have like 5 built in options and then we
 *    can sell them in packs of 6 for 300 credits each"
 *
 * These pin the rules that make the answer real: five ship, a pack adds more on
 * the same terms, the five produce genuinely DIFFERENT shapes rather than five
 * wordings of one, a section's internal id never becomes viewer-facing text,
 * and — the one that protects every channel that already exists — picking
 * nothing changes nothing.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { ContentPackDocumentSchema, ContentPackItemKindSchema } from '../content-packs/schemas.js'
import { BUILT_IN_METADATA_FORMULA_IDS } from '../contracts/metadata-formulas.js'
import {
  getMetadataFormula,
  metadataFormulaCatalogue,
  metadataFormulaPlan,
  resolveActiveMetadataFormula,
  withMetadataFormulaShape,
} from '../services/metadata-formula-catalogue.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'
import type { Format } from '../models/types.js'

function packFormula(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'metadata-formula',
    schema_version: 1,
    id: 'com.example.metadata-formula.ledger',
    name: 'Ledger',
    description: 'A running account of what the episode establishes.',
    architecture: 'A numbered ledger of claims, each with its support.',
    description_plan: {
      max_chars: 1800,
      separator: 'rule',
      sections: [
        {
          id: 'entries',
          instruction: 'List what the episode establishes, one claim per line.',
          header: { render: true, text: 'The record' },
          target_chars: 400,
        },
        {
          id: 'closing',
          instruction: 'One sentence on what remains unsettled.',
          header: { render: false },
        },
      ],
    },
    title_plan: { mode: 'paraphrase', count: 3, max_length: 80, guidance: 'State the claim plainly.' },
    tag_plan: { count: 12, guidance: 'for this record-keeping episode' },
    tone: { constraints: ['Every claim must be one the episode supports.'] },
    ...overrides,
  }
}

describe('a pack can ship a metadata formula at all', () => {
  test('metadata-formula is a content pack item kind', () => {
    assert.equal(ContentPackItemKindSchema.safeParse('metadata-formula').success, true)
  })

  test('a well-formed formula validates', () => {
    const parsed = ContentPackDocumentSchema.safeParse(packFormula())
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
  })

  test('a section that renders a header must say what it says', () => {
    const parsed = ContentPackDocumentSchema.safeParse(packFormula({
      description_plan: {
        max_chars: 800,
        separator: 'none',
        sections: [{ id: 'body', instruction: 'Write it.', header: { render: true } }],
      },
    }))
    assert.equal(parsed.success, false)
  })

  test('two sections may not share an id', () => {
    const parsed = ContentPackDocumentSchema.safeParse(packFormula({
      description_plan: {
        max_chars: 800,
        separator: 'none',
        sections: [
          { id: 'body', instruction: 'Write it.', header: { render: false } },
          { id: 'body', instruction: 'Write it again.', header: { render: false } },
        ],
      },
    }))
    assert.equal(parsed.success, false)
  })

  test('a pack may never take a built-in formula id', () => {
    for (const id of BUILT_IN_METADATA_FORMULA_IDS) {
      const parsed = ContentPackDocumentSchema.safeParse(packFormula({ id }))
      assert.equal(parsed.success, false, `${id} was allowed to be shadowed`)
    }
  })
})

describe('the five built-ins', () => {
  test('all five load, and they are exactly the declared five', async () => {
    const rows = (await metadataFormulaCatalogue()).filter(row => row.source === 'built-in')
    assert.equal(rows.length, 5)
    assert.deepEqual(
      rows.map(row => row.id).sort(),
      [...BUILT_IN_METADATA_FORMULA_IDS].sort(),
    )
  })

  test('each one validates against the very schema a bought formula must satisfy', async () => {
    for (const row of await metadataFormulaCatalogue()) {
      // The pack-only anti-shadow rule is the single exception, so a built-in is
      // checked with its id swapped for one outside the protected namespace.
      const parsed = ContentPackDocumentSchema.safeParse({
        ...row.document,
        id: 'com.example.metadata-formula.probe',
      })
      assert.equal(parsed.success, true, `${row.id}: ${JSON.stringify(parsed.error?.issues)}`)
    }
  })

  test('they are five different SHAPES, not five wordings of one', async () => {
    const rows = (await metadataFormulaCatalogue()).filter(row => row.source === 'built-in')
    // The shape of a formula is its ordered section ids plus which of them show
    // a header. If two formulas agreed on both they would be the same
    // architecture wearing different prose, which is what the owner already had.
    const shapes = rows.map(row => JSON.stringify(
      row.document.description_plan.sections.map(s => `${s.id}:${s.header.render ? 'headed' : 'bare'}`),
    ))
    assert.equal(new Set(shapes).size, rows.length, 'two built-ins share a section architecture')
    // And they must not merely differ in section names while agreeing on length.
    assert.ok(new Set(rows.map(row => row.document.description_plan.max_chars)).size >= 4)
    assert.ok(new Set(rows.map(row => row.document.description_plan.separator)).size >= 2)
  })

  test('nothing about a formula is hardcoded in the app', async () => {
    // Every word the model receives has to be a field on the document, so the
    // owner can change any of it without a release.
    for (const row of await metadataFormulaCatalogue()) {
      const plan = metadataFormulaPlan(row)
      for (const [index, section] of row.document.description_plan.sections.entries()) {
        assert.ok(
          plan.sections[index].config.instructions.includes(section.instruction.trim()),
          `${row.id}/${section.id}: the document's own instruction did not reach the prompt`,
        )
      }
      assert.equal(plan.titleGuidance, row.document.title_plan.guidance)
      assert.equal(plan.tagGuidance, row.document.tag_plan.guidance)
      assert.equal(plan.descriptionMaxChars, row.document.description_plan.max_chars)
      assert.equal(plan.tagCount, row.document.tag_plan.count)
    }
  })
})

describe('a section id is an instruction, never viewer-facing text', () => {
  test('a headed section is told the exact line to print', async () => {
    const rows = await metadataFormulaCatalogue()
    let checked = 0
    for (const row of rows) {
      const plan = metadataFormulaPlan(row)
      row.document.description_plan.sections.forEach((section, index) => {
        if (!section.header.render) return
        checked++
        const instructions = plan.sections[index].config.instructions
        assert.ok(
          instructions.includes(JSON.stringify(section.header.text)),
          `${row.id}/${section.id}: the exact header line was not stated`,
        )
      })
    }
    assert.ok(checked > 0, 'no headed sections were exercised')
  })

  test('an unheaded section is told in as many words not to print its name', async () => {
    const rows = await metadataFormulaCatalogue()
    let checked = 0
    for (const row of rows) {
      const plan = metadataFormulaPlan(row)
      row.document.description_plan.sections.forEach((section, index) => {
        if (section.header.render) return
        checked++
        const instructions = plan.sections[index].config.instructions
        assert.match(instructions, /Do not print any heading, label, or section name/)
        assert.match(instructions, /internal instruction key and must never appear in the description/)
      })
    }
    assert.ok(checked > 0, 'no unheaded sections were exercised')
  })
})

describe('picking nothing changes nothing', () => {
  test('no request field and no channel default resolves to no formula', async () => {
    assert.equal(await resolveActiveMetadataFormula({ config: {} }), null)
    assert.equal(await resolveActiveMetadataFormula({ config: null }), null)
    assert.equal(await resolveActiveMetadataFormula({}), null)
  })

  test("the channel's default applies when the request names nothing", async () => {
    const resolved = await resolveActiveMetadataFormula({
      config: { metadata_formula_id: BUILT_IN_METADATA_FORMULA_IDS[0] },
    })
    assert.equal(resolved?.id, BUILT_IN_METADATA_FORMULA_IDS[0])
  })

  test('an explicit request id beats the channel default', async () => {
    const resolved = await resolveActiveMetadataFormula({
      requestedId: BUILT_IN_METADATA_FORMULA_IDS[1],
      config: { metadata_formula_id: BUILT_IN_METADATA_FORMULA_IDS[0] },
    })
    assert.equal(resolved?.id, BUILT_IN_METADATA_FORMULA_IDS[1])
  })

  test('an explicit EMPTY request id means "no formula for this episode"', async () => {
    // The channel has one and the episode is opting out — the same rule the
    // channel title prefix/suffix override already uses.
    const resolved = await resolveActiveMetadataFormula({
      requestedId: '',
      config: { metadata_formula_id: BUILT_IN_METADATA_FORMULA_IDS[0] },
    })
    assert.equal(resolved, null)
  })

  test('an unknown id resolves to no formula rather than the wrong one', async () => {
    assert.equal(await getMetadataFormula('com.example.metadata-formula.nope'), null)
    assert.equal(await resolveActiveMetadataFormula({ requestedId: 'not-a-formula' }), null)
  })
})

describe("a formula shapes the write-up without silencing the channel", () => {
  test("the channel's own voice survives and the formula's rules are added to it", async () => {
    const row = (await metadataFormulaCatalogue())[0]
    const plan = metadataFormulaPlan(row)
    const format = {
      metadata: {
        descriptionShape: {
          voiceGuidance: 'Speak as a prayer channel.',
          descriptionShapeRules: ['Never open with hype.'],
        },
      },
    } as unknown as Format
    const merged = withMetadataFormulaShape(format, plan, row.architecture)
    const shape = merged!.metadata!.descriptionShape!
    assert.equal(shape.voiceGuidance, 'Speak as a prayer channel.')
    assert.equal(shape.descriptionShapeRules?.[0], 'Never open with hype.')
    for (const constraint of plan.toneConstraints) {
      assert.ok(shape.descriptionShapeRules?.includes(constraint))
    }
  })

  test('the separator is the formula\'s choice, and it reaches the prompt as THE rule', async () => {
    for (const row of await metadataFormulaCatalogue()) {
      const plan = metadataFormulaPlan(row)
      const separator = row.document.description_plan.separator
      if (separator === 'none') assert.match(plan.separatorRule, /Do not use separator lines/)
      if (separator === 'rule') assert.match(plan.separatorRule, /horizontal rule line/)
      if (separator === 'blank-line') assert.match(plan.separatorRule, /single blank line/)
      // It must arrive on descriptionShape.separatorRule, because that is the
      // field the prompt builder uses INSTEAD of its own default line. Left in
      // the rules list it would sit alongside a contradicting instruction.
      const shape = withMetadataFormulaShape(null, plan, row.architecture)!.metadata!.descriptionShape!
      assert.equal(shape.separatorRule, plan.separatorRule)
    }
  })

  test('a formula asking for no dividers is not contradicted by its own prompt', async () => {
    const row = (await metadataFormulaCatalogue())
      .find(r => r.document.description_plan.separator === 'none')
    assert.ok(row, 'no built-in formula asks for a divider-free description')
    const plan = metadataFormulaPlan(row!)
    const prompt = buildDescriptionPrompt(
      'TN0001', 'A Title', 'context', plan.sections as never,
      plan.descriptionMaxChars, withMetadataFormulaShape(null, plan, row!.architecture),
    )
    assert.doesNotMatch(prompt, /Use separator lines/)
    assert.match(prompt, /Do not use separator lines/)
  })

  test('a channel with no formula still gets the long-standing separator line', () => {
    const prompt = buildDescriptionPrompt('TN0001', 'A Title', 'context', [], 5000, null)
    assert.match(prompt, /Use separator lines \(──────\) between major sections\./)
  })
})
