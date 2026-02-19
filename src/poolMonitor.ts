import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PoolInfo {
  pairContract: string;
  tokenSymbol: string;
  baseSymbol: string;
  baseDenom: string;
  quoteSymbol: string;
  quoteDenom: string;
  imageUri: string | null;
  createdAt: string;
  priceNative: number | null;
  priceUsd: number | null;
  tvlNative: number | null;
  tvlUsd: number | null;
  volumeNative: number | null;
  volumeUsd: number | null;
}

interface PoolCacheEntry {
  token: string;
  createdAt: string | null;
  imageUri: string | null;
  priceNative: number | null;
  priceUsd: number | null;
  base: { symbol: string | null; denom: string | null; priceNative?: number | null; priceUsd?: number | null };
  quote: { symbol: string | null; denom: string | null; priceNative?: number | null; priceUsd?: number | null };
  tvlNative: number | null;
  tvlUsd: number | null;
  volumeNative: number | null;
  volumeUsd: number | null;
}

interface PoolCacheData {
  pairs: Record<string, PoolCacheEntry>;
  last_checked: string | null;
}

// API response shapes — matching the Python code exactly
interface TokenApiItem {
  symbol: string;
  imageUri?: string;
  [key: string]: unknown;
}

interface PoolApiItem {
  pairContract: string;
  base: { symbol?: string; denom?: string; priceNative?: number; priceUsd?: number };
  quote: { symbol?: string; denom?: string; priceNative?: number; priceUsd?: number };
  createdAt?: string;
  priceNative?: number;
  priceUsd?: number;
  tvlNative?: number;
  tvlUsd?: number;
  volumeNative?: number;
  volumeUsd?: number;
  [key: string]: unknown;
}

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
export type BroadcastFn = (pools: PoolInfo[]) => Promise<void>;

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = 'https://dev-api.degenter.io';
const SCAN_INTERVAL_MS = 300_000; // 5 minutes

// ─── Cache ───────────────────────────────────────────────────────────────────

let cacheFilePath: string;
let cache: PoolCacheData = { pairs: {}, last_checked: null };

