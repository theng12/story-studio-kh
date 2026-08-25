# Task 2 semantic failure inventory summary

Source: `497a583c9b869f5b8eecab673c0fb35d7b4af725` / SHA-256 `b96e981851f11605038c14ebfbd5646605a349d8059dadd47b72fefcf4a6b3d6`

The audit inspected all 1,000 tuples at the atomic object + scope + mechanism + evidence-lens grain. It records **184 failing tuples** (18.4%) and 816 tuples without a direct failure under the conservative policy. 98 rows have a scope failure, 110 have an evidence failure, and 24 have both.

## Failure types

- `evidence:not-claim-capable`: 99
- `scope:incompatible-place-or-behavior`: 67
- `scope:incompatible-time-or-life-stage`: 30
- `evidence:inapplicable-to-taxon-or-medium`: 11
- `scope:ambiguous-or-unfilmable`: 1

## Counts by ordinal

1: 2; 2: 13; 3: 4; 4: 12; 5: 15; 6: 11; 7: 4; 8: 7; 9: 20; 10: 3; 11: 17; 12: 13; 13: 10; 14: 14; 15: 2; 16: 10; 17: 0; 18: 11; 19: 13; 20: 3

## Most common failing current method bases

- 15 — focal predator-prey or competitor encounters with attack, escape, and survival outcomes
- 15 — respirometry with oxygen or ventilation measurements synchronized to dive, flow, or activity records
- 13 — continuous nest, den, egg, or embryo monitoring with microclimate and hatching outcomes
- 13 — focal feeding video, prey handling time, and diet remains or isotope analysis
- 12 — thermal imaging and body-temperature logging across matched environmental conditions
- 10 — identified parent-offspring follows with care, provisioning, growth, and survival recorded
- 9 — blood, urine, secretion, or ambient-water ion and osmolarity assays
- 9 — longitudinal known-young observations with growth, skill acquisition, recruitment, and survival
- 8 — repeated occupancy, abundance, or mark-recapture surveys linked to measured habitat and threat exposure
- 7 — diet or use observations combined with exclusion, before-after, and community field surveys
- 6 — calibrated display video or models with receiver responses and interaction outcomes
- 6 — controlled biomechanics or performance measurements paired with energetic and life-history costs

## Counts by profile

- African bush elephant: 2
- Gray wolf: 3
- Polar bear: 5
- Sea otter: 2
- North American beaver: 1
- Common bottlenose dolphin: 2
- Humpback whale: 2
- Common vampire bat: 4
- Naked mole-rat: 5
- Giant panda: 6
- Cheetah: 7
- Spotted hyena: 2
- Emperor penguin: 5
- Wandering albatross: 3
- Kākāpō: 1
- Peregrine falcon: 2
- Barn owl: 5
- Common cuckoo: 9
- Ruby-throated hummingbird: 5
- Common ostrich: 2
- Atlantic puffin: 3
- Hoatzin: 3
- Komodo dragon: 4
- Green sea turtle: 3
- Veiled chameleon: 5
- King cobra: 4
- Gila monster: 4
- Saltwater crocodile: 5
- Axolotl: 2
- Strawberry poison frog: 3
- Wood frog: 6
- Hellbender: 2
- Great white shark: 4
- Electric eel: 5
- Banded archerfish: 4
- Ocellaris clownfish: 1
- Atlantic salmon: 6
- West African lungfish: 2
- Ocean sunfish: 5
- Common octopus: 0
- Common cuttlefish: 3
- Chambered nautilus: 4
- Coconut crab: 3
- Peacock mantis shrimp: 4
- Tiger pistol shrimp: 6
- Atlantic horseshoe crab: 4
- Moon jellyfish: 5
- Giant tube worm: 2
- Ochre sea star: 5
- Common earthworm: 4

## Reconciliation

- Unique tuple coordinates: 184 / 184.
- Ordinal counts sum to 184.
- Current-method counts sum to 184.
- Profile counts sum to 184.
- Scope/evidence union: 98 + 110 - 24 = 184.
- Machine-readable inventory: `task-2-semantic-failure-inventory.json`.
