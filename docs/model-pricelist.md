# Model Pricelist

Provider pricing records used by the built-in catalog.

## Kie.ai

### GPT Image 2

Status: **applied to the live model catalog**

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

The current prices imply $0.005 per Kie credit.

### Nano Banana 2 Lite

Status: **applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| Nano Banana 2 Lite, text-to-image, 1K | 4 | $0.02 |

Provider label shown in source: Google.

### Nano Banana 2

Status: **applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| Google Nano Banana 2, 1K | 8 | $0.04 |
| Google Nano Banana 2, 2K | 12 | $0.06 |
| Google Nano Banana 2, 4K | 18 | $0.09 |

Provider label shown in source: Google.

### Qwen Z-Image

Status: **applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| Qwen Z-Image, text-to-image, 1.0s | 0.8 | $0.004 |

Provider label shown in source: Qwen.

### Seedream 5 Pro

Status: **generation tiers applied to the live model catalog**

Source: user-provided Kie.ai pricing screenshot, recorded 2026-07-15.

| Model and modality | Kie credits per generation | Our price (USD) |
| --- | ---: | ---: |
| Seedream 5 Pro, input image, first image free | 0.5 | $0.0025 |
| Seedream 5 Pro, text-to-image, 1K | 7 | $0.035 |
| Seedream 5 Pro, text-to-image, 2K | 14 | $0.07 |
| Seedream 5 Pro, image-to-image, 1K | 7 | $0.035 |
| Seedream 5 Pro, image-to-image, 2K | 14 | $0.07 |

Provider label shown in source: ByteDance.

The 0.5-credit additional reference-image charge is retained here as provider
pricing metadata. Story Studio's current estimate is per generated output and
does not yet add variable reference-image surcharges.

## Image Catalog Scope

The built-in catalog is curated to these categories:

- Qwen Z-Image
- Grok
- Seedream
- Nano Banana
- GPT Image 2

Legacy template rows and the static FLUX entry were removed. GPT Image 2 may
still appear through multiple providers (Kie, fal.ai, OpenAI, and OpenRouter),
but those rows remain within the same GPT Image 2 family.
