/**
 * Whether Story Studio puts emoji into the text it writes for him (v1.4.12).
 *
 * *"about the emojis. i think to make sure we don't generate emojis when we
 * don't have to. it's unprofessional"*
 *
 * ── Two layers, and why one is not enough ──
 *
 * 1. TELL THE MODEL. `noEmojiDirective()` goes into the prompts that write
 *    text he publishes. This is the layer that actually matters: a model asked
 *    plainly not to decorate mostly does not, and every emoji that is never
 *    generated is one that cannot be mis-handled downstream.
 *
 * 2. CLEAN THE OUTPUT. Models ignore instructions, so `applyEmojiPolicy()` is
 *    the net under the wire. It is deliberately the SECOND layer: stripping
 *    alone teaches the model nothing and fights it on every single generation.
 *
 * ── The rule that protects his own writing ──
 *
 * Only MODEL-GENERATED text is cleaned. If his script, his title, his standards
 * file or his prompt carries an emoji, he has made a decision about this piece
 * of work and it stands — pass those strings as `sources` and the generated
 * text is left exactly as the model wrote it. For a field that MIXES his prose
 * with a generated block (a YouTube description with managed chapter and source
 * sections spliced into paragraphs he edited), clean the BLOCK before it is
 * spliced. Never the assembled result: by then the two are indistinguishable.
 *
 * ── Not in scope: the app talking to him ──
 *
 * Story Studio's own interface keeps its emoji. `🗑️ Hidden channels`,
 * `📦 Move this project`, the `✅` on a finished folder — that is the app
 * speaking to its user, not content going out under his name, and he did not
 * ask for it. This module is only ever applied to generated OUTPUT.
 *
 * ── A setting, not a constant ──
 *
 * His standing rule: *"i want something that can be selected, update, change by
 * myself later on. not hardcoded."* One app-level switch, defaulting to no
 * emoji because that is what he asked for. Deliberately NOT per-surface — he
 * asked for a policy, not a control panel.
 */

import { getAppSetting } from '../services/app-settings.js'
import { stripEmojiFromGenerated } from './well-formed-text.js'

/**
 * App setting key. Absent (the default, and every existing install) means NO
 * emoji, so this takes effect without him having to go and turn it on.
 */
export const EMOJI_SETTING_KEY = 'allow_emoji_in_generated_text'

/** The instruction added to a prompt that writes text he publishes. */
export const NO_EMOJI_DIRECTIVE
  = 'Do not use emoji, emoticons, or decorative symbols anywhere in your output. '
  + 'Plain text only. The one exception: if the source material you were given '
  + 'already contains an emoji, you may keep that one where it belongs.'

/** True when he has turned emoji back on. Defaults to false. */
export async function emojiAllowed(): Promise<boolean> {
  try {
    return await getAppSetting(EMOJI_SETTING_KEY) === true
  } catch {
    // An unreadable settings file must not silently re-enable something he
    // switched off. The stated default is the safe answer either way.
    return false
  }
}

/**
 * The instruction to splice into a prompt, with leading separation — or an
 * empty string when emoji are allowed, so callers can wire it in
 * unconditionally exactly as `imagePromptGuidanceBlock()` is wired in.
 */
export async function noEmojiDirective(): Promise<string> {
  return await emojiAllowed() ? '' : `\n${NO_EMOJI_DIRECTIVE}`
}

/**
 * Clean one piece of MODEL-GENERATED text, honouring the setting and his own
 * emoji.
 *
 * `sources` is every scrap of HIS text that fed this generation — the script,
 * the title he typed, the topic line, the style instructions. One emoji in any
 * of them and `generated` comes back untouched.
 */
export async function applyEmojiPolicy(
  generated: string,
  sources: Array<string | null | undefined> = [],
): Promise<string> {
  if (!generated || await emojiAllowed()) return generated
  return stripEmojiFromGenerated(generated, sources)
}

/** `applyEmojiPolicy` for a list — tags, title options, cue labels. */
export async function applyEmojiPolicyToAll(
  generated: string[],
  sources: Array<string | null | undefined> = [],
): Promise<string[]> {
  if (!generated.length || await emojiAllowed()) return generated
  return generated.map(value => stripEmojiFromGenerated(value, sources))
}
