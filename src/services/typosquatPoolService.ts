import pool from "../dbPool.js";

/**
 * Behavior-derived pool for the static typosquat list.
 *
 * The JSON file remains the input list. This service joins each domain to the
 * observations already stored in `ads` and assigns a sampling tier:
 *
 *   hot     - produced a scam destination recently
 *   normal  - rotates through many distinct final parents/hosts
 *   low     - some rotation, but limited
 *   cold    - static parking / single-destination behavior
 *   unknown - not enough off-peak observations yet
 *
 * No new tables are required for this phase.
 */

export type TyposquatTier = "hot" | "normal" | "low" | "cold" | "unknown";

export interface TyposquatPoolStats {
  offpeakRows: number;
  distinctFinalParents: number;
  distinctFinalHosts: number;
  meanDistinctHosts: number;
  maxFanIn: number;
  pctShortPaths: number;
  pctTrackerPaths: number;
  recentScams: number;
  recentErrors: number;
  recentCycles: number;
  lastSeen: string | null;
}

export interface TyposquatPoolEntry {
  domain: string;
  tier: TyposquatTier;
  stats: TyposquatPoolStats | null;
}

export interface TyposquatRunContext {
  isPeak: boolean;
  hourEt: number;
  isodow: number;
}

export interface TyposquatSelection extends TyposquatPoolEntry {
  context: TyposquatRunContext;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;

const TRACKER_PARENTS = [
  "demdex.net",
  "doubleclick.net",
  "quantserve.com",
  "googlesyndication.com",
  "googleadservices.com",
  "scorecardresearch.com",
  "adsrvr.org",
  "rubiconproject.com",
  "pubmatic.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "revcontent.com",
  "mgid.com",
  "adsterra.com",
  "propellerads.com",
  "popads.net",
  "onclickads.net",
  "exoclick.com",
  "juicyads.com",
  "trafficjunky.com",
  "adnxs.com",
  "casalemedia.com",
  "openx.net",
  "smartadserver.com",
  "33across.com",
  "sharethrough.com",
  "teads.tv",
];

const POOL_SQL = `
WITH base AS (
  SELECT
    id,
    is_scam,
    last_seen,
    lower(
      regexp_replace(
        split_part(regexp_replace(initial_url, '^https?://', ''), '/', 1),
        '^www\\.',
        ''
      )
    ) AS src,
    lower(split_part(regexp_replace(final_url, '^https?://', ''), '/', 1)) AS final_host,
    cardinality(redirect_path) AS hops,
    (
      SELECT count(DISTINCT lower(split_part(regexp_replace(u, '^[a-z]+://', ''), '/', 1)))
      FROM unnest(redirect_path) u
    ) AS distinct_hosts,
    extract(hour FROM first_seen AT TIME ZONE 'America/New_York')::int AS hour_et,
    extract(isodow FROM first_seen AT TIME ZONE 'America/New_York')::int AS isodow
  FROM ads
  WHERE ad_type = 'typosquat'
),
with_parent AS (
  SELECT
    *,
    CASE
      WHEN final_host LIKE '%.it.com' THEN
        regexp_replace(final_host, '^.*\\.([^.]+\\.[^.]+\\.[^.]+)$', '\\1')
      WHEN final_host ~ '^[0-9.]+$' THEN final_host
      ELSE
        regexp_replace(final_host, '^.*\\.([^.]+\\.[^.]+)$', '\\1')
    END AS final_parent
  FROM base
),
offpeak AS (
  SELECT *
  FROM with_parent
  WHERE NOT (isodow BETWEEN 1 AND 5 AND hour_et BETWEEN 9 AND 16)
),
fanin AS (
  SELECT final_parent, count(DISTINCT src)::int AS source_count
  FROM with_parent
  GROUP BY final_parent
),
recent_scams AS (
  SELECT src, count(*)::int AS recent_scams
  FROM with_parent
  WHERE is_scam AND last_seen > now() - interval '30 days'
  GROUP BY src
),
recent_failures AS (
  SELECT
    lower(
      regexp_replace(
        regexp_replace(details->>'domain', '^https?://', ''),
        '^www\\.',
        ''
      )
    ) AS src,
    count(*)::int AS recent_errors
  FROM hunter_events
  WHERE hunter_type = 'typosquat'
    AND event_type = 'error'
    AND created_at > now() - interval '7 days'
    AND details->>'domain' IS NOT NULL
  GROUP BY 1
),
recent_cycles AS (
  SELECT
    lower(
      regexp_replace(
        regexp_replace(details->>'domain', '^https?://', ''),
        '^www\\.',
        ''
      )
    ) AS src,
    count(*)::int AS recent_cycles
  FROM hunter_events
  WHERE hunter_type = 'typosquat'
    AND event_type = 'cycle_start'
    AND created_at > now() - interval '7 days'
    AND details->>'domain' IS NOT NULL
  GROUP BY 1
)
SELECT
  o.src,
  count(*)::int AS offpeak_rows,
  count(DISTINCT o.final_parent)::int AS distinct_final_parents,
  count(DISTINCT o.final_host)::int AS distinct_final_hosts,
  coalesce(avg(o.distinct_hosts), 0)::float AS mean_distinct_hosts,
  coalesce(max(f.source_count), 0)::int AS max_fanin,
  coalesce(avg(CASE WHEN o.hops <= 3 THEN 1 ELSE 0 END), 0)::float AS pct_short,
  coalesce(avg(CASE WHEN o.final_parent = ANY($1::text[]) THEN 1 ELSE 0 END), 0)::float AS pct_tracker,
  coalesce(max(rs.recent_scams), 0)::int AS recent_scams,
  coalesce(max(rf.recent_errors), 0)::int AS recent_errors,
  coalesce(max(rc.recent_cycles), 0)::int AS recent_cycles,
  max(o.last_seen) AS last_seen
FROM offpeak o
LEFT JOIN fanin f ON f.final_parent = o.final_parent
LEFT JOIN recent_scams rs ON rs.src = o.src
LEFT JOIN recent_failures rf ON rf.src = o.src
LEFT JOIN recent_cycles rc ON rc.src = o.src
GROUP BY o.src
`;

// Weights are per domain, not per tier. This prevents a tier with one or two
// domains from taking a large share of all picks.
//
// Peak: hot domains get the highest per-domain weight, normal domains get
// broad coverage, and cold/unknown are limited to exploration.
const PEAK_DOMAIN_WEIGHTS: Record<TyposquatTier, number> = {
  hot: 10,
  normal: 2,
  low: 1,
  cold: 0.5,
  unknown: 0.5,
};

// Off-hours: cold and unknown domains get more per-domain weight so the
// abundant time is used for qualification, while hot domains still get a
// small share to catch off-hours campaigns.
const OFFPEAK_DOMAIN_WEIGHTS: Record<TyposquatTier, number> = {
  hot: 2,
  normal: 2,
  low: 3,
  cold: 4,
  unknown: 2,
};

const WEEKDAY_TO_ISODOW: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const ET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});

