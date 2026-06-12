/**
 * One-off normalization for an external (iCloud) Story Studio KH project.
 *
 * Brings a project folder up to current app conventions for cases where the
 * folder predates recent migrations or accumulated legacy/cruft items the
 * app's own boot-time migrations don't cover.
 *
 * Usage:
 *   # Phase 1 — scan (read-only). Produces normalization-plan.{json,md}.
 *   npx tsx scripts/normalize-icloud-project.ts \
 *     --project-path "/path/to/project" \
 *     --mode=scan
 *
 *   # Phase 2 — apply (executes the plan, writes execution log).
 *   # Refuses to run if any flagged item lacks a `decision` field.
 *   npx tsx scripts/normalize-icloud-project.ts \
 *     --project-path "/path/to/project" \
 *     --mode=apply
 *
 *   # Phase 3 — undo (replays log in reverse for reversible actions).
 *   npx tsx scripts/normalize-icloud-project.ts \
 *     --project-path "/path/to/project" \
 *     --mode=undo
 *
 * Default output paths (override with --plan / --log):
 *   <script-dir>/normalization-plan.json
 *   <script-dir>/normalization-plan.md
 *   <script-dir>/normalization-execution.log
 */

import fs from 'fs/promises'
import { existsSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── Action types ────────────────────────────────────────────────────────────

type Action =
  | { kind: 'description-migrate'; src: string; code: string; targets: { txt: string; json: string; bak: string } }
  | { kind: 'description-orphan'; src: string; folderCode: string; fileCode: string; recommendation: string; decision?: string }
  | { kind: 'folder-rename'; src: string; dst: string }
  | { kind: 'ep-to-tn'; src: string; dst: string; folderCode: string }
  | { kind: 'ext-lowercase'; src: string; dst: string }
  | { kind: 'ext-jpeg-jpg'; src: string; dst: string; collision?: string }
  | { kind: 'delete-dsstore'; src: string }
  | { kind: 'flag-secrets'; files: { path: string; size: number; mtime: string }[]; decision?: string }

interface NormalizationPlan {
  generatedAt: string
  projectPath: string
  episodePrefix: string
  episodeDigits: number
  totals: Record<string, number>
  actions: Action[]
}

interface LogEntry {
  ts: string
  kind: string
  status: 'before' | 'done' | 'skip' | 'error'
  detail: Record<string, unknown>
}

// ── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(): { projectPath: string; mode: 'scan' | 'apply' | 'undo'; planJson: string; planMd: string; log: string } {
  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    // Accept both `--flag value` and `--flag=value` forms.
    const eq = args.find(a => a.startsWith(flag + '='))
    if (eq) return eq.slice(flag.length + 1)
    const i = args.indexOf(flag)
    if (i === -1) return undefined
    const v = args[i + 1]
    if (v === undefined) throw new Error(`Missing value for ${flag}`)
    return v
  }
  const projectPath = get('--project-path')
  const mode = (get('--mode') || 'scan') as 'scan' | 'apply' | 'undo'
  if (!projectPath) {
    console.error('Usage: --project-path <dir> [--mode scan|apply|undo] [--plan path] [--log path]')
    process.exit(2)
  }
  if (!['scan', 'apply', 'undo'].includes(mode)) {
    console.error(`Invalid --mode: ${mode}`)
    process.exit(2)
  }
  const defaultPlanJson = path.join(__dirname, 'normalization-plan.json')
  const defaultPlanMd = path.join(__dirname, 'normalization-plan.md')
  const defaultLog = path.join(__dirname, 'normalization-execution.log')
  const planArg = get('--plan')
  return {
    projectPath,
    mode,
    planJson: planArg ? planArg : defaultPlanJson,
    planMd: planArg ? planArg.replace(/\.json$/, '.md') : defaultPlanMd,
    log: get('--log') || defaultLog,
  }
}

// ── Episode-code helpers (mirrors electron/server/services/utils.ts) ───────

