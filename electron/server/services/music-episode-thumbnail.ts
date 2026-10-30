/**
 * Thumbnails for a music (Episode Builder) episode — SPEC phase 4.
 *
 * Two ways, both the owner's choice on the Thumbnail Generator page:
 *  1. Use one of the episode's scene pictures as it is (no lettering is added by code; scene
 *     pictures carry no text).
 *  2. Draw one with the image model the owner picks (Z-Image, FLUX…): Story writes the episode's
 *     thumbnail prompts from its scenes and theme, and the model draws the picture WITH its headline
 *     (owner 2026-10-03: the headline stays model-drawn; template text settings only shape the
 *     gallery preview). The regular Thumbnail Generator then runs those prompts unchanged.
 *
 * Nothing here calls a provider or spends anything.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as im from './idea-manager.js'
import { resolveEpisodePaths, resolveScenePlanPath } from './utils.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { resolveSceneImagesDir } from '../generators/scene-image.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { writePromptCompletionManifest } from './prompt-completion.js'
import { writeSelectedThumbnail } from './upload-overrides.js'
import { episodeDirFor, isMusicEpisodeDir, readEpisodeDoc, untitledScenePrompts } from './music-episode-store.js'
import type { ScenePlan } from '../models/types.js'
import { THUMBNAIL_COUNT_MAX, thumbnailCount } from '../contracts/thumbnail-counts.js'

/** YouTube's thumbnail size. Scene pictures are 1280x720 already; anything else is cover-cropped to it. */
export const THUMBNAIL_W = 1280
export const THUMBNAIL_H = 720

async function episodeTitle(slug: string, code: string): Promise<string> {
  const idea = (await im.getIdeas(slug, 'accepted')).find(i => (i.episode_code || '').toUpperCase() === code)
  return idea?.title?.trim() || code
}

export interface MusicThumbnailScene { id: string; scene_index: number; prompt: string; image_path: string | null }

/** The episode's scenes with their current pictures (null = no picture yet). */
export async function musicThumbnailScenes(slug: string, code: string): Promise<MusicThumbnailScene[]> {
  const upper = code.toUpperCase()
  const episodeDir = await episodeDirFor(slug, upper)
  if (!isMusicEpisodeDir(episodeDir)) return []
  const planPath = await resolveScenePlanPath(slug, upper, episodeDir)
  if (!existsSync(planPath)) return []
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  const imagesDir = await resolveSceneImagesDir(slug, upper, episodeDir)
  return (plan.scenes || []).map(scene => {
    const named = path.join(imagesDir, `${scene.id}.png`)
    const image = existsSync(named) ? named : scene.image_path && existsSync(scene.image_path) ? scene.image_path : null
    return { id: scene.id, scene_index: scene.scene_index, prompt: scene.visual_prompt || '', image_path: image }
  })
}

/**
 * Copy one scene picture into the episode's thumbnail folder (cover-cropped to 1280x720 PNG) and pin
 * it as the YouTube thumbnail — the owner picked it, so the upload uses it.
 */
export async function useSceneAsThumbnail(slug: string, code: string, sceneId: string): Promise<{ filename: string; path: string }> {
  const upper = code.toUpperCase()
  const scene = (await musicThumbnailScenes(slug, upper)).find(s => s.id === sceneId)
  if (!scene) throw Object.assign(new Error('That scene is not in this episode any more. Reload the page.'), { statusCode: 404 })
  if (!scene.image_path) throw Object.assign(new Error(`Scene ${scene.scene_index} has no picture yet. Make it in Episode Builder first.`), { statusCode: 409 })
  const title = await episodeTitle(slug, upper)
  const paths = await resolveEpisodePaths(slug, upper, title)
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  const filename = `${upper}_Thumb_Scene${String(scene.scene_index).padStart(2, '0')}_v1.png`
  const out = path.join(paths.thumb_dir, filename)
  const temp = path.join(paths.thumb_dir, `.tmp_${filename}`)
  await runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-i', scene.image_path,
    '-vf', `scale=${THUMBNAIL_W}:${THUMBNAIL_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${THUMBNAIL_W}:${THUMBNAIL_H}`,
    '-frames:v', '1', '-update', '1', temp,
  ])
  await fs.rename(temp, out)
  await writeSelectedThumbnail(slug, upper, title, 'youtube', filename)
  try {
    const { episodeStatusCache } = await import('./episode-status-cache.js')
    episodeStatusCache.invalidate(slug, upper)
  } catch { /* the cache refreshes on its own */ }
  return { filename, path: out }
}

/**
 * One thumbnail prompt per chosen scene (default: the first `count` scenes): the scene's own idea
 * (with no song title), the episode theme and the channel's visual style, then the one headline the
 * model must draw: once, large, spelled exactly (CJ0027 came out "Morrting Doffee Jamz").
 */
