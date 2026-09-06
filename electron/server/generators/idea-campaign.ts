import type { Format, GenerateIdeasRequest, Job, Niche, StoryIdea } from '../models/types.js'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import { callAiWithRetry } from '../lib/ai-client.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { composeNicheWithTopicPacks, loadNiche } from '../services/niche-loader.js'
import {
  assignmentSummary,
  planIdeaAssignments,
  type IdeaAssignment,
} from '../services/idea-campaign-planner.js'
import {
  filterGenerated,
  tokenize,
  type SimilarityCandidate,
} from '../services/idea-similarity.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { ideaOutputTokenBudget } from '../services/idea-output-budget.js'
import { ideaCampaignOutputContract } from '../lib/story-output-contracts.js'
import {
  applyFormulaEpisodeProfile,
  applyFormulaEpisodeProfileTitle,
  resolveFormulaEpisodeProfile,
} from '../services/formula-production-kit.js'
import { truncateChars } from '../lib/well-formed-text.js'
import { applyEmojiPolicy, NO_EMOJI_DIRECTIVE } from '../lib/emoji-policy.js'
import { generateFreeformIdeaBatch, rewriteLeadingCount, type AvoidItem } from '../services/freeform-idea-generation.js'

interface IdeaCampaignParams extends GenerateIdeasRequest {
  campaign_id: string
  series_formula_id?: string
  topic_pack_ids?: string[]
  title_prefix?: string
  title_suffix?: string
}

