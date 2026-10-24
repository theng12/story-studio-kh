import fs from 'node:fs/promises'
import path from 'node:path'

import { writeJsonAtomic } from '../lib/atomic-store.js'
import type { ContentPackVisualStyle } from '../content-packs/legacy-adapters.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { UserStylePackSchema, type UserStylePack } from '../content-packs/schemas.js'

/** One JSON file per pack, named by its pack id, beside the signed Content Pack runtime. */
function packDir(paths?: ContentPackRuntimePaths): string {
  return path.join((paths ?? getContentPackRuntimePaths()).root, 'user-style-packs')
}

/** Validate and save (or replace) one user style pack. Throws a ZodError for a bad pack. */
export async function installUserStylePack(input: unknown, paths?: ContentPackRuntimePaths): Promise<UserStylePack> {
  const pack = UserStylePackSchema.parse(input)
  await writeJsonAtomic(path.join(packDir(paths), `${pack.pack_id}.json`), pack)
  return pack
}

/** Installed user style packs. A damaged file is skipped with a warning so it never hides the others. */
export async function listUserStylePacks(paths?: ContentPackRuntimePaths): Promise<UserStylePack[]> {
  const dir = packDir(paths)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const packs: UserStylePack[] = []
  for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
    try {
      packs.push(UserStylePackSchema.parse(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))))
    } catch (error: unknown) {
      console.warn(`[user-style-packs] skipped unreadable user style pack ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return packs
}

/** User pack styles in the Style Library's record shape. They have no preview image. */
export async function listUserVisualStyles(paths?: ContentPackRuntimePaths): Promise<ContentPackVisualStyle[]> {
  return (await listUserStylePacks(paths)).flatMap(pack => pack.styles.map(style => ({
    id: style.id,
    name: style.name,
    builtin: true as const,
    blurb: style.description,
    category: style.category,
    tags: [...style.tags],
    data: { style_bible: style.style_bible, negative_prompt: style.negative_prompt ?? '' },
    preview_image: '',
    preview_images: [],
  })))
}
