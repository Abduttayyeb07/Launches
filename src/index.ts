import * as dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs';
import * as path from 'path';
import { startPoolMonitor, stopPoolMonitor, PoolInfo } from './poolMonitor';

// ─── Environment ─────────────────────────────────────────────────────────────

const RPC_WS = process.env['RPC_WS'];
const MDF_CONTRACT = process.env['MDF_CONTRACT'];
const MDF_TOKEN_API_BASE = process.env['MDF_TOKEN_API_BASE'] ?? '';
const LOG_LEVEL = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];

if (!RPC_WS) {
  console.error('[FATAL] RPC_WS environment variable is not set. Exiting.');
  process.exit(1);
}
if (!MDF_CONTRACT) {
  console.error('[FATAL] MDF_CONTRACT environment variable is not set. Exiting.');
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN) {
  console.error('[FATAL] TELEGRAM_BOT_TOKEN environment variable is not set. Exiting.');
  process.exit(1);
}

// ─── Logger ──────────────────────────────────────────────────────────────────

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
  if ((LEVELS[level] ?? 0) >= currentLevel) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  }
}

// ─── Subscriber Store ─────────────────────────────────────────────────────────

const DATA_DIR = process.env['DATA_DIR'] ?? '.';
const SUBSCRIBERS_FILE = path.resolve(DATA_DIR, 'subscribers.json');

function loadSubscribers(): Set<number> {
  try {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
      const raw = fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8');
      const arr = JSON.parse(raw) as number[];
      return new Set(arr);
    }
  } catch (err) {
    log('warn', `[STORE] Failed to load subscribers: ${String(err)}`);
  }
  return new Set();
}

function saveSubscribers(subs: Set<number>): void {
  try {
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...subs]), 'utf-8');
  } catch (err) {
    log('error', `[STORE] Failed to save subscribers: ${String(err)}`);
  }
}

const subscribers: Set<number> = loadSubscribers();
log('info', `[STORE] Loaded ${subscribers.size} subscriber(s) from disk`);

// ─── Telegram Bot ─────────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN as string, { polling: true });

const SUBSCRIBE_BTN = { text: '🔔 Subscribe to MDF Launches', callback_data: 'subscribe' };
const UNSUBSCRIBE_BTN = { text: '🔕 Unsubscribe', callback_data: 'unsubscribe' };

function getKeyboard(chatId: number): TelegramBot.InlineKeyboardMarkup {
  const isSubbed = subscribers.has(chatId);
  return {
    inline_keyboard: [[isSubbed ? UNSUBSCRIBE_BTN : SUBSCRIBE_BTN]],
  };
}

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name ?? 'there';
  const isSubbed = subscribers.has(chatId);

  bot
    .sendMessage(
      chatId,
      `👋 Hey ${firstName}!\n\n` +
        `I track *MemesDotFun (MDF)* launches and *Degenter new pools* in real-time.\n\n` +
        `${isSubbed ? '✅ You are currently *subscribed*.' : '📭 You are not subscribed yet.'}\n\n` +
        `Press the button below to ${isSubbed ? 'unsubscribe' : 'subscribe'}:`,
      {
        parse_mode: 'Markdown',
        reply_markup: getKeyboard(chatId),
      }
    )
    .catch((err: Error) => log('error', `[TG] Failed to send /start message: ${err.message}`));
});

// /status command
bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const isSubbed = subscribers.has(chatId);

  bot
    .sendMessage(
      chatId,
      isSubbed
        ? '✅ You are *subscribed* to MDF launch alerts.'
        : '📭 You are *not subscribed*. Press /start to subscribe.',
      {
        parse_mode: 'Markdown',
        reply_markup: getKeyboard(chatId),
      }
    )
    .catch((err: Error) => log('error', `[TG] Failed to send /status message: ${err.message}`));
});