function loadCache(log: LogFn): void {
  try {
    if (fs.existsSync(cacheFilePath)) {
      const raw = fs.readFileSync(cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PoolCacheData>;
      cache = {
        pairs: parsed.pairs ?? {},
        last_checked: parsed.last_checked ?? null,
      };
      log('info', `[POOLS] Loaded cache: ${Object.keys(cache.pairs).length} known pair(s)`);
    } else {
      log('info', '[POOLS] No cache file found — starting fresh');
    }
  } catch (err) {
    log('warn', `[POOLS] Failed to load cache: ${String(err)}`);
  }
}

function saveCache(log: LogFn): void {
  try {
    cache.last_checked = new Date().toISOString();
    fs.writeFileSync(cacheFilePath, JSON.stringify(cache, null, 2), 'utf-8');
    log('debug', `[POOLS] Cache saved (${Object.keys(cache.pairs).length} pairs)`);
  } catch (err) {
    log('error', `[POOLS] Failed to save cache: ${String(err)}`);
  }
}

// ─── API Helpers (matching Python code exactly) ──────────────────────────────

async function getTokens(log: LogFn): Promise<TokenApiItem[]> {
  try {
    const resp = await axios.get<{ data?: TokenApiItem[] }>(
      `${API_BASE}/tokens`,
      { timeout: 15_000, headers: { Accept: 'application/json' } }
    );
    const body = resp.data;
    // Python: data.get("data", [])
    const tokens = body?.data ?? [];
    if (!Array.isArray(tokens)) {
      log('warn', '[POOLS] /tokens returned unexpected shape');
      return [];
    }
    log('debug', `[POOLS] Fetched ${tokens.length} token(s) from /tokens`);
    return tokens;
  } catch (err) {
    log('error', `[POOLS] Failed to fetch /tokens: ${String(err)}`);
    return [];
  }
}

async function getPoolsForToken(symbol: string, log: LogFn): Promise<PoolApiItem[]> {
  try {
    const resp = await axios.get<{ data?: PoolApiItem[] }>(
      `${API_BASE}/tokens/${encodeURIComponent(symbol)}/pools`,
      { timeout: 10_000, headers: { Accept: 'application/json' } }
    );
    const body = resp.data;
    // Python: data.get("data", [])
    const pools = body?.data ?? [];
    if (!Array.isArray(pools)) return [];
    return pools;
  } catch (err) {
    log('debug', `[POOLS] Failed to fetch pools for ${symbol}: ${String(err)}`);
    return [];
  }
}

// ─── Detection (mirrors Python detect_new_pools exactly) ──────────────────────

async function detectNewPools(log: LogFn): Promise<PoolInfo[]> {
  const tokens = await getTokens(log);
  if (tokens.length === 0) return [];

  log('info', `🔍 Checking ${tokens.length} tokens for new pools...`);
  const newPools: PoolInfo[] = [];
  const seenPairs = cache.pairs;

  for (const t of tokens) {
    if (!t.symbol) continue;

    const symbol = t.symbol;
    const imageUri = t.imageUri ?? null; // imageUri comes from token level

    const pools = await getPoolsForToken(symbol, log);

    for (const p of pools) {
      const pairAddr = p.pairContract;
      if (!pairAddr) continue;

      // Normalize nested base/quote objects (matching Python exactly)
      const baseInfo = p.base ?? {};
      const quoteInfo = p.quote ?? {};
      const priceNative = p.priceNative ?? null;
      const priceUsd = p.priceUsd ?? null;
      const tvlNative = p.tvlNative ?? null;
      const tvlUsd = p.tvlUsd ?? null;
      const volNative = p.volumeNative ?? null;
      const volUsd = p.volumeUsd ?? null;

      if (!(pairAddr in seenPairs)) {
        // NEW pool — emit alert payload
        newPools.push({
          pairContract: pairAddr,
          tokenSymbol: symbol,
          baseSymbol: baseInfo.symbol ?? '',
          baseDenom: baseInfo.denom ?? '',
          quoteSymbol: quoteInfo.symbol ?? '',
          quoteDenom: quoteInfo.denom ?? '',
          imageUri,
          createdAt: p.createdAt ?? new Date().toISOString(),
          priceNative,
          priceUsd,
          tvlNative,
          tvlUsd,
          volumeNative: volNative,
          volumeUsd: volUsd,
        });

        // Enrich cache entry (matching Python structure)
        seenPairs[pairAddr] = {
          token: symbol,
          createdAt: p.createdAt ?? null,
          imageUri,
          priceNative,
          priceUsd,
          base: {
            symbol: baseInfo.symbol ?? null,
            denom: baseInfo.denom ?? null,
            priceNative: baseInfo.priceNative ?? null,
            priceUsd: baseInfo.priceUsd ?? null,
          },
          quote: {
            symbol: quoteInfo.symbol ?? null,
            denom: quoteInfo.denom ?? null,
            priceNative: quoteInfo.priceNative ?? null,
            priceUsd: quoteInfo.priceUsd ?? null,
          },
          tvlNative,
          tvlUsd,
          volumeNative: volNative,
          volumeUsd: volUsd,
        };

        log('info', `[POOLS] 🆕 New pool: ${baseInfo.symbol ?? '?'}/${quoteInfo.symbol ?? '?'} (${pairAddr})`);
      } else {
        // Already known pair — update enriched fields so cache stays fresh
        const existing = seenPairs[pairAddr];
        if (existing) {
          existing.imageUri = imageUri ?? existing.imageUri;
          existing.priceNative = priceNative;
          existing.priceUsd = priceUsd;
          existing.tvlNative = tvlNative;
          existing.tvlUsd = tvlUsd;
          existing.volumeNative = volNative;
          existing.volumeUsd = volUsd;

          // Update base/quote details
          if (existing.base) {
            existing.base.symbol = baseInfo.symbol ?? existing.base.symbol;
            existing.base.denom = baseInfo.denom ?? existing.base.denom;
          }
          if (existing.quote) {
            existing.quote.symbol = quoteInfo.symbol ?? existing.quote.symbol;
            existing.quote.denom = quoteInfo.denom ?? existing.quote.denom;
          }
        }
      }
    }
  }

  // Save cache after full scan
  saveCache(log);
  return newPools;
}

// ─── Monitor Loop ─────────────────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

export function startPoolMonitor(
  dataDir: string,
  log: LogFn,
  broadcastNewPools: BroadcastFn,
  firstRunSilent: boolean = true
): void {
  cacheFilePath = path.resolve(dataDir, 'pools_cache.json');
  loadCache(log);

  log('info', `[POOLS] Monitor starting (interval: ${SCAN_INTERVAL_MS / 1000}s)`);
  isRunning = true;

  let isFirstRun = firstRunSilent;

  const runScan = async (): Promise<void> => {
    if (!isRunning) return;

    log('info', '[POOLS] Starting pool scan...');
    try {
      const newPools = await detectNewPools(log);

      if (newPools.length > 0) {
        // Sort by createdAt ascending (oldest first) — matching Python
        newPools.sort((a, b) => {
          const dateA = a.createdAt.replace(/Z$/, '+00:00');
          const dateB = b.createdAt.replace(/Z$/, '+00:00');
          return new Date(dateA).getTime() - new Date(dateB).getTime();
        });

        if (isFirstRun) {
          log('info', `[POOLS] First run: seeded ${newPools.length} existing pool(s) into cache — not alerting`);
        } else {
          log('info', `[POOLS] Found ${newPools.length} new pool(s) — broadcasting alerts`);
          await broadcastNewPools(newPools);
        }
      } else {
        log('debug', '[POOLS] No new pools detected');
      }
    } catch (err) {
      log('error', `[POOLS] Scan error: ${String(err)}`);
    }

    isFirstRun = false;

    // Schedule next scan
    if (isRunning) {
      monitorTimer = setTimeout(() => {
        runScan().catch((e) => log('error', `[POOLS] Fatal scan error: ${String(e)}`));
      }, SCAN_INTERVAL_MS);
    }
  };

  // First scan immediately
  runScan().catch((e) => log('error', `[POOLS] Fatal scan error: ${String(e)}`));
}

export function stopPoolMonitor(): void {
  isRunning = false;
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
}
