/**
 * Every setting the owner can change, and the section that holds it.
 *
 * v1.4.249 — "the way settings are is a bit messy. it's hard to understand or
 * navigate." The old search only matched SECTION names, so typing "telegram"
 * or "time zone" found nothing useful. Search now matches individual settings
 * and jumps to the exact control (`[data-setting="<anchor>"]` on the page).
 */
export interface SettingsSectionDef {
  id: string
  label: string
  description: string
}
export interface SettingsZoneDef {
  id: 'machine' | 'project'
  title: string
  scope: string
  sections: SettingsSectionDef[]
}
export interface SettingEntry {
  anchor: string
  section: string
  label: string
  keywords: string
}

export const SETTINGS_ZONES: SettingsZoneDef[] = [
  {
    id: 'machine',
    title: 'This Mac',
    scope: 'Every channel on this Mac',
    sections: [
      { id: 'connections', label: 'Connections', description: 'Gateway, YouTube, Facebook, Instagram and TikTok accounts' },
      { id: 'default-models', label: 'Default models', description: 'The model each kind of work uses when nothing else picks one' },
      { id: 'performance', label: 'Performance & recovery', description: 'How much runs at once, paid replacements' },
      { id: 'appearance', label: 'Appearance & notifications', description: 'Light or dark, alerts, daily brief' },
      { id: 'maintenance', label: 'Files & maintenance', description: 'Where your files are, free up space, FFmpeg' },
      { id: 'backup', label: 'Backup & restore', description: 'Back up to a drive, restore on a new Mac' },
    ],
  },
  {
    id: 'project',
    title: 'This Channel',
    scope: 'Travels with this channel',
    sections: [
      { id: 'identity', label: 'Channel identity', description: 'Name, Series Formula and Topic Packs' },
      { id: 'production', label: 'Production defaults', description: 'Continuity, episode shape, narration checks' },
      { id: 'writing', label: 'Writing & style', description: 'Art style and writing instructions' },
      { id: 'publishing', label: 'Publishing', description: 'Upload schedule, YouTube channel, social platforms, category' },
      { id: 'files', label: 'Project files & behavior', description: 'Numbering, storage, confirmations' },
      { id: 'safety', label: 'Safety checks', description: 'Off, Warn or Block for every check that can stop an episode' },
    ],
  },
]

