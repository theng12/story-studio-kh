# Model Pricelist

Pending provider pricing records collected for a future catalog update.

## Kie.ai

### GPT Image 2

Status: **recorded, not yet applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| GPT Image 2, image-to-image, 1K | 6 | $0.03 |
| GPT Image 2, image-to-image, 2K | 10 | $0.05 |
| GPT Image 2, image-to-image, 4K | 16 | $0.08 |
| GPT Image 2, text-to-image, 1K | 6 | $0.03 |
| GPT Image 2, text-to-image, 2K | 10 | $0.05 |
| GPT Image 2, text-to-image, 4K | 16 | $0.08 |

Provider label shown in source: OpenAI.

Integration notes:

- Do not update `DEFAULT_IMAGE_MODELS` from this record until the remaining provider/model pricing has been collected and reviewed.
- The current prices imply $0.005 per Kie credit.

### Nano Banana 2 Lite

Status: **recorded, not yet applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| Nano Banana 2 Lite, text-to-image, 1K | 4 | $0.02 |

Provider label shown in source: Google.

### Nano Banana 2

Status: **recorded, not yet applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| Google Nano Banana 2, 1K | 8 | $0.04 |
| Google Nano Banana 2, 2K | 12 | $0.06 |
| Google Nano Banana 2, 4K | 18 | $0.09 |

Provider label shown in source: Google.

### Qwen Z-Image

Status: **recorded, not yet applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| Qwen Z-Image, text-to-image, 1.0s | 0.8 | $0.004 |

Provider label shown in source: Qwen.

### Seedream 5 Pro

Status: **recorded, category not yet implemented, not yet applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| Seedream 5 Pro, input image, first image free | 0.5 | $0.0025 |
| Seedream 5 Pro, text-to-image, 1K | 7 | $0.035 |
| Seedream 5 Pro, text-to-image, 2K | 14 | $0.07 |
| Seedream 5 Pro, image-to-image, 1K | 7 | $0.035 |
| Seedream 5 Pro, image-to-image, 2K | 14 | $0.07 |

Provider label shown in source: ByteDance.

## Planned Image Catalog Scope

For the later image-model cleanup and pricing implementation, keep only these categories:

- Qwen Z-Image
- Grok
- Seedream
- Nano Banana
- GPT Image 2

The existing image models outside this planned scope are to be reviewed for removal later. This note does not remove or modify them.
