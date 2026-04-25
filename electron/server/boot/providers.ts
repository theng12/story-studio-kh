/**
 * Provider bootstrap — side-effect-only module.
 *
 * Each provider file self-registers with the registry on import (see
 * `providers/registry.ts`). Importing this module once from `app.ts` is
 * enough to have every provider wired. Adding a new provider? Add its
 * import here — do not touch `app.ts`.
 */

import '../providers/image/kie.js'
import '../providers/audio/fal.js'
import '../providers/audio/genaipro.js'
import '../providers/video/genaipro-veo.js'
import '../providers/video/fal.js'
import '../providers/video/kie.js'
import '../providers/text/anthropic.js'
import '../providers/text/openai.js'
import '../providers/text/kie-text.js'