export const SETTINGS_INDEX: SettingEntry[] = [
  { section: 'connections', anchor: 'gateway', label: 'Gateway address and key', keywords: 'gateway gatewaykh url key api connection connect test genstudio' },
  { section: 'connections', anchor: 'youtube-accounts', label: 'YouTube accounts', keywords: 'youtube google oauth connect account channel sign in' },
  { section: 'connections', anchor: 'social-accounts', label: 'Facebook, Instagram and TikTok accounts', keywords: 'facebook instagram tiktok meta reels social posting oauth connect account page professional' },
  { section: 'connections', anchor: 'gateway-catalog', label: 'Gateway model catalog', keywords: 'models catalog chat music available refresh' },
  { section: 'default-models', anchor: 'default-models', label: 'Default models', keywords: 'default model writing image video voice audio tts transcription subtitles music fallback last used choose' },
  { section: 'connections', anchor: 'scene-analysis', label: 'Scene analysis models', keywords: 'scene analysis depth vision florence subject outline sky water 3d photo rack focus models' },

  { section: 'performance', anchor: 'throughput', label: 'How much runs at once', keywords: 'concurrency throughput parallel jobs at once writing images thumbnails transcribing subtitles episodes speed' },
  { section: 'performance', anchor: 'throughput', label: 'Writing request time limit', keywords: 'timeout time limit minutes writing request tokens per second slow speed warning outline chapters headroom' },
  // v1.4.365 — optional, in-app duplicate screening (owner 2026-10-27). Listed
  // under This Mac because the model is installed once per Mac, next to the
  // performance knobs it sits with on the page.
  { section: 'performance', anchor: 'duplicate-screening', label: 'Duplicate screening (optional)', keywords: 'duplicate near duplicate screening embeddings model scene title local offline optional download' },
  { section: 'performance', anchor: 'paid-replacement', label: 'Paid replacements after a failure', keywords: 'failed failure retry replacement buy credits limit ceiling image subtitle audio writing recovery automatic' },

  { section: 'appearance', anchor: 'theme', label: 'Light or dark mode', keywords: 'theme dark light system appearance colour color' },
  { section: 'appearance', anchor: 'notifications', label: 'Desktop alerts', keywords: 'notifications alerts desktop job failed long job pipeline finished threshold' },
  { section: 'appearance', anchor: 'telegram', label: 'Telegram alerts', keywords: 'telegram phone bot chat notifications' },
  { section: 'appearance', anchor: 'daily-brief', label: 'Daily production brief', keywords: 'daily brief digest summary morning schedule email' },
  { section: 'appearance', anchor: 'emoji', label: 'Emoji in generated text', keywords: 'emoji house style titles descriptions' },
  { section: 'appearance', anchor: 'server-mode', label: 'Open from another computer (Server Mode)', keywords: 'server mode remote access network password port tailscale' },

  { section: 'maintenance', anchor: 'library-folder', label: 'Library folder', keywords: 'library folder location where files projects channels move drive storage' },
  { section: 'maintenance', anchor: 'self-contained-all', label: 'Make all channels self-contained', keywords: 'self-contained move channel another mac copy assets shared project assets exports portable migrate' },
  { section: 'maintenance', anchor: 'exports-folder', label: 'Finished videos folder', keywords: 'finished videos exports export folder renders final mp4 where location' },
  { section: 'maintenance', anchor: 'free-up-space', label: 'Free up space', keywords: 'free up space cleanup disk storage trash shrink images clean up all channels leftover files uploaded videos' },
  { section: 'maintenance', anchor: 'move-uploaded', label: 'Move uploaded videos to another drive', keywords: 'archive move uploaded videos drive disk space external' },
  { section: 'files', anchor: 'episode-storage', label: "What's using space", keywords: 'storage disk usage space used episode scan preview cache' },
  { section: 'maintenance', anchor: 'smaller-files', label: 'Smaller files (compression)', keywords: 'compression compress smaller files aac jpeg png music narration images thumbnails' },
  { section: 'maintenance', anchor: 'ffmpeg', label: 'FFmpeg video engine', keywords: 'ffmpeg video engine assembly subtitles burn drawtext libass install' },
  { section: 'maintenance', anchor: 'about', label: 'Version and build', keywords: 'about version build copy report bug' },

  { section: 'backup', anchor: 'backup-folder', label: 'Backup folder', keywords: 'backup back up drive ssd external copy safe folder' },
  { section: 'backup', anchor: 'backup-extras', label: 'What the backup includes', keywords: 'backup include finished videos narration audio thumbnails size' },
  { section: 'backup', anchor: 'backup-auto', label: 'Automatic backup', keywords: 'automatic backup daily schedule plugged in drive' },
  { section: 'backup', anchor: 'backup-versions', label: 'Older copies on the backup drive', keywords: 'versions older copies prune delete backup space' },
  { section: 'backup', anchor: 'backup-restore', label: 'Restore from a backup', keywords: 'restore backup new mac machine move migrate recover' },

  { section: 'identity', anchor: 'project-name', label: 'Channel name, handle and logo', keywords: 'name rename channel project title handle logo banner avatar profile picture description' },
  { section: 'identity', anchor: 'formula', label: 'Series Formula and Topic Packs', keywords: 'formula niche series topics topic packs identity' },
  { section: 'identity', anchor: 'custom-formulas', label: 'Custom formulas', keywords: 'custom formula niche create delete' },
  { section: 'identity', anchor: 'idea-quality', label: 'Idea supply and repeat checks', keywords: 'ideas supply running low unused subjects covered topics map duplicate repeat meaning embeddings haiku helper alerts telegram' },

  { section: 'production', anchor: 'continuity', label: 'Reference behavior (continuity)', keywords: 'continuity character reference scenes independent explainer' },
  { section: 'production', anchor: 'episode-shape', label: 'Episode length, chapters and reading pace', keywords: 'length minutes chapters words per minute pace episode shape runtime title voice' },
  { section: 'production', anchor: 'guide-density', label: 'Recurring guide visibility', keywords: 'guide density recurring character scene plan' },
  { section: 'production', anchor: 'audio-quality', label: 'Narration quality checks', keywords: 'audio quality narration check repair transcript' },

  { section: 'writing', anchor: 'art-style', label: 'Art style', keywords: 'art style visual style images look' },
  { section: 'writing', anchor: 'writing-instructions', label: 'Writing instructions', keywords: 'writing instructions standards intro rules presets prompt' },
  { section: 'writing', anchor: 'style-library', label: 'Custom art styles', keywords: 'style library custom styles create' },

  { section: 'publishing', anchor: 'upload-schedule', label: 'Upload schedule', keywords: 'upload plan schedule cadence publishing days time zone timezone weekly when publish' },
  { section: 'publishing', anchor: 'youtube-channel', label: 'YouTube channel for this project', keywords: 'youtube channel assign account' },
  { section: 'publishing', anchor: 'social-platforms', label: 'Where this channel posts', keywords: 'facebook instagram tiktok reels social post crosspost platforms opt in' },
  { section: 'publishing', anchor: 'publishing-profile', label: 'Publishing profile (links, credits, disclosures)', keywords: 'publishing profile description links credits cta disclosure tags metadata template' },
  { section: 'publishing', anchor: 'category', label: 'YouTube category', keywords: 'youtube category entertainment' },
  { section: 'publishing', anchor: 'ai-disclosure', label: 'AI content disclosure', keywords: 'ai synthetic altered content disclosure label' },

  { section: 'safety', anchor: 'safety-checks', label: 'Safety checks (Off / Warn / Block)', keywords: 'safety checks guard guards block warn off stop stopped loudness lufs allowance silent audio upload private overlap stale caption gap preflight strict lenient' },
  { section: 'files', anchor: 'self-contained', label: 'Make this channel self-contained', keywords: 'self-contained move channel another mac copy assets logo intro music overlays exports portable' },
  { section: 'files', anchor: 'numbering', label: 'Episode prefix and groups', keywords: 'episode prefix code season group batch numbering' },
  { section: 'files', anchor: 'project-location', label: 'Project folder', keywords: 'project folder location finder open' },
  { section: 'files', anchor: 'project-smaller-files', label: 'Smaller files for this project', keywords: 'compression project override smaller files' },
  { section: 'files', anchor: 'confirmations', label: 'Confirmation prompts', keywords: 'confirm confirmation prompts ask dialog' },
  { section: 'files', anchor: 'folder-names', label: 'Episode folder names', keywords: 'folder names templates subfolders sync' },
  { section: 'files', anchor: 'hide-project', label: 'Hide project', keywords: 'hide remove delete project' },
  { section: 'files', anchor: 'recovery-data', label: 'Script recovery data', keywords: 'chunked progress sidecars recovery resume cleanup' },
]

const sectionLabel = (id: string) => SETTINGS_ZONES.flatMap(z => z.sections).find(s => s.id === id)?.label || id

/**
 * Settings matching what was typed. Every word must match the setting's
 * label, keywords, or its section's name; labels that start with the query
 * rank first.
 */
export function searchSettings(query: string): Array<SettingEntry & { sectionLabel: string }> {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: Array<{ entry: SettingEntry; score: number }> = []
  for (const entry of SETTINGS_INDEX) {
    const label = entry.label.toLocaleLowerCase()
    const haystack = `${label} ${entry.keywords} ${sectionLabel(entry.section).toLocaleLowerCase()}`
    if (!words.every(w => haystack.includes(w))) continue
    const q = words.join(' ')
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2
    scored.push({ entry, score })
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .map(({ entry }) => ({ ...entry, sectionLabel: sectionLabel(entry.section) }))
}
