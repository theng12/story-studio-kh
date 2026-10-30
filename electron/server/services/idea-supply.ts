/**
 * #6 Idea supply counter and running-low warning (1.4.285).
 *
 * Read-only, visible on every channel. It uses the campaign's own inputs (`resolveCampaignNiche`,
 * `collectFormulaHistory`, the planner's fingerprints), so it cannot disagree with the generator.
 * "0 unused subjects" and "not a pack channel" are different answers (AGENTS §6).
 *
 * Alerts are opt-in per channel (`idea_upgrades.supply_alerts`) and fire only when the status
 * changes for the worse (ok → low, low → empty), at most once per channel per day.
 */
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { TOPIC_PACK_DROP_REASONS } from './niche-loader.js'
import { subjectUseByPack } from './idea-campaign-planner.js'
import { collectFormulaHistory, resolveCampaignNiche } from '../generators/idea-campaign.js'
import { readIdeaUpgrades } from './idea-upgrades.js'
import { withGrownPack } from './grown-pack.js'
import { getAppSetting, setAppSetting } from './app-settings.js'

export type SupplyStatus = 'ok' | 'low' | 'empty'
export type UnusedSubjects =
  | { kind: 'measured'; value: number; total: number; per_pack: Array<{ id: string; name: string; unused: number; total: number }> }
  | { kind: 'not-applicable'; reason: string }

export interface IdeaSupply {
  slug: string
  name: string
  mode: 'packs' | 'freeform' | 'no-formula'
  unused_subjects: UnusedSubjects
  ignored_packs: Array<{ id: string; reason: string }>
  waiting_ideas: number
  accepted_last_30d: number
  /** Waiting ideas ÷ the 30-day acceptance rate. Null when nothing was accepted in 30 days. */
  days_left: number | null
  status: SupplyStatus
  /** Plain sentences behind a low/empty status. */
  reasons: string[]
  thresholds: { low_unused_subjects: number; low_days_of_ideas: number }
  supply_alerts: boolean
}

const DAY_MS = 86_400_000

export async function computeIdeaSupply(slug: string, now = Date.now()): Promise<IdeaSupply | null> {
  const project = await pm.getProject(slug)
  if (!project) return null
  const upgrades = readIdeaUpgrades(await pm.getConfig(slug).catch(() => null))
  const resolved = await resolveCampaignNiche(project)
  const { formulaId, rawNiche } = resolved
  // Same as the campaign: with #3 on, the channel's grown pack counts as one of its packs.
  const niche = upgrades.grow_packs ? await withGrownPack(resolved.niche, slug) : resolved.niche
  const ideas = await im.getIdeas(slug)
  const waiting = ideas.filter(idea => idea.status === 'new').length
  const accepted = ideas.filter(idea => idea.accepted_at && now - Date.parse(idea.accepted_at) <= 30 * DAY_MS).length
  const days_left = accepted ? Math.round((waiting / (accepted / 30)) * 10) / 10 : null

  const packs = niche?.activeTopicPacks || []
  const mode: IdeaSupply['mode'] = !formulaId || !rawNiche ? 'no-formula' : packs.length ? 'packs' : 'freeform'
  let unused_subjects: UnusedSubjects = {
    kind: 'not-applicable',
    reason: mode === 'no-formula' ? 'This channel has no Series Formula.' : 'This channel generates freely from its Formula; it has no Topic Pack subjects.',
  }
  if (mode === 'packs') {
    const history = await collectFormulaHistory(slug, formulaId)
    const per_pack = subjectUseByPack(niche!, history.map(idea => idea.idea_fingerprint).filter((value): value is string => !!value))
    unused_subjects = {
      kind: 'measured',
      value: per_pack.reduce((sum, pack) => sum + pack.unused, 0),
      total: per_pack.reduce((sum, pack) => sum + pack.total, 0),
      per_pack,
    }
  }
  // The composer's own answer, so this panel and the campaign cannot disagree
  // about which selected packs were dropped and why. A selection that reads as
  // a listed pack (an old id now served by a merged one) is NOT "ignored".
  const ignored_packs: IdeaSupply['ignored_packs'] = resolved.droppedTopicPacks
    .map(dropped => ({ id: dropped.id, reason: TOPIC_PACK_DROP_REASONS[dropped.reason] }))

  const thresholds = { low_unused_subjects: upgrades.low_unused_subjects, low_days_of_ideas: upgrades.low_days_of_ideas }
  const reasons: string[] = []
  if (unused_subjects.kind === 'measured' && unused_subjects.value < thresholds.low_unused_subjects) {
    reasons.push(`${unused_subjects.value} unused Topic Pack subject${unused_subjects.value === 1 ? '' : 's'} left (warning below ${thresholds.low_unused_subjects}).`)
  }
  if (days_left !== null && days_left < thresholds.low_days_of_ideas) {
    reasons.push(`${waiting} waiting idea${waiting === 1 ? '' : 's'} cover about ${days_left} days at the last 30 days' pace (warning below ${thresholds.low_days_of_ideas}).`)
  }
  const empty = waiting === 0 && mode !== 'no-formula'
    && (mode === 'freeform' || (unused_subjects.kind === 'measured' && unused_subjects.value === 0))
  if (empty) reasons.unshift(mode === 'freeform' ? 'No ideas are waiting.' : 'No ideas are waiting and every Topic Pack subject is used.')
  return {
    slug,
    name: project.name || slug,
    mode,
    unused_subjects,
    ignored_packs,
    waiting_ideas: waiting,
    accepted_last_30d: accepted,
    days_left,
    status: empty ? 'empty' : reasons.length ? 'low' : 'ok',
    reasons,
    thresholds,
    supply_alerts: upgrades.supply_alerts,
  }
}

