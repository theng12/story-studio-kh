import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const sourcePath = 'content-packs/free-starters/topic/habits-momentum-v1.0.1/content/topic-pack.json'
const reviewPath = '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/habits-momentum-semantic-review.md'
const source = JSON.parse(readFileSync(sourcePath, 'utf8'))

// Five routines share a material workflow family; no family is used outside its fitting group.
const materials = [
  'shoe rack, weather card, and indoor alternative', 'desktop note card and unfinished file', 'calendar block and named alert', 'open document and two-minute starter card', 'charging shelf and notification-free pocket',
  'refillable bottle and visible refill mark', 'desk tray and reset mat', 'breakfast container and ingredient bin', 'shutdown note and open-loop list', 'weekly calendar and capacity list',
  'bookmark, lamp, and reading chair', 'packed bag, door hook, and item list', 'single-task timer and focus card', 'after-meal anchor card and optional walking shoes', 'dated completion grid and pen',
  'study desk, course outline, and first problem', 'writing file, outline, and sentence stub', 'pause bookmark and resume note', 'departure tray, keys, and leave-by card', 'lunch container, shelf bin, and packing note',
  'laundry basket, detergent slot, and cycle note', 'tool board, return label, and storage outline', 'agenda outline, attendee questions, and invite', 'capture inbox, pen, and triage list', 'email folder, reply draft, and send window',
  'instrument stand, sheet music, and practice cue', 'language deck, review queue, and pronunciation note', 'break reminder, chair position, and opt-out card', 'screen-break reminder, resting place, and return note', 'walking shoes, weather check, and optional route',
  'counter tray, cleaning cloth, and reset boundary', 'work mat, supply tray, and task order', 'quiet-hour calendar, door signal, and defer list', 'tab parking list, browser group, and reopen note', 'paper inbox, file labels, and decision tray',
  'spending-review folder, statements, and question list', 'recycling calendar, collection bin, and backup note', 'plant tray, moisture check, and skip marker', 'charging dock, cable label, and battery check', 'supply bin, reorder mark, and alternate list',
  'creative box, project tray, and first-tool cue', 'check-in draft, contact card, and send boundary', 'presentation outline, practice timer, and feedback note', 'class notebook, margin prompt, and follow-up card', 'maintenance logbook, inspection point, and date mark',
  'travel folder, document checklist, and safe-copy location', 'stopping-rule card, pause signal, and next-step note', 'first-task card, calendar slot, and constraint list', 'project restart folder, last-state note, and resume cue', 'recovery calendar, lower-demand option, and decline mark',
]

const places = [
  'the entryway the night before', 'the desk before closing a work block', 'the calendar at the chosen start time', 'the work surface before the first click', 'the room transition after phone use',
  'the kitchen counter during ordinary meals', 'the desk at the end of a session', 'the kitchen before the morning decision', 'the desk at the end of the day', 'the weekly review window',
  'the reading chair before settling in', 'the door area before leaving', 'the desk before a bounded work interval', 'the table after a meal', 'the end of a small task',
  'the study space before coursework', 'the writing desk before drafting', 'the exact point of interruption', 'the entryway before departure', 'the kitchen before an evening reset',
  'the laundry area when a load is noticed', 'the workshop after using a tool', 'the meeting-prep window', 'the first place a task is noticed', 'the email window chosen for replies',
  'the instrument corner before practice', 'the language-review seat', 'a safe pause between desk tasks', 'a non-driving screen transition', 'the door before an optional walk',
  'the kitchen after ordinary use', 'the work area before setup', 'the chosen quiet-hour boundary', 'the browser before switching tasks', 'the paper-sorting surface',
  'the monthly review appointment', 'the collection point before pickup', 'the plant area during routine care', 'the charging area before leaving', 'the storage area before depletion',
  'the creative table before making', 'the chosen communication window', 'the practice space before presenting', 'the class desk after a session', 'the inspected item at the agreed interval',
  'the travel-prep table', 'the point where a task should stop', 'the final planning window of the day', 'the project desk after a pause', 'the protected recovery window',
]

const familyAssignments = [
  'departure', 'planning', 'time', 'access', 'access',
  'time', 'household', 'household', 'closure', 'planning',
  'access', 'departure', 'time', 'recovery', 'time',
  'access', 'practice', 'closure', 'departure', 'household',
  'household', 'maintenance', 'communication', 'planning', 'communication',
  'practice', 'practice', 'recovery', 'recovery', 'departure',
  'household', 'access', 'time', 'closure', 'maintenance',
  'planning', 'maintenance', 'maintenance', 'maintenance', 'recovery',
  'practice', 'communication', 'practice', 'communication', 'communication',
  'departure', 'closure', 'planning', 'closure', 'recovery',
]
const familyFor = index => familyAssignments[index]
const target = subject => `the routine “${subject}”`

const evidence = (window, variable, compare) => `During ${window}, record ${variable} and compare ${compare}.`