// Inline button callbacks
bot.on('callback_query', (query) => {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;

  if (query.data === 'subscribe') {
    subscribers.add(chatId);
    saveSubscribers(subscribers);
    log('info', `[TG] New subscriber: chatId=${chatId} (total: ${subscribers.size})`);

    bot
      .answerCallbackQuery(query.id, { text: '✅ Subscribed! You will receive MDF launch alerts.' })
      .catch(() => undefined);

    bot
      .editMessageText(
        `✅ *Subscribed!*\n\nYou will now receive real-time MDF launch alerts.\n\nPress the button to unsubscribe anytime.`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: getKeyboard(chatId),
        }
      )
      .catch((err: Error) => log('error', `[TG] editMessageText error: ${err.message}`));
  } else if (query.data === 'unsubscribe') {
    subscribers.delete(chatId);
    saveSubscribers(subscribers);
    log('info', `[TG] Unsubscribed: chatId=${chatId} (total: ${subscribers.size})`);

    bot
      .answerCallbackQuery(query.id, { text: '🔕 Unsubscribed. You will no longer receive alerts.' })
      .catch(() => undefined);

    bot
      .editMessageText(
        `🔕 *Unsubscribed.*\n\nYou will no longer receive MDF launch alerts.\n\nPress the button to re-subscribe anytime.`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: getKeyboard(chatId),
        }
      )
      .catch((err: Error) => log('error', `[TG] editMessageText error: ${err.message}`));
  }
});

let pollingBackoffMs = 5_000;
let pollingBackoffTimer: ReturnType<typeof setTimeout> | null = null;

bot.on('polling_error', (err) => {
  const isDnsError =
    err.message.includes('ENOTFOUND') ||
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('EFATAL');

  if (isDnsError) {
    // Stop the default polling loop to prevent spam
    bot.stopPolling().catch(() => undefined);

    log('error', `[TG] Cannot reach api.telegram.org — network/DNS issue.`);
    log('warn', `[TG] Telegram may be blocked in your region. Try a VPN or proxy.`);
    log('warn', `[TG] Retrying Telegram connection in ${pollingBackoffMs / 1000}s...`);

    if (pollingBackoffTimer) clearTimeout(pollingBackoffTimer);
    pollingBackoffTimer = setTimeout(() => {
      if (!isShuttingDown) {
        log('info', '[TG] Attempting to restart polling...');
        bot.startPolling({ restart: true }).catch((e: Error) => {
          log('error', `[TG] Failed to restart polling: ${e.message}`);
        });
        // Exponential backoff, max 5 minutes
        pollingBackoffMs = Math.min(pollingBackoffMs * 2, 300_000);
      }
    }, pollingBackoffMs);
  } else {
    log('error', `[TG] Polling error: ${err.message}`);
  }
});

log('info', `[TG] Telegram bot started (polling)`);

// ─── Broadcast to Subscribers ─────────────────────────────────────────────────

