#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binSuffix = process.platform === 'win32' ? '.cmd' : ''
const tsx = path.join(root, 'node_modules', '.bin', `tsx${binSuffix}`)
const tsc = path.join(root, 'node_modules', '.bin', `tsc${binSuffix}`)

const qualificationTests = [
  'electron/server/__tests__/genstudio-release-qualification.test.ts',
  'electron/server/__tests__/genstudio-client-boundary.test.ts',
  'electron/server/__tests__/audio-genstudio-only.test.ts',
  'electron/server/__tests__/image-genstudio-boundary.test.ts',
  'electron/server/__tests__/scene-genstudio-boundary.test.ts',
  'electron/server/__tests__/research-genstudio-boundary.test.ts',
  'electron/server/__tests__/image-edit-boundary.test.ts',
  'electron/server/__tests__/legacy-network-boundary.test.ts',
  'electron/server/__tests__/stock-sfx-genstudio-boundary.test.ts',
]

const environment = {
  ...process.env,
  STORY_STUDIO_DISABLE_LISTEN: '1',
  STORY_STUDIO_GENSTUDIO_QUALIFICATION: 'mock-only',
}

function run(label, command, args) {
  console.log(`\n[genstudio-release] ${label}`)
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`[genstudio-release] ${label} could not start: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('[genstudio-release] deterministic qualification: loopback mock only, zero provider spend')
run('focused GenStudio contracts', tsx, ['--test', ...qualificationTests])
run('qualification TypeScript contract', tsc, [
  '--noEmit',
  '--target', 'ES2022',
  '--module', 'ESNext',
  '--moduleResolution', 'bundler',
  '--esModuleInterop',
  '--strict',
  '--resolveJsonModule',
  '--skipLibCheck',
  '--types', 'node,electron',
  ...qualificationTests,
])
console.log('\n[genstudio-release] PASS — no provider calls, live jobs, or credits were used')
