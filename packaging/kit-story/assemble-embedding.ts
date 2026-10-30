#!/usr/bin/env -S npx tsx
import fs from 'node:fs/promises'
import path from 'node:path'
import { LOCAL_EMBEDDING_FILES, LOCAL_EMBEDDING_MODEL, LOCAL_RUNTIME_FILES } from '../../electron/server/contracts/local-duplicate-screening.js'

const destination = process.argv[2]
if (!destination || !path.isAbsolute(destination)) throw new Error('Pass an absolute path for the EmbeddingGemma folder.')
process.env.STORY_STUDIO_DATA_DIR = destination
const { downloadLocalModel, localModelStatus } = await import('../../electron/server/services/local-model-store.js')
const status = await downloadLocalModel(p => {
  if (p.file) process.stderr.write(`\r${p.percent}% ${p.file}                          `)
})
if (!status.installed || !(await localModelStatus()).installed) throw new Error('The assembled model did not pass Story Studio verification.')
const model = `embedding-models/${LOCAL_EMBEDDING_MODEL.revision}`
const runtime = `embedding-models/runtime-${LOCAL_EMBEDDING_MODEL.runtime.package}-${LOCAL_EMBEDDING_MODEL.runtime.version}`
const lines = [
  ...LOCAL_EMBEDDING_FILES.map(f => `${f.sha256}  ${model}/${f.path}`),
  ...LOCAL_RUNTIME_FILES.map(f => `${f.sha256}  ${runtime}/${f.path}`),
]
await fs.writeFile(path.join(destination, 'SHA256SUMS'), lines.join('\n') + '\n')
await fs.writeFile(path.join(destination, 'FILECOUNT'), `${lines.length}\n`)
console.log(`\nVerified ${lines.length} files; installed: true; ${status.bytes_present} bytes.\n${destination}`)
