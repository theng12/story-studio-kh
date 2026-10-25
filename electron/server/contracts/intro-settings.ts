/** Editable suggestions, not model limits. Legacy recipes remain the source of truth. */
export type IntroTone = 'friendly' | 'curious' | 'documentary' | 'calm'
export type IntroLength = 'short' | 'standard' | 'extended'
export type IntroBeat = { id: string; label: string; enabled: boolean; custom_text?: string; choice?: string }
export const INTRO_LENGTHS = { short: 100, standard: 160, extended: 300 } as const
export const INTRO_STYLES = [
  { id: 'welcome', label: 'Welcome & story overview', hint: 'Greet listeners, introduce the subject, then begin the story.', sections: ['welcome', 'story_teaser', 'subscribe_cta', 'community_question', 'transition'], tone: 'friendly' },
  { id: 'question', label: 'Question first', hint: 'Open with a question, introduce the channel, then begin.', sections: ['story_teaser', 'welcome', 'transition'], tone: 'curious' },
  { id: 'moment', label: 'Start with a story moment', hint: 'Begin inside an episode scene, then explain what it explores.', sections: ['story_teaser', 'transition'], tone: 'documentary' },
  { id: 'bedtime', label: 'Calm bedtime opening', hint: 'A gentle greeting and settling invitation for a sleep channel.', sections: ['welcome', 'relaxation', 'story_teaser', 'transition'], tone: 'calm' },
] as const

