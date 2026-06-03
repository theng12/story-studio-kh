/**
 * Provider bootstrap — side-effect-only module.
 *
 * Each provider file self-registers with the registry on import (see
 * `providers/registry.ts`). Importing this module once from `app.ts` is
 * enough to have every provider wired. Adding a new provider? Add its
 * import here — do not touch `app.ts`.
 */

import '../providers/image/kie.js'
// v1.0.151+ — Image Studio KH (Pinokio FastAPI wrapper, MLX-backed
// FLUX-family image generation). Sibling of Voice Studio; the user
// runs them on the same Mac and swaps them in/out via Pinokio.
import '../providers/image/imagestudio.js'
// v1.0.234+ — official OpenAI Images API (gpt-image-2), billed on the user's
// own OpenAI key. txt2img via /generations, img2img via /edits.
import '../providers/image/openai-image.js'
// v1.0.236+ — OpenRouter image models (Google Gemini "Nano Banana" flash-image),
// billed on the user's OpenRouter credit. txt2img + img2img via chat-completions
// with modalities:["image","text"].
import '../providers/image/openrouter-image.js'
import '../providers/audio/fal.js'
import '../providers/audio/genaipro.js'
// v1.0.149+ — Voice Studio KH (Pinokio-launched FastAPI wrapper around
// VoxCPM-MLX + 11 other TTS families). Reached over Tailscale.
// v1.0.150+ — replaces the standalone Chatterbox provider entirely
// (Chatterbox is now reachable through Voice Studio's chatterbox-mlx
// family if the user ever wants it back).
import '../providers/audio/voicestudio.js'
import '../providers/video/fal.js'
import '../providers/video/kie.js'
import '../providers/text/openai.js'
import '../providers/text/deepseek.js'
import '../providers/text/openrouter.js'
