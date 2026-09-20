import assert from 'node:assert/strict'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { setYoutubeDefaults } from '../services/app-settings.js'
import { createProject, updateConfig } from '../services/project-manager.js'
import { resolveYouTubeUploadSettings } from '../services/youtube-metadata-package.js'

test('a null AI-disclosure override follows either current app default', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const project = await createProject({ name: 'Task 13 disclosure default' })

  await updateConfig(project.slug, { mark_as_ai_generated: true } as any)
  await updateConfig(project.slug, { mark_as_ai_generated: null } as any)

  for (const defaultValue of [true, false]) {
    await setYoutubeDefaults({ default_mark_as_ai_generated: defaultValue })
    assert.equal((await resolveYouTubeUploadSettings(project.slug)).mark_as_ai_generated, defaultValue)
  }
})