type Option = { id: string; label: string; hint: string; instruction: string; en: string; km: string }
const option = (id: string, label: string, hint: string, instruction: string, en: string, km: string): Option => ({ id, label, hint, instruction, en, km })
export const INTRO_SECTIONS: Record<string, { label: string; options: Option[] }> = {
  welcome: { label: 'Welcome', options: [
    option('channel', 'Channel name', 'Greet listeners using the real channel name.', 'Welcome listeners to the channel using its real name. Do not invent a host name.', 'Welcome to {channel}.', 'សូមស្វាគមន៍មកកាន់ឆានែល{channel}។'),
    option('host', 'Host and channel', 'Use the host name entered in More settings.', 'Welcome listeners with the supplied host and channel names; omit any name that is not supplied.', 'Welcome to {channel}. Let’s begin.', 'សូមស្វាគមន៍មកកាន់ឆានែល{channel}។ យើងចាប់ផ្តើមទាំងអស់គ្នា។'),
    option('custom', 'Custom greeting', 'Keep your exact opening line from More settings.', 'Use the supplied custom opening line exactly; do not invent a host.', 'Welcome. I’m glad you’re here.', 'សូមស្វាគមន៍។ រីករាយដែលអ្នកបានមកចូលរួម។'),
  ] },
  story_teaser: { label: 'Story overview', options: [
    option('teaser', 'One-sentence teaser', 'Hint at the subject without giving away the ending.', 'Give a one-sentence teaser based only on this episode’s chapters, without spoilers.', 'Today, we explore how a change reshaped everyday life.', 'ថ្ងៃនេះ យើងស្វែងយល់ពីការផ្លាស់ប្តូរដែលបានប្តូរជីវិតប្រចាំថ្ងៃ។'),
    option('explain', 'Brief explanation', 'Explain what the episode explores.', 'Briefly explain what this episode explores, using only its actual chapters and no spoilers.', 'We’ll follow the choices people faced and what changed around them.', 'យើងនឹងស្វែងយល់ពីជម្រើសរបស់មនុស្ស និងការផ្លាស់ប្តូរជុំវិញពួកគេ។'),
    option('question', 'Question-led hook', 'Start with a question grounded in the episode.', 'Open with an intriguing question grounded only in this episode’s chapters; do not invent facts.', 'What would you have chosen in their place?', 'បើអ្នកនៅក្នុងស្ថានភាពនោះ តើអ្នកនឹងជ្រើសរើសអ្វី?'),
    option('moment', 'Story moment', 'Open inside a scene the chapters actually describe.', 'Open with a scene or event from this episode’s actual chapters, then introduce what it explores. Do not invent details or spoil the ending.', 'A decision is about to change an ordinary day.', 'ការសម្រេចចិត្តមួយកំពុងនឹងផ្លាស់ប្តូរថ្ងៃធម្មតាមួយ។'),
  ] },
  subscribe_cta: { label: 'Viewer invitation', options: [
    option('subscribe', 'Subscribe', 'A brief invitation to follow the channel.', 'Briefly invite viewers to subscribe; no invented links or memberships.', 'Follow {channel} for more stories.', 'សូមចុចតាមដានឆានែល{channel} ដើម្បីស្តាប់រឿងរ៉ាវបន្ថែម។'),
    option('like', 'Subscribe and like', 'Keep the invitation to one short sentence.', 'Briefly invite viewers to subscribe and like, in one short sentence; no invented links.', 'If you enjoy these stories, like and follow {channel}.', 'បើអ្នកចូលចិត្តរឿងរ៉ាវប្រវត្តិសាស្ត្រ សូមចុចតាមដានឆានែល{channel}។'),
    option('share', 'Share', 'Invite listeners to pass the story along.', 'Briefly invite viewers to share this episode; no invented links.', 'Share this story with someone who might enjoy it.', 'សូមចែករំលែករឿងនេះទៅអ្នកដែលអាចចូលចិត្តស្តាប់។'),
    option('custom', 'Custom invitation', 'Write your own invitation below.', 'Follow the custom invitation supplied below. Do not invent links, sponsors or memberships.', 'Thank you for listening with us.', 'អរគុណដែលបានស្តាប់ជាមួយយើង។'),
  ] },
  community_question: { label: 'Community question', options: [
    option('opinion', 'Opinion', 'Ask one question about the episode’s subject.', 'Ask one opinion question grounded in this episode’s chapters, without spoilers.', 'Which choice makes the most sense to you?', 'តើជម្រើសមួយណាដែលអ្នកយល់ថាសមហេតុផលជាងគេ?'),
    option('imagine', 'Imagine yourself there', 'Invite listeners to consider an episode-specific choice.', 'Ask one imagine-yourself-there question grounded in this episode’s actual chapters, without spoilers.', 'If you lived then, would you farm or keep gathering food?', 'បើអ្នករស់នៅសម័យនោះ តើអ្នកនឹងជ្រើសរើសដាំដុះ ឬបន្តស្វែងរកអាហារតាមធម្មជាតិ?'),
    option('experience', 'Personal experience', 'Invite a relevant experience from the audience.', 'Ask one question inviting a personal experience relevant to this episode’s chapters.', 'Have you ever faced a similar choice?', 'តើអ្នកធ្លាប់ប្រឈមមុខនឹងជម្រើសស្រដៀងគ្នានេះទេ?'),
    option('custom', 'Custom question', 'Give your own question instructions below.', 'Follow the custom question instructions below; stay grounded in this episode’s chapters.', 'What would you like to discuss about this story?', 'តើអ្នកចង់ពិភាក្សាអ្វីអំពីរឿងនេះ?'),
  ] },
  transition: { label: 'Transition', options: [
    option('direct', 'Direct', 'Move straight into chapter one.', 'Transition directly into the story.', 'Now, let’s explore this story together.', 'ឥឡូវនេះ យើងចាប់ផ្តើមស្វែងយល់រឿងនេះទាំងអស់គ្នា។'),
    option('curious', 'Curious and inviting', 'Invite listeners to discover what comes next.', 'Use a curious, inviting transition into the story.', 'Let’s discover where this story begins.', 'យើងមកស្វែងយល់ថារឿងនេះចាប់ផ្តើមពីណា។'),
    option('calm', 'Calm', 'Ease gently into the story.', 'Use a calm transition into the story.', 'Settle in, and let the story begin.', 'សូមសម្រាកឱ្យស្រួល ហើយចាប់ផ្តើមស្តាប់រឿងនេះ។'),
    option('custom', 'Custom transition', 'Write your own transition instructions below.', 'Follow the supplied transition instructions.', 'Let’s begin.', 'យើងចាប់ផ្តើមទាំងអស់គ្នា។'),
  ] },
  relaxation: { label: 'Settling invitation', options: [
    option('calm', 'Gentle settling invitation', 'For deliberately chosen sleep openings only.', 'Gently invite listeners to settle in for a bedtime story.', 'Find a comfortable place and settle in.', 'សូមរកកន្លែងដែលមានផាសុកភាព ហើយសម្រាកឱ្យស្រួល។'),
  ] },
}
export function introOption(beat: IntroBeat): Option | undefined {
  return INTRO_SECTIONS[beat.id]?.options.find(o => o.id === beat.choice)
}
export type IntroSampleSource = '' | 'opening' | 'custom' | 'choice'
/**
 * The sample wording for one section, and whose words those are.
 *
 * ONE function answers both, because a separate "where did that come from?"
 * reader is free to disagree with the chooser the first time either gains a
 * step — and a label that disagrees with the sentence under it is worse than
 * no label.
 *
 * A section carrying the owner's own wording but no option picked shows THOSE
 * words, marked as his, rather than the catalogue's first option, which is a
 * different sentence from the one that would be generated. A section with
 * neither shows nothing at all, so the purpose hint stands alone instead of an
 * invented line presented as an example.
 */
