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
    text: text.slice(0, 4096),
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
  const text = `<b>Story Studio KH</b>\nNotifications connected. ${new Date().toLocaleString()}`
  return sendTelegramMessage(botToken, chatId, text, { parseMode: 'HTML' })
}
