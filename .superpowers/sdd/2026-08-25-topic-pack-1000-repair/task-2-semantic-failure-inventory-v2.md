# Task 2 semantic failure inventory v2

Source commit: `437a9d50ccd54d3ae68ae4b518122cd84c6fa00d`  
Source SHA-256: `cbf2e4c4edc89043ef4ca8794be987f3745c5c42eee17652cd91ab3194009020`

## Result

All 1,000 tuples were re-audited from scratch with two independent questions: exact scene/life-phase coherence and direct claim-capable evidence. The audit flags **251 unique coordinates** (91 scope failures, 183 evidence failures, 23 with both; 274 total failing dimensions). **56** rows are explicitly marked conservative-borderline rather than silently passed. The remaining 749 coordinates passed both questions.

The JSON is the authoritative row-level inventory. Every row preserves the exact current tuple, records separate question verdicts, and supplies exact replacement wording for each failed dimension.

## Failure types

| Type | Count |
|---|---:|
| `evidence:inapplicable-to-taxon-or-medium` | 30 |
| `evidence:not-claim-capable` | 153 |
| `scope:ambiguous-or-unfilmable` | 2 |
| `scope:incompatible-place-or-behavior` | 52 |
| `scope:incompatible-time-or-life-stage` | 37 |

## By ordinal

| Ordinal | Failing coordinates |
|---:|---:|
| 1 | 6 |
| 2 | 15 |
| 3 | 17 |
| 4 | 11 |
| 5 | 12 |
| 6 | 13 |
| 7 | 13 |
| 8 | 3 |
| 9 | 11 |
| 10 | 10 |
| 11 | 18 |
| 12 | 32 |
| 13 | 20 |
| 14 | 12 |
| 15 | 5 |
| 16 | 21 |
| 17 | 4 |
| 18 | 8 |
| 19 | 11 |
| 20 | 9 |

## Highest-count profiles

| Profile | Failing coordinates |
|---|---:|
| North American beaver | 11 |
| Hoatzin | 9 |
| Cheetah | 8 |
| Peregrine falcon | 8 |
| West African lungfish | 8 |
| Common cuttlefish | 7 |
| Common ostrich | 7 |
| Kākāpō | 7 |
| King cobra | 7 |
| Moon jellyfish | 7 |
| Spotted hyena | 7 |
| Wandering albatross | 7 |
| Chambered nautilus | 6 |
| Common earthworm | 6 |
| Common vampire bat | 6 |

## Highest-count incapable method bases

| Current method base | Failing coordinates |
|---|---:|
| diet or use observations combined with exclusion, before-after, and community field surveys | 17 |
| focal feeding video, prey handling time, and diet remains or isotope analysis | 15 |
| identified parent-offspring follows with care, provisioning, growth, and survival recorded | 14 |
| longitudinal known-young observations with growth, skill acquisition, recruitment, and survival | 13 |
| 3D high-speed kinematics, substrate force measurements, and speed or energy estimates | 12 |
| continuous nest, den, egg, or embryo monitoring with microclimate and hatching outcomes | 8 |
| identified-animal courtship observation with hormone, paternity, or reproductive-success measures | 8 |
| continuous brood imaging with oxygen, fouling, predation, and hatching outcomes | 7 |
| identified-animal focal sampling combined with signaling records and social-network analysis | 7 |
| controlled sensory-cue trials with receiver choice, latency, and orientation recorded | 6 |
| focal predator-prey or competitor encounters with attack, escape, and survival outcomes | 6 |
| blood, urine, secretion, or ambient-water ion and osmolarity assays | 5 |
| CT anatomy, bite or rasp force measurement, and prey-material failure tests | 5 |
| exclusion, removal, or before-after-control plots with prey and community responses | 5 |
| repeated occupancy, abundance, or mark-recapture surveys linked to measured habitat and threat exposure | 5 |

## Coverage proof

- Profiles: 50; tuple counts per profile: 20.
- Audited tuples: 1000; audited questions: 2000.
- Unique failing-coordinate digest: `31c6e242e5aed50884ddd0feff11e5ab894ff2699f3ad8ef30bfe9e22147b3b0`.
- All source-coordinate digest: `d55860af8269d50d1a0482048a64ca844e67336efd32582537728688b5bc27a6`.
- Failing 251 + passing 749 = 1,000.
- The inventory is bound to the current source hash above and is intended as ignored, untracked Task 19 evidence.