export function introSampleFor(
  beat: IntroBeat,
  language: string,
  channel: string,
  opening = '',
): { text: string; source: IntroSampleSource } {
  if (beat.id === 'welcome' && opening.trim()) return { text: opening, source: 'opening' }
  const custom = (beat.custom_text || '').trim()
  if (!beat.choice) return custom ? { text: custom, source: 'custom' } : { text: '', source: '' }
  const sample = introOption(beat)
  if (!sample) return { text: '', source: '' }
  const lang = language.toLowerCase().split(/[-_]/)[0]
  if (!['km', 'khmer', 'en', 'english'].includes(lang)) return { text: '', source: '' }
  const text = (lang === 'km' || lang === 'khmer' ? sample.km : sample.en)
    .replaceAll('{channel}', channel || (lang === 'km' || lang === 'khmer' ? '[ឈ្មោះឆានែល]' : '[channel name]'))
  return { text, source: 'choice' }
}
export function introSample(beat: IntroBeat, language: string, channel: string, opening = ''): string {
  return introSampleFor(beat, language, channel, opening).text
}
export function introStyleBeats(id: string): IntroBeat[] {
  const style = INTRO_STYLES.find(s => s.id === id)
  return (style?.sections || []).map(section => ({ id: section, label: INTRO_SECTIONS[section]!.label, enabled: true,
    choice: section === 'story_teaser' ? (id === 'question' ? 'question' : id === 'moment' ? 'moment' : 'explain')
      : section === 'subscribe_cta' ? 'like' : section === 'community_question' ? 'imagine' : INTRO_SECTIONS[section]!.options[0]!.id }))
}
/** Adapter stays on the existing beats seam; absent choices produce the legacy text exactly. */
export function introPromptLines(recipe: { beats: IntroBeat[]; tone?: IntroTone }): string[] {
  const lines = recipe.beats.filter(b => b.enabled).map(beat => {
    const extra = (beat.custom_text || '').trim()
    const instruction = introOption(beat)?.instruction
    return `${beat.label}${instruction ? ` — ${instruction}` : ''}${extra ? ` — specifically cover: ${extra}` : ''}`
  })
  if (recipe.tone) lines.push(`Use a ${recipe.tone} tone throughout the opening.`)
  return lines
}
