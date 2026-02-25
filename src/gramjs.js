import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { getSetting, getChannelUsernames, upsertPost } from "./db.js";
import { v4 as uuidv4 } from "uuid";

const apiId = parseInt(process.env.TG_API_ID, 10);
const apiHash = process.env.TG_API_HASH;

function createClient() {
  const saved = getSetting("gramjs_session") || "";
  const session = new StringSession(saved);
  return new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5
  });
}

/**
 * Собирает посты из всех каналов за последние 24 часа и сохраняет в БД.
 * @returns {{ collected: number, errors: string[] }}
 */
export async function collectChannelPosts() {
  const channelUsernames = getChannelUsernames();
  if (channelUsernames.length === 0) {
    return { collected: 0, errors: [] };
  }

  const client = createClient();
  const errors = [];
  let collected = 0;

  try {
    await client.connect();
  } catch (e) {
    errors.push(`GramJS connect: ${e.message}`);
    return { collected: 0, errors };
  }

  const sinceTs = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

  for (const username of channelUsernames) {
    try {
      const channelName = username.startsWith("@") ? username : `@${username}`;
      const count = await collectFromChannel(client, channelName, sinceTs);
      collected += count;
    } catch (e) {
      errors.push(`${username}: ${e.message}`);
    }
  }

  try {
    await client.disconnect();
  } catch (_) {}

  return { collected, errors };
}

async function collectFromChannel(client, channelName, sinceTs) {
  let count = 0;
  const nowTs = Math.floor(Date.now() / 1000);

  for await (const message of client.iterMessages(channelName, {
    offsetDate: nowTs,
    limit: 500
  })) {
    if (message.date < sinceTs) break;
    if (!message.id || (!message.text && !message.message)) continue;

    const text = message.text || message.message || "";
    const views = message.views || 0;
    const date = new Date(message.date * 1000).toISOString();
    const channel = channelName.replace(/^@/, "").toLowerCase();
    const link = `https://t.me/${channel}/${message.id}`;
    const id = uuidv4();

    upsertPost(id, channel, message.id, text, link, views, date);
    count++;
  }

  return count;
}

export default { collectChannelPosts, createClient };