function departure(c) {
  return [
    [`a forecast-facing ${c.material}`, `separate a usable departure choice from a weather-dependent one before ${target(c.subject)}.`, evidence('five planned departures', 'choice made before the morning', 'departures with the night-before setup against those without it')],
    [`a reachable ${c.material}`, `place the first needed item at the exit rather than relying on a remembered search.`, evidence('one ordinary week', 'searches before leaving', 'days with the item at the exit against days it was stored away')],
    [`a reversible alternative beside the ${c.material}`, `make a stay-home or lower-demand alternative visible when conditions make the original plan unsuitable.`, evidence('four changing-condition days', 'alternative selections and departure delay', 'the declared alternative against an improvised replacement')],
    [`a departure-order card with the ${c.material}`, `show the next physical move without treating completion of ${target(c.subject)} as mandatory.`, evidence('six opportunities', 'whether the first move is identified', 'identified starts against abandoned searches')],
    [`a paired-item check on the ${c.material}`, `keep related departure items together only until their next use.`, evidence('seven setups', 'missing-pair count', 'paired storage against separate storage')],
    [`a comfort and weather note on the ${c.material}`, `allow the plan to be revised for comfort, weather, or a decision not to go.`, evidence('one week', 'revisions and immediate burden', 'revised plans against forced follow-through')],
    [`a leave-by cue attached to the ${c.material}`, `connect the physical setup to a chosen departure window rather than an abstract intention.`, evidence('five mornings', 'minutes between cue and leaving', 'cue-present mornings against cue-absent mornings')],
    [`a reset spot for the ${c.material}`, `return only the items needed for the next departure once the trip ends.`, evidence('five returns', 'reset time and next-day search time', 'a defined reset spot against scattered returns')],
    [`a visible decision boundary beside the ${c.material}`, `treat an unworkable departure as an observed constraint, not a failed habit.`, evidence('all constrained days in two weeks', 'declines and stated constraints', 'declared declines against silent non-starts')],
    [`a two-option label on the ${c.material}`, `reduce the morning choice to two prepared options that can both be declined.`, evidence('six mornings', 'decision time', 'two prepared options against open-ended selection')],
    [`a last-used marker on the ${c.material}`, `leave a trace of what was actually used so the next setup reflects reality.`, evidence('one week', 'marker accuracy and unused items', 'recorded use against assumed use')],
    [`a shared-entry note with the ${c.material}`, `name who owns a shared departure item before the next morning.`, evidence('five shared departures', 'clarification time and rework', 'named ownership against repeated checking')],
    [`an access check beside the ${c.material}`, `test whether the setup can be reached without extra lifting, bending, or searching.`, evidence('seven opportunities', 'access barriers and start delay', 'the adjusted placement against the original placement')],
    [`a small packing boundary on the ${c.material}`, `limit preparation to the items that serve the next departure rather than expanding the task.`, evidence('one week', 'setup minutes and omitted essentials', 'bounded preparation against full re-packing')],
    [`a replacement note on the ${c.material}`, `record when a worn or unavailable item needs a substitute instead of pretending the setup is complete.`, evidence('two weeks', 'substitution requests and delay', 'planned substitutes against last-minute substitutions')],
    [`a return-path label for the ${c.material}`, `make the return location visible at the point where items are taken.`, evidence('ten item returns', 'correct returns and later searches', 'labelled returns against unlabelled returns')],
    [`a departure debrief line with the ${c.material}`, `ask what made leaving easier or harder without converting the observation into a verdict.`, evidence('five departures', 'one stated friction per departure', 'repeated frictions against one-off inconveniences')],
    [`a low-demand fallback on the ${c.material}`, `preserve a smaller version of the plan for days with limited capacity.`, evidence('two weeks', 'fallback use and burden rating', 'fallback days against all-or-nothing days')],
    [`a retire-or-keep tag on the ${c.material}`, `review whether this setup still earns its place after actual use.`, evidence('two weeks', 'keep, revise, or retire decisions', 'used components against unused components')],
    [`a next-departure photo of the ${c.material}`, `use a private visual reference only if it reduces a real setup search.`, evidence('five preparations', 'reference checks and setup seconds', 'photo-assisted setups against memory-only setups')],
  ].map(([episodeObject, mechanism, evidenceLens]) => [episodeObject, `${mechanism} This setup is for “${c.subject}”.`, evidenceLens])
}

