import { computed } from 'vue'

export interface FeatureGuideTopic {
  title: string
  purpose: string
  useWhen?: string
  effect?: string
}

export interface FeatureGuide {
  title: string
  summary: string
  workflow: string[]
  topics: FeatureGuideTopic[]
  tips: string[]
}

export const featureGuides: Record<string, FeatureGuide> = {
  login: {
    title: 'Sign In',
    summary: 'Authenticate to a Story Studio Mac running Server Mode. Credentials protect remote access to projects, files, and production controls.',
    workflow: ['Confirm you are connecting to the intended Mac.', 'Enter the Server Mode username and password.', 'Manage or reset credentials only from the host Mac.'],
    topics: [
      { title: 'Server host', purpose: 'Identifies the Story Studio Mac receiving this sign-in.' },
      { title: 'Username and password', purpose: 'Creates an authenticated browser session without exposing project data publicly.' },
      { title: 'Session', purpose: 'Keeps a trusted browser signed in until expiry, password change, or Sign Out Everywhere.' },
    ],
    tips: ['Use authenticated Server Mode over a private network such as Tailscale.', 'Never expose the Story Studio server port directly to the public internet.'],
  },
  projects: {
    title: 'Projects',
    summary: 'Create, open, relocate, and recover Story Studio channels. Each project keeps its own episodes, presets, styles, and production files.',
    workflow: ['Open an existing project, or put its folder in your projects folder for it to appear.', 'Create a project when starting a new channel.', 'Use Settings inside a project for channel-specific configuration.'],
    topics: [
      { title: 'Project card', purpose: 'Opens that channel workspace and shows whether its folder is available.', useWhen: 'Use it whenever you want to continue production for a channel.' },
      // v1.4.2 — this described a button removed on 2026-08-08. Project
      // discovery is a filesystem scan, so the honest answer is where to put the
      // folder, not which button to press.
      { title: 'Adding a project that already exists on disk', purpose: 'Story Studio finds any folder in your projects folder that contains a project.json, so a project you copied or restored appears on its own.', useWhen: 'Use after restoring a backup or moving a project between Macs. Settings → Storage shows where your projects folder is.' },
      { title: 'Hidden channels', purpose: 'Lists channels removed from the list with Hide project, and restores them without touching any files.', useWhen: 'Use when a channel you hid needs to come back.' },
      { title: 'New Project', purpose: 'Creates the channel structure, production format, and initial settings.', effect: 'A new project folder and project record are created.' },
      { title: 'Usage', purpose: 'Shows GenStudio-authoritative credits, reservations, and completed settlement activity.' },
      { title: 'Settings', purpose: 'Opens settings that belong to this Mac, including appearance, remote access, and the GenStudio connection.' },
    ],
    tips: ['Removing a project from the app is different from deleting its files. Use project controls rather than deleting folders blindly.', 'A "Folder missing" badge means the project record is safe but the episodes folder it points at is not there — the path is named on the project page so you can move the folder back or repoint it in Settings → Storage.'],
  },
  dashboard: {
    title: 'Project Dashboard',
    summary: 'A channel-level command center that summarizes verified readiness, active work, finished videos, and the most useful next action.',
    workflow: ['Review Needs Work and Ready to Render.', 'Open the suggested next action.', 'Use Production workflow for stage-by-stage coverage.'],
    topics: [
      { title: 'Needs Work', purpose: 'Counts episodes missing at least one required stage under the same completion rules used by Pipeline and Production Board.' },
      { title: 'Ready to Render', purpose: 'Shows episodes whose required assets and approvals are complete but final video is still missing.' },
      { title: 'Final Videos', purpose: 'Counts episodes with a verified assembled output.' },
      { title: 'Idea Library', purpose: 'Shows the size and review state of the channel idea catalog.' },
      { title: 'Focus now', purpose: 'Ranks useful next actions from verified project state instead of guessing from folder names.' },
    ],
    tips: ['Optional stages never block readiness unless you explicitly enable them for the project.', 'Use Refresh status after importing or changing files outside Story Studio.'],
  },
  ideas: {
    title: 'Ideas Generator',
    summary: 'Develop channel-fit episode concepts, explore creative directions, prevent repeats, and promote approved ideas into production episodes.',
    workflow: ['Describe the territory you want to explore.', 'Choose creative freedom, lenses, and a GenStudio model.', 'Generate, review, and promote the strongest ideas.'],
    topics: [
      { title: 'Creative brief', purpose: 'Tells the model what this batch should explore in natural language.', useWhen: 'Use a sentence, question, constraint, or detailed editorial direction.' },
      { title: 'Creative freedom', purpose: 'Controls how tightly the channel formula constrains new concepts.', effect: 'Explore freely produces broader ideas; Channel-safe stays close to proven boundaries.' },
      { title: 'Optional lenses', purpose: 'Adds useful editorial angles such as overlooked stories, human stakes, or cinematic framing.' },
      { title: 'Prevent repeated ideas', purpose: 'Compares new concepts with the saved project catalog and the current batch.', effect: 'Near-duplicates are rejected or regenerated before they enter the library.' },
      { title: 'Promote', purpose: 'Turns an accepted idea into an episode with the next stable episode code.' },
    ],
    tips: ['Use Manage to search the full catalog before planning a similar topic.', 'A precise brief can still use Explore freely; creative freedom controls guardrails, not prompt detail.'],
  },
  pipeline: {
    title: 'Pipeline',
    summary: 'Queue selected stages for many episodes while preserving dependencies, completion checks, preset choices, and self-healing retries.',
    workflow: ['Select only the stages you want to advance.', 'Choose episodes and review blockers.', 'Run the batch; completed work is skipped unless you explicitly rerun it.'],
    topics: [
      { title: 'Stage selection', purpose: 'Defines which production steps the batch may run.', effect: 'Unselected stages are left untouched; optional steps can remain skipped.' },
      { title: 'Preset per stage', purpose: 'Pins reusable settings to each selected generator or assembly step.' },
      { title: 'Episode filters', purpose: 'Finds episodes missing a specific required component using live completion rules.' },
      { title: 'Preflight blockers', purpose: 'Explains missing dependencies before any work is queued.' },
      { title: 'Run Batch', purpose: 'Creates durable local jobs in dependency order.', effect: 'The local queue survives restart and GenStudio remains authoritative for remote admission.' },
    ],
    tips: ['Start with a small batch when testing a new preset.', 'Research, introductions, contextual cues, sound design, and motion may be optional depending on project configuration.'],
  },
  board: {
    title: 'Production Board',
    summary: 'See every episode against the same verified completion contract and jump directly to whichever stage needs attention.',
    workflow: ['Keep Needs work enabled to focus on incomplete episodes.', 'Click a stage cell to open that episode in the relevant workspace.', 'Use manual completion only for genuinely imported external work.'],
    topics: [
      { title: 'Detected checkmark', purpose: 'The authoritative expected output exists and passed validation.' },
      { title: 'Manual checkmark', purpose: 'Records that you intentionally completed or imported a stage outside the app.' },
      { title: 'Pending circle', purpose: 'The required output is absent, partial, stale, malformed, or unapproved.' },
      { title: 'Generating indicator', purpose: 'A matching job is active or queued.' },
      { title: 'Repair', purpose: 'Reconciles disk state and recoverable provider output without treating partial work as complete.' },
    ],
    tips: ['A green episode is based on verified stage rules, not merely folder existence.', 'Motion and other optional stages should not block completion when disabled.'],
  },
  research: {
    title: 'Research',
    summary: 'Gather model-generated claims and decide which ones may be used. Only claims you keep flow into the Script Generator.',
    workflow: ['Confirm the research topic and questions.', 'Pick the research mode and model.', 'Decide every claim — Verified to keep it, Ignore to drop it. That decision is what marks the research reviewed.'],
    topics: [
      { title: 'Research topic', purpose: 'Sets the factual boundary for this episode rather than rewriting its title.' },
      { title: 'Questions to answer', purpose: 'Focuses evidence gathering on uncertainties, causes, dates, or disputed claims.' },
      { title: 'Research mode', purpose: 'Model knowledge only answers from what the model already knows; Search the web looks sources up live and records them.', effect: 'Web search needs a qualified model and costs credits per search; model knowledge costs only the usual generation.' },
      { title: 'Claim status', purpose: 'Verified claims may inform the script; ignored or unreviewed claims do not.' },
      { title: 'Sources for metadata', purpose: 'Controls which reviewed citations may appear in the final description.' },
    ],
    tips: ['Research blocks completion only when the channel requires it (Settings → Channel).', 'Model knowledge is reliable on well-established facts but cites nothing, so check anything specific or recent. Web search records the sources it read for the run as a whole, not per claim.'],
  },
  scripts: {
    title: 'Script Generator',
    summary: 'Create an outline, expand every approved chapter, and optionally write an introduction with explicit completeness checks.',
    workflow: ['Generate and approve the outline.', 'Expand all required chapters.', 'Review narration and generate the optional introduction when enabled.'],
    topics: [
      { title: 'Outline', purpose: 'Defines chapter order, narrative beats, and scope before full prose is written.' },
      { title: 'Approve outline', purpose: 'Locks the intended structure so chapter expansion does not run from an unreviewed plan.' },
      { title: 'Chapter expansion', purpose: 'Writes full narration for each approved chapter and saves each chapter independently.' },
      { title: 'Introduction', purpose: 'Creates an optional opening separate from the main chapters.' },
      { title: 'Completion status', purpose: 'Compares expected chapters with valid expanded narration.', effect: 'A partial script remains pending and Retry targets only missing work.' },
    ],
    tips: ['Review the outline before expensive expansion if structure matters.', 'Imported scripts should use clear chapter headings so downstream audio and subtitle stages can verify coverage.'],
  },
  metadata: {
    title: 'YouTube Finalizer',
    summary: 'Build the upload-ready YouTube title, description, tags, measured chapters, selected sources, and disclosures once the production timeline exists.',
    workflow: ['Complete Script and Audio Assembly; finish Subtitles when available.', 'Choose a reusable preset and GenStudio model.', 'Finalize once, then review the complete upload package.'],
    topics: [
      { title: 'Formula publishing profile', purpose: 'Applies the channel Formula’s reusable title and description behavior.' },
      { title: 'Measured chapters', purpose: 'Uses Audio Assembly timing and approved outline titles to create the YouTube chapter block.' },
      { title: 'Subtitle verification', purpose: 'Cross-checks chapter coverage when subtitles are complete.', effect: 'Incomplete subtitles show a warning but never prevent finalization.' },
      { title: 'Sources & Further Reading', purpose: 'Adds only selected real research titles and URLs; the model never invents citation links.' },
      { title: 'Tags', purpose: 'Creates search and topic labels for YouTube metadata.' },
      { title: 'Fork to new version', purpose: 'Preserves the current metadata while creating a separately editable revision.' },
    ],
    tips: ['Finalize after Audio Assembly so timestamps use measured durations.', 'A subtitle warning is informational; review it before upload if exact cross-checking matters.'],
  },
  'thumbnail-prompts': {
    title: 'Thumbnail Prompts',
    summary: 'Turn an episode into several distinct thumbnail concepts with composition, subject, text, and visual-direction instructions.',
    workflow: ['Choose a recipe, style, and GenStudio model.', 'Generate multiple prompt concepts.', 'Review differences before rendering images.'],
    topics: [
      { title: 'Thumbnail recipe', purpose: 'Defines a reusable visual strategy such as subject scale, layout, emotion, and title treatment.' },
      { title: 'Prompt count', purpose: 'Controls how many distinct thumbnail directions are generated.' },
      { title: 'In-image title', purpose: 'Specifies exact visible wording when the selected workflow renders text inside the artwork.' },
      { title: 'Vision references', purpose: 'Lets a qualified vision model interpret supplied visual references.' },
      { title: 'Prompt review', purpose: 'Shows exactly what will be sent to image generation before credits are used.' },
    ],
    tips: ['Aim for meaningfully different concepts, not small wording variations.', 'Thumbnail prompts are separate from Scene Plan visual prompts.'],
  },
  thumbnails: {
    title: 'Thumbnail Generator',
    summary: 'Render, inspect, recover, pin, and choose final thumbnail images from approved thumbnail prompts.',
    workflow: ['Select a GenStudio image model and its supported controls.', 'Generate missing images or render one sample first.', 'Preview results and pin the preferred upload thumbnail.'],
    topics: [
      { title: 'Model', purpose: 'Chooses a live, approved GenStudio image model. Available ratios and controls come from its catalog capabilities.' },
      { title: 'Aspect ratio', purpose: 'Controls the output shape. GenStudio owns the output resolution and render effort.' },
      { title: 'Generate missing fresh', purpose: 'Submits only missing images as new paid work; verified existing images are skipped.' },
      { title: 'Image integrity', purpose: 'Compares expected thumbnail IDs with usable files and recoverable GenStudio jobs.' },
      { title: 'Pin for upload', purpose: 'Locks a specific thumbnail so automatic highest-version selection does not replace it.' },
    ],
    tips: ['Use a single sample to validate an unfamiliar style or model before generating the full set.', 'Repair recovers an existing accepted job; fresh generation creates a new request and may use credits.'],
  },
  audio: {
    title: 'Audio Generator',
    summary: 'Create narration per introduction or chapter using a compatible GenStudio voice and model, with per-section recovery.',
    workflow: ['Choose a TTS model and compatible voice.', 'Select missing sections or generate one chapter inline.', 'Review files before Audio Assembly.'],
    topics: [
      { title: 'TTS model', purpose: 'Chooses the voice-generation tier and capabilities published by GenStudio.' },
      { title: 'Voice', purpose: 'Filters to voices compatible with the selected model or provider family.' },
      { title: 'Section selection', purpose: 'Controls exactly which chapters enter the next job.' },
      { title: 'Inline Generate', purpose: 'Generates one chapter only.', useWhen: 'Useful for repairs, testing a voice, or using a small remaining credit balance.' },
      { title: 'Voice controls', purpose: 'Adjusts supported delivery traits such as speed, stability, similarity, or expression.' },
    ],
    tips: ['Word and character counts help estimate whether a section fits model limits.', 'Existing valid chapter audio is preserved unless you explicitly enable regeneration.'],
  },
  'audio-merge': {
    title: 'Audio Assembly',
    summary: 'Verify every required narration section, normalize chapter audio, apply gaps and music, and create one merged episode track.',
    workflow: ['Select an episode and verify chapter coverage.', 'Set gaps, normalization, and music behavior.', 'Assemble and inspect the merged output.'],
    topics: [
      { title: 'Chapter coverage', purpose: 'Blocks assembly when any required narration section is missing or unusable.' },
      { title: 'Gap duration', purpose: 'Adds controlled silence between narration sections.' },
      { title: 'Normalization', purpose: 'Balances loudness so chapters sound consistent.' },
      { title: 'Music mix', purpose: 'Adds selected music beneath narration at a controlled level.' },
      { title: 'Audio manifest', purpose: 'Records the exact source sections and timing used by subtitles and later assembly.' },
    ],
    tips: ['Audio Assembly must be complete before transcription can prove full subtitle coverage.', 'Regenerate a missing chapter in Audio Generator rather than forcing a partial merge.'],
  },
  subtitles: {
    title: 'Subtitles',
    summary: 'Transcribe the verified assembled narration into per-section subtitles, stitch the complete timeline, and preview cue timing.',
    workflow: ['Complete Audio Assembly first.', 'Transcribe only missing sections.', 'Stitch and review the complete subtitle timeline.'],
    topics: [
      { title: 'Transcription model', purpose: 'Chooses a qualified GenStudio speech-to-text model.' },
      { title: 'Missing only', purpose: 'Targets sections without valid subtitle files and preserves completed work.' },
      { title: 'Re-run', purpose: 'Explicitly overwrites existing subtitle sections.' },
      { title: 'Stitched SRT', purpose: 'Combines section subtitles against the assembled audio timeline for Scene Plan and Video Assembly.' },
      { title: 'Coverage status', purpose: 'Compares the Audio Assembly manifest with usable subtitle files.', effect: 'Any missing section remains loud and blocking.' },
    ],
    tips: ['Do not transcribe before Audio Assembly; there is no authoritative complete timeline yet.', 'Use Retry for missing sections rather than retranscribing successful chapters.'],
  },
  'character-sheet': {
    title: 'Character Sheet',
    summary: 'Define the visual anchor, built-in style, and reusable guidance that keeps scene imagery coherent for this episode.',
    workflow: ['Choose the project visual style.', 'Add or select the episode reference image when needed.', 'Review guidance before Scene Plan.'],
    topics: [
      { title: 'Style', purpose: 'Sets the shared visual language used by Scene Plan and image generation.' },
      { title: 'Reference image', purpose: 'Provides a concrete visual anchor for recurring appearance and composition.' },
      { title: 'Channel Characters', purpose: 'Links reusable character records and channel-specific voice profiles.' },
      { title: 'Style Bible', purpose: 'Supplies render-ready art direction and negative guidance to downstream prompts.' },
    ],
    tips: ['Use one strong, readable reference rather than a crowded collage.', 'Scene Plan consumes this style automatically; it should not duplicate a second style picker.'],
  },
  'scene-plan': {
    title: 'Scene Plan',
    summary: 'Build a cue-aligned timeline, generate full visual prompts in durable packs, and optionally add motion prompts.',
    workflow: ['Build the deterministic timeline from stitched subtitles.', 'Generate all missing visual prompts.', 'Optionally generate motion prompts after visual prompts exist.'],
    topics: [
      { title: 'Timeline', purpose: 'Splits narration into stable, timestamped scenes without using an LLM.' },
      { title: 'Opening visuals', purpose: 'Reserves a branded opening or starts story scenes from the first second.' },
      { title: 'Visual interpretation', purpose: 'Controls how literally or creatively narration becomes imagery.' },
      { title: 'Prompt batch size', purpose: 'Controls scenes per GenStudio LLM request while preserving each result by stable scene ID.' },
      { title: 'Motion prompts', purpose: 'Adds optional image-to-video direction without changing scene timing.' },
      { title: 'Repair controls', purpose: 'Fix long scenes, coverage gaps, or timestamp drift without discarding healthy work.' },
    ],
    tips: ['Generate visual prompts only after the timeline looks structurally correct.', 'A missing or duplicate prompt blocks image generation rather than silently reusing another scene.'],
  },
  'contextual-cues': {
    title: 'Contextual Cues',
    summary: 'Optionally place reviewed location, date, map, or documentary context labels against the Scene Plan timeline.',
    workflow: ['Enable the feature only for projects that need it.', 'Review proposed cues.', 'Approve, edit, or exclude every cue before final assembly.'],
    topics: [
      { title: 'Cue type', purpose: 'Defines the information being presented, such as place, time, or context.' },
      { title: 'Timing', purpose: 'Places the cue against stable scene timestamps.' },
      { title: 'Approval', purpose: 'Allows only explicitly reviewed cues into Video Assembly.' },
      { title: 'Exclude', purpose: 'Resolves an unwanted cue without including it in the video.' },
    ],
    tips: ['Keep documentary labels concise and readable.', 'When enabled, unresolved cues block Final Video so they cannot slip through unnoticed.'],
  },
  'sound-design': {
    title: 'Sound Design',
    summary: 'Optionally place ambient beds and spot effects while protecting narration clarity.',
    workflow: ['Choose safe pacing and mix defaults.', 'Add or review cues against the timeline.', 'Approve or exclude every cue before Final Video.'],
    topics: [
      { title: 'Sound density', purpose: 'Controls how often ambience and effects appear.' },
      { title: 'Maximum spots per minute', purpose: 'Caps brief effects so narration does not become crowded.' },
      { title: 'Ambient bed level', purpose: 'Sets continuous background loudness in decibels.' },
      { title: 'Spot effect level', purpose: 'Sets brief effect loudness in decibels.' },
      { title: 'Bed ducking', purpose: 'Lowers ambience under speech to preserve intelligibility.' },
    ],
    tips: ['More-negative dB values are quieter.', 'Minimal density, -20 dB beds, -12 dB spots, and Gentle ducking are safe narration-first starting points.'],
  },
  'scene-review': {
    title: 'Scene Review',
    summary: 'Inspect every planned scene image against narration and timing, repair gaps, and approve the final still-image sequence.',
    workflow: ['Generate or upload missing scene images.', 'Preview each result at full size.', 'Approve every usable scene or repair it before assembly.'],
    topics: [
      { title: 'Episode readiness', purpose: 'Shows image coverage, stale assets, and approval percentage using authoritative scene IDs.' },
      { title: 'Render settings', purpose: 'Controls the GenStudio image model, aspect, size, quality, seed, and rewrite model.' },
      { title: 'Auto-approve generated images', purpose: 'Marks newly verified generated images approved when the saved preset explicitly enables it.' },
      { title: 'Repair', purpose: 'Recovers or regenerates only the affected stable scene.' },
      { title: 'Greenlight', purpose: 'Unlocks Motion Review or Video Assembly only when required images and approvals are complete.' },
    ],
    tips: ['Leave auto-approve off when visual quality needs manual review.', 'Approval is separate from file existence so a bad image cannot silently pass downstream.'],
  },
  'motion-review': {
    title: 'Motion Review',
    summary: 'Optionally turn approved still images into image-to-video clips while preserving Scene Plan timestamps.',
    workflow: ['Enable motion only for projects that need it.', 'Generate clips from their exact approved scene images.', 'Review and approve clips before assembly.'],
    topics: [
      { title: 'Motion prompt', purpose: 'Describes camera and subject movement without changing scene content.' },
      { title: 'Motion intensity', purpose: 'Ranges from near-still ambience to more visible movement.' },
      { title: 'Image-to-video model', purpose: 'Chooses a qualified GenStudio video model and its supported duration or quality controls.' },
      { title: 'Clip approval', purpose: 'Prevents failed or visually poor motion from replacing an approved still.' },
      { title: 'Skip motion', purpose: 'Keeps the still image valid for Video Assembly when motion is unnecessary.' },
    ],
    tips: ['Subtle motion usually preserves faces and composition better.', 'Every request must use the matching stable scene image; another scene is never substituted.'],
  },
  'video-assembly': {
    title: 'Video Assembly',
    summary: 'Combine the approved scene timeline, narration, music, titles, overlays, subtitles, framing, and export settings into one final video.',
    workflow: ['Validate episode assets.', 'Configure timeline, effects, subtitles, and export.', 'Preview representative frames, then render on this Mac.'],
    topics: [
      { title: 'Assets', purpose: 'Verifies required scene media and merged narration before editing begins.' },
      { title: 'Intro and timeline', purpose: 'Places title media and approved scenes against Scene Plan timestamps automatically.' },
      { title: 'Effects and overlays', purpose: 'Adds motion, framing, backgrounds, logo, vignette, layers, and optional text treatment.' },
      { title: 'Subtitles', purpose: 'Burns the reviewed stitched track with safe-area positioning and style controls.' },
      { title: 'Local render', purpose: 'Builds the final video on this Mac without spending GenStudio credits.' },
      { title: 'Export', purpose: 'Sets resolution, encoder, quality, output path, and final validation.' },
    ],
    tips: ['Presets save reusable editing behavior but never save an episode-specific title image path.', 'Use preview before a long render, especially after changing overlays, framing, or subtitle placement.'],
  },
  upload: {
    title: 'YouTube Upload',
    summary: 'Connect one YouTube channel, review finished episodes, choose thumbnails and metadata, schedule publishing, and monitor results.',
    workflow: ['Connect or refresh the channel account.', 'Review the upload preview and choose a thumbnail.', 'Apply a plan or upload privately, then monitor publishing.'],
    topics: [
      { title: 'Accounts', purpose: 'Connects the project to exactly one YouTube channel and shows token health.' },
      { title: 'Upload Queue', purpose: 'Lists verified final videos that are ready for metadata and upload.' },
      { title: 'Upload preview', purpose: 'Shows the exact title, description, tags, privacy, and selectable thumbnail before submission.' },
      { title: 'Plans', purpose: 'Applies a recurring schedule from the latest existing scheduled upload forward.' },
      { title: 'Playlists', purpose: 'Assigns uploaded episodes to channel collections.' },
      { title: 'Analytics and Comments', purpose: 'Surfaces performance and audience feedback after publishing.' },
    ],
    tips: ['Reconnect immediately when YouTube reports an expired session.', 'Uploads start private unless your reviewed schedule explicitly says otherwise.'],
  },
  jobs: {
    title: 'Jobs',
    summary: 'Monitor durable work, understand failures, pause local queue dispatch, recover accepted GenStudio jobs, and inspect verified output.',
    workflow: ['Filter by project, type, or status.', 'Inspect progress and provider diagnostics.', 'Pause, retry, reclaim, cancel, or clear history as appropriate.'],
    topics: [
      { title: 'Waiting locally', purpose: 'The durable Story Studio queue has not submitted this work yet.' },
      { title: 'Accepted or account queued', purpose: 'GenStudio owns the job and may be waiting for account or provider capacity.' },
      { title: 'Pause', purpose: 'Stops Story Studio from submitting further queued items; already accepted GenStudio jobs continue and can be reclaimed.' },
      { title: 'Retry', purpose: 'Repairs missing work using persisted idempotency and job identifiers rather than duplicating accepted work.' },
      { title: 'All Jobs', purpose: 'Shows work across every project instead of only the current channel.' },
    ],
    tips: ['A queued GenStudio job is healthy, not failed.', 'Do not create new work after an uncertain response; Story Studio reuses the stable idempotency key.'],
  },
  presets: {
    title: 'Presets',
    summary: 'Manage reusable local settings for generators, review stages, assembly, and upload without mixing episode-specific assets.',
    workflow: ['Filter by workspace.', 'Rename, duplicate, export, or remove a preset.', 'Return to the workspace to apply it.'],
    topics: [
      { title: 'Preset', purpose: 'Stores reusable control choices for one workspace.' },
      { title: 'Last used', purpose: 'Restores your most recent explicit choice when no preset overrides it.' },
      { title: 'Duplicate', purpose: 'Creates a safe variant without changing the original.' },
      { title: 'Export', purpose: 'Produces a portable backup of reusable settings.' },
      { title: 'Episode-specific exclusions', purpose: 'Prevents files such as title images from leaking into another episode.' },
    ],
    tips: ['Presets are local project configuration, not a cloud catalog.', 'Give presets outcome-based names such as Narration Safe or Remote Final Render.'],
  },
  settings: {
    title: 'Settings',
    summary: 'Configure what belongs to this Mac and what travels with this project, with GenStudio remaining authoritative for models, credits, and access.',
    workflow: ['Use App and Connections for this Mac.', 'Use Content and Generation for channel behavior.', 'Use Files for project paths and storage.'],
    topics: [
      { title: 'App and Connections', purpose: 'Manages appearance, server mode, secure GenStudio connection, catalog access, and account diagnostics.' },
      { title: 'Format, Niche, and Standards', purpose: 'Defines what the channel produces and its editorial guardrails.' },
      { title: 'Styles', purpose: 'Chooses or builds the visual language used by prompts and image generation.' },
      { title: 'Performance', purpose: 'Controls only local Story Studio staging pressure; GenStudio remains authoritative for account admission.' },
      { title: 'Folders, Storage, and Named Roots', purpose: 'Controls project file locations, portable paths, and cleanup behavior.' },
      { title: 'Confirmations and Project', purpose: 'Controls safety prompts, project identity, relocation, and removal.' },
    ],
    tips: ['Labels state whether a setting stays on this Mac or travels with the project.', 'Never expose the Story Studio server port publicly; use authenticated Server Mode over a private network such as Tailscale.'],
  },
  'channel-characters': {
    title: 'Channel Characters',
    summary: 'Maintain one shared character record, assign it to channels, and give each channel a compatible voice profile.',
    workflow: ['Create or select a shared character.', 'Add concrete visual identity and a reference image.', 'Assign channel labels and voice profiles.'],
    topics: [
      { title: 'Identity', purpose: 'Stores stable appearance, personality, and role details reused by scripts and prompts.' },
      { title: 'Reference image', purpose: 'Provides a previewable visual anchor shared across assigned channels.' },
      { title: 'Channel labels', purpose: 'Controls which channel workspaces may use the character.' },
      { title: 'Voice profile', purpose: 'Maps the character to a model-compatible voice for each channel.' },
      { title: 'Vision description', purpose: 'Uses a qualified model to describe a reference image when you need prompt-ready details.' },
    ],
    tips: ['Use concrete visible traits instead of vague adjectives.', 'Preview the reference image before saving so a missing or corrupted file does not become the shared anchor.'],
  },
  'assets-library': {
    title: 'Assets Library',
    summary: 'Index reusable B-roll, still images, and sound effects from local or external folders across every project on this Mac.',
    workflow: ['Register an asset pool folder.', 'Scan and normalize compatible media.', 'Search, tag, and inspect provenance before use.'],
    topics: [
      { title: 'Pool', purpose: 'Represents one indexed folder and its media handling rules.' },
      { title: 'Scan', purpose: 'Finds new, changed, moved, or removed files without copying the originals.' },
      { title: 'Normalize', purpose: 'Creates edit-friendly media variants while preserving source files.' },
      { title: 'Provenance', purpose: 'Records origin and licensing context for safer publishing.' },
      { title: 'Asset log', purpose: 'Exports or audits indexed media and attribution details.' },
    ],
    tips: ['Offline external drives remain registered and can be rescanned when reconnected.', 'Keep source licensing information with every asset intended for customer-facing production.'],
  },
  usage: {
    title: 'Credits and Settlement',
    summary: 'Display GenStudio-authoritative balance, reservation, refund, and final settlement information without calculating prices locally.',
    workflow: ['Refresh account data.', 'Review current balance and reserved credits.', 'Inspect recent job settlements when reconciling usage.'],
    topics: [
      { title: 'Spendable credits', purpose: 'Credits currently available for new GenStudio reservations.' },
      { title: 'Reserved credits', purpose: 'Maximum expected cost held for accepted jobs until they settle.' },
      { title: 'Final settlement', purpose: 'The actual GenStudio charge after completion.' },
      { title: 'Returned credits', purpose: 'Unused reservation or eligible cancellation/failure amount returned by GenStudio.' },
    ],
    tips: ['Story Studio never maintains independent model prices.', 'If data is unavailable, repair the GenStudio connection or permission rather than trusting stale local totals.'],
  },
  remote: {
    title: 'Remote Control',
    summary: 'A compact, touch-friendly production view for starting saved pipeline work and monitoring active jobs from another trusted device.',
    workflow: ['Choose a project.', 'Review the saved steps and rerun option.', 'Queue work and monitor active or failed jobs.'],
    topics: [
      { title: 'Project switcher', purpose: 'Changes the channel controlled by this remote view.' },
      { title: 'Full run', purpose: 'Queues the project’s saved production chain while preserving dependency checks.' },
      { title: 'Up to review', purpose: 'Stops the chain at the visual review gate when supported.' },
      { title: 'Force rerun', purpose: 'Requeues completed steps and should be used only when replacement output is intentional.' },
      { title: 'Stop all', purpose: 'Stops Story Studio dispatch for the displayed active jobs.' },
    ],
    tips: ['Configure presets on the desktop workspace before relying on remote runs.', 'Use Tailscale plus Server Mode authentication for iPad or remote-browser access.'],
  },
  'metadata-template': {
    title: 'YouTube Publishing Profile',
    summary: 'Store recurring channel copy separately from episode-specific metadata so titles, links, disclosures, credits, and calls to action stay consistent.',
    workflow: ['Review the available episode placeholders.', 'Build the reusable title, description, and tag structure.', 'Save and return to YouTube Finalizer.'],
    topics: [
      { title: 'Dynamic placeholders', purpose: 'Insert approved episode-specific values such as topic, summary, code, keywords, or date.' },
      { title: 'Title wrapper', purpose: 'Adds a durable channel prefix or suffix without replacing the approved episode title.' },
      { title: 'Description blocks', purpose: 'Stores stable links, credits, calls to action, disclosures, and channel copy.' },
      { title: 'Recurring tags', purpose: 'Adds channel-level tags alongside episode-specific metadata.' },
    ],
    tips: ['Keep episode-specific wording in YouTube Finalizer, not this profile.', 'Check placeholder spelling; unknown placeholders intentionally resolve empty.'],
  },
  'thumbnail-templates': {
    title: 'Thumbnail Recipe Catalog',
    summary: 'Browse and maintain reusable composition recipes that direct thumbnail concepts, artwork layout, and final headline treatment.',
    workflow: ['Browse recommended or searchable recipes.', 'Set one as the project default or fork it.', 'Edit composition rules and preview examples when needed.'],
    topics: [
      { title: 'Active recipe', purpose: 'Shows the project default that new thumbnail prompts and renders will use.' },
      { title: 'Recipe card', purpose: 'Explains a reusable subject, layout, emotion, and text-treatment strategy.' },
      { title: 'Project override', purpose: 'Pins one recipe for this channel without changing the library source.' },
      { title: 'Fork or edit', purpose: 'Creates a safe custom variant of a built-in recipe.' },
    ],
    tips: ['Recipes guide composition; Thumbnail Prompts still creates episode-specific creative directions.', 'Use clearly different recipes when testing click-through performance.'],
  },
  'image-pool': {
    title: 'Image Pool Bridge',
    summary: 'Materialize reusable stills from an indexed image pool into the unified scene-based Video Assembly workflow.',
    workflow: ['Choose an online image pool and episode.', 'Set the image pacing and load images as scenes.', 'Finish editing and rendering in Video Assembly.'],
    topics: [
      { title: 'Pool subscription', purpose: 'Chooses the indexed still-image source used by this project.' },
      { title: 'Seconds per image', purpose: 'Estimates how many stills are needed to cover narration.' },
      { title: 'No-repeat window', purpose: 'Reduces reuse across recent episodes from the same pool.' },
      { title: 'Load into Video Assembly', purpose: 'Creates standard scene assets so the unified editor can handle effects, subtitles, and export.' },
    ],
    tips: ['This is an optional bridge for pool-based channels, not the normal AI Scene Review path.', 'Reconnect offline storage and rescan the pool before loading assets.'],
  },
  recency: {
    title: 'Recency Log',
    summary: 'Inspect the topics, objects, names, or motifs that a channel formula asks future writing runs to avoid repeating too soon.',
    workflow: ['Review the active niche rule and lookback.', 'Search or filter recorded items.', 'Remove only entries you intentionally want to make eligible again.'],
    topics: [
      { title: 'Active rule', purpose: 'Shows which niche rule records repetition-sensitive content and how far back it looks.' },
      { title: 'Log entry', purpose: 'Records an extracted item and the episode that recently used it.' },
      { title: 'Remove entry', purpose: 'Allows that item to re-enter future generation.' },
      { title: 'Clear in bulk', purpose: 'Resets a filtered or complete avoidance history and should be used deliberately.' },
    ],
    tips: ['Idea duplicate prevention and the Recency Log solve different problems: concept duplication versus repeated story ingredients.', 'Historical entries remain visible if a later niche disables recency rules.'],
  },
  broll: {
    title: 'B-Roll Selection',
    summary: 'Select timed stock clips from a subscribed local pool for narration-led formats that intentionally use B-roll instead of generated scene images.',
    workflow: ['Choose an online B-roll pool and episode.', 'Set selection, pacing, audio, and repeat-avoidance rules.', 'Review the sequence and continue to unified Video Assembly.'],
    topics: [
      { title: 'Pool subscription', purpose: 'Chooses the indexed B-roll collection available to this project.' },
      { title: 'Selection mode', purpose: 'Controls random, tagged, themed, or manual clip selection.' },
      { title: 'Pacing', purpose: 'Sets timed segments or source-length playback behavior.' },
      { title: 'Repeat avoidance', purpose: 'Prevents immediate clip reuse within and across episodes.' },
      { title: 'Unified assembly', purpose: 'Hands the selected visual sequence to the standard effects, subtitle, and export editor.' },
    ],
    tips: ['This page is only relevant when the project format explicitly uses B-roll.', 'Check licensing and provenance in Assets Library before publishing stock footage.'],
  },
  'characters-redirect': {
    title: 'Channel Characters',
    summary: 'Project character links now open the shared Channel Characters library, filtered to the current channel.',
    workflow: ['Wait for the shared library to open.', 'Review characters assigned to this channel.', 'Edit identity, reference image, labels, or voice profile.'],
    topics: [
      { title: 'Shared character record', purpose: 'Prevents separate conflicting copies of the same recurring identity.' },
      { title: 'Channel filter', purpose: 'Shows which shared characters are available to the current project.' },
    ],
    tips: ['This route redirects automatically and exists for compatibility.', 'Use Channel Characters in the main navigation for global management.'],
  },
}

