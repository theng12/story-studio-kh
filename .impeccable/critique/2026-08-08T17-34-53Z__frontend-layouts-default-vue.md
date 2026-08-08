---
target: Story Studio frontend workspace
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-08T17-34-53Z
slug: frontend-layouts-default-vue
---
# Story Studio KH UX critique

## Design-specificity verdict

Story Studio is strongly authored at the product level: verified completion, episode workflows,
Formula context, provider-owned pricing, and production safeguards are specific to this product.
Its visual language is less distinctive. Dark surfaces, amber accents, rounded cards, gradients,
and metric tiles are coherent but could belong to many SaaS dashboards; most of the product's
identity currently comes from its copy and data model.

## Nielsen heuristic score

| # | Heuristic | Score | Evidence |
|---|---|---:|---|
| 1 | Visibility of system status | 2 | Readiness and queue states are strong, but a large-project Script Generator can remain in a long loading state without a recovery action. |
| 2 | Match with the real world | 3 | Creator language is good; channel, project, Formula, and Continuity Engine add a vocabulary layer. |
| 3 | User control and freedom | 3 | Navigation, filters, toggles, and reversible manual completion are strong. |
| 4 | Consistency and standards | 3 | Shared heroes, toolbars, cards, and navigation are cohesive; scope nouns vary. |
| 5 | Error prevention | 3 | Safe empty selections, blockers, and verified completion prevent costly mistakes. |
| 6 | Recognition rather than recall | 2 | Sixteen stages and the wide Production Board require users to retain a large process map. |
| 7 | Flexibility and efficiency | 3 | Search, presets, filters, pagination, and batches support experts. |
| 8 | Aesthetic and minimalist design | 3 | Dashboard hierarchy is calm; Pipeline and Board are substantially denser. |
| 9 | Error recognition and recovery | 3 | Retry and repair states exist, but the episode-loading surface lacks a visible failure/retry state. |
| 10 | Help and documentation | 4 | Page Guide provides unusually good in-context task flow and safeguards. |
| **Total** |  | **29/40** | **Good foundation; structural simplification remains.** |

## Cognitive-load assessment

The large-project Pipeline failed seven of eight cognitive-load checks. It presents stage
selection, dependencies, presets, blockers, episode scope, and the batch action together. The
fifteen batchable stages are not chunked into production phases, and optional/advanced controls
are visible before a user chooses a goal. The dashboard performs much better because “Focus now”
reduces the project to one ranked next action.

## Emotional journey

The dashboard begins calm and trustworthy. Pipeline creates an anxiety valley: “nothing is
selected automatically” is safe, but the wall of choices makes an owner uncertain about cost and
irreversibility. Individual generators regain confidence by explaining scope, Formula, price,
model boundaries, and completion rules. A long unresolved episode load weakens that confidence.

## What works

- Dashboard status is credible and actionable, especially “Focus now.”
- The full workflow remains directly visible, matching the owner's preferred stage-first access.
- Channel Characters and Assets Library preserve project context; the old navigation loop was not
  reproducible in the live smoke test.
- LLM, image, and voice dialogs use focused search and a consistent modal pattern.
- Voice models are grouped by plan and show provider identity. ElevenLabs browsing is scoped to
  ElevenLabs and uses one “Load more voices” action rather than overlapping previous/next controls.
- Page Guide gives strong contextual help without forcing onboarding screens.
- Provider-owned cost, capability, and completion boundaries are explained rather than hidden.

## Priority issues

### P1 — Pipeline exposes the whole production graph before guiding a decision

Fifteen batchable stages, an external stage, presets, blockers, and episode scope compete at once.
Reframe it as: choose episodes, choose a recommended or advanced package, then review exact work,
presets, cost, and blockers. Preserve the full sidebar; this recommendation concerns batch setup,
not removing direct access.

### P1 — The sixteen-stage workflow is hard to hold in memory

The full sidebar is intentionally preserved, but Pipeline and Board still need visual phase bands
or compact phase summaries so the production graph is readable without memorization. A later
layout batch should add phases without hiding destinations or returning to a dashboard-first flow.

### P1 — Production Board symbolic cells lacked accessible names

The live accessibility tree exposed actionable cells as only “✓” or “○”. This was fixed during the
audit by reusing the existing episode, stage, state, and action descriptions as `aria-label`s; row
import shortcuts now name their episode too.

### P2 — Episode loading needs a bounded recovery state

A 400-episode project remained on “Loading episodes… please wait” for more than five seconds. The
elapsed timer is honest, but a real request failure has no visible error or Retry affordance. Add a
failure state using the existing `useEpisodes.error` value; do not impose an arbitrary timeout on a
large but still progressing disk scan.

### P2 — “Focus now” competes with four equally weighted metric cards

The ranked next action is the best dashboard decision aid, but four primary-looking metric cards
precede it. A future layout pass can demote those metrics to a quieter summary strip.

## Detector evidence

The deterministic frontend detector reported 103 warnings: 81 side-tab, 9 layout-transition,
8 overused-font, and 5 broken-image. Manual qualification found no immediate code-fix batch:

- All five broken-image findings are commented-out Vue/TypeScript examples, not rendered images.
- Five font findings are declarations for the same bundled Inter variable font; the other three
  are intentional Inter use.
- Side-tab is overbroad for this product and mostly flags meaningful status, warning, approval,
  and enabled/disabled state borders.
- All nine width transitions are small progress/fill indicators; no live jank was observed.

These warnings should not be mass-edited. Revisit only alongside a specific visual redesign or
measured performance problem.

## Persona red flags

- **Alex, power user:** batch filters and presets help, but stage-by-stage preset inspection and a
  fifteen-tile grid slow repeated production work.
- **Jordan, first-time owner:** Dashboard gives a clear next action, but Pipeline introduces the
  full vocabulary and graph before a recommended staged path.
- **Sam, accessibility-dependent:** Board cell naming was a concrete blocker and is now fixed.
  The wide matrix still needs phase/orientation help for keyboard and screen-reader navigation.

## Minor observations

- The Script page's flow ribbon, hero, and command surface consume much of a 720px viewport before
  the writing form begins.
- Channel, project, Formula, production path, and Continuity Engine are individually defensible but
  their relationship is not consistently taught at point of use.
- The live GenStudio image catalog classifies FLUX.2 Klein as paid-only and publishes no provider
  labels. Story Studio correctly refuses to guess either value; this is a GenStudio catalog issue.

## Questions to consider

1. Should Pipeline remain an expert control plane while Dashboard and direct sidebar stages serve
   normal production, or should Pipeline become the safest default batch journey?
2. Can phase grouping improve orientation without collapsing the full sidebar the owner prefers?
3. When episode loading fails, what backend error detail is safe and useful to expose beside Retry?