export function parseArray(raw: string): any[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('Idea Campaign provider returned no JSON array')
  const parsed = JSON.parse(text.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('Idea Campaign provider response was not an array')
  return parsed
}

function titleRules(format: Format): string {
  const rules = format.idea.titleShapeRules || []
  return rules.length
    ? rules.map(rule => `- ${rule}`).join('\n')
    : '- Match the Series Formula and examples. Keep the assigned subject concrete.'
}

function examples(format: Format): string {
  return (format.idea.exampleIdeas || [])
    .slice(0, 20)
    .map(example => `- ${example.title}`)
    .join('\n')
}

function campaignPrompt(options: {
  request: IdeaCampaignParams
  format: Format
  niche: Niche
  assignments: IdeaAssignment[]
  avoid: SimilarityCandidate[]
  standards?: string | null
}): string {
  const { request, format, assignments } = options
  const assignmentBlock = assignments
    .map((assignment, index) => {
      const profiledNiche = applyFormulaEpisodeProfile(options.niche, assignment.dimensions)
      const profile = resolveFormulaEpisodeProfile(options.niche, assignment.dimensions)
      const role = profiledNiche.ideaSystemPromptRole || format.idea.systemPromptRole
      const guidance = profiledNiche.ideaGuidanceText || format.idea.guidanceText
      return `${index + 1}. idea_key="${assignment.idea_key}" — ${assignmentSummary(assignment)}
   IDEA ROLE: ${role}
   IDEA GUIDANCE: ${guidance}${profiledNiche.scriptContext ? `
   IDEA CONTEXT: ${profiledNiche.scriptContext}` : ''}${profile?.titlePolicy ? `
   PROFILE TITLE POLICY: ${profile.titlePolicy}` : ''}`
    })
    .join('\n')
  const avoidBlock = options.avoid
    .slice(-200)
    .map(item => `- ${item.title}`)
    .join('\n')
  const template = request.title_template?.trim()
    ? `Every title must follow this template, replacing its placeholders with the assigned dimensions: "${request.title_template.trim()}".`
    : ''
  const refinements = [
    request.genre ? `Genre: ${request.genre}` : '',
    request.theme ? `Theme: ${request.theme}` : '',
    request.audience ? `Audience: ${request.audience}` : '',
    request.mood ? `Mood: ${request.mood}` : '',
    request.keywords?.length ? `Required keywords where relevant: ${request.keywords.join(', ')}` : '',
    request.creative_direction?.trim() ? `Creative direction: ${request.creative_direction.trim()}` : '',
  ].filter(Boolean).join('\n')

  return `Generate exactly ${assignments.length} distinct episode ideas, one for each RESERVED ASSIGNMENT below.
The assignments were selected by Story Studio's coverage planner. They are binding.
Each assignment carries its own Formula role and guidance. Apply only the contract printed beneath that assignment.

RESERVED ASSIGNMENTS:
${assignmentBlock}

TITLE RULES:
${titleRules(format)}
${template}

EXAMPLE BAR:
${examples(format) || '- Use the Series Formula faithfully.'}

${refinements ? `USER REFINEMENTS:\n${refinements}\n` : ''}
${options.standards ? `OPTIONAL PROJECT INSTRUCTIONS — never override the Series Formula:\n${truncateChars(options.standards, 1800)}\n` : ''}
${avoidBlock ? `ALREADY USED — do not repeat, rephrase, sequel, or lightly remix:\n${avoidBlock}\n` : ''}

OUTPUT CONTRACT:
- Return one object per reserved assignment, in the same order.
- Copy idea_key exactly. Never invent, omit, or change a key.
- The title and logline must explicitly reflect the assignment's subject and distinguishing dimensions.
- Ideas must be meaningfully different in subject and payoff, not merely differently worded.
- suggested_chapters must be an integer within ${format.script.chapterCountRange[0]}-${format.script.chapterCountRange[1]}.
- suggested_length must be a minutes string within ${format.script.lengthMinutesRange[0]}-${format.script.lengthMinutesRange[1]} minutes.
- themes must contain 2-4 concrete keywords.

- ${NO_EMOJI_DIRECTIVE}

Return ONLY a JSON object of the form {"ideas": [ ... ]}, where every array item has these exact keys:
idea_key, title, logline, themes, suggested_chapters, suggested_length, mood`
}

async function collectFormulaHistory(
  currentSlug: string,
  formulaId: string,
): Promise<im.StoredIdea[]> {
  const found: im.StoredIdea[] = []
  const projects = await pm.listProjects()
  for (const summary of projects) {
    const project = await pm.getProject(summary.slug).catch(() => null)
    if (!project) continue
    if (summary.slug !== currentSlug && project.niche_id !== formulaId) continue
    const ideas = await im.getIdeas(summary.slug).catch(() => [])
    for (const idea of ideas) {
      if (summary.slug === currentSlug
        || idea.series_formula_id === formulaId
        || (!idea.series_formula_id && project.niche_id === formulaId)) {
        found.push(idea)
      }
    }
  }
  return found.sort((a, b) => (b.generated_at || '').localeCompare(a.generated_at || ''))
}

function fallbackNiche(format: Format, request: IdeaCampaignParams): Niche {
  const seed = request.theme || request.genre || request.creative_direction || 'Fresh channel idea'
  return {
    id: request.series_formula_id || 'generic-series-formula',
    name: 'Generic Series Formula',
    description: format.idea.guidanceText || format.idea.systemPromptRole,
    builtin: true,
    schemaVersion: 1,
    kind: 'series-formula',
    exampleTopics: [seed],
  }
}

/**
 * Did this idea answer the assignment it was given, or wander off?
 *
 * IT USED TO ASK ONLY WHETHER THE SUBJECT'S OWN WORDS APPEARED, and that is
 * wrong whenever a subject is a CATEGORY rather than a thing. A Topic Pack's
 * subject is "mammals" or "big cats"; a good episode title is "Why the Naked
 * Mole-Rat Never Gets Cancer" or "The Leopard That Drags Dinner Up a Tree".
 * Neither contains a token of its subject, so both were thrown away as drift
 * and their slots refilled — until the campaign ran out of slots and failed.
 *
 * MEASURED on the owner's own run, 2026-08-24: a thirteen-idea campaign on the
 * Animals pack lost six of its first ten to "drifted from assigned subject",
 * kept refilling, and ended `12/13 required item(s) verified`. Nothing was
 * wrong with the ideas.
 *
 * The assignment also names an EPISODE OBJECT -- the concrete thing the idea
 * was told to be about, like "a leopard hauling a kill up a tree". An output
 * that mentions the leopard has done exactly what was asked, so matching the
 * object is a truer test of obedience than matching a category noun. Either
 * match counts; a model that mentions neither has genuinely gone elsewhere.
 */
function mentionsSubject(item: any, assignment: IdeaAssignment): boolean {
  const anchors = [assignment.dimensions.subject, assignment.dimensions['episode-object']]
  const anchorTokens = new Set(anchors.flatMap(value => tokenize(value || '')))
  // No anchor to check against is not evidence of drift.
  if (!anchorTokens.size) return true
  const outputTokens = new Set(tokenize(`${item?.title || ''} ${item?.logline || ''}`))
  return [...anchorTokens].some(token => outputTokens.has(token))
}

function normalizeIdea(
  item: any,
  assignment: IdeaAssignment,
  request: IdeaCampaignParams,
  niche: Niche,
  formulaId: string,
  activePackIds: string[],
): StoryIdea & { campaign_id: string } {
  const rawTitle = applyFormulaEpisodeProfileTitle(
    String(item?.title || ''),
    niche,
    assignment.dimensions,
  )
  const title = `${request.title_prefix || ''}${rawTitle}${request.title_suffix || ''}`.trim()
  const chapters = request.items_per_listicle && request.items_per_listicle > 0
    ? Math.round(request.items_per_listicle)
    : Math.max(1, Math.round(Number(item?.suggested_chapters) || 10))
  return {
    title,
    logline: String(item?.logline || '').trim(),
    themes: Array.isArray(item?.themes)
      ? item.themes.map((value: unknown) => String(value).trim()).filter(Boolean).slice(0, 4)
      : [],
    suggested_chapters: chapters,
    suggested_length: String(item?.suggested_length || '30 min'),
    mood: String(item?.mood || '').trim(),
    idea_fingerprint: assignment.fingerprint,
    series_formula_id: formulaId,
    topic_pack_ids: activePackIds,
    idea_dimensions: assignment.dimensions,
    campaign_id: request.campaign_id,
  }
}

function normalizeFreeformIdea(
  item: any,
  request: IdeaCampaignParams,
  formulaId: string,
): StoryIdea & { campaign_id: string } {
  const rawTitle = String(item?.title || '').trim()
  const pinnedChapters = request.items_per_listicle && request.items_per_listicle > 0
    ? Math.round(request.items_per_listicle)
    : null
  const chapters = pinnedChapters ?? Math.max(1, Math.round(Number(item?.suggested_chapters) || 10))
  const countAdjustedTitle = pinnedChapters === null
    ? rawTitle
    : rewriteLeadingCount(rawTitle, pinnedChapters)
  const title = (request.title_prefix || '') + countAdjustedTitle + (request.title_suffix || '')
  return {
    title: title.trim(),
    logline: String(item?.logline || '').trim(),
    themes: Array.isArray(item?.themes)
      ? item.themes.map((value: unknown) => String(value).trim()).filter(Boolean).slice(0, 4)
      : [],
    suggested_chapters: chapters,
    suggested_length: String(item?.suggested_length || '30 min'),
    mood: String(item?.mood || '').trim(),
    series_formula_id: formulaId,
    topic_pack_ids: [],
    campaign_id: request.campaign_id,
  }
}

export async function generateIdeaCampaign(job: Job): Promise<void> {
  const request = job.params as IdeaCampaignParams
  const wanted = Math.max(1, Math.min(100, Math.round(Number(request.count) || 0)))
  if (!request.campaign_id) throw new Error('Idea Campaign is missing its durable campaign_id')
  if (!request.model?.trim()) throw new Error('Idea Campaign requires a text model')

  const project = await pm.getProject(job.project_slug)
  if (!project) throw new Error(`Project '${job.project_slug}' not found`)
  const formulaId = request.series_formula_id || project.niche_id || ''
  const rawNiche = formulaId ? await loadNiche(formulaId) : null
  const topicPackIds = Array.isArray(request.topic_pack_ids)
    ? request.topic_pack_ids
    : project.topic_pack_ids
  const niche = rawNiche
    ? await composeNicheWithTopicPacks(rawNiche, topicPackIds)
    : null
  const format = await getEffectiveFormat(job.project_slug, {
    nicheIdOverride: formulaId || null,
    topicPackIdsOverride: topicPackIds,
  })
  const plannerNiche = niche || fallbackNiche(format, request)
  const activePackIds = (plannerNiche.activeTopicPacks || []).map(pack => pack.id)

  const projectIdeas = await im.getIdeas(job.project_slug)
  const alreadyCompleted = projectIdeas.filter(idea => idea.campaign_id === request.campaign_id)
  if (alreadyCompleted.length >= wanted) {
    job.progress = 100
    job.output_lines.push(`Campaign already complete — ${alreadyCompleted.length}/${wanted} verified ideas.`)
    requireJobCompletion(job, {
      label: 'Idea Campaign',
      expected: wanted,
      completed: wanted,
    })
    return
  }

  const history = await collectFormulaHistory(job.project_slug, formulaId || plannerNiche.id)
  const remaining = wanted - alreadyCompleted.length

  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error(`Project '${job.project_slug}' config not found`)
  const standards = await pm.getStandards(job.project_slug)
  const apiKeys = {
    anthropic_api_key: config.anthropic_api_key,
    openai_api_key: config.openai_api_key,
    kie_api_key: config.kie_api_key,
  }

  const similarityPool: SimilarityCandidate[] = history.map(idea => ({
    title: idea.title,
    logline: idea.logline,
    themes: idea.themes,
    mood: idea.mood,
  }))
  // An explicit pack selection keeps the established structural path even if a
  // legacy job can no longer resolve its pack. Only an actually pack-free
  // formula changes the provider/prompt branch below.
  const isFormulaFreeform = !activePackIds.length && !(topicPackIds?.length)
  let assignmentPool: IdeaAssignment[] = []
  if (!isFormulaFreeform) {
    const usedFingerprints = history
      .map(idea => idea.idea_fingerprint)
      .filter((value): value is string => !!value)
    assignmentPool = planIdeaAssignments({
      niche: plannerNiche, count: remaining, usedFingerprints, seed: request.campaign_id,
    })
    if (assignmentPool.length < remaining) {
      requireJobCompletion(job, {
        label: 'Idea Campaign coverage plan', expected: wanted, completed: alreadyCompleted.length,
        missing: Array.from({ length: remaining }, (_, index) => 'coverage-slot-' + (index + 1)),
        retry_hint: 'Add another compatible Topic Pack or more subjects/axis values, then Retry.',
      })
      return
    }
  }

  const created: im.StoredIdea[] = []
  const batchSize = 10
  const maxCalls = Math.max(4, Math.ceil(remaining / batchSize) * 4)
  let calls = 0
  job.progress = Math.round((alreadyCompleted.length / wanted) * 100)
  job.output_lines.push(isFormulaFreeform
    ? 'Idea Campaign ' + request.campaign_id + ': Formula-only freeform generation; ' + wanted + ' required, ' + alreadyCompleted.length + ' already complete.'
    : 'Idea Campaign ' + request.campaign_id + ': ' + wanted + ' required, ' + alreadyCompleted.length + ' already complete, ' + assignmentPool.length + ' unused coverage assignments available.')

  while (alreadyCompleted.length + created.length < wanted && (isFormulaFreeform || assignmentPool.length) && calls < maxCalls) {
    if (jq.isCancelled(job.job_id)) throw new Error('Idea Campaign cancelled')
    const needed = wanted - alreadyCompleted.length - created.length
    const count = Math.min(batchSize, needed)
    calls++
    const controller = new AbortController()
    const watcher = setInterval(() => {
      if (jq.isCancelled(job.job_id)) controller.abort()
    }, 500)
    let candidates: Array<StoryIdea & { campaign_id: string }>
    try {
      if (isFormulaFreeform) {
        job.output_lines.push('Generating freeform batch ' + calls + ': ' + count + ' idea(s)…')
        let prompt = ''
        const avoid: AvoidItem[] = similarityPool.map(item => ({
          title: item.title, mood: item.mood, themes: item.themes,
        }))
        const responseItems = await generateFreeformIdeaBatch({
          request: { ...request, count }, format, standards, avoid, apiKeys,
          slug: job.project_slug, jobId: job.job_id, signal: controller.signal,
          titleTemplate: request.title_template,
          onPrompt: value => { prompt = value },
        })
        candidates = await Promise.all(responseItems
          .filter(item => String(item?.title || '').trim() && String(item?.logline || '').trim())
          .map(async item => normalizeFreeformIdea({
            ...item,
            title: await applyEmojiPolicy(String(item.title || ''), [prompt]),
            logline: await applyEmojiPolicy(String(item.logline || ''), [prompt]),
          }, request, formulaId || plannerNiche.id)))
      } else {
        const assignments = assignmentPool.splice(0, count)
        job.output_lines.push('Generating coverage batch ' + calls + ': ' + assignments.length + ' reserved idea(s)…')
        const prompt = campaignPrompt({
          request, format, niche: plannerNiche, assignments, avoid: similarityPool, standards,
        })
        const raw = await callAiWithRetry(request.model, '', prompt, apiKeys, false, {
          slug: job.project_slug,
          jobId: job.job_id,
          signal: controller.signal,
          outputBudget: { tier: 'long', minimumTokens: ideaOutputTokenBudget(assignments.length) },
          outputContract: ideaCampaignOutputContract(assignments.map(item => item.idea_key)),
        })
        const responseItems = parseArray(raw)
        const byKey = new Map(
          responseItems
            .filter(item => typeof item?.idea_key === 'string')
            .map(item => [item.idea_key, item]),
        )
        candidates = []
        for (let index = 0; index < assignments.length; index++) {
          const assignment = assignments[index]!
          const item = byKey.get(assignment.idea_key) || responseItems[index]
          if (!item || !String(item.title || '').trim() || !String(item.logline || '').trim()) {
            job.output_lines.push('  ↻ ' + assignment.idea_key + ': provider omitted usable title/logline; replacing slot.')
            continue
          }
          if (!mentionsSubject(item, assignment)) {
            job.output_lines.push('  ↻ ' + assignment.idea_key + ': output drifted from assigned subject; replacing slot.')
            continue
          }
          candidates.push(normalizeIdea(
            {
              ...item,
              title: await applyEmojiPolicy(String(item.title || ''), [prompt]),
              logline: await applyEmojiPolicy(String(item.logline || ''), [prompt]),
            },
            assignment, request, plannerNiche, formulaId || plannerNiche.id, activePackIds,
          ))
        }
      }
    } finally {
      clearInterval(watcher)
    }

    const filtered = request.avoid_repeated_ideas === false
      ? { kept: candidates, rejected: [] }
      : filterGenerated(candidates, similarityPool)
    for (const rejection of filtered.rejected) {
      job.output_lines.push(`  ↻ Rejected near-duplicate: "${rejection.candidate.title}"`)
    }
    const kept = isFormulaFreeform ? filtered.kept.slice(0, needed) : filtered.kept
    if (kept.length) {
      const stored = await im.addIdeas(
        job.project_slug,
        kept,
        request.model,
        request.campaign_id,
      )
      created.push(...stored)
      const savedCandidates = stored.map(idea => ({
        title: idea.title,
        logline: idea.logline,
        themes: idea.themes,
        mood: idea.mood,
      }))
      if (isFormulaFreeform) similarityPool.unshift(...savedCandidates)
      else similarityPool.push(...savedCandidates)
      job.output_lines.push(`  ✓ Saved ${stored.length}; campaign now ${alreadyCompleted.length + created.length}/${wanted}.`)
    }
    job.progress = Math.min(99, Math.round(((alreadyCompleted.length + created.length) / wanted) * 100))
  }

  const completed = alreadyCompleted.length + created.length
  job.result = {
    campaign_id: request.campaign_id,
    created_idea_ids: created.map(idea => idea.id),
    completed,
    expected: wanted,
    series_formula_id: formulaId || plannerNiche.id,
    topic_pack_ids: activePackIds,
  }
  requireJobCompletion(job, {
    label: 'Idea Campaign',
    expected: wanted,
    completed,
    missing: completed < wanted
      ? Array.from({ length: wanted - completed }, (_, index) => `idea-slot-${completed + index + 1}`)
      : [],
    retry_hint: isFormulaFreeform
      ? 'Completed ideas were saved. Retry this job to fill only the missing ideas.'
      : 'Completed ideas were saved. Retry this job to fill only the missing slots with unused fingerprints.',
  })
  job.progress = 100
  job.output_lines.push(isFormulaFreeform
    ? '✓ Idea Campaign complete — ' + completed + '/' + wanted + ' ideas saved; ' + (request.avoid_repeated_ideas === false ? 'duplicate checks disabled by request.' : 'duplicate checks passed.')
    : `✓ Idea Campaign complete — ${completed}/${wanted} unique ideas verified.`)
}

/**
 * Exposed so the drift rule can be tested against the real function rather
 * than a copy of it in a test file, which is how a rule and its test quietly
 * stop agreeing.
 */
export const __ideaCampaignInternals = { campaignPrompt, mentionsSubject }