const suffixToGuide: Record<string, string> = {
  ideas: 'ideas',
  pipeline: 'pipeline',
  board: 'board',
  research: 'research',
  scripts: 'scripts',
  metadata: 'metadata',
  'image-prompts': 'thumbnail-prompts',
  images: 'thumbnails',
  audio: 'audio',
  'audio-merge': 'audio-merge',
  subtitles: 'subtitles',
  'character-sheet': 'character-sheet',
  'scene-plan': 'scene-plan',
  'contextual-cues': 'contextual-cues',
  'sound-design': 'sound-design',
  'scene-review': 'scene-review',
  'motion-review': 'motion-review',
  'video-assembly': 'video-assembly',
  upload: 'upload',
  jobs: 'jobs',
  presets: 'presets',
  settings: 'settings',
  'metadata-template': 'metadata-template',
  'thumbnail-templates': 'thumbnail-templates',
  'image-pool': 'image-pool',
  recency: 'recency',
  broll: 'broll',
  characters: 'characters-redirect',
}

export const fallbackFeatureGuide: FeatureGuide = {
  title: 'Page Guide',
  summary: 'Use this workspace to review its current status, configure reusable controls, and continue the project workflow safely.',
  workflow: ['Read the workspace summary.', 'Choose the relevant episode or project.', 'Review validation feedback before starting work.'],
  topics: [
    { title: 'Workspace status', purpose: 'Explains what is ready, missing, blocked, or currently running.' },
    { title: 'Primary action', purpose: 'Starts the main task for this page after required inputs pass validation.' },
    { title: 'Preset controls', purpose: 'Save and restore reusable settings without storing episode-specific files.' },
  ],
  tips: ['Warnings explain what must be fixed before continuing.', 'Use the Jobs page to inspect long-running or failed work.'],
}

export function featureGuideKeyForPath(path: string): string {
  if (path === '/') return 'projects'
  if (path === '/login') return 'login'
  if (path === '/remote') return 'remote'
  if (path === '/usage') return 'usage'
  if (path === '/character-library') return 'channel-characters'
  if (path === '/broll-library') return 'assets-library'
  const match = path.match(/^\/projects\/[^/]+(?:\/([^/?#]+))?/)
  if (!match) return ''
  return match[1] ? (suffixToGuide[match[1]] || '') : 'dashboard'
}

export function resolveFeatureGuide(path: string): FeatureGuide {
  return featureGuides[featureGuideKeyForPath(path)] || fallbackFeatureGuide
}

export function useFeatureGuide() {
  const route = useRoute()
  const guide = computed(() => resolveFeatureGuide(route.path))
  return { guide }
}