function episodeNumberFromCode(code: string, prefix: string): number | null {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`, 'i')
  const m = code.match(re)
  if (!m || !m[1]) return null
  return parseInt(m[1], 10)
}

function extractCodeFromFolder(folderName: string, prefix: string): string | null {
  // Episode folder pattern: "TN0001 - Title…"
  const re = new RegExp(`^(${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+)\\s*-`, 'i')
  const m = folderName.match(re)
  return m && m[1] ? m[1].toUpperCase() : null
}

// ── Project metadata loader ─────────────────────────────────────────────────

interface ProjectMeta {
  episode_prefix: string
  episode_digits: number
  output_root: string
  subfolder_names?: Record<string, string>
}

async function loadProjectMeta(projectPath: string): Promise<ProjectMeta> {
  const metaPath = path.join(projectPath, 'project.json')
  const raw = await fs.readFile(metaPath, 'utf-8')
  const meta = JSON.parse(raw)
  return {
    episode_prefix: meta.episode_prefix || 'EP',
    episode_digits: meta.episode_digits || 4,
    output_root: meta.output_root || './episodes',
  subfolder_names: meta.subfolder_names || {},
  }
}

// ── SCAN ────────────────────────────────────────────────────────────────────

async function scan(projectPath: string): Promise<NormalizationPlan> {
  const meta = await loadProjectMeta(projectPath)
  const prefix = meta.episode_prefix
  const episodesRoot = path.isAbsolute(meta.output_root)
    ? meta.output_root
    : path.join(projectPath, meta.output_root)

  const actions: Action[] = []

  // 8 — Secrets duplicate (root-level only; keep above the heavy walk).
  await scanSecretsAtRoot(projectPath, actions)

  // 7 — .DS_Store cruft (whole tree).
  await scanDsStores(projectPath, actions)

  if (existsSync(episodesRoot)) {
    const seasons = await fs.readdir(episodesRoot)
    for (const season of seasons.sort()) {
      const seasonDir = path.join(episodesRoot, season)
      const sStat = await fs.stat(seasonDir).catch(() => null)
      if (!sStat?.isDirectory()) continue

      const eps = await fs.readdir(seasonDir)
      for (const ep of eps.sort()) {
        const epDir = path.join(seasonDir, ep)
        const eStat = await fs.stat(epDir).catch(() => null)
        if (!eStat?.isDirectory()) continue

        const folderCode = extractCodeFromFolder(ep, prefix)
        await scanEpisode(epDir, folderCode, prefix, actions)
      }
    }
  }

  const totals: Record<string, number> = {}
  for (const a of actions) totals[a.kind] = (totals[a.kind] || 0) + 1

  return {
    generatedAt: new Date().toISOString(),
    projectPath,
    episodePrefix: prefix,
    episodeDigits: meta.episode_digits,
    totals,
    actions,
  }
}

async function scanSecretsAtRoot(projectPath: string, actions: Action[]): Promise<void> {
  const candidates = ['secrets.json', 'secrets 2.json']
  const found: { path: string; size: number; mtime: string }[] = []
  for (const name of candidates) {
    const p = path.join(projectPath, name)
    if (!existsSync(p)) continue
    const st = statSync(p)
    found.push({ path: p, size: st.size, mtime: st.mtime.toISOString() })
  }
  if (found.length > 1) actions.push({ kind: 'flag-secrets', files: found })
}

async function scanDsStores(rootDir: string, actions: Action[]): Promise<void> {
  const stack: string[] = [rootDir]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[] = []
    try { entries = await fs.readdir(dir) } catch { continue }
    for (const name of entries) {
      const p = path.join(dir, name)
      let st
      try { st = await fs.stat(p) } catch { continue }
      if (st.isDirectory()) {
        // Don't descend into legacy archives — they're intentional and may
        // contain old .DS_Store residue that the user wants preserved.
        if (name === '00 Legacy' || / - 00 Legacy$/.test(name)) continue
        stack.push(p)
      } else if (name === '.DS_Store') {
        actions.push({ kind: 'delete-dsstore', src: p })
      }
    }
  }
}

async function scanEpisode(epDir: string, folderCode: string | null, prefix: string, actions: Action[]): Promise<void> {
  // Files at the episode root itself need normalization too — early
  // versions of the app wrote some artifacts (e.g. merged_audio) directly
  // into the episode dir before the dedicated subfolder template existed.
  await scanEpisodeSubfolder(epDir, folderCode, prefix, actions)

  // 3 — legacy "02 Description" subfolder
  let subs: string[] = []
  try { subs = await fs.readdir(epDir) } catch { return }
  for (const sub of subs) {
    const subPath = path.join(epDir, sub)
    let st
    try { st = await fs.stat(subPath) } catch { continue }
    if (!st.isDirectory()) continue

    // Legacy archives are intentional junk-drawers created by previous apply
    // runs (decision: 'legacy'). They preserve recoverable cruft and must not
    // be re-scanned — re-flagging them would loop the normalization forever.
    if (/ - 00 Legacy$/.test(sub)) continue

    if (/^.+? - 02 Description$/.test(sub)) {
      const newName = sub.replace(/02 Description$/, '02 Metadata')
      const dst = path.join(epDir, newName)
      if (!existsSync(dst)) actions.push({ kind: 'folder-rename', src: subPath, dst })
    }

    // Recurse into the subfolder for file-level scans
    await scanEpisodeSubfolder(subPath, folderCode, prefix, actions)
  }
}

async function scanEpisodeSubfolder(subDir: string, folderCode: string | null, prefix: string, actions: Action[]): Promise<void> {
  let files: string[] = []
  try { files = await fs.readdir(subDir) } catch { return }

  for (const f of files) {
    const fp = path.join(subDir, f)
    let st
    try { st = await fs.stat(fp) } catch { continue }
    if (st.isDirectory()) continue

    // 1 & 2 — _YouTube_Description.txt
    const descMatch = f.match(/^([A-Za-z]+\d+)_YouTube_Description\.txt$/)
    if (descMatch && descMatch[1]) {
      const fileCode = descMatch[1].toUpperCase()
      const txtPath = path.join(subDir, `${fileCode}_Metadata.txt`)
      const jsonPath = path.join(subDir, `${fileCode}_Metadata.json`)
      const bakPath = path.join(subDir, `${f}.bak`)
      if (folderCode && fileCode === folderCode) {
        actions.push({
          kind: 'description-migrate',
          src: fp,
          code: fileCode,
          targets: { txt: txtPath, json: jsonPath, bak: bakPath },
        })
      } else {
        actions.push({
          kind: 'description-orphan',
          src: fp,
          folderCode: folderCode || '(unknown)',
          fileCode,
          recommendation:
            folderCode && fileCode !== folderCode
              ? `Filename code ${fileCode} ≠ enclosing folder code ${folderCode}. Likely renumber-orphan. Decide: skip|delete|rename-to:<absolute path>`
              : 'Could not determine enclosing episode code. Decide: skip|delete|rename-to:<absolute path>',
        })
      }
      continue
    }

    // 4 — EP-prefixed legacy filename in a TN-prefixed folder
    if (folderCode && folderCode.startsWith('TN') && /^EP\d+_/i.test(f)) {
      // Replace just the leading EP#### with the folder's TN####
      const dstName = f.replace(/^EP\d+_/i, `${folderCode}_`)
      const dst = path.join(subDir, dstName)
      actions.push({ kind: 'ep-to-tn', src: fp, dst, folderCode })
      continue
    }

    // 5 — uppercase .MP3
    if (f.endsWith('.MP3')) {
      const dst = path.join(subDir, f.slice(0, -4) + '.mp3')
      actions.push({ kind: 'ext-lowercase', src: fp, dst })
      continue
    }

    // 6 — .jpeg → .jpg (also .JPEG via case-insensitive check)
    const lower = f.toLowerCase()
    if (lower.endsWith('.jpeg')) {
      const baseLen = f.length - 5 // strip .jpeg / .JPEG / .Jpeg etc.
      const dstName = f.slice(0, baseLen) + '.jpg'
      const dst = path.join(subDir, dstName)
      const collision = existsSync(dst) && path.resolve(dst) !== path.resolve(fp) ? dst : undefined
      actions.push({ kind: 'ext-jpeg-jpg', src: fp, dst, collision })
      continue
    }
  }
}

// ── Plan rendering ──────────────────────────────────────────────────────────

function renderMarkdown(plan: NormalizationPlan): string {
  const lines: string[] = []
  lines.push(`# Normalization Plan`)
  lines.push('')
  lines.push(`- Generated: ${plan.generatedAt}`)
  lines.push(`- Project: \`${plan.projectPath}\``)
  lines.push(`- Episode prefix: \`${plan.episodePrefix}\` (${plan.episodeDigits} digits)`)
  lines.push('')
  lines.push(`## Totals by category`)
  lines.push('')
  for (const [k, v] of Object.entries(plan.totals).sort()) {
    lines.push(`- **${k}**: ${v}`)
  }
  lines.push('')

  const flagged = plan.actions.filter(
    a => a.kind === 'description-orphan' || a.kind === 'flag-secrets',
  )
  if (flagged.length) {
    lines.push(`## ⚠ Items needing your decision (apply will refuse to run until each has a \`decision\` field in the JSON plan)`)
    lines.push('')
    for (const a of flagged) {
      if (a.kind === 'description-orphan') {
        lines.push(`### Orphan: ${path.basename(a.src)}`)
        lines.push(`- src: \`${a.src}\``)
        lines.push(`- folderCode: \`${a.folderCode}\` ; fileCode: \`${a.fileCode}\``)
        lines.push(`- recommendation: ${a.recommendation}`)
        lines.push(`- to resolve, edit JSON and add e.g.: \`"decision": "delete"\` or \`"decision": "skip"\` or \`"decision": "rename-to:/absolute/new/path.txt"\``)
        lines.push('')
      } else if (a.kind === 'flag-secrets') {
        lines.push(`### Secrets duplicate`)
        for (const f of a.files) lines.push(`- \`${f.path}\` (${f.size} B, mtime ${f.mtime})`)
        lines.push(`- to resolve, edit JSON and add: \`"decision": "delete:/absolute/path/to/the/loser.json"\` (or \`"decision": "skip"\`)`)
        lines.push('')
      }
    }
  }

  const groups: Record<string, Action[]> = {}
  for (const a of plan.actions) {
    (groups[a.kind] = groups[a.kind] || []).push(a)
  }

  for (const [kind, list] of Object.entries(groups).sort()) {
    if (kind === 'description-orphan' || kind === 'flag-secrets') continue
    lines.push(`## ${kind} (${list.length})`)
    lines.push('')
    for (const a of list.slice(0, 50)) {
      if ('src' in a && 'dst' in a) {
        lines.push(`- \`${a.src}\` → \`${a.dst}\``)
      } else if ('src' in a) {
        lines.push(`- \`${a.src}\``)
      }
    }
    if (list.length > 50) lines.push(`- … and ${list.length - 50} more`)
    lines.push('')
  }
  return lines.join('\n')
}

// ── APPLY ───────────────────────────────────────────────────────────────────

async function logAppend(logPath: string, entry: LogEntry): Promise<void> {
  await fs.appendFile(logPath, JSON.stringify(entry) + '\n')
}

async function apply(planPath: string, logPath: string): Promise<void> {
  const planRaw = await fs.readFile(planPath, 'utf-8')
  const plan: NormalizationPlan = JSON.parse(planRaw)

  // Validation gate: every flagged action must have a decision
  const unresolved = plan.actions.filter(
    a =>
      (a.kind === 'description-orphan' && !a.decision) ||
      (a.kind === 'flag-secrets' && !a.decision),
  )
  if (unresolved.length) {
    console.error(`❌ Apply refused: ${unresolved.length} flagged action(s) missing \`decision\` field. Edit ${planPath} and try again.`)
    for (const a of unresolved) {
      console.error(`   - ${a.kind}: ${'src' in a ? a.src : (a as any).files.map((f: any) => f.path).join(' / ')}`)
    }
    process.exit(3)
  }

  await fs.writeFile(logPath, '') // truncate previous log for this apply run
  await logAppend(logPath, { ts: new Date().toISOString(), kind: 'apply-start', status: 'before', detail: { plan: planPath, totals: plan.totals } })

  const ordered: (Action['kind'])[] = [
    'delete-dsstore',
    'folder-rename',
    'description-migrate',
    'ep-to-tn',
    'ext-lowercase',
    'ext-jpeg-jpg',
    'description-orphan',
    'flag-secrets',
  ]

  for (const kind of ordered) {
    const list = plan.actions.filter(a => a.kind === kind)
    if (!list.length) continue
    console.log(`[apply] ${kind}: ${list.length} action(s)`)
    for (const a of list) {
      try {
        await applyAction(a, logPath)
      } catch (e: any) {
        console.error(`[apply] error on ${kind}:`, e.message)
        await logAppend(logPath, { ts: new Date().toISOString(), kind, status: 'error', detail: { action: a, error: e.message } })
      }
    }
  }
  await logAppend(logPath, { ts: new Date().toISOString(), kind: 'apply-end', status: 'done', detail: {} })
  console.log(`✅ Apply complete. Log: ${logPath}`)
}

async function applyAction(a: Action, logPath: string): Promise<void> {
  switch (a.kind) {
    case 'delete-dsstore': {
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: { src: a.src } })
      await fs.unlink(a.src)
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: { src: a.src } })
      return
    }
    case 'folder-rename': {
      if (existsSync(a.dst)) {
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'skip', detail: { reason: 'dst-exists', ...a } })
        return
      }
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: a })
      await fs.rename(a.src, a.dst)
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: a })
      return
    }
    case 'description-migrate': {
      // Mirrors electron/server/services/folder-migration.ts:170-203
      if (!existsSync(a.src)) {
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'skip', detail: { reason: 'src-missing', ...a } })
        return
      }
      const description = (await fs.readFile(a.src, 'utf-8').catch(() => '')).trim()
      const metadataObj = {
        title: '',
        description,
        tags: [] as string[],
        savedAt: new Date().toISOString(),
        version: 1,
        migrated_from: path.basename(a.src),
      }
      const txt = formatMetadataTxt(metadataObj)
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: a })
      if (!existsSync(a.targets.txt)) await fs.writeFile(a.targets.txt, txt)
      if (!existsSync(a.targets.json)) await fs.writeFile(a.targets.json, JSON.stringify(metadataObj, null, 2) + '\n')
      if (!existsSync(a.targets.bak)) await fs.rename(a.src, a.targets.bak)
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: a })
      return
    }
    case 'ep-to-tn': {
      if (existsSync(a.dst)) {
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'skip', detail: { reason: 'dst-exists', ...a } })
        return
      }
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: a })
      await fs.rename(a.src, a.dst)
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: a })
      return
    }
    case 'ext-lowercase': {
      // Two-step on case-insensitive APFS: src → src.tmp → dst
      const tmp = a.src + '.normtmp'
      if (existsSync(a.dst) && path.resolve(a.dst).toLowerCase() !== path.resolve(a.src).toLowerCase()) {
        // True collision (different basename, not just casing)
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'skip', detail: { reason: 'dst-collision', ...a } })
        return
      }
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: a })
      await fs.rename(a.src, tmp)
      await fs.rename(tmp, a.dst)
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: a })
      return
    }
    case 'ext-jpeg-jpg': {
      // Two-step rename through a tmp name to handle case-only and same-stem collisions safely
      if (a.collision) {
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'skip', detail: { reason: 'collision', ...a } })
        return
      }
      const tmp = a.src + '.normtmp'
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: a })
      await fs.rename(a.src, tmp)
      await fs.rename(tmp, a.dst)
      await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: a })
      return
    }
    case 'description-orphan': {
      const decision = (a.decision || '').trim()
      if (!decision || decision === 'skip') {
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'skip', detail: { reason: decision || 'no-decision', ...a } })
        return
      }
      if (decision === 'delete') {
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: { op: 'delete', ...a } })
        await fs.unlink(a.src)
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: { op: 'delete', ...a } })
        return
      }
      // `legacy` — auto-route to <episode-dir>/<folderCode> - 00 Legacy/<basename>
      // This preserves the file (recoverable) without polluting the canonical
      // 02 Metadata folder where the app expects only current files.
      if (decision === 'legacy') {
        const epDir = path.dirname(path.dirname(a.src))
        const dst = path.join(epDir, `${a.folderCode} - 00 Legacy`, path.basename(a.src))
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: { op: 'legacy-move', dst, ...a } })
        await fs.mkdir(path.dirname(dst), { recursive: true })
        await fs.rename(a.src, dst)
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: { op: 'legacy-move', dst, ...a } })
        return
      }
      const renameTo = decision.match(/^rename-to:(.+)$/)
      if (renameTo && renameTo[1]) {
        const dst = renameTo[1].trim()
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: { op: 'rename', dst, ...a } })
        await fs.mkdir(path.dirname(dst), { recursive: true })
        await fs.rename(a.src, dst)
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: { op: 'rename', dst, ...a } })
        return
      }
      throw new Error(`Unknown decision: ${decision}`)
    }
    case 'flag-secrets': {
      const decision = (a.decision || '').trim()
      if (!decision || decision === 'skip') {
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'skip', detail: { reason: decision || 'no-decision', files: a.files } })
        return
      }
      // `legacy:<dst-dir>` — move every flagged file to <dst-dir>, preserving
      // basenames. Used for project-root files (secrets etc.) that aren't tied
      // to a specific episode but should still be archived rather than deleted.
      const legacy = decision.match(/^legacy:(.+)$/)
      if (legacy && legacy[1]) {
        const dstDir = legacy[1].trim()
        await fs.mkdir(dstDir, { recursive: true })
        for (const f of a.files) {
          const dst = path.join(dstDir, path.basename(f.path))
          await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: { op: 'legacy-move', src: f.path, dst } })
          await fs.rename(f.path, dst)
          await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: { op: 'legacy-move', src: f.path, dst } })
        }
        return
      }
      const del = decision.match(/^delete:(.+)$/)
      if (del && del[1]) {
        const target = del[1].trim()
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'before', detail: { op: 'delete', target, files: a.files } })
        await fs.unlink(target)
        await logAppend(logPath, { ts: new Date().toISOString(), kind: a.kind, status: 'done', detail: { op: 'delete', target } })
        return
      }
      throw new Error(`Unknown decision: ${decision}`)
    }
  }
}