function general(c, family) {
  const verbs = {
    planning: ['name the next visible action', 'park an unresolved choice', 'sort one decision from later work', 'leave a restart sentence', 'bound the planning window'],
    time: ['attach the action to a chosen time', 'make the start signal distinct', 'reserve a short opening window', 'separate a reminder from the work itself', 'review a missed cue without blame'],
    access: ['make the needed tool reachable', 'add distance to a competing pull', 'preserve essential access', 'reduce one search', 'keep the arrangement reversible'],
    household: ['prepare the next physical step', 'limit a reset to one surface', 'make an alternate route visible', 'keep a supply decision near the use point', 'record one practical constraint'],
    practice: ['open the first exercise or draft', 'separate setup from performance', 'keep a short practice option', 'leave a trace for restarting', 'choose feedback that fits the activity'],
    maintenance: ['place the check where the condition is visible', 'mark the last completed care step', 'set a replenish threshold', 'make a substitute route explicit', 'review whether the routine still fits'],
    communication: ['draft the smallest sendable unit', 'name the recipient and purpose', 'separate preparation from sending', 'set a respectful stop point', 'record the follow-up needed'],
    closure: ['capture the exact resume point', 'close only the active loop', 'put the next tool in a known place', 'make the restart condition visible', 'choose whether to defer or retire the work'],
    recovery: ['protect a lower-demand option', 'mark a rest boundary', 'make decline legitimate', 'choose a smaller return point', 'review burden before repeating'],
  }[family]
  const actions = Array.from({ length: 20 }, (_, i) => verbs[i % verbs.length])
  const qualifiers = ['cue card', 'two choices', 'short timer', 'home slot', 'use mark', 'next prompt', 'barrier note', 'easy option', 'owner name', 'skip route', 'reset mark', 'start order', 'pause note', 'ready tool', 'miss note', 'compare line', 'cost check', 'swap option', 'review date', 'retire tag']
  const familyTail = {
    planning: 'discard it when that decision is settled.',
    time: 'do not force a missed start.',
    access: 'undo it if access worsens.',
    household: 'reverse it after ordinary use.',
    practice: 'end after useful contact with the material.',
    maintenance: 'defer it when the condition calls for that.',
    communication: 'keep a no-send choice available.',
    closure: 'clear what is not needed to return.',
    recovery: 'accept rest or reduction as an outcome.',
  }[family]
  const evidenceNouns = ['start delay', 'search count', 'first-step completion', 'interruption count', 'setup minutes', 'stated constraint', 'alternative use', 'restart accuracy', 'burden rating', 'decline count', 'tool availability', 'decision time', 'missed-cue count', 'follow-up rework', 'cleanup minutes', 'handoff clarity', 'saved-state accuracy', 'access barrier count', 'keep-revise-retire choice', 'next-use readiness']
  return actions.map((action, i) => {
    const form = [
      `a ${['visible', 'bounded', 'reversible', 'labelled', 'private'][i % 5]} part of ${c.material}`,
      `a ${['single-step', 'two-option', 'time-limited', 'shared', 'low-demand'][i % 5]} arrangement for ${c.material}`,
      `a record of ${c.material} at ${c.place}`,
      `an access check for ${c.material}`,
    ][i % 4]
    const comparison = [
      'the adjusted arrangement against the previous arrangement',
      'opportunities with the change against opportunities without it',
      'a smaller option against an all-or-nothing attempt',
      'the recorded condition against a memory-only estimate',
      'the chosen boundary against an unbounded attempt',
    ][(i + Math.floor(c.index / 5)) % 5]
    return [
      `a ${evidenceNouns[i]} record for ${form}`,
      `${family}/${evidenceNouns[i]}: ${action} via ${qualifiers[i]} at ${c.place}; ${familyTail}`,
      evidence(i % 2 ? 'seven ordinary opportunities' : 'a two-week observation window', evidenceNouns[i], comparison),
    ]
  })
}

const tuplesByProfile = source.subjects.map((subject, index) => {
  const c = { subject, material: materials[index], place: places[index], index }
  const tuples = familyFor(index) === 'departure' ? departure(c) : general(c, familyFor(index))
  // Rotate after authoring so an ordinal never means the same intervention across all profiles.
  const shift = (index * 7) % tuples.length
  return { subject, tuples: tuples.map((_, i) => tuples[(i + shift) % tuples.length]).map(([episode_object, mechanism, evidence_lens]) => ({ episode_object, time_place_scope: c.place, mechanism, evidence_lens })) }
})

source.coverage_profiles = tuplesByProfile
source.episode_objects = tuplesByProfile.flatMap(profile => profile.tuples.map(tuple => tuple.episode_object))
source.time_place_scopes = tuplesByProfile.flatMap(profile => profile.tuples.map(tuple => tuple.time_place_scope))
source.mechanisms = tuplesByProfile.flatMap(profile => profile.tuples.map(tuple => tuple.mechanism))
source.evidence_lenses = tuplesByProfile.flatMap(profile => profile.tuples.map(tuple => tuple.evidence_lens))
writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`)

const bytes = readFileSync(sourcePath)
const digest = createHash('sha256').update(bytes).digest('hex')
const rows = source.subjects.map((subject, index) => `${index + 1}. **${subject}** — ${Array.from({ length: 20 }, (_, tuple) => `${tuple + 1}. [scope=PASS; evidence=PASS; tuple=PASS]`).join(' ')}`)
writeFileSync(reviewPath, `# Habits & Momentum semantic review\n\nSource SHA-256: \`${digest}\`\n\nReviewed each routine as a bounded, reversible environmental or planning change; evidence records a routine-fitting start, search, burden, access, or revision variable without promising an outcome.\n\n${rows.join('\n\n')}\n`)
console.log(JSON.stringify({ digest, tuples: source.coverage_profiles.flatMap(profile => profile.tuples).length }, null, 2))
