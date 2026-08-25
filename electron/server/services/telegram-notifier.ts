/**
 * Telegram bot channel for app notifications (v1.0.60+).
 *
 * The user creates a bot via @BotFather, pastes the bot_token + their
 * own chat_id into App Settings, and the app POSTs to Telegram's HTTP
 * Bot API on every job-completion event the desktop channel would
 * have surfaced. No SDK — Telegram's API is a single
 * `https://api.telegram.org/bot{token}/sendMessage` call.
 *
 * Errors here are logged but never rethrown into the main process —
 * a flaky network or revoked token must not crash the Electron app
 * or block desktop notifications.
 */

import type { NotificationPayload } from './job-notifier.js'
import { truncateChars } from '../lib/well-formed-text.js'

export interface TelegramSendResult {
  ok: boolean
  /** HTTP status from the Telegram API call (e.g. 200, 400, 401). */
  status: number
  /** Telegram's `description` field on error, or our own message. */
  error?: string
}

/**
 * POST a single message to Telegram. Bot tokens look like
 * `1234567890:AAA…BBB`; chat ids are numeric (your own user id) or
 * `@channelname` for channels the bot owns.
 *
 * Telegram rejects empty / overlong text, so we trim + cap at 4 096
 * chars (the API's hard limit). HTML parse mode lets us bold the
 * title cheaply without escape hassles — values that contain `<` or
 * `&` are escaped before assembly.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  opts: { parseMode?: 'HTML' | 'MarkdownV2' | 'none'; signal?: AbortSignal } = {},
): Promise<TelegramSendResult> {
  const token = (botToken || '').trim()
  const chat = (chatId || '').trim()
  if (!token) return { ok: false, status: 0, error: 'Bot token is empty' }
  if (!chat) return { ok: false, status: 0, error: 'Chat id is empty' }

  const body: Record<string, unknown> = {
    chat_id: chat,
    text: truncateChars(text, 4096),
    disable_web_page_preview: true,
  }
  if (opts.parseMode && opts.parseMode !== 'none') body.parse_mode = opts.parseMode

  try {
    const r = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      },
    )
    const status = r.status
    let detail: string | undefined
    try {
      const json = await r.json() as { ok?: boolean; description?: string }
      if (!r.ok || !json.ok) detail = json.description || r.statusText
    } catch { /* non-JSON response */ }
    if (!r.ok) return { ok: false, status, error: detail || `HTTP ${status}` }
    return { ok: true, status }
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) }
  }
}

/**
 * Convert a NotificationPayload (from job-notifier's formatters) into
 * the HTML-formatted text Telegram renders. The title is bold, then
 * a newline, then the body. Any user-provided string that could
 * contain HTML special chars is escaped first.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function formatTelegramText(payload: NotificationPayload): string {
  const title = escapeHtml(payload.title || '')
  const body = escapeHtml(payload.body || '')
  return `<b>${title}</b>\n${body}`.trim()
}

/**
 * Convenience: send a "test" message so the user can verify the bot
 * token + chat id are correct from the Settings page. Used by the
 * `/app-settings/notifications/telegram-test` route.
 */
export async function sendTelegramTestMessage(
  botToken: string,
  chatId: string,
): Promise<TelegramSendResult> {
  const text = `<b>Story Studio KH</b>\nTelegram alerts are connected. Test sent ${new Date().toLocaleString()}.`
  return sendTelegramMessage(botToken, chatId, text, { parseMode: 'HTML' })
}

export interface TelegramDetectResult {
  ok: boolean
  /** Most recent chat that messaged the bot, when at least one message exists. */
  chat_id?: string
  /** Display name we can show in the UI ("@username" or "First Last"). */
  chat_label?: string
  /** Total updates Telegram returned — useful when the user has multiple
   *  chats and we only auto-fill the latest. */
  total_updates?: number
  error?: string
}

/**
 * Read pending bot updates and return the most recent chat that
 * messaged the bot. Skips the user's "open the URL and read JSON"
 * step from the manual setup walkthrough.
 *
 * Caveat: Telegram's `getUpdates` returns at most 100 updates and
 * each lives ~24 h in their queue. If the user opened the bot weeks
 * ago and never messaged it again, this will come back empty — UI
 * tells them to send /start and click again.
 *
 * Note: getUpdates conflicts with webhooks. We don't set webhooks,
 * so this is safe in our deployment.
 */
export async function detectTelegramChatId(
  botToken: string,
  opts: { signal?: AbortSignal } = {},
): Promise<TelegramDetectResult> {
  const token = (botToken || '').trim()
  if (!token) return { ok: false, error: 'Bot token is empty' }
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`,
      { method: 'GET', signal: opts.signal },
    )
    type Update = {
      message?: { chat?: { id?: number; username?: string; first_name?: string; last_name?: string; type?: string } }
      edited_message?: { chat?: { id?: number; username?: string; first_name?: string; last_name?: string; type?: string } }
    }
    type GetUpdatesResp = { ok?: boolean; description?: string; result?: Update[] }
    let json: GetUpdatesResp = {}
    try { json = await r.json() as GetUpdatesResp } catch { /* non-JSON */ }
    if (!r.ok || !json.ok) {
      return { ok: false, error: json.description || `HTTP ${r.status}` }
    }
    const updates = Array.isArray(json.result) ? json.result : []
    // Pick the LATEST chat (last entry — Telegram returns oldest-first).
    let chat: { id?: number; username?: string; first_name?: string; last_name?: string } | null = null
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i]!
      const c = u.message?.chat || u.edited_message?.chat
      if (c?.id != null) { chat = c; break }
    }
    if (!chat || chat.id == null) {
      return {
        ok: true,
        total_updates: updates.length,
        error: updates.length === 0
          ? 'No messages found yet. Open Telegram, find your bot by username, and send /start — then click Detect again.'
          : 'Updates returned but no chat id resolved.',
      }
    }
    const label = chat.username
      ? `@${chat.username}`
      : [chat.first_name, chat.last_name].filter(Boolean).join(' ') || `chat ${chat.id}`
    return { ok: true, chat_id: String(chat.id), chat_label: label, total_updates: updates.length }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