function formatMetadataTxt(meta: { title: string; description: string; tags: string[] }): string {
  const tags = (meta.tags || []).join(', ')
  return [
    '=== TITLE ===',
    meta.title || '',
    '',
    '=== DESCRIPTION ===',
    meta.description || '',
    '',
    '=== TAGS ===',
    tags,
    '',
  ].join('\n')
}

// ── UNDO ────────────────────────────────────────────────────────────────────

async function undo(logPath: string): Promise<void> {
  if (!existsSync(logPath)) {
    console.error(`No log at ${logPath}`)
    process.exit(2)
  }
  const lines = (await fs.readFile(logPath, 'utf-8')).split('\n').filter(Boolean)
  const entries: LogEntry[] = lines.map(l => JSON.parse(l))
  const dones = entries.filter(e => e.status === 'done').reverse()

  for (const e of dones) {
    try {
      switch (e.kind) {
        case 'folder-rename':
        case 'ep-to-tn':
        case 'ext-lowercase':
        case 'ext-jpeg-jpg': {
          const d: any = e.detail
          if (existsSync(d.dst) && !existsSync(d.src)) {
            await fs.rename(d.dst, d.src)
            console.log(`[undo] reverted ${e.kind}: ${d.dst} → ${d.src}`)
          }
          break
        }
        case 'description-migrate': {
          const d: any = e.detail
          if (existsSync(d.targets.bak) && !existsSync(d.src)) {
            await fs.rename(d.targets.bak, d.src)
            if (existsSync(d.targets.txt)) await fs.unlink(d.targets.txt).catch(() => {})
            if (existsSync(d.targets.json)) await fs.unlink(d.targets.json).catch(() => {})
            console.log(`[undo] reverted description-migrate for ${d.code}`)
          }
          break
        }
        case 'description-orphan':
        case 'flag-secrets': {
          const d: any = e.detail
          if (d.op === 'legacy-move' || d.op === 'rename') {
            const src = d.src as string
            const dst = d.dst as string
            if (existsSync(dst) && !existsSync(src)) {
              await fs.mkdir(path.dirname(src), { recursive: true })
              await fs.rename(dst, src)
              console.log(`[undo] reverted ${e.kind} ${d.op}: ${dst} → ${src}`)
            }
          }
          break
        }
        // delete-dsstore is not undone (irrecoverable; .DS_Store regenerated by Finder)
      }
    } catch (err: any) {
      console.error(`[undo] failed for ${e.kind}:`, err.message)
    }
  }
  console.log(`✅ Undo replay complete.`)
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs()
  if (opts.mode === 'scan') {
    if (!existsSync(opts.projectPath)) {
      console.error(`Project path does not exist: ${opts.projectPath}`)
      process.exit(2)
    }
    console.log(`[scan] walking ${opts.projectPath}…`)
    const plan = await scan(opts.projectPath)
    await fs.writeFile(opts.planJson, JSON.stringify(plan, null, 2))
    await fs.writeFile(opts.planMd, renderMarkdown(plan))
    console.log(`[scan] wrote ${opts.planJson}`)
    console.log(`[scan] wrote ${opts.planMd}`)
    console.log(`[scan] totals:`, plan.totals)
    return
  }
  if (opts.mode === 'apply') {
    await apply(opts.planJson, opts.log)
    return
  }
  if (opts.mode === 'undo') {
    await undo(opts.log)
    return
  }
}

main().catch(e => {
  console.error('fatal:', e)
  process.exit(1)
})