async function broadcastLaunch(data: LaunchData): Promise<void> {
  if (subscribers.size === 0) {
    log('debug', '[TG] No subscribers to broadcast to');
    return;
  }

  const symbol = data.symbol ?? 'Unknown';
  const name = data.name ?? 'Unknown';
  const denom = data.denom ?? 'Unknown';
  const creator = data.creator ?? 'Unknown';
  const image = data.imageUri;

  const text =
    `🚀 *New MDF Launch!*\n\n` +
    `🪙 *Symbol:* \`${symbol}\`\n` +
    `📛 *Name:* ${name}\n` +
    `🔗 *Denom:* \`${denom}\`\n` +
    `👤 *Creator:* \`${creator}\`\n` +
    (image ? `🖼 *Image:* [View](${image})\n` : '') +
    `\n_Source: denom\\_metadata\\_updated_`;

  const sendPromises = [...subscribers].map(async (chatId) => {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      log('debug', `[TG] Sent launch alert to chatId=${chatId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // If user blocked the bot or chat not found, remove them
      if (msg.includes('bot was blocked') || msg.includes('chat not found') || msg.includes('user is deactivated')) {
        log('warn', `[TG] Removing unreachable subscriber chatId=${chatId}: ${msg}`);
        subscribers.delete(chatId);
        saveSubscribers(subscribers);
      } else {
        log('error', `[TG] Failed to send to chatId=${chatId}: ${msg}`);
      }
    }
  });

  await Promise.allSettled(sendPromises);
  log('info', `[TG] Broadcast complete to ${subscribers.size} subscriber(s)`);
}

// ─── Broadcast New Pools to Subscribers ────────────────────────────────────────

async function broadcastNewPools(pools: PoolInfo[]): Promise<void> {
  if (subscribers.size === 0) {
    log('debug', '[TG] No subscribers to broadcast pools to');
    return;
  }

  for (const pool of pools) {
    const text =
      `🏊 *New Degenter Pool!*\n\n` +
      `🪙 *Token:* \`${pool.tokenSymbol}\`\n` +
      `💱 *Pair:* ${pool.baseSymbol} / ${pool.quoteSymbol}\n` +
      `📄 *Contract:* \`${pool.pairContract}\`\n` +
      `📅 *Created:* ${pool.createdAt.slice(0, 10)}\n` +
      (pool.priceUsd != null ? `💰 *Price:* $${pool.priceUsd}\n` : '') +
      (pool.tvlUsd != null ? `🔒 *TVL:* $${pool.tvlUsd.toLocaleString()}\n` : '') +
      (pool.volumeUsd != null ? `📊 *Volume 24h:* $${pool.volumeUsd.toLocaleString()}\n` : '');

    const sendPromises = [...subscribers].map(async (chatId) => {
      try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('bot was blocked') || msg.includes('chat not found') || msg.includes('user is deactivated')) {
          log('warn', `[TG] Removing unreachable subscriber chatId=${chatId}: ${msg}`);
          subscribers.delete(chatId);
          saveSubscribers(subscribers);
        } else {
          log('error', `[TG] Failed to send pool alert to chatId=${chatId}: ${msg}`);
        }
      }
    });

    await Promise.allSettled(sendPromises);
  }

  log('info', `[TG] Pool broadcast: ${pools.length} pool(s) sent to ${subscribers.size} subscriber(s)`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface LaunchData {
  symbol: string | null;
  name: string | null;
  denom: string | null;
  creator: string | null;
  imageUri: string | null;
}

interface TendermintEventAttribute {
  key: string;
  value: string;
}

interface TendermintEvent {
  type: string;
  attributes: TendermintEventAttribute[] | Record<string, string>;
}

interface TendermintResult {
  events?: Record<string, string[]> | TendermintEvent[];
  data?: {
    value?: {
      TxResult?: {
        result?: {
          events?: TendermintEvent[];
        };
      };
    };
  };
}

interface RpcMessage {
  id?: number | string;
  result?: TendermintResult;
  error?: { code: number; message: string; data?: string };
}

// ─── Deduplication ───────────────────────────────────────────────────────────

const COOLDOWN_MS = 60_000;
const seenDenoms = new Map<string, number>();

function isDuplicate(denom: string): boolean {
  const lastSeen = seenDenoms.get(denom);
  const now = Date.now();
  if (lastSeen !== undefined && now - lastSeen < COOLDOWN_MS) {
    return true;
  }
  seenDenoms.set(denom, now);
  return false;
}

// ─── Safe Helpers ─────────────────────────────────────────────────────────────

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeStr(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─── Event Parsing ────────────────────────────────────────────────────────────

function extractDenomMetadataUpdated(result: TendermintResult): Record<string, string> | null {
  const events = result.events;
  if (!events) return null;

  // Shape 1: Dict style
  if (!Array.isArray(events)) {
    const dictEvents = events as Record<string, string[]>;
    const hasDmu = Object.keys(dictEvents).some((k) => k.startsWith('denom_metadata_updated'));
    if (!hasDmu) return null;

    const attrs: Record<string, string> = {};
    for (const [key, values] of Object.entries(dictEvents)) {
      if (key.startsWith('denom_metadata_updated.')) {
        const attrKey = key.replace('denom_metadata_updated.', '');
        attrs[attrKey] = Array.isArray(values) ? (values[0] ?? '') : String(values);
      }
    }
    return Object.keys(attrs).length > 0 ? attrs : null;
  }

  // Shape 2: List style
  const listEvents = events as TendermintEvent[];
  const dmuEvent = listEvents.find((e) => e.type === 'denom_metadata_updated');
  if (!dmuEvent) return null;

  const attrs: Record<string, string> = {};
  if (Array.isArray(dmuEvent.attributes)) {
    for (const attr of dmuEvent.attributes as TendermintEventAttribute[]) {
      if (attr.key && attr.value !== undefined) attrs[attr.key] = attr.value;
    }
  } else if (typeof dmuEvent.attributes === 'object' && dmuEvent.attributes !== null) {
    const objAttrs = dmuEvent.attributes as Record<string, string>;
    for (const [k, v] of Object.entries(objAttrs)) attrs[k] = v;
  }

  return Object.keys(attrs).length > 0 ? attrs : null;
}

function extractFromTxResult(result: TendermintResult): Record<string, string> | null {
  const txEvents = result.data?.value?.TxResult?.result?.events;
  if (!txEvents || !Array.isArray(txEvents)) return null;

  const dmuEvent = (txEvents as TendermintEvent[]).find((e) => e.type === 'denom_metadata_updated');
  if (!dmuEvent) return null;

  const attrs: Record<string, string> = {};
  if (Array.isArray(dmuEvent.attributes)) {
    for (const attr of dmuEvent.attributes as TendermintEventAttribute[]) {
      if (attr.key && attr.value !== undefined) attrs[attr.key] = attr.value;
    }
  } else if (typeof dmuEvent.attributes === 'object' && dmuEvent.attributes !== null) {
    const objAttrs = dmuEvent.attributes as Record<string, string>;
    for (const [k, v] of Object.entries(objAttrs)) attrs[k] = v;
  }

  return Object.keys(attrs).length > 0 ? attrs : null;
}

// ─── Data Extraction ──────────────────────────────────────────────────────────

function extractLaunchData(attrs: Record<string, string>): LaunchData {
  const metadataRaw = attrs['metadata'] ?? attrs['denom_metadata'] ?? null;
  let parsedMeta: Record<string, unknown> = {};

  if (metadataRaw) {
    const parsed = safeJsonParse(metadataRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsedMeta = parsed as Record<string, unknown>;
    }
  }

  const symbol = normalizeStr(parsedMeta['symbol']) ?? normalizeStr(attrs['symbol']) ?? null;
  const name =
    normalizeStr(parsedMeta['name']) ??
    normalizeStr(parsedMeta['display']) ??
    normalizeStr(attrs['name']) ??
    null;
  const denom =
    normalizeStr(parsedMeta['base']) ?? normalizeStr(attrs['denom']) ?? null;
  const creator =
    normalizeStr(attrs['creator']) ??
    normalizeStr(attrs['sender']) ??
    normalizeStr(attrs['signer']) ??
    null;
  const imageUri =
    normalizeStr(parsedMeta['uri']) ??
    normalizeStr(attrs['uri']) ??
    normalizeStr(attrs['uri_hash']) ??
    null;

  return { symbol, name, denom, creator, imageUri };
}

// ─── Optional API Enrichment ──────────────────────────────────────────────────

async function enrichFromApi(data: LaunchData): Promise<LaunchData> {
  if (!MDF_TOKEN_API_BASE) return data;
  if (!data.denom) return data;
  if (data.symbol && data.name && data.imageUri) return data;

  const url = `${MDF_TOKEN_API_BASE}/${encodeURIComponent(data.denom)}`;
  log('debug', `[ENRICH] Fetching metadata from ${url}`);

  try {
    const response = await axios.get<Record<string, unknown>>(url, {
      timeout: 4_000,
      headers: { Accept: 'application/json' },
    });
    const body = response.data;
    if (body && typeof body === 'object') {
      return {
        symbol: data.symbol ?? normalizeStr(body['symbol']),
        name: data.name ?? normalizeStr(body['name']),
        denom: data.denom,
        creator: data.creator ?? normalizeStr(body['creator']),
        imageUri:
          data.imageUri ??
          normalizeStr(body['imageUri']) ??
          normalizeStr(body['image']),
      };
    }
  } catch (err: unknown) {
    log('warn', `[ENRICH] API call failed for ${data.denom}: ${String(err)}`);
  }

  return data;
}

// ─── Launch Emission ──────────────────────────────────────────────────────────

async function emitLaunch(data: LaunchData): Promise<void> {
  const symbol = data.symbol ?? 'unknown';
  const name = data.name ?? 'unknown';
  const denom = data.denom ?? 'unknown';
  const creator = data.creator ?? 'unknown';
  const image = data.imageUri ?? 'none';

  // Console output (strict format per spec)
  console.log(
    `[MDF LAUNCH] symbol=${symbol} name=${name} denom=${denom} creator=${creator} image=${image} source=denom_metadata_updated`
  );

  // Telegram broadcast to all subscribers
  await broadcastLaunch(data);
}

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleMessage(raw: string): Promise<void> {
  const msg = safeJsonParse(raw) as RpcMessage | null;
  if (!msg || typeof msg !== 'object') return;

  if (msg.error) {
    log('warn', `[WS] RPC error: ${msg.error.message} (code=${msg.error.code})`);
    return;
  }

  const result = msg.result;
  if (!result || typeof result !== 'object') return;

  // CRITICAL: Only emit from denom_metadata_updated
  let attrs = extractDenomMetadataUpdated(result);
  if (!attrs) attrs = extractFromTxResult(result);
  if (!attrs) {
    log('debug', '[WS] No denom_metadata_updated event — skipping');
    return;
  }

  log('debug', '[WS] denom_metadata_updated event detected');

  let launchData = extractLaunchData(attrs);

  const denomKey = launchData.denom ?? JSON.stringify(attrs);
  if (isDuplicate(denomKey)) {
    log('info', `[DEDUP] Skipping duplicate launch for denom: ${denomKey}`);
    return;
  }

  launchData = await enrichFromApi(launchData);
  await emitLaunch(launchData);
}

// ─── WebSocket Manager ────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let isShuttingDown = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const SUBSCRIPTIONS = [
  {
    id: 1,
    label: 'create_denom',
    query: `tm.event='Tx' AND wasm._contract_address='${MDF_CONTRACT}' AND wasm.method='create_denom'`,
  },
  {
    id: 2,
    label: 'denom_metadata_updated',
    query: `tm.event='Tx' AND denom_metadata_updated.module='factory'`,
  },
];

function subscribe(socket: WebSocket): void {
  for (const sub of SUBSCRIPTIONS) {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscribe',
      id: sub.id,
      params: { query: sub.query },
    });
    socket.send(payload);
    log('info', `[WS] Subscribed to ${sub.label}`);
  }
}