export function normalizeTyposquatDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

export function classifyTyposquatTier(
  stats: TyposquatPoolStats | null
): TyposquatTier {
  if (stats == null) {
    return "unknown";
  }

  if (stats.recentScams > 0) {
    return "hot";
  }

  // Static parking / single-destination behavior. The historical analysis
  // found this cut catches roughly half of never-scam domains with no
  // meaningful loss of good domains.
  if (stats.distinctFinalParents <= 3 || stats.meanDistinctHosts <= 2) {
    return "cold";
  }

  if (stats.offpeakRows < 3) {
    return "unknown";
  }

  if (stats.distinctFinalParents <= 10 || stats.meanDistinctHosts <= 3) {
    return "low";
  }

  return "normal";
}

export function getTyposquatRunContext(
  now: Date = new Date()
): TyposquatRunContext {
  const parts = ET_FORMATTER.formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hourEt = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const isodow = WEEKDAY_TO_ISODOW[weekday] ?? 1;

  return {
    isPeak: isodow >= 1 && isodow <= 5 && hourEt >= 9 && hourEt <= 16,
    hourEt,
    isodow,
  };
}

function weightForEntry(
  entry: TyposquatPoolEntry,
  weights: Record<TyposquatTier, number>,
  isPeak: boolean
): number {
  const base = weights[entry.tier];
  const stats = entry.stats;

  if (base <= 0 || stats == null || stats.recentCycles <= 0) {
    return base;
  }

  const failureRate = Math.min(
    1,
    Math.max(0, stats.recentErrors / stats.recentCycles)
  );

  if (stats.recentCycles >= 3 && failureRate >= 0.8) {
    if (entry.tier === "hot") {
      // A blocked hot domain may still be a live scam hidden by the carrier.
      return base * 0.5;
    }

    // Persistently blocked/timeout domains leave the main peak rotation but
    // keep a small off-hours retry. After the 7-day event window rolls off,
    // they get a fresh normal attempt.
    return isPeak ? 0 : base * 0.2;
  }

  return base * Math.max(0.2, 1 - failureRate);
}

