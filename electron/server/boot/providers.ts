/**
 * Provider bootstrap — side-effect-only module.
 *
 * Each provider file self-registers with the registry on import (see
 * `providers/registry.ts`). Importing this module once from `app.ts` is
 * enough to have every provider wired. Adding a new provider? Add its
 * import here — do not touch `app.ts`.
 */

// GenStudio KH owns its live catalog, durable task queue, fleet dispatch, and
// private artifacts. Story Studio discovers it instead of duplicating models.
import '../providers/image/genstudio.js'
import '../providers/text/genstudio.js'
import '../providers/video/genstudio.js'
