/**
 * Route bootstrap — the single place that decides which routers mount where.
 *
 * All routers live under `/api`. Adding a new router means one edit here
 * plus the new file; `app.ts` stays untouched.
 */

import type { Express } from 'express'
import { router as projectsRouter } from './projects.js'
import { router as settingsRouter } from './settings.js'
import { router as jobsRouter } from './jobs.js'
import { router as scriptsRouter } from './scripts.js'
import { router as imagesRouter } from './images.js'
import { router as audioRouter } from './audio.js'
import { router as videoAssemblyRouter } from './video.js'
import { router as audioMergeRouter } from './audio-merge.js'
import { router as ideasRouter } from './ideas.js'
import { router as pipelineRouter } from './pipeline.js'
import { router as healthRouter } from './health.js'
import { router as systemRouter } from './system.js'
import { router as visionRouter } from './vision.js'
import { router as uploadRouter } from './upload.js'
import { router as youtubeConnectionsRouter } from './youtube-connections.js'
import { router as youtubeUploadCenterRouter } from './youtube-upload-center.js'
import { router as appSettingsRouter } from './app-settings.js'
import { router as lastSessionRouter } from './last-session.js'
import { router as charactersRouter } from './characters.js'
import { router as characterLibraryRouter } from './character-library.js'
import { router as nichesRouter } from './niches.js'
import { router as thumbnailTemplatesRouter } from './thumbnail-templates.js'
import { router as contentPacksRouter } from './content-packs.js'
import { router as contentStoreRouter } from './content-store.js'
import { router as recencyRouter } from './recency.js'
import { router as musicPoolRouter } from './music-pool.js'
import { router as musicLibraryRouter } from './music-library.js'
import { router as songPoolRouter } from './song-pool.js'
import { router as libraryRouter } from './library.js'
import { router as mediaCleanupRouter } from './media-cleanup.js'
import { router as softDeletedProjectsRouter } from './soft-deleted-projects.js'
import { router as imagePreviewRouter } from './image-preview.js'
import { router as stylePreviewRouter } from './style-preview.js'
import { router as letteringPreviewsRouter } from './lettering-previews.js'
import { router as imagePromptsEditRouter } from './image-prompts-edit.js'
import { router as imageReferencesRouter } from './image-references.js'
import { router as changelogRouter } from './changelog.js'
import { router as brollPoolsRouter } from './broll-pools.js'
import { router as brollProjectRouter } from './broll-project.js'
import { router as brollFetchRouter } from './broll-fetch.js'
import { router as researchRouter } from './research.js'
import { router as scenePlanRouter } from './scene-plan.js'
import { router as sceneReviewRouter } from './scene-review.js'
import { router as contextualCuesRouter } from './contextual-cues.js'
import { router as effectsLibraryRouter } from './effects-library.js'
import { router as soundDesignRouter } from './sound-design.js'
import { router as episodeSegmentsRouter } from './episode-segments.js'
import { router as continuityRouter } from './continuity.js'
import { requireProject } from './middleware.js'

export function mountRoutes(app: Express): void {
  // v1.0.338 — ONE project-existence guard for every /projects/:slug/*
  // endpoint (404 {detail:'Project not found'} for unknown slugs). Mounted
  // before all routers so individual handlers no longer each need the
  // hand-copied inline check. See routes/middleware.ts.
  app.use('/api/projects/:slug', requireProject)
  app.use('/api', projectsRouter)
  app.use('/api', settingsRouter)
  app.use('/api', appSettingsRouter)
  app.use('/api', lastSessionRouter)
  app.use('/api', jobsRouter)
  app.use('/api', scriptsRouter)

  app.use('/api', imagesRouter)
  app.use('/api', audioRouter)
  app.use('/api', videoAssemblyRouter)
  app.use('/api', soundDesignRouter)
  app.use('/api', episodeSegmentsRouter)
  app.use('/api', audioMergeRouter)
  app.use('/api', ideasRouter)
  app.use('/api', pipelineRouter)
  app.use('/api', healthRouter)
  app.use('/api', systemRouter)
  app.use('/api', visionRouter)
  app.use('/api', uploadRouter)
  app.use('/api', youtubeConnectionsRouter)
  app.use('/api', youtubeUploadCenterRouter)
  app.use('/api', charactersRouter)
  app.use('/api', characterLibraryRouter)
  app.use('/api', nichesRouter)
  app.use('/api', thumbnailTemplatesRouter)
  app.use('/api', contentPacksRouter)
  app.use('/api', contentStoreRouter)
  app.use('/api', recencyRouter)
  app.use('/api', musicPoolRouter)
  app.use('/api', musicLibraryRouter)
  app.use('/api', songPoolRouter)
  app.use('/api', libraryRouter)
  app.use('/api', mediaCleanupRouter)
  app.use('/api', softDeletedProjectsRouter)
  app.use('/api', imagePreviewRouter)
  app.use('/api', stylePreviewRouter)
  app.use('/api', letteringPreviewsRouter)
  app.use('/api', imagePromptsEditRouter)
  app.use('/api', imageReferencesRouter)
  app.use('/api', changelogRouter)
  app.use('/api', brollPoolsRouter)
  app.use('/api', brollProjectRouter)
  app.use('/api', brollFetchRouter)
  app.use('/api', researchRouter)
  app.use('/api', scenePlanRouter)
  app.use('/api', sceneReviewRouter)
  app.use('/api', contextualCuesRouter)
  app.use('/api', effectsLibraryRouter)
  app.use('/api', continuityRouter)
}