function connect(): void {
  if (isShuttingDown) return;

  log('info', `[WS] Connecting to ${RPC_WS} (attempt ${reconnectAttempt + 1})`);
  ws = new WebSocket(RPC_WS as string);

  ws.on('open', () => {
    log('info', '[WS] Connected');
    reconnectAttempt = 0;
    subscribe(ws as WebSocket);
  });

  ws.on('message', (data: WebSocket.RawData) => {
    handleMessage(data.toString()).catch((err: unknown) => {
      log('error', `[WS] Unhandled error in message handler: ${String(err)}`);
    });
  });

  ws.on('close', (code: number, reason: Buffer) => {
    log('warn', `[WS] Connection closed (code=${code}, reason=${reason.toString() || 'none'})`);
    scheduleReconnect();
  });

  ws.on('error', (err: Error) => {
    log('error', `[WS] Socket error: ${err.message}`);
  });
}

function scheduleReconnect(): void {
  if (isShuttingDown) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30_000);
  reconnectAttempt++;
  log('info', `[WS] Reconnecting in ${delay / 1000}s...`);
  reconnectTimer = setTimeout(() => connect(), delay);
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log('info', `[WS] Received ${signal}. Shutting down gracefully...`);
  isShuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  stopPoolMonitor();
  bot.stopPolling().catch(() => undefined);

  if (ws) {
    ws.close(1000, 'Graceful shutdown');
    ws = null;
  }

  log('info', '[WS] Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Entry Point ──────────────────────────────────────────────────────────────

log('info', '=== MDF Launch Tracker + Telegram Bot starting ===');
log('info', `[CONFIG] RPC_WS=${RPC_WS}`);
log('info', `[CONFIG] MDF_CONTRACT=${MDF_CONTRACT}`);
log('info', `[CONFIG] MDF_TOKEN_API_BASE=${MDF_TOKEN_API_BASE || '(not set)'}`);
log('info', `[CONFIG] LOG_LEVEL=${LOG_LEVEL}`);
log('info', `[CONFIG] Subscribers loaded: ${subscribers.size}`);
log('info', '');
log('info', '⚠️  Launch alerts are ONLY emitted from denom_metadata_updated events.');
log('info', '');

connect();

// Start Degenter pool monitor (first run silently seeds cache, then alerts every 5 min)
startPoolMonitor(DATA_DIR, log, broadcastNewPools, false);