/**
 * Pure weighted selection, exported for tests. The random function is
 * injectable so tier/time behavior is deterministic in unit tests.
 */
export function selectTyposquatFromPool(
  entries: TyposquatPoolEntry[],
  context: TyposquatRunContext,
  random: () => number = Math.random
): TyposquatSelection | null {
  if (entries.length === 0) {
    return null;
  }

  const weights = context.isPeak
    ? PEAK_DOMAIN_WEIGHTS
    : OFFPEAK_DOMAIN_WEIGHTS;

  const weighted = entries
    .map((entry) => ({
      entry,
      weight: weightForEntry(entry, weights, context.isPeak),
    }))
    .filter((item) => item.weight > 0);

  if (weighted.length === 0) {
    const index = Math.min(
      entries.length - 1,
      Math.floor(random() * entries.length)
    );
    return { ...entries[index], context };
  }

  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);

  if (totalWeight <= 0) {
    const index = Math.min(
      entries.length - 1,
      Math.floor(random() * entries.length)
    );
    return { ...entries[index], context };
  }

  let pick = random() * totalWeight;
  let selected = weighted[weighted.length - 1].entry;

  for (const item of weighted) {
    pick -= item.weight;
    if (pick <= 0) {
      selected = item.entry;
      break;
    }
  }

  return { ...selected, context };
}

interface PoolCache {
  loadedAt: number;
  entries: Map<string, TyposquatPoolEntry>;
}

let cache: PoolCache | null = null;
let lastFailureAt = 0;

export function clearTyposquatPoolCache(): void {
  cache = null;
  lastFailureAt = 0;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rowToStats(row: Record<string, unknown>): TyposquatPoolStats {
  return {
    offpeakRows: toNumber(row.offpeak_rows),
    distinctFinalParents: toNumber(row.distinct_final_parents),
    distinctFinalHosts: toNumber(row.distinct_final_hosts),
    meanDistinctHosts: toNumber(row.mean_distinct_hosts),
    maxFanIn: toNumber(row.max_fanin),
    pctShortPaths: toNumber(row.pct_short),
    pctTrackerPaths: toNumber(row.pct_tracker),
    recentScams: toNumber(row.recent_scams),
    recentErrors: toNumber(row.recent_errors),
    recentCycles: toNumber(row.recent_cycles),
    lastSeen: row.last_seen == null
      ? null
      : new Date(row.last_seen as string | Date).toISOString(),
  };
}

function unknownEntry(domain: string): TyposquatPoolEntry {
  return { domain, tier: "unknown", stats: null };
}

function unknownEntries(domains: string[]): TyposquatPoolEntry[] {
  return domains.map(unknownEntry);
}

/**
 * Returns one entry per requested domain, using cached `ads` statistics.
 * A database failure degrades to "unknown" rather than stopping the hunter.
 */
export async function getTyposquatPool(
  domains: string[],
  options: { forceRefresh?: boolean } = {}
): Promise<TyposquatPoolEntry[]> {
  const normalized = Array.from(
    new Set(domains.map(normalizeTyposquatDomain).filter((domain) => domain.length > 0))
  );

  if (normalized.length === 0) {
    return [];
  }

  const now = Date.now();

  if (
    !options.forceRefresh &&
    cache != null &&
    now - cache.loadedAt < CACHE_TTL_MS
  ) {
    return normalized.map(
      (domain) => cache?.entries.get(domain) ?? unknownEntry(domain)
    );
  }

  if (!options.forceRefresh && now - lastFailureAt < FAILURE_RETRY_MS) {
    return unknownEntries(normalized);
  }

  try {
    const result = await pool.query(POOL_SQL, [TRACKER_PARENTS]);
    const byDomain = new Map<string, TyposquatPoolEntry>();

    for (const row of result.rows as Record<string, unknown>[]) {
      const domain = normalizeTyposquatDomain(String(row.src ?? ""));
      if (domain.length === 0) {
        continue;
      }
      const stats = rowToStats(row);
      byDomain.set(domain, {
        domain,
        tier: classifyTyposquatTier(stats),
        stats,
      });
    }

    const entries = normalized.map(
      (domain) => byDomain.get(domain) ?? unknownEntry(domain)
    );

    cache = {
      loadedAt: now,
      entries: new Map(entries.map((entry) => [entry.domain, entry])),
    };

    return entries;
  } catch (error) {
    lastFailureAt = now;
    console.error(`Failed to load typosquat pool stats: ${error}`);
    return unknownEntries(normalized);
  }
}
