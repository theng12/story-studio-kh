/**
 * v1.4.7 — every credit figure on the Jobs page says "credits".
 *
 * From a real report. He was reading Project Jobs and asked whether the
 * capacity numbers were Story Studio's or GenStudio's. They are GenStudio's and
 * that part was working — but the question surfaced a genuine ambiguity next to
 * it. `GenStudioBatchLedger` rendered:
 *
 *     GenStudio batch:  50 items   450 on hold
 *
 * `450` is CREDITS, printed with no unit, immediately after a count that is
 * items. It reads as 450 items on hold.
 *
 * Worse, the same page spelled one fact three ways: the ledger printed
 * `450 charged` and `450 on hold` bare, while `jobs.vue` printed
 * `· on hold 450 credits` WITH the unit — but only on the held branch, leaving
 * `charged` and `returned` bare beside it.
 *
 * The figures themselves were correct — `heldFor` already refuses to invent a
 * hold from `credit_cost` — so this was never a wrong number, only an
 * unlabelled one. That is why the fix is wording and this test guards wording.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const ledger = read('../components/GenStudioBatchLedger.vue')
const jobs = read('../pages/projects/[slug]/jobs.vue')

/** Every mustache that renders one of the three credit figures. */
function creditLines(src: string): string[] {
  return src.split('\n').filter(l =>
    /\{\{[^}]*(?:charged|Charged|held|Held|returned|Returned)[^}]*\}\}/.test(l)
    && /charged|on hold|returned/.test(l))
}

test('every rendered credit figure carries its unit', () => {
  const lines = [...creditLines(ledger), ...creditLines(jobs)]
  assert.ok(lines.length >= 12, `expected the full set of credit renderings, found ${lines.length}`)
  for (const line of lines) {
    assert.match(
      line, /credits/,
      `a credit figure is rendered without its unit:\n  ${line.trim()}`,
    )
  }
})

test('the ledger head cannot read as an item count', () => {
  // The exact defect: a bare number directly after "N items".
  const head = ledger.slice(ledger.indexOf('gs-batch-head'), ledger.indexOf('gs-batch-progress'))
  assert.match(head, /items/)
  for (const word of ['charged', 'on hold', 'returned']) {
    const re = new RegExp(`\\}\\}\\s*${word}`)
    assert.ok(!re.test(head), `"${word}" still follows a bare number in the batch head`)
  }
})

test('one fact is spelled one way across the page', () => {
  // Before this release: "450 charged" in the ledger, "charged 450" in jobs.vue,
  // and "on hold 450 credits" one branch further on. A provisional total may
  // add "so far", but it must keep the same figure → unit → meaning order.
  for (const [name, src] of [['ledger', ledger], ['jobs.vue', jobs]] as const) {
    for (const line of creditLines(src)) {
      assert.match(
        line, /\}\}\s*credits\s+(?:(?:charged|on hold|returned)|\{\{\s*summary\.confirmed\s*\?\s*'(charged|returned)'\s*:\s*'\1 so far'\s*\}\})/,
        `${name} uses a different phrasing from the rest:\n  ${line.trim()}`,
      )
    }
  }
})