export async function computeAllIdeaSupply(): Promise<IdeaSupply[]> {
  const out: IdeaSupply[] = []
  for (const summary of await pm.listProjects()) {
    const supply = await computeIdeaSupply(summary.slug).catch(() => null)
    if (supply) out.push(supply)
  }
  return out
}

// ── Alerts ──────────────────────────────────────────────────────────────────

const ALERT_STATE_KEY = 'idea_supply_alerts'
const RANK: Record<SupplyStatus, number> = { ok: 0, low: 1, empty: 2 }

type AlertState = Record<string, { status: SupplyStatus; date: string }>

function localYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function formatSupplyAlert(supply: IdeaSupply): { title: string; body: string } {
  const unused = supply.unused_subjects.kind === 'measured'
    ? ` · ${supply.unused_subjects.value} unused subjects (${supply.unused_subjects.per_pack.map(pack => `${pack.name} ${pack.unused}`).join(', ')})`
    : ''
  return {
    title: `${supply.name}: ideas ${supply.status === 'empty' ? 'have run out' : 'are running low'}`,
    body: `${supply.waiting_ideas} ideas waiting${unused}. ${supply.reasons.join(' ')}`.trim(),
  }
}

/**
 * One pass over every channel with alerts on. Sends only on a change for the worse since the last
 * recorded status, and never twice for one channel on one local day. Returns what it sent.
 */
export async function runIdeaSupplyAlerts(
  send: (payload: { title: string; body: string }, slug: string) => Promise<void>,
  now = new Date(),
  supplies?: IdeaSupply[],
): Promise<string[]> {
  const today = localYmd(now)
  const raw = await getAppSetting(ALERT_STATE_KEY)
  const state: AlertState = raw && typeof raw === 'object' ? { ...(raw as AlertState) } : {}
  const sent: string[] = []
  let changed = false
  for (const supply of supplies || await computeAllIdeaSupply()) {
    if (!supply.supply_alerts) continue
    const last = state[supply.slug]
    if (supply.status === 'ok') {
      if (last && last.status !== 'ok') { state[supply.slug] = { status: 'ok', date: last.date }; changed = true }
      continue
    }
    if (last && (RANK[supply.status] <= RANK[last.status] || last.date === today)) continue
    await send(formatSupplyAlert(supply), supply.slug)
    state[supply.slug] = { status: supply.status, date: today }
    sent.push(supply.slug)
    changed = true
  }
  if (changed) await setAppSetting(ALERT_STATE_KEY, state)
  return sent
}