export function buildMusicThumbnailPrompt(input: { sceneIdea: string; theme?: string; style?: string; headline: string; textFree?: boolean }, enforce: (prompt: string, title: string) => string): string {
  const idea = input.sceneIdea
    .replace(/,?\s*no people,?\s*no text\s*$/i, '')
    .replace(/[.\s,]+$/, '')
    .trim()
  const themed = input.theme?.trim() ? `${input.theme.trim()} mood` : ''
  const base = [
    idea || 'A calm, atmospheric landscape',
    themed && !idea.toLowerCase().includes(themed.toLowerCase()) ? themed : '',
    input.style?.trim() || '',
    'one strong focal point, rich colour and light, no people',
  ].filter(Boolean).join(', ')
  if (input.textFree) return enforce(`${base}. No words, letters, numbers, captions, logos or typography anywhere in the image.`, '')
  const headline = input.headline.trim().replace(/"/g, "'")
  return enforce(`${base}. The headline "${headline}" printed once, large, in big clean legible letters, `
    + `spelled exactly "${headline}" letter for letter, no other text`, headline)
}

/**
 * Write `<CODE>_Thumbnail_Prompts.md` for a music episode so the regular Thumbnail Generator can draw
 * it with the owner's image model. Never overwrites an existing prompt file unless `overwrite`.
 */
export async function writeMusicThumbnailPrompts(
  slug: string,
  code: string,
  opts: { sceneIds?: string[]; count?: number; overwrite?: boolean } = {},
): Promise<{ path: string; written: boolean; count: number; requested: number }> {
  const upper = code.toUpperCase()
  // No count named → the ONE default (contracts/thumbnail-counts): three
  // thumbnail prompts, so there is something to choose from. It was 1 here, so
  // a music episode was the one surface still making a single candidate.
  const requested = thumbnailCount(opts.count)
  const title = await episodeTitle(slug, upper)
  const paths = await resolveEpisodePaths(slug, upper, title)
  const target = paths.thumb_prompts_docx
  if (existsSync(target) && !opts.overwrite) return { path: target, written: false, count: 0, requested }
  const doc = await readEpisodeDoc(slug, upper)
  if (!doc) throw Object.assign(new Error(`${upper} has no Episode Builder plan yet. Draw songs first.`), { statusCode: 409 })
  const scenes = await musicThumbnailScenes(slug, upper)
  if (!scenes.length) throw Object.assign(new Error(`${upper} has no scenes yet. Draw songs in Episode Builder first.`), { statusCode: 409 })
  // One candidate per SCENE: distinct scenes are what makes candidates distinct,
  // so an episode with fewer scenes than the target can only offer what it has.
  // `count` in the answer is what was really written, and the caller says so.
  const wanted = opts.sceneIds?.length
    ? opts.sceneIds.map(id => scenes.find(s => s.id === id)).filter((s): s is MusicThumbnailScene => !!s)
    : scenes.slice(0, Math.min(THUMBNAIL_COUNT_MAX, requested))
  if (!wanted.length) throw Object.assign(new Error('None of those scenes are in this episode any more. Reload the page.'), { statusCode: 404 })
  const { enforceThumbnailPromptElements } = await import('../generators/image-prompts.js')
  const { resolveStyleBible } = await import('../lib/style-bible.js')
  const style = (await resolveStyleBible({ slug, episodeDir: await episodeDirFor(slug, upper) }).catch(() => ({ text: '' }))).text || ''
  const { getContentLanguage } = await import('../lib/content-language.js')
  const textFree = await getContentLanguage(slug) === 'km'
  const enforce = (prompt: string, headline: string) => enforceThumbnailPromptElements(prompt, { aspectRatio: '16:9', title: headline, ...(textFree ? { headlineMode: 'none', textStyle: 'none' } : {}) })
  // A titled scene's prompt asks for its song's title; the thumbnail carries only the episode headline.
  const untitled = doc.settings.scenes.title_on_scene ? await untitledScenePrompts(slug, upper, doc) : null
  let markdown = '# Thumbnail Prompts\n\n'
  wanted.forEach((scene, i) => {
    const sceneIdea = untitled?.get(scene.id) ?? scene.prompt
    const prompt = buildMusicThumbnailPrompt({ sceneIdea, theme: doc.settings.theme, style, headline: title, textFree }, enforce)
    markdown += `## Thumbnail ${i + 1}: ${title}\n\n${prompt}\n\n`
  })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await buildImagePromptsDocx(markdown, upper, title, target)
  await writePromptCompletionManifest(path.dirname(target), upper, 'thumbnail', wanted.length)
  return { path: target, written: true, count: wanted.length, requested }
}
