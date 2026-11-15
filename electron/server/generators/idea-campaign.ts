import type { Format, GenerateIdeasRequest, Job, Niche, StoryIdea } from '../models/types.js'
import { safetyGate, safetyMode } from '../services/safety-checks.js'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import { callAiWithRetry, resolveLivePipelineModel, type CallAiContext } from '../lib/ai-client.js'
import { isProvenChatFailure, isProvenUncreatedChatRequest, isProvenUnusableChatAnswer, listChatModels } from '../lib/genstudio-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { composeNicheWithTopicPacksDetailed, loadNiche, TOPIC_PACK_DROP_REASONS, type DroppedTopicPack } from '../services/niche-loader.js'
import {
  assignmentSummary,
  planIdeaAssignments,
  subjectUseByPack,
  type IdeaAssignment,
} from '../services/idea-campaign-planner.js'
import {
  filterGenerated,
  tokenize,
  watchDuplicates,
  type SimilarityCandidate,
} from '../services/idea-similarity.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { composeChannelTitle } from '../lib/title-wrapping.js'
import { ideaBatchForPublishedCeiling, ideaOutputTokenBudget, storedExpectedOutputTokens } from '../services/idea-output-budget.js'
import { ideaBatchOutputContract, ideaCampaignOutputContract } from '../lib/story-output-contracts.js'
import {
  applyFormulaEpisodeProfile,
  applyFormulaEpisodeProfileTitle,
  resolveFormulaEpisodeProfile,
} from '../services/formula-production-kit.js'
import { truncateChars } from '../lib/well-formed-text.js'
import { formulaLengthPrompt } from '../lib/episode-length.js'
import { normalizeContentLanguage, projectContentLanguageDirective } from '../lib/content-language.js'
import { applyEmojiPolicy, NO_EMOJI_DIRECTIVE } from '../lib/emoji-policy.js'
import { recentCharacterNamesAvoidance } from '../services/recent-character-names.js'
import { buildFreeformIdeaPrompt, generateFreeformIdeaBatch, renderRealSubjectsBlock, renderVarietyBlock, rewriteLeadingCount, varietySeedLabel, varietySlots, type AvoidItem, type VarietySlot } from '../services/freeform-idea-generation.js'
import { readIdeaUpgrades } from '../services/idea-upgrades.js'
import { renderCoveredBlock, updateCoveredMap } from '../services/covered-topics.js'
import {
  ideaBatchAppendKey,
  ideaBatchRecordState,
  nextIdeaBatchOrdinal,
  releaseDeadIdeaBatch,
  writeIdeaBatch,
  type IdeaBatchRecord,
} from '../services/idea-campaign-recovery.js'
import { withGrownPack } from '../services/grown-pack.js'
import { getReferencePool, sample, unusedReferenceItems, type ReferencePool } from '../services/reference-pool.js'
import { embedTexts } from '../lib/embeddings-client.js'
import { appendFile } from 'fs/promises'
import path from 'path'

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

/** Ideas should not star the same main character as recent episodes. */
function withNamesAvoidance(prompt: string, line: string): string {
  return line ? `${prompt}\n\n${line}` : prompt
}

/** 1.4.285+ idea-upgrade blocks (covered map, idea slots, real subjects); '' (switch off) leaves the prompt byte-identical. */
function withBlock(prompt: string, block: string): string {
  return block ? `${prompt}\n\n${block}` : prompt
}

