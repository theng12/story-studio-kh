import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { filterGenerated, isTooSimilar } from '../services/idea-similarity.js'

describe('Ideas originality guard', () => {
  test('blocks a rephrased concept even when the title wording changes', () => {
    const existing = {
      title: 'How the Antikythera Mechanism Survived the Sea',
      logline: 'Ancient Greek gears crossed the Mediterranean, sank in a shipwreck, and survived underwater until divers recovered the machine.',
      themes: ['ancient technology', 'shipwreck', 'archaeology'],
    }
    const candidate = {
      title: 'The Ancient Computer Recovered by Divers',
      logline: 'Greek mechanical gears were preserved in a Mediterranean shipwreck before divers recovered this ancient technology.',
      themes: ['archaeology', 'ancient technology', 'shipwreck'],
    }

    assert.equal(isTooSimilar(candidate, existing), true)
  })

  test('checks the complete prior pool and deduplicates the generated batch', () => {
    const prior = Array.from({ length: 220 }, (_, index) => ({
      title: `Original subject ${index}`,
      logline: `A distinct account about subject ${index} and its consequence.`,
      themes: [`subject-${index}`, 'history'],
    }))
    const candidates = [
      { ...prior[0], title: 'Original subject 0 revisited' },
      {
        title: 'A Clockmaker Who Standardized Railway Time',
        logline: 'A provincial clockmaker helps towns coordinate railway departures.',
        themes: ['timekeeping', 'railways'],
      },
      {
        title: 'How a Clockmaker Standardized Railway Time',
        logline: 'A clockmaker helps towns coordinate railway schedules and departures.',
        themes: ['timekeeping', 'railways'],
      },
    ]

    const result = filterGenerated(candidates, prior)
    assert.equal(result.kept.length, 1)
    assert.equal(result.kept[0]?.title, 'A Clockmaker Who Standardized Railway Time')
    assert.equal(result.rejected.length, 2)
  })
})
