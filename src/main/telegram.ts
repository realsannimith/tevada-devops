/**
 * Minimal Telegram Bot API client — runs only in the main process. The bot
 * token is passed in by the caller (loaded from the encrypted secret store) and
 * never crosses IPC to the renderer.
 *
 * Only three endpoints are needed for alerting:
 *  - getMe:      validate a token and learn the bot's @username.
 *  - getUpdates: discover the chat_id (the user messages the bot once, we read it).
 *  - sendMessage: deliver an alert to a chat.
 *
 * Messages use HTML parse mode (simpler and safer to escape than MarkdownV2 —
 * only &, <, > need escaping). Shape mirrors Uptime Kuma / Gatus: a single POST
 * to https://api.telegram.org/bot<token>/sendMessage.
 */
const API_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 15_000;

/** Escape the three characters that are special in Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function call(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json: { ok: boolean; result?: unknown; description?: string } | null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!json || !json.ok) {
      throw new Error(json?.description || `Telegram API error (HTTP ${res.status}).`);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export type BotIdentity = { username?: string; name?: string };

/** Validate a token. Throws with a friendly message if it's rejected. */
export async function getMe(token: string): Promise<BotIdentity> {
  const result = (await call(token, 'getMe')) as {
    username?: string;
    first_name?: string;
  };
  return { username: result.username, name: result.first_name };
}

export type DetectedChat = { id: string; title: string };

/**
 * Read recent updates to discover which chats have messaged the bot. Used so the
 * user doesn't have to hunt for their numeric chat_id — they just send the bot a
 * message and we surface the chat here.
 */
export async function getUpdates(token: string): Promise<DetectedChat[]> {
  const result = (await call(token, 'getUpdates', { timeout: 0 })) as Array<{
    message?: { chat?: TelegramChat };
    channel_post?: { chat?: TelegramChat };
    my_chat_member?: { chat?: TelegramChat };
  }>;
  const byId = new Map<string, string>();
  for (const update of result) {
    const chat =
      update.message?.chat ??
      update.channel_post?.chat ??
      update.my_chat_member?.chat;
    if (chat && chat.id != null) {
      byId.set(String(chat.id), describeChat(chat));
    }
  }
  return [...byId.entries()].map(([id, title]) => ({ id, title }));
}

type TelegramChat = {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

function describeChat(chat: TelegramChat): string {
  const name =
    chat.title ??
    [chat.first_name, chat.last_name].filter(Boolean).join(' ') ??
    chat.username;
  const who = name || `Chat ${chat.id}`;
  return chat.username ? `${who} (@${chat.username})` : who;
}

/** Send a message (HTML parse mode). Link previews are disabled for tidy alerts. */
export async function sendMessage(
  token: string,
  chatId: string,
  html: string,
  opts: { silent?: boolean } = {},
): Promise<void> {
  await call(token, 'sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: opts.silent ?? false,
  });
}