function campaignPrompt(options: {
  request: IdeaCampaignParams
  format: Format
  niche: Niche
  assignments: IdeaAssignment[]
  avoid: SimilarityCandidate[]
  standards?: string | null
  /**
   * The audience-language directive for this campaign, from the channel's live
   * `content_language`. '' (the default) adds nothing, so an unset language
   * leaves this prompt byte-identical.
   */
  languageDirectiveText?: string
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
  // `avoid` is newest-first (formula history is sorted that way and each saved
  // batch is unshifted), so the first 200 are the most recent — the ones a
  // model is likeliest to echo. slice(-200) used to send the OLDEST 200.
  const avoidBlock = options.avoid
    .slice(0, 200)
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

  // The directive sits with the binding contract, before the reserved assignments the model must
  // satisfy: the language is read as part of the job, not after the subjects are chosen. '' adds
  // nothing, so the prompt for a channel with no language is byte-identical.
  const languageBlock = options.languageDirectiveText
    ? `\n${options.languageDirectiveText}\nApply this to every returned text value, including title, logline, each theme, mood and suggested_length. Keep JSON keys and idea_key unchanged.`
    : ''

  // 1.4.369 — a short-form Formula publishes seconds (Quote Shorts: 10–60 s).
  // The contract says seconds then, instead of a whole-minute range the model
  // would round into a length the Formula itself contradicts.
  const lengthPrompt = formulaLengthPrompt(format.script)
  const lengthRule = format.script.lengthSecondsRange || typeof format.script.defaultLengthSeconds === 'number'
    ? `${lengthPrompt.oneOf}`
    : `a minutes string within ${format.script.lengthMinutesRange[0]}-${format.script.lengthMinutesRange[1]} minutes`

  return `Generate exactly ${assignments.length} distinct episode ideas, one for each RESERVED ASSIGNMENT below.
The assignments were selected by Story Studio's coverage planner. They are binding.
Each assignment carries its own Formula role and guidance. Apply only the contract printed beneath that assignment.${languageBlock}

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
- suggested_length must be ${lengthRule}.
- themes must contain 2-4 concrete keywords.

- ${NO_EMOJI_DIRECTIVE}

Return ONLY a JSON object of the form {"ideas": [ ... ]}, where every array item has these exact keys:
idea_key, title, logline, themes, suggested_chapters, suggested_length, mood`
}

export async function collectFormulaHistory(
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

/**
 * The Formula and composed Topic Packs a campaign uses. Shared with the supply counter
 * (services/idea-supply.ts) so the counter can never disagree with the generator.
 */
export async function resolveCampaignNiche(
  project: { niche_id?: string; topic_pack_ids?: string[] },
  request: { series_formula_id?: string; topic_pack_ids?: string[] } = {},
): Promise<{ formulaId: string; rawNiche: Niche | null; topicPackIds: string[] | undefined; niche: Niche | null; droppedTopicPacks: DroppedTopicPack[] }> {
  const formulaId = request.series_formula_id || project.niche_id || ''
  const rawNiche = formulaId ? await loadNiche(formulaId) : null
  const topicPackIds = Array.isArray(request.topic_pack_ids)
    ? request.topic_pack_ids
    : project.topic_pack_ids
  if (!rawNiche) return { formulaId, rawNiche, topicPackIds, niche: null, droppedTopicPacks: [] }
  const composed = await composeNicheWithTopicPacksDetailed(rawNiche, topicPackIds)
  return { formulaId, rawNiche, topicPackIds, niche: composed.niche, droppedTopicPacks: composed.droppedTopicPacks }
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
type SubjectCheck = 'match' | 'drift' | 'unmeasurable'

/**
 * The overlap test reads English tokens, so for a channel writing in another language it can
 * only say "I cannot tell" (AGENTS.md §6), never "drifted": a Khmer idea shares no token with
 * an English anchor however faithful it is.
 */
function checkSubject(item: any, assignment: IdeaAssignment, contentLanguage: unknown): SubjectCheck {
  const anchors = [assignment.dimensions.subject, assignment.dimensions['episode-object']]
  const anchorTokens = new Set(anchors.flatMap(value => tokenize(value || '')))
  // No anchor to check against is not evidence of drift.
  if (!anchorTokens.size) return 'match'
  const language = normalizeContentLanguage(contentLanguage)
  if (language && language !== 'en') return 'unmeasurable'
  const outputTokens = new Set(tokenize(`${item?.title || ''} ${item?.logline || ''}`))
  if (!outputTokens.size) return 'unmeasurable'
  return [...anchorTokens].some(token => outputTokens.has(token)) ? 'match' : 'drift'
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
  const title = composeChannelTitle(rawTitle, request.title_prefix || '', request.title_suffix || '')
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
  const title = composeChannelTitle(countAdjustedTitle, request.title_prefix || '', request.title_suffix || '')
  return {
    title,
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

/**
 * Why a COLLECTED batch's key can never produce a usable answer, or null when that is not proven.
 *
 * Three shapes qualify, and each is proof the key is spent: the Gateway settled the job `failed`
 * with no hold left; it settled it `succeeded` and Story refused the answer; or it proved it never
 * saw the key at all. Collecting any of them again answers the same way for as long as that job
 * exists, so the batch is released and asked once more under a new identity.
 *
 * Everything else keeps its key. A hold or an uncertain submission may still yield an answer, a
 * cancellation is the user's own last word, an unreachable Gateway proves nothing, and a truncated
 * answer is reproduced by the same request — a second request would be paid for and fail the same
 * way.
 */
function deadBatchEvidence(
  error: unknown,
  record: IdeaBatchRecord,
): NonNullable<IdeaBatchRecord['settled_dead']> | null {
  const base = {
    idempotency_key: record.idempotency_key!,
    ...(record.provider_job_id ? { provider_job_id: record.provider_job_id } : {}),
  }
  if (isProvenChatFailure(error)) {
    return { ...base, kind: 'failed', failure_code: error.failureCode, reason: error.failureReason }
  }
  if (isProvenUnusableChatAnswer(error)) {
    // The retained job is the authority on which request the refused answer belongs to.
    return { ...base, provider_job_id: error.jobId, kind: 'unusable', reason: error.message }
  }
  if (isProvenUncreatedChatRequest(error)) {
    return { ...base, kind: 'uncreated', reason: 'The Gateway has no record of this request key.' }
  }
  return null
}

/** What the owner is told when a saved batch is released, in the words of the kind of death. */
const DEAD_BATCH_REASON: Record<NonNullable<IdeaBatchRecord['settled_dead']>['kind'], string> = {
  failed: 'the Gateway settled it as a failure that cannot change',
  unusable: 'the Gateway\'s answer could not be read',
  uncreated: 'the Gateway never received it',
}

export async function generateIdeaCampaign(job: Job): Promise<void> {
  const request = job.params as IdeaCampaignParams
  const wanted = Math.max(1, Math.min(100, Math.round(Number(request.count) || 0)))
  if (!request.campaign_id) throw new Error('Idea Campaign is missing its durable campaign_id')
  if (!request.model?.trim()) throw new Error('Idea Campaign requires a text model')

  const project = await pm.getProject(job.project_slug)
  if (!project) throw new Error(`Project '${job.project_slug}' not found`)
  const { formulaId, topicPackIds, niche, droppedTopicPacks } = await resolveCampaignNiche(project, request)
  // A selected Topic Pack that could not be used is never silent: the job says
  // which one and why, before any paid call.
  for (const dropped of droppedTopicPacks) {
    job.output_lines.push(`Topic Pack "${dropped.name || dropped.id}" was not used: ${TOPIC_PACK_DROP_REASONS[dropped.reason]}.`)
  }
  const format = await getEffectiveFormat(job.project_slug, {
    nicheIdOverride: formulaId || null,
    topicPackIdsOverride: topicPackIds,
  })
  let plannerNiche = niche || fallbackNiche(format, request)
  let activePackIds = (plannerNiche.activeTopicPacks || []).map(pack => pack.id)

  // The durable batch record is read BEFORE anything paid or live — before the helper model, the
  // catalogue, Wikipedia, the planner and the names lookup. A captured-but-unresolved batch is
  // COLLECTED from that record; nothing it already paid for is run again.
  const batchState = ideaBatchRecordState(job.params)
  if (batchState.state === 'malformed') {
    throw new Error(
      'This campaign has a saved batch record that cannot be read, so nothing was sent. '
      + 'Clear the "idea_batch" entry in this job\'s params and start a new campaign.',
    )
  }
  let replayBatch = batchState.state === 'pending' ? batchState.record : null

  const projectIdeas = await im.getIdeas(job.project_slug)
  const alreadyCompleted = projectIdeas.filter(idea => idea.campaign_id === request.campaign_id)
  // A keyless capture never reached the provider, so a complete campaign may simply resolve it. A
  // KEYED capture is a paid request the provider accepted and never delivered — it must be collected
  // (below), never silently resolved into unrecoverability.
  if (alreadyCompleted.length >= wanted && !replayBatch?.idempotency_key) {
    job.progress = 100
    job.output_lines.push(`Campaign already complete — ${alreadyCompleted.length}/${wanted} verified ideas.`)
    if (replayBatch) {
      // The campaign is complete, so a captured batch is not collected — that would exceed what was
      // asked for. It is marked resolved so it cannot linger or be replayed forever.
      replayBatch.resolved = true
      writeIdeaBatch(job, replayBatch)
      await jq.checkpointJobState(job)
      job.output_lines.push(`A batch prepared earlier (ordinal ${replayBatch.ordinal}) was left uncollected because the campaign is already complete.`)
      replayBatch = null
    }
    requireJobCompletion(job, {
      label: 'Idea Campaign',
      expected: wanted,
      completed: wanted,
    })
    return
  }
  if (alreadyCompleted.length >= wanted && replayBatch) {
    // Complete, but the batch carries a key the provider accepted. Collect it and drop the excess:
    // nothing is appended beyond what was asked for, and the paid request is not lost.
    job.output_lines.push(`Campaign already complete, but a batch prepared earlier (ordinal ${replayBatch.ordinal}) was already accepted by the provider; collecting it and discarding the excess.`)
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

  // 1.4.285 idea upgrades: read once at job start; a running job never changes behaviour mid-run.
  // All off (the default) leaves every prompt and every saved idea exactly as before.
  const upgrades = readIdeaUpgrades(config)
  // The channel's audience language, read once at job start beside the upgrades for the same
  // reason: every batch in this campaign carries one instruction, and a language the owner changes
  // mid-run is picked up by the NEXT campaign rather than applied half-way through this one. Unset
  // (the default) is '' and leaves both prompts byte-identical.
  const languageDirectiveText = projectContentLanguageDirective(project)
  let subjectCheckSkipNoted = false
  // `on` also rejects by meaning; both modes log every candidate's nearest score.
  const watching = upgrades.semantic_dedupe !== 'off'
  const enforcing = upgrades.semantic_dedupe === 'on' && request.avoid_repeated_ideas !== false
  const upgradesOn = upgrades.covered_map || watching || upgrades.variety_seeds || upgrades.grow_packs || upgrades.real_sources
  if (upgrades.grow_packs) {
    // #3: the channel's own grown pack joins the composed packs (Topic Pack channels only).
    const grown = await withGrownPack(plannerNiche, job.project_slug)
    if (grown !== plannerNiche) {
      plannerNiche = grown
      activePackIds = (plannerNiche.activeTopicPacks || []).map(pack => pack.id)
      const added = plannerNiche.activeTopicPacks!.at(-1)!
      job.output_lines.push(`Grown subjects: ${added.subjects.length} from "${added.name}" are in the plan.`)
    }
  }
  let coveredBlock = ''
  let coveredSubjects: string[] = []
  // A replay never runs the helper model: it already paid for this batch's map delta.
  if (upgrades.covered_map && !replayBatch) {
    const covered = await updateCoveredMap({
      slug: job.project_slug,
      helperModel: upgrades.helper_model,
      formulaId: formulaId || plannerNiche.id,
      channelName: project.name || job.project_slug,
      description: plannerNiche.description,
      history,
    })
    if (covered.note) job.output_lines.push(`Covered-topics map: ${covered.note}.`)
    else if (covered.added) job.output_lines.push(`Covered-topics map: folded in ${covered.added} more idea(s).`)
    coveredBlock = renderCoveredBlock(covered.map, isFormulaFreeformFor(activePackIds, topicPackIds) ? 'freeform' : 'pack')
    coveredSubjects = covered.map?.entries.subjects.map(entry => entry.name) || []
    if (coveredBlock && covered.map) job.output_lines.push(`Covered-topics map: ${covered.map.entries.subjects.length} covered subjects shown to the idea model.`)
  }
  const watchStats = { generated: 0, rejected_words: 0, rejected_meaning: 0, would_reject: 0, method: '' as '' | 'meaning' | 'words', fallback_reason: '', nearest: [] as Array<{ title: string; matched: string | null; score: number }> }
  const vectorCache = new Map<string, number[]>()

  const similarityPool: SimilarityCandidate[] = history.map(idea => ({
    title: idea.title,
    logline: idea.logline,
    themes: idea.themes,
    mood: idea.mood,
  }))
  // An explicit pack selection keeps the established structural path even if a
  // legacy job can no longer resolve its pack. Only an actually pack-free
  // formula changes the provider/prompt branch below.
  const isFormulaFreeform = isFormulaFreeformFor(activePackIds, topicPackIds)
  // A channel that chose Topic Packs and ends up with none is not "freeform" —
  // it has nothing to write from. Say so once, loudly, and keep the job's own
  // message honest below.
  const noUsableTopicPacks = !!topicPackIds?.length && !activePackIds.length
  if (noUsableTopicPacks) {
    job.output_lines.push(
      `None of the ${topicPackIds!.length} selected Topic Pack${topicPackIds!.length === 1 ? '' : 's'} could be used with this Series Formula, so this campaign has no Topic Pack subjects. `
      + 'It will write from the Formula\'s own example topics instead; choose different Topic Packs with "Choose Formula & Topics" to use their subjects.',
    )
  }
  // #5: real Wikipedia subjects for formula-only channels (pack channels get them through #3's grow).
  let referencePool: ReferencePool | null = null
  if (upgrades.real_sources && isFormulaFreeform && !replayBatch) {
    const reference = await getReferencePool(job.project_slug, upgrades.reference_categories)
    referencePool = reference.pool
    job.output_lines.push(`Real subjects: ${reference.note}.`)
  }
  let assignmentPool: IdeaAssignment[] = []
  // Assignments this campaign asked for and had rejected on CONTENT (drift, no title or logline, a
  // duplicate). Kept in the job's params, which Retry copies forward, so a later attempt does not
  // reserve them again: rejected ideas are never saved, so the seeded plan would otherwise repeat.
  // A provider or parse failure throws before this is touched and records nothing. Freeform ideas
  // carry no fingerprint and so record nothing either.
  const rejectedAssignments = new Set<string>(
    Array.isArray(job.params.rejected_assignments) ? job.params.rejected_assignments.filter((value: unknown) => typeof value === 'string') : [],
  )
  const reject = (fingerprint: string | undefined) => { if (fingerprint) rejectedAssignments.add(fingerprint) }
  // How many requested ideas the Topic Packs cannot cover at all. Those that
  // fit are still made and saved; the job then fails loudly naming the rest,
  // instead of refusing the whole batch up front.
  let coverageShortfall = 0
  // Every Topic Pack subject already has an idea. The planner still reserves new structural tuples of
  // those subjects, so the pool can look large while every idea collapses onto a used subject.
  let subjectsUsedUp = false
  // A replay keeps the assignments it reserved; re-planning would change the batch.
  if (!isFormulaFreeform && !replayBatch) {
    const usedFingerprints = history
      .map(idea => idea.idea_fingerprint)
      .filter((value): value is string => !!value)
    assignmentPool = planIdeaAssignments({
      niche: plannerNiche, count: remaining, usedFingerprints, seed: request.campaign_id,
      excludeFingerprints: rejectedAssignments,
      ...(upgrades.variety_seeds ? { spreadPacks: true } : {}),
    })
    coverageShortfall = Math.max(0, remaining - assignmentPool.length)
    const subjectUse = subjectUseByPack(plannerNiche, usedFingerprints)
    subjectsUsedUp = subjectUse.some(pack => pack.total) && subjectUse.every(pack => !pack.unused)
    if (coverageShortfall) {
      job.output_lines.push(`Your Topic Packs have unused subjects for only ${assignmentPool.length} of the ${remaining} ideas still needed; making those now.`)
    }
  }

  const namesAvoidance = replayBatch ? '' : await recentCharacterNamesAvoidance(job.project_slug)
  const created: im.StoredIdea[] = []
  // Ideas the meaning check rejected as repeats (1.4.300 "idea repeat" safety check, used below).
  const repeats: Array<StoryIdea & { campaign_id: string }> = []
  /**
   * How many ideas ONE request may ask for, from what the selected product publishes for output.
   *
   * The owner's rule (2026-10-18): a single request takes every remaining idea, up to the batch cap,
   * whenever the published ceiling permits; a smaller ceiling takes what it holds and the loop comes
   * back for the rest. The fixed ten-call sequence is gone.
   *
   * The catalogue is read live for each batch through the same APIs the covered-map helper uses, so
   * a published limit is never a stored number and never inferred. A product the catalogue cannot
   * resolve, or a figure it publishes malformed, fails HERE — loudly and before any request — rather
   * than being read as "no ceiling" and silently sized. Only a product that genuinely publishes no
   * ceiling attempts the whole remaining batch with the wire field omitted.
   */
  const ideaBatchForModel = async (needed: number): Promise<number> => {
    const apiKey = await getApiKey('genstudio')
    const published = resolveLivePipelineModel(request.model, apiKey ? await listChatModels(apiKey) : []).max_output_tokens
    const sizing = ideaBatchForPublishedCeiling(published, needed)
    if (sizing.batch !== null) return sizing.batch
    throw new Error(
      `The selected product publishes a ${sizing.ceiling}-token output ceiling, and one complete idea does not fit in the ${sizing.budget} tokens that ceiling leaves for the answer. Choose a product with a larger output limit in Settings, then press Retry.`,
    )
  }
  // Sized once for the loop guard: four times the batches this run would need if each came back
  // whole, and never fewer calls than the retired fixed ten-idea batch ever had. `10` below is only
  // that historical ALLOWANCE denominator, not a batch size — every batch is sized live above.
  //
  // A replay keeps today's catalogue out of its path: the captured batch already carries its own
  // count and body, so the guard is sized from that count rather than a live read — collecting a
  // request already paid for must not depend on what the catalogue publishes now. It also keeps the
  // divisor non-zero when `remaining` is 0 (a keyed capture collected for an already-complete
  // campaign), which a live `ideaBatchForModel(remaining)` would divide by.
  const firstBatch = replayBatch ? replayBatch.count : await ideaBatchForModel(remaining)
  const maxCalls = Math.max(4, Math.ceil(remaining / Math.min(firstBatch, 10)) * 4)
  let calls = 0
  // A batch captured but never resolved is REPLAYED from its own record rather than rebuilt. The
  // provider derives its idempotency key from the request body, so only the same body collects the
  // answer that was already accepted — a rebuilt body would carry a new key and buy a second job.
  if (replayBatch) {
    job.output_lines.push(`Collecting batch ${replayBatch.ordinal} prepared by an earlier run (${replayBatch.count} idea(s)); it is not sent again.`)
  }
  job.progress = Math.round((alreadyCompleted.length / wanted) * 100)
  // One released-and-resent batch per run at most, so a saved key the Gateway proves dead costs
  // exactly one fresh request and never a chain of them (the audio generator's
  // `askedAfreshForDeadResult`, same shape).
  let releasedSettledBatch = false
  job.output_lines.push(isFormulaFreeform
    ? 'Idea Campaign ' + request.campaign_id + ': Formula-only freeform generation; ' + wanted + ' required, ' + alreadyCompleted.length + ' already complete.'
    : 'Idea Campaign ' + request.campaign_id + ': ' + wanted + ' required, ' + alreadyCompleted.length + ' already complete, ' + assignmentPool.length + ' unused coverage assignments available.')

  // A captured batch is collected even when nothing new is needed or the pool is empty: the request
  // was already paid for, and collecting it must not depend on today's planning.
  while ((replayBatch || (alreadyCompleted.length + created.length < wanted && (isFormulaFreeform || assignmentPool.length))) && calls < maxCalls) {
    if (jq.isCancelled(job.job_id)) throw new Error('Idea Campaign cancelled')
    const needed = wanted - alreadyCompleted.length - created.length
    const count = replayBatch ? replayBatch.count : await ideaBatchForModel(needed)
    const ordinal = replayBatch?.ordinal ?? nextIdeaBatchOrdinal(job.params)
    calls++
    const controller = new AbortController()
    const watcher = setInterval(() => {
      if (jq.isCancelled(job.job_id)) controller.abort()
    }, 500)
    let candidates: Array<StoryIdea & { campaign_id: string }>
    let batchRecord: IdeaBatchRecord | null = null
    try {
      if (isFormulaFreeform) {
        job.output_lines.push((replayBatch ? 'Collecting freeform batch ' : 'Generating freeform batch ') + calls + ': ' + count + ' idea(s)…')
        // A replay dispatches the CAPTURED model as well as the captured text: the model is part of
        // the request body, and the provider derives its key from the body. A channel whose preset
        // model changed between runs must still send the body this batch was bound to.
        const requestForBatch = { ...request, count, ...(replayBatch ? { model: replayBatch.model } : {}) }
        const avoid: AvoidItem[] = similarityPool.map(item => ({
          title: item.title, mood: item.mood, themes: item.themes,
        }))
        // A replay uses the slots it captured: `varietySlots` draws from Math.random, so calling it
        // again would drift the seed labels away from the captured prompt.
        const slots = replayBatch
          ? ((replayBatch.slots as VarietySlot[] | undefined) ?? [])
          : (upgrades.variety_seeds ? varietySlots(count, plannerNiche.vocabulary?.theme) : [])
        const realSubjects = referencePool
          ? sample(unusedReferenceItems(referencePool, coveredSubjects, similarityPool.map(item => item.title)), count * 3)
          : []
        let prompt = replayBatch?.prompt ?? withBlock(withBlock(withBlock(withNamesAvoidance(buildFreeformIdeaPrompt(
          requestForBatch, format, standards, avoid, undefined,
          request.title_template, undefined, languageDirectiveText,
        ), namesAvoidance), coveredBlock), renderVarietyBlock(slots)), renderRealSubjectsBlock(realSubjects))
        batchRecord = replayBatch ?? {
          ordinal, count, model: request.model, prompt,
          request_identity: `${job.project_slug}:${request.campaign_id}:ideas:${ordinal}`,
          outputBudget: { tier: 'maximum' },
          expected_output_tokens: ideaOutputTokenBudget(count),
          outputContract: ideaBatchOutputContract(),
          slots, keys: slots.map(slot => varietySeedLabel(slot)),
        }
        // The caller's prompt is the one sent (`preparePrompt` wins inside the service), so it can be
        // persisted BEFORE the request: a restart replays this exact body instead of buying another.
        writeIdeaBatch(job, batchRecord)
        await jq.checkpointJobState(job)
        const responseItems = await generateFreeformIdeaBatch({
          request: requestForBatch, format, standards, avoid, apiKeys,
          slug: job.project_slug, jobId: job.job_id, signal: controller.signal,
          titleTemplate: request.title_template,
          onPrompt: value => { prompt = value; batchRecord!.prompt = value },
          requestIdentity: batchRecord.request_identity,
          preparePrompt: () => prompt,
          outputContract: batchRecord.outputContract,
          outputBudget: batchRecord.outputBudget,
          expectedOutputTokens: storedExpectedOutputTokens(batchRecord.expected_output_tokens),
          ...(batchRecord.idempotency_key ? { idempotencyKey: batchRecord.idempotency_key } : {}),
          onRequestPrepared: async key => { batchRecord!.idempotency_key = key; writeIdeaBatch(job, batchRecord!); await jq.checkpointJobState(job) },
          onJobAccepted: async providerJobId => { batchRecord!.provider_job_id = providerJobId; writeIdeaBatch(job, batchRecord!); await jq.checkpointJobState(job) },
          ...(replayBatch?.idempotency_key
            ? { recoverByIdempotencyKey: true, allowedRecoveryKeys: [replayBatch.idempotency_key] }
            : {}),
        })
        candidates = await Promise.all(responseItems
          .map((item, index) => ({ item, slot: slots[index] }))
          .filter(({ item }) => String(item?.title || '').trim() && String(item?.logline || '').trim())
          .map(async ({ item, slot }) => {
            const idea = normalizeFreeformIdea({
              ...item,
              title: await applyEmojiPolicy(String(item.title || ''), [prompt]),
              logline: await applyEmojiPolicy(String(item.logline || ''), [prompt]),
            }, request, formulaId || plannerNiche.id)
            // #4: the slot this idea was asked to start from, for measuring spread (new ideas only).
            return slot ? { ...idea, idea_dimensions: { variety_seed: varietySeedLabel(slot) } } : idea
          }))
      } else {
        // A replay uses the reserved assignments it captured — never today's planner, whose output
        // could differ and would change the body (and therefore the provider key).
        const assignments = replayBatch
          ? ((replayBatch.assignments as IdeaAssignment[] | undefined) ?? [])
          : assignmentPool.splice(0, count)
        if (replayBatch && assignments.length !== replayBatch.count) {
          throw new Error(`Batch ${ordinal} was captured without its reserved subjects, so it was not sent again. Start a new campaign.`)
        }
        job.output_lines.push((replayBatch ? 'Collecting coverage batch ' : 'Generating coverage batch ') + calls + ': ' + assignments.length + ' reserved idea(s)…')
        const prompt = replayBatch ? replayBatch.prompt : withBlock(withNamesAvoidance(campaignPrompt({
          request, format, niche: plannerNiche, assignments, avoid: similarityPool, standards,
          languageDirectiveText,
        }), namesAvoidance), coveredBlock)
        batchRecord = replayBatch ?? {
          ordinal, count: assignments.length, model: request.model, prompt,
          request_identity: `${job.project_slug}:${request.campaign_id}:ideas:${ordinal}`,
          outputBudget: { tier: 'maximum' },
          expected_output_tokens: ideaOutputTokenBudget(assignments.length),
          outputContract: ideaCampaignOutputContract(assignments.map(item => item.idea_key)),
          assignments, keys: assignments.map(item => item.idea_key),
        }
        // Persist the exact body BEFORE it can be charged, so a restart replays this request instead
        // of buying a second one under a freshly derived key.
        writeIdeaBatch(job, batchRecord)
        await jq.checkpointJobState(job)
        const context: CallAiContext = {
          slug: job.project_slug,
          jobId: job.job_id,
          signal: controller.signal,
          outputBudget: batchRecord.outputBudget,
          expectedOutputTokens: storedExpectedOutputTokens(batchRecord.expected_output_tokens),
          outputContract: batchRecord.outputContract,
          requestIdentity: batchRecord.request_identity,
          ...(batchRecord.idempotency_key ? { idempotencyKey: batchRecord.idempotency_key } : {}),
          // Record the key the provider generated, as it is prepared — no key format of ours.
          onRequestPrepared: async key => { batchRecord!.idempotency_key = key; writeIdeaBatch(job, batchRecord!); await jq.checkpointJobState(job) },
          onJobAccepted: async providerJobId => { batchRecord!.provider_job_id = providerJobId; writeIdeaBatch(job, batchRecord!); await jq.checkpointJobState(job) },
          ...(replayBatch?.idempotency_key
            ? { recoverByIdempotencyKey: true, allowedRecoveryKeys: [replayBatch.idempotency_key] }
            : {}),
        }
        const raw = await callAiWithRetry(batchRecord.model, '', prompt, apiKeys, false, context)
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
            reject(assignment.fingerprint)
            continue
          }
          const subject = checkSubject(item, assignment, project?.content_language)
          if (subject === 'drift') {
            job.output_lines.push('  ↻ ' + assignment.idea_key + ': output drifted from assigned subject; replacing slot.')
            reject(assignment.fingerprint)
            continue
          }
          if (subject === 'unmeasurable' && !subjectCheckSkipNoted) {
            subjectCheckSkipNoted = true
            job.output_lines.push(`Subject check skipped: the ideas are in ${normalizeContentLanguage(project?.content_language) === 'km' ? 'Khmer' : 'a language'} this check cannot compare.`)
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
    } catch (error) {
      // The batch saved for this campaign was COLLECTED and the answer proves its key is spent: the
      // Gateway settled it as a failure with no hold left, settled it as an answer Story cannot
      // read, or proved it never received the key at all. Collecting that key again answers the
      // same way — every Retry would re-collect it and fail again, forever. Release the identity
      // and let THIS run ask once more under a new one. The captured prompt, slots and assignments
      // are still exactly what is sent; only the identity moves. A hold, an uncertain submission, a
      // cancellation, an unreachable Gateway and a truncated answer all keep their key, because
      // their answer may still be on its way or would simply come back the same.
      const dead = replayBatch
      if (releasedSettledBatch || !dead) throw error
      const death = dead.idempotency_key ? deadBatchEvidence(error, dead) : null
      if (!death) throw error
      releasedSettledBatch = true
      releaseDeadIdeaBatch(dead, death)
      if (needed > 0) {
        job.output_lines.push(`  ↻ The batch saved for this campaign can never be answered (${DEAD_BATCH_REASON[death.kind]}); asking once more as a fresh request.`)
      } else {
        // The campaign filled from elsewhere while this batch was saved, so there is nothing to
        // replace: the dead capture is closed out rather than answered by a request whose ideas
        // would be discarded.
        dead.resolved = true
        replayBatch = null
      }
      writeIdeaBatch(job, dead)
      await jq.checkpointJobState(job)
      continue
    } finally {
      clearInterval(watcher)
    }

    const filtered = request.avoid_repeated_ideas === false
      ? { kept: candidates, rejected: [] }
      : filterGenerated(candidates, similarityPool)
    for (const rejection of filtered.rejected) {
      reject(rejection.candidate.idea_fingerprint)
      job.output_lines.push(`  ↻ Rejected near-duplicate: "${rejection.candidate.title}"`)
    }
    let rejectedByMeaning = new Set<unknown>()
    if (watching && candidates.length) {
      // Watch: report what a meaning check would reject. `on`: also drop those from what the word
      // filter kept. Any embeddings failure leaves the word filter alone in charge (never blocks).
      const watched = await watchDuplicates(enforcing ? filtered.kept : candidates, similarityPool, {
        embed: upgrades.embedding_model ? texts => embedTexts(upgrades.embedding_model, texts) : undefined,
        threshold: upgrades.semantic_threshold,
        prefix: request.title_prefix,
        suffix: request.title_suffix,
        vectorCache,
      })
      if (watched.method === 'words' && !watchStats.fallback_reason) {
        job.output_lines.push(enforcing
          ? `  Meaning check unavailable (${watched.fallback_reason}); only the word check is rejecting repeats this run.`
          : `  Meaning check unavailable (${watched.fallback_reason}); watching with the improved word check instead.`)
      }
      watchStats.method = watched.method
      watchStats.fallback_reason ||= watched.fallback_reason || ''
      if (watched.method === 'meaning') {
        // Every candidate's nearest neighbour is logged, so the pilot can tune the threshold.
        for (const row of watched.nearest) {
          const verdict = row.score >= upgrades.semantic_threshold ? `${enforcing ? 'rejected' : 'would reject'} (≥ ${upgrades.semantic_threshold})` : 'kept'
          job.output_lines.push(`  ${enforcing ? 'Meaning' : 'Watch-only meaning'} ${row.score.toFixed(3)} ${verdict}: "${row.candidate.title}"${row.matched ? ` ~ "${row.matched.title}"` : ''}`)
          watchStats.nearest.push({ title: row.candidate.title, matched: row.matched?.title ?? null, score: Math.round(row.score * 1000) / 1000 })
        }
      } else {
        for (const hit of watched.hits) {
          job.output_lines.push(`  Watch-only: would reject "${hit.candidate.title}" (words ${hit.score.toFixed(2)} ~ "${hit.matched.title}")`)
        }
      }
      watchStats.would_reject += watched.hits.length
      if (enforcing && watched.method === 'meaning') {
        rejectedByMeaning = new Set(watched.hits.map(hit => hit.candidate))
        for (const hit of watched.hits) reject(hit.candidate.idea_fingerprint)
        repeats.push(...watched.hits.map(hit => hit.candidate))
        for (const hit of watched.hits) {
          job.output_lines.push(`  ↻ Rejected near-duplicate (meaning ${hit.score.toFixed(2)} ~ "${hit.matched.title}"): "${hit.candidate.title}"`)
        }
        watchStats.rejected_meaning += watched.hits.length
      }
    }
    watchStats.generated += candidates.length
    watchStats.rejected_words += filtered.rejected.length
    const survivors = rejectedByMeaning.size ? filtered.kept.filter(item => !rejectedByMeaning.has(item)) : filtered.kept
    // A replay may carry more ideas than are still needed (the campaign filled from elsewhere): keep
    // only what is still wanted, so nothing is appended beyond the requested count.
    const kept = replayBatch
      ? survivors.slice(0, Math.max(0, needed))
      : (isFormulaFreeform ? survivors.slice(0, needed) : survivors)
    // A cancellation that arrived while the provider was answering stops HERE: nothing is appended,
    // and the batch stays unresolved so a later run can still collect the answer it already paid for.
    if (jq.isCancelled(job.job_id)) throw new Error('Idea Campaign cancelled')
    let appended: im.StoredIdea[] = []
    // Everything stored under this batch's identity, which is what the record's provenance names.
    let storedUnderBatch: im.StoredIdea[] = []
    if (kept.length) {
      // Keyed by this batch's durable identity, so a crash between the append and the record below
      // cannot append the same batch twice. The model is the one this batch was actually generated
      // on: on a replay that is the captured one, so `model_used` describes the answer's own
      // provenance rather than today's preset.
      const result = await appendNewIdeas(
        job.project_slug, kept, batchRecord!.model, ideaBatchAppendKey(request.campaign_id, ordinal),
        [...projectIdeas, ...created],
      )
      storedUnderBatch = result.stored
      appended = result.added
      created.push(...appended)
      const savedCandidates = appended.map(idea => ({
        title: idea.title,
        logline: idea.logline,
        themes: idea.themes,
        mood: idea.mood,
      }))
      // Newest-first on both paths, matching collectFormulaHistory's order.
      similarityPool.unshift(...savedCandidates)
      job.output_lines.push(`  ✓ Saved ${appended.length}; campaign now ${alreadyCompleted.length + created.length}/${wanted}.`)
    }
    // The batch is answered. Mark it resolved even when nothing usable survived the filters, so a
    // filtered-out answer cannot be collected in a loop, and never replay it again.
    if (rejectedAssignments.size) job.params.rejected_assignments = [...rejectedAssignments]
    if (batchRecord) {
      batchRecord.resolved = true
      // The whole set under the identity, not just this call's remainder: a batch partly appended by
      // an earlier run stays named in full.
      if (storedUnderBatch.length) batchRecord.idea_ids = storedUnderBatch.map(idea => idea.id)
      writeIdeaBatch(job, batchRecord)
      await jq.checkpointJobState(job)
      replayBatch = null
    }
    job.progress = Math.min(99, Math.round(((alreadyCompleted.length + created.length) / wanted) * 100))
  }

  // 1.4.300 "Idea repeat check by meaning" safety check. The channel's own switch still decides
  // whether repeats are rejected and remade. When the campaign then ends short, Block leaves those
  // slots empty (as before); Off/Warn fill them with the closest repeats, named in the log.
  const shortBy = wanted - alreadyCompleted.length - created.length
  if (shortBy > 0 && repeats.length && await safetyMode(job.project_slug, 'idea_repeat') !== 'block') {
    const fill = repeats.slice(0, shortBy)
    await safetyGate(job.project_slug, 'idea_repeat', job, `${fill.length} idea slot(s) could only be filled with ideas `
      + `that repeat earlier ones by meaning; they are saved anyway: ${fill.map(idea => `"${idea.title}"`).join(', ')}.`)
    created.push(...(await appendNewIdeas(job.project_slug, fill, request.model, request.campaign_id, [...projectIdeas, ...created])).added)
  }

  const completed = alreadyCompleted.length + created.length
  job.result = {
    ...(job.result?.safety_warnings ? { safety_warnings: job.result.safety_warnings } : {}),
    campaign_id: request.campaign_id,
    created_idea_ids: created.map(idea => idea.id),
    completed,
    expected: wanted,
    series_formula_id: formulaId || plannerNiche.id,
    topic_pack_ids: activePackIds,
    ...(upgradesOn ? {
      upgrades: { covered_map: upgrades.covered_map, semantic_dedupe: upgrades.semantic_dedupe, helper_model: upgrades.helper_model, embedding_model: upgrades.embedding_model, semantic_threshold: upgrades.semantic_threshold, variety_seeds: upgrades.variety_seeds, grow_packs: upgrades.grow_packs, real_sources: upgrades.real_sources },
      duplicate_stats: { generated: watchStats.generated, kept: created.length, rejected_words: watchStats.rejected_words, rejected_meaning: watchStats.rejected_meaning, shadow_would_reject: watchStats.would_reject, shadow_method: watchStats.method || null },
    } : {}),
  }
  if (upgradesOn) await appendCampaignStats(job.project_slug, {
    at: new Date().toISOString(),
    campaign_id: request.campaign_id,
    job_id: job.job_id,
    model: request.model,
    wanted,
    completed,
    ...(job.result as any).duplicate_stats,
    shadow_fallback_reason: watchStats.fallback_reason || null,
    shadow_threshold: watching ? upgrades.semantic_threshold : null,
    nearest_scores: watchStats.nearest,
    covered_map: upgrades.covered_map,
    variety_seeds: upgrades.variety_seeds,
    grow_packs: upgrades.grow_packs,
    real_sources: upgrades.real_sources,
    packs_used: [...new Set(created.flatMap(idea => idea.idea_fingerprint?.split('|')[1] || []))],
  })
  const missingCount = wanted - completed
  requireJobCompletion(job, {
    label: 'Idea Campaign',
    expected: wanted,
    completed,
    missing: completed < wanted
      ? Array.from({ length: missingCount }, (_, index) => `idea-slot-${completed + index + 1}`)
      : [],
    // The owner reads this in Jobs. Slot ids and fingerprints mean nothing to
    // him; the count, what was kept, and the one next step do. A Retry uses
    // the project's current Topic Packs (owner decision 2026-10-03).
    message: noUsableTopicPacks
      ? `${completed} of ${wanted} ideas were saved. None of the Topic Packs selected for this channel can be used with its Series Formula (${[...new Set(droppedTopicPacks.map(dropped => TOPIC_PACK_DROP_REASONS[dropped.reason]))].join('; ')}), so there were no subjects to write ideas from. Choose different Topic Packs with "Choose Formula & Topics", then press Retry.`
      : subjectsUsedUp
      ? `${completed} of ${wanted} ideas were saved. The subjects in your Topic Packs are all used up, so the other ${missingCount} would only repeat earlier ideas. Add another Topic Pack with "Choose Formula & Topics", then press Retry to make them.`
      : coverageShortfall
      ? `${completed} of ${wanted} ideas were saved. Your Topic Packs have no unused subjects left for the other ${missingCount}. Add another Topic Pack with "Choose Formula & Topics", then press Retry to make the rest.`
      : `${completed} of ${wanted} ideas were saved. Press Retry to make the ${missingCount} missing one${missingCount === 1 ? '' : 's'}.`,
  })
  job.progress = 100
  job.output_lines.push(isFormulaFreeform
    ? '✓ Idea Campaign complete — ' + completed + '/' + wanted + ' ideas saved; ' + (request.avoid_repeated_ideas === false ? 'duplicate checks disabled by request.' : 'duplicate checks passed.')
    : `✓ Idea Campaign complete — ${completed}/${wanted} unique ideas verified.`)
}

/**
 * Append ideas under a batch identity and return which rows are NEW to this campaign count.
 *
 * `addIdeas` returns the COMPLETE set under the identity (an already-stored row plus whatever this
 * call added), so a crash-retry of a partly-appended batch, or a second attempt's warn-fill under
 * the same campaign-wide identity, would otherwise count stored rows a second time. They are already
 * in `known` (disk at job start plus this run's own rows) and `completed` would pass the disk, where
 * `requireJobCompletion` compares strictly. Sound because the queue admits one idea_campaign per
 * (project, episode) at a time and identities are campaign-namespaced, so no other run can append
 * under this identity between the snapshot and the call.
 */
async function appendNewIdeas(
  slug: string,
  ideas: Parameters<typeof im.addIdeas>[1],
  model: string,
  batchId: string,
  known: im.StoredIdea[],
): Promise<{ stored: im.StoredIdea[]; added: im.StoredIdea[] }> {
  const knownIds = new Set(known.map(idea => idea.id))
  const stored = await im.addIdeas(slug, ideas, model, batchId)
  return { stored, added: stored.filter(idea => !knownIds.has(idea.id)) }
}

function isFormulaFreeformFor(activePackIds: string[], topicPackIds: string[] | undefined): boolean {
  return !activePackIds.length && !(topicPackIds?.length)
}

/** One JSON line per campaign in `projects/<slug>/idea-campaign-stats.jsonl` — the durable metric (job history is pruned). */
async function appendCampaignStats(slug: string, line: Record<string, unknown>): Promise<void> {
  const dir = pm.getProjectDir(slug)
  if (!dir) return
  await appendFile(path.join(dir, 'idea-campaign-stats.jsonl'), `${JSON.stringify(line)}\n`).catch(() => {})
}

/**
 * Watch-only duplicate check for ideas that arrive outside a campaign (paste-import, manual add,
 * episode-folder import). Runs only with `idea_upgrades.semantic_dedupe = 'shadow'`; it never
 * blocks the import, and any failure returns null. The result is logged to the stats file.
 */
export async function watchImportedIdeas(
  slug: string,
  source: string,
  ideas: SimilarityCandidate[],
): Promise<{ method: 'meaning' | 'words'; fallback_reason?: string; threshold: number; would_reject: Array<{ title: string; matched: string; score: number }>; nearest: Array<{ title: string; matched: string | null; score: number }> } | null> {
  try {
    const upgrades = readIdeaUpgrades(await pm.getConfig(slug))
    // Imports are never blocked, even with `on`: the owner typed them. They are only reported.
    if (upgrades.semantic_dedupe === 'off' || !ideas.length) return null
    const project = await pm.getProject(slug)
    if (!project) return null
    const { formulaId } = await resolveCampaignNiche(project)
    const history = await collectFormulaHistory(slug, formulaId)
    const watched = await watchDuplicates(ideas, history, {
      embed: upgrades.embedding_model ? texts => embedTexts(upgrades.embedding_model, texts) : undefined,
      threshold: upgrades.semantic_threshold,
    })
    const round = (score: number) => Math.round(score * 1000) / 1000
    const result = {
      method: watched.method,
      ...(watched.fallback_reason ? { fallback_reason: watched.fallback_reason } : {}),
      threshold: upgrades.semantic_threshold,
      would_reject: watched.hits.map(hit => ({ title: hit.candidate.title, matched: hit.matched.title, score: round(hit.score) })),
      nearest: watched.nearest.map(row => ({ title: row.candidate.title, matched: row.matched?.title ?? null, score: round(row.score) })),
    }
    await appendCampaignStats(slug, { at: new Date().toISOString(), kind: 'import', source, count: ideas.length, shadow_would_reject: result.would_reject.length, shadow_method: result.method, shadow_fallback_reason: result.fallback_reason || null, shadow_threshold: result.threshold, would_reject: result.would_reject, nearest_scores: result.nearest })
    return result
  } catch {
    return null
  }
}

/**
 * Exposed so the drift rule can be tested against the real function rather
 * than a copy of it in a test file, which is how a rule and its test quietly
 * stop agreeing.
 */
export const __ideaCampaignInternals = { campaignPrompt, checkSubject }
