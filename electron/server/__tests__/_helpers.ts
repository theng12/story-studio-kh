/**
 * Shared test helpers. Provides isolated temp dirs and an API fixture.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { setContentStoreAnchorPlaintextTestSeamForTests } from '../services/app-secrets-store.js'

/** Create a fresh temp data dir and point STORY_STUDIO_DATA_DIR at it. */
export async function useTempDataDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-test-'))
  process.env.STORY_STUDIO_DATA_DIR = dir
  setContentStoreAnchorPlaintextTestSeamForTests(true)
  return {
    dir,
    cleanup: async () => {
      delete process.env.STORY_STUDIO_DATA_DIR
      setContentStoreAnchorPlaintextTestSeamForTests(false)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}
