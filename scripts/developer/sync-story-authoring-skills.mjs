import { cp, readFile, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const canonicalRoot = fileURLToPath(new URL('../../developer-migration/codex-skills', import.meta.url))
const packageNames = [
  'story-studio-channel-kit-authoring',
  'story-studio-niche-adoption',
  'story-studio-thumbnail-adoption',
  'story-studio-visual-style-adoption',
]

async function inventory(directory, prefix = '') {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
  const files = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Story authoring skill package contains a symlink: ${relative}`)
    if (entry.isDirectory()) files.push(...await inventory(path, relative))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`Story authoring skill package contains a non-file entry: ${relative}`)
  }
  return files
}

export async function checkAuthoringSkills({ skillsRoot = join(homedir(), '.codex', 'skills') } = {}) {
  let files = 0
  for (const packageName of packageNames) {
    const source = join(canonicalRoot, packageName)
    const destination = join(resolve(skillsRoot), packageName)
    const expectedFiles = await inventory(source)
    let actualFiles
    try {
      actualFiles = await inventory(destination)
    } catch (error) {
      throw new Error(`${packageName} is not installed from the canonical migration package: ${error.message}`)
    }
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error(`${packageName} differs from canonical migration package inventory`)
    for (const file of expectedFiles) {
      const [expected, actual] = await Promise.all([readFile(join(source, file)), readFile(join(destination, file))])
      if (!expected.equals(actual)) throw new Error(`${packageName}/${file} differs from canonical migration package`)
      files += 1
    }
  }
  return { packages: packageNames.length, files }
}

export async function installAuthoringSkills({ skillsRoot = join(homedir(), '.codex', 'skills') } = {}) {
  const destinationRoot = resolve(skillsRoot)
  for (const packageName of packageNames) {
    const destination = join(destinationRoot, packageName)
    await rm(destination, { recursive: true, force: true })
    await cp(join(canonicalRoot, packageName), destination, { recursive: true, errorOnExist: true })
  }
  return checkAuthoringSkills({ skillsRoot: destinationRoot })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (!['--install', '--check'].includes(command) || process.argv.length !== 3) {
    throw new Error('usage: sync-story-authoring-skills.mjs --install | --check')
  }
  const result = command === '--install' ? await installAuthoringSkills() : await checkAuthoringSkills()
  process.stdout.write(`Story authoring skills ${command === '--install' ? 'installed' : 'match canonical copies'}: ${result.packages} packages, ${result.files} files\n`)
}
