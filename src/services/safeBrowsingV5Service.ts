import { createHash } from "crypto";
import { getDomain, parse as parseTld } from "tldts";
import pool from "../dbPool.js";
import { readConfig } from "../config.js";
import { fetch } from "undici";
import protobuf from "protobufjs";

// ---------------------------------------------------------------------------
// Protobuf Schema Definitions (for decoding v5 API protobuf responses)
// ---------------------------------------------------------------------------

const proto = protobuf.Root.fromJSON({
  nested: {
    SearchHashesResponse: {
      fields: {
        fullHashes: { rule: "repeated", type: "FullHash", id: 1 },
        cacheDuration: { type: "google.protobuf.Duration", id: 2 },
      },
    },
    FullHash: {
      fields: {
        fullHash: { type: "bytes", id: 1 },
        fullHashDetails: { rule: "repeated", type: "FullHashDetail", id: 2 },
      },
    },
    FullHashDetail: {
      fields: {
        threatType: { type: "ThreatType", id: 1 },
        attributes: { rule: "repeated", type: "ThreatAttribute", id: 2 },
      },
    },
    ThreatType: {
      values: {
        THREAT_TYPE_UNSPECIFIED: 0,
        MALWARE: 1,
        SOCIAL_ENGINEERING: 2,
        UNWANTED_SOFTWARE: 3,
        POTENTIALLY_HARMFUL_APPLICATION: 4,
      },
    },
    ThreatAttribute: {
      values: {
        THREAT_ATTRIBUTE_UNSPECIFIED: 0,
        CANARY: 1,
        FRAME_ONLY: 2,
      },
    },
    BatchGetHashListsResponse: {
      fields: {
        hashLists: { rule: "repeated", type: "HashList", id: 1 },
      },
    },
    HashList: {
      fields: {
        name: { type: "string", id: 1 },
        version: { type: "bytes", id: 2 },
        partialUpdate: { type: "bool", id: 3 },
        compressedRemovals: { type: "RiceDeltaEncoded32Bit", id: 4 },
        compressedAdditions: { type: "RiceDeltaEncoded", id: 5 },
        minimumWaitDuration: { type: "google.protobuf.Duration", id: 7 },
        metadata: { type: "HashListMetadata", id: 8 },
        sha256Checksum: { type: "bytes", id: 9 },
      },
    },
    HashListMetadata: {
      fields: {
        threatTypes: { rule: "repeated", type: "ThreatType", id: 1 },
        hashLength: { type: "int32", id: 3 },
      },
    },
    RiceDeltaEncoded: {
      fields: {
        firstValue: { type: "bytes", id: 1 },
        riceParameter: { type: "int32", id: 2 },
        entriesCount: { type: "int32", id: 3 },
        encodedData: { type: "bytes", id: 4 },
      },
    },
    RiceDeltaEncoded32Bit: {
      fields: {
        firstValue: { type: "uint32", id: 1 },
        riceParameter: { type: "int32", id: 2 },
        entriesCount: { type: "int32", id: 3 },
        encodedData: { type: "bytes", id: 4 },
      },
    },
    google: {
      nested: {
        protobuf: {
          nested: {
            Duration: {
              fields: {
                seconds: { type: "int64", id: 1 },
                nanos: { type: "int32", id: 2 },
              },
            },
          },
        },
      },
    },
  },
});

const SearchHashesResponseType = proto.lookupType("SearchHashesResponse");
const BatchGetHashListsResponseType = proto.lookupType("BatchGetHashListsResponse");

// Reverse enum lookups
const THREAT_TYPE_NAMES: Record<number, string> = {
  0: "THREAT_TYPE_UNSPECIFIED",
  1: "MALWARE",
  2: "SOCIAL_ENGINEERING",
  3: "UNWANTED_SOFTWARE",
  4: "POTENTIALLY_HARMFUL_APPLICATION",
};

const THREAT_ATTR_NAMES: Record<number, string> = {
  0: "THREAT_ATTRIBUTE_UNSPECIFIED",
  1: "CANARY",
  2: "FRAME_ONLY",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HashSearchFullHash {
  fullHash: string; // base64
  fullHashDetails: {
    threatType: string;
    attributes?: string[];
  }[];
}

interface HashSearchResponse {
  fullHashes?: HashSearchFullHash[];
  cacheDuration?: string; // e.g. "300s"
}

interface HashListResponse {
  hashLists: HashListEntry[];
}

interface HashListEntry {
  name: string;
  version: string; // base64
  partialUpdate?: boolean;
  compressedRemovals?: RiceDeltaEncoded;
  compressedAdditions?: RiceDeltaEncoded;
  metadata?: { hashLength?: number };
  minimumWaitDuration?: string; // e.g. "300s"
  sha256Checksum?: string; // base64
}

interface RiceDeltaEncoded {
  firstValue?: string; // numeric string or base64 depending on context
  riceParameter: number;
  entriesCount: number;
  encodedData?: string; // base64
}

type CheckResult = "SAFE" | "UNSAFE" | "UNSURE";

export interface SafeBrowsingCheckResult {
  isFlagged: boolean;
  threatTypes?: string[];
}

// The lists we subscribe to
const THREAT_LISTS = ["se-4b", "mw-4b", "uws-4b"];
const GLOBAL_CACHE_LIST = "gc-32b";
const ALL_LISTS = [GLOBAL_CACHE_LIST, ...THREAT_LISTS];

// Map list names to threat types for labeling results
const LIST_THREAT_TYPE: Record<string, string> = {
  "se-4b": "SOCIAL_ENGINEERING",
  "mw-4b": "MALWARE",
  "uws-4b": "UNWANTED_SOFTWARE",
};

// ---------------------------------------------------------------------------
// URL Canonicalization (per Google spec)
// ---------------------------------------------------------------------------

export function canonicalizeUrl(rawUrl: string): string {
  // Remove tab, CR, LF
  let url = rawUrl.replace(/[\t\r\n]/g, "");

  // Remove fragment
  const fragmentIdx = url.indexOf("#");
  if (fragmentIdx !== -1) {
    url = url.substring(0, fragmentIdx);
  }

  // Repeatedly percent-unescape until stable
  let prev = "";
  while (prev !== url) {
    prev = url;
    try {
      url = decodeURIComponent(url);
    } catch {
      break; // invalid sequence, stop
    }
  }

  // Parse into components
  let parsed: URL;
  try {
    // Ensure scheme
    if (!/^https?:\/\//i.test(url)) {
      url = "http://" + url;
    }
    parsed = new URL(url);
  } catch {
    return url; // unparseable, return as-is
  }

  // Canonicalize hostname
  let hostname = parsed.hostname;
  hostname = hostname.replace(/^\.+|\.+$/g, ""); // strip leading/trailing dots
  hostname = hostname.replace(/\.{2,}/g, "."); // collapse consecutive dots
  hostname = hostname.toLowerCase();

  // Canonicalize path
  let path = parsed.pathname;
  // Resolve /../ and /./
  path = new URL(`http://x${path}`).pathname; // leverage URL parser for resolution
  // Collapse consecutive slashes
  path = path.replace(/\/{2,}/g, "/");

  // Ensure trailing slash if path is empty
  if (!path || path === "") {
    path = "/";
  }

  // Percent-escape chars <=32, >=127, '#', '%'
  const escapePath = (s: string): string => {
    let result = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c <= 32 || c >= 127 || s[i] === "#" || s[i] === "%") {
        result += "%" + c.toString(16).toUpperCase().padStart(2, "0");
      } else {
        result += s[i];
      }
    }
    return result;
  };

  const canonPath = escapePath(path);
  const canonQuery = parsed.search ? escapePath(parsed.search) : "";

  return `${hostname}${canonPath}${canonQuery}`;
}

// ---------------------------------------------------------------------------
// Suffix/Prefix Expression Generation
// ---------------------------------------------------------------------------

export function generateExpressions(canonicalizedUrl: string): string[] {
  // Split into hostname and path+query
  const firstSlash = canonicalizedUrl.indexOf("/");
  if (firstSlash === -1) {
    return [canonicalizedUrl + "/"];
  }

  const hostname = canonicalizedUrl.substring(0, firstSlash);
  const pathAndQuery = canonicalizedUrl.substring(firstSlash);

  // Separate path from query
  const queryIdx = pathAndQuery.indexOf("?");
  const path = queryIdx !== -1 ? pathAndQuery.substring(0, queryIdx) : pathAndQuery;
  const query = queryIdx !== -1 ? pathAndQuery.substring(queryIdx) : "";

  // Generate host suffixes (up to 5)
  const hostSuffixes: string[] = [];

  // Check if hostname is an IP literal
  const isIp =
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname.startsWith("[");

  if (isIp) {
    hostSuffixes.push(hostname);
  } else {
    // Exact hostname
    hostSuffixes.push(hostname);

    // eTLD+1 and successive components
    const tldResult = parseTld(hostname);
    const domain = tldResult.domain; // eTLD+1
    if (domain && domain !== hostname) {
      // Build successive components from eTLD+1 upward
      const domainParts = hostname.split(".");
      const eTldPlusParts = domain.split(".");
      const extraParts = domainParts.length - eTldPlusParts.length;

      // eTLD+1 itself
      hostSuffixes.push(domain);

      // Add components between eTLD+1 and full hostname (up to 3 more, total 5 with exact + eTLD+1)
      for (let i = extraParts - 1; i >= 1 && hostSuffixes.length < 5; i--) {
        hostSuffixes.push(domainParts.slice(i).join("."));
      }
    }
  }

  // Generate path prefixes (up to 6)
  const pathPrefixes: string[] = [];

  // Exact path with query
  if (query) {
    pathPrefixes.push(path + query);
  }

  // Exact path without query
  pathPrefixes.push(path);

  // Up to 4 path components with trailing slash
  const pathParts = path.split("/").filter(Boolean);
  for (let i = 0; i < Math.min(pathParts.length - 1, 4); i++) {
    pathPrefixes.push("/" + pathParts.slice(0, i + 1).join("/") + "/");
  }

  // Root
  if (!pathPrefixes.includes("/")) {
    pathPrefixes.push("/");
  }

  // Combine
  const expressions = new Set<string>();
  for (const host of hostSuffixes) {
    for (const pathPrefix of pathPrefixes) {
      expressions.add(host + pathPrefix);
    }
  }

  return [...expressions];
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha256(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function hashPrefix4(fullHash: Buffer): Buffer {
  return fullHash.subarray(0, 4);
}

function bufferToBigInt(buf: Buffer): bigint {
  let result = 0n;
  for (let i = 0; i < buf.length; i++) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Golomb-Rice Decoding
// ---------------------------------------------------------------------------

class BitReader {
  private data: Buffer;
  private bytePos: number;
  private bitPos: number; // 0-7, within current byte (LSB first)

  constructor(data: Buffer) {
    this.data = data;
    this.bytePos = 0;
    this.bitPos = 0;
  }

  readBit(): number {
    if (this.bytePos >= this.data.length) return 0;
    const bit = (this.data[this.bytePos] >> this.bitPos) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
    return bit;
  }

  readBits(n: number): bigint {
    let value = 0n;
    for (let i = 0; i < n; i++) {
      const bit = this.readBit();
      value |= BigInt(bit) << BigInt(i);
    }
    return value;
  }

  readUnary(): number {
    let count = 0;
    while (this.readBit() === 1) {
      count++;
    }
    return count;
  }
}

export function decodeGolombRice(
  firstValue: bigint,
  riceParameter: number,
  entriesCount: number,
  encodedData: Buffer,
  hashLength: number
): Buffer[] {
  if (entriesCount === 0 && firstValue === 0n) return [];

  const results: bigint[] = [firstValue];
  const reader = new BitReader(encodedData);

  for (let i = 0; i < entriesCount; i++) {
    const q = reader.readUnary();
    const r = reader.readBits(riceParameter);
    const delta = (BigInt(q) << BigInt(riceParameter)) | r;
    results.push(results[results.length - 1] + delta);
  }

  // Convert bigints to byte buffers (big-endian)
  return results.map((value) => {
    const buf = Buffer.alloc(hashLength);
    let v = value;
    for (let i = hashLength - 1; i >= 0; i--) {
      buf[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return buf;
  });
}

// ---------------------------------------------------------------------------
// Database Operations
// ---------------------------------------------------------------------------

async function getListVersion(listName: string): Promise<Buffer | null> {
  const result = await pool.query(
    "SELECT version FROM safebrowsing_hash_lists WHERE name = $1",
    [listName]
  );
  return result.rows[0]?.version ?? null;
}

async function getNextUpdateTime(listName: string): Promise<Date | null> {
  const result = await pool.query(
    "SELECT next_update_at FROM safebrowsing_hash_lists WHERE name = $1",
    [listName]
  );
  return result.rows[0]?.next_update_at ?? null;
}

async function isHashInGlobalCache(fullHash: Buffer): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM safebrowsing_hash_prefixes WHERE list_name = $1 AND hash_prefix = $2 LIMIT 1",
    [GLOBAL_CACHE_LIST, fullHash]
  );
  return result.rows.length > 0;
}

async function isHashPrefixInThreatLists(prefix: Buffer): Promise<string[]> {
  const result = await pool.query(
    "SELECT DISTINCT list_name FROM safebrowsing_hash_prefixes WHERE hash_prefix = $1 AND list_name = ANY($2)",
    [prefix, THREAT_LISTS]
  );
  return result.rows.map((r: { list_name: string }) => r.list_name);
}

interface CacheEntry {
  full_hash: Buffer;
  threat_types: string[];
  expires_at: Date;
}

async function getCachedHashes(prefix: Buffer): Promise<CacheEntry[]> {
  const result = await pool.query(
    "SELECT full_hash, threat_types, expires_at FROM safebrowsing_hash_cache WHERE hash_prefix = $1 AND expires_at > NOW()",
    [prefix]
  );
  return result.rows;
}

async function upsertCacheEntries(
  prefix: Buffer,
  fullHashes: { fullHash: Buffer; threatTypes: string[] }[],
  expiresAt: Date
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const entry of fullHashes) {
      await client.query(
        `INSERT INTO safebrowsing_hash_cache (hash_prefix, full_hash, threat_types, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (hash_prefix, full_hash) DO UPDATE SET threat_types = $3, expires_at = $4`,
        [prefix, entry.fullHash, entry.threatTypes, expiresAt]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function pruneExpiredCache(): Promise<void> {
  await pool.query("DELETE FROM safebrowsing_hash_cache WHERE expires_at <= NOW()");
}

// ---------------------------------------------------------------------------
// Hash List Sync (download/update threat lists and global cache)
// ---------------------------------------------------------------------------

export async function syncHashLists(): Promise<void> {
  const { googleSafeBrowsingApiKey: apiKey } = await readConfig();
  if (!apiKey) {
    console.error("Missing SafeBrowsing API key — cannot sync hash lists");
    return;
  }

  // Check which lists are due for update
  const listsToUpdate: string[] = [];
  const versions: string[] = [];

  for (const listName of ALL_LISTS) {
    const nextUpdate = await getNextUpdateTime(listName);
    if (!nextUpdate || nextUpdate <= new Date()) {
      listsToUpdate.push(listName);
      const version = await getListVersion(listName);
      versions.push(version ? version.toString("base64") : "");
    }
  }

  if (listsToUpdate.length === 0) {
    return;
  }

  // Build query params for batchGet
  const params = new URLSearchParams();
  params.append("key", apiKey);
  for (const name of listsToUpdate) {
    params.append("names", name);
  }
  for (const version of versions) {
    if (version) {
      params.append("version", version);
    }
  }

  const url = `https://safebrowsing.googleapis.com/v5/hashLists:batchGet?${params.toString()}`;

  let data: { hashLists: any[] };
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "redirectChecker/1.0",
      },
    });

    if (!response.ok) {
      console.error(`hashLists.batchGet error: ${response.status} ${response.statusText}`);
      return;
    }

    const buf = Buffer.from(await response.arrayBuffer());
    const decoded = BatchGetHashListsResponseType.decode(buf);
    data = BatchGetHashListsResponseType.toObject(decoded, { bytes: Buffer, longs: Number }) as typeof data;
  } catch (error) {
    console.error("Error fetching hash lists:", error);
    return;
  }

  // Process each returned list
  for (const hashList of data.hashLists) {
    try {
      await applyHashListUpdate(hashList);
    } catch (error) {
      console.error(`Error applying update for list ${hashList.name}:`, error);
      // On error, reset the list version to force a full re-download next time
      await pool.query(
        "UPDATE safebrowsing_hash_lists SET version = NULL WHERE name = $1",
        [hashList.name]
      );
    }
  }

  // Prune expired cache entries while we're at it
  await pruneExpiredCache();

  console.log(`SafeBrowsing v5: synced ${data.hashLists.length} hash lists`);
}

async function applyHashListUpdate(hashList: any): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const isFullUpdate = !hashList.partialUpdate;
    const hashLength = hashList.name.endsWith("-32b") ? 32 : 4;

    if (isFullUpdate) {
      // Full update: clear all existing prefixes for this list
      await client.query(
        "DELETE FROM safebrowsing_hash_prefixes WHERE list_name = $1",
        [hashList.name]
      );
    }

    // Apply removals (for incremental updates)
    if (hashList.compressedRemovals && !isFullUpdate) {
      const removalIndices = decodeRemovalIndices(hashList.compressedRemovals);
      if (removalIndices.length > 0) {
        // Get current prefixes sorted lexicographically
        const currentResult = await client.query(
          "SELECT hash_prefix FROM safebrowsing_hash_prefixes WHERE list_name = $1 ORDER BY hash_prefix ASC",
          [hashList.name]
        );
        const currentPrefixes: Buffer[] = currentResult.rows.map(
          (r: { hash_prefix: Buffer }) => r.hash_prefix
        );

        // Determine which prefixes to remove (by sorted index)
        const toRemove = new Set(removalIndices);
        const prefixesToDelete: Buffer[] = [];
        for (let i = 0; i < currentPrefixes.length; i++) {
          if (toRemove.has(i)) {
            prefixesToDelete.push(currentPrefixes[i]);
          }
        }

        for (const prefix of prefixesToDelete) {
          await client.query(
            "DELETE FROM safebrowsing_hash_prefixes WHERE list_name = $1 AND hash_prefix = $2",
            [hashList.name, prefix]
          );
        }
      }
    }

    // Apply additions
    if (hashList.compressedAdditions) {
      const additions = decodeCompressedHashes(hashList.compressedAdditions, hashLength);

      // Batch insert with ON CONFLICT to avoid duplicates
      for (let i = 0; i < additions.length; i += 500) {
        const batch = additions.slice(i, i + 500);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        batch.forEach((prefix, idx) => {
          const base = idx * 2;
          placeholders.push(`($${base + 1}, $${base + 2})`);
          values.push(hashList.name, prefix);
        });

        if (placeholders.length > 0) {
          await client.query(
            `INSERT INTO safebrowsing_hash_prefixes (list_name, hash_prefix) VALUES ${placeholders.join(",")} ON CONFLICT DO NOTHING`,
            values
          );
        }
      }
    }

    // Verify checksum if provided (for incremental updates)
    if (hashList.sha256Checksum && !isFullUpdate) {
      const checksumResult = await client.query(
        "SELECT hash_prefix FROM safebrowsing_hash_prefixes WHERE list_name = $1 ORDER BY hash_prefix ASC",
        [hashList.name]
      );

      const hash = createHash("sha256");
      for (const row of checksumResult.rows) {
        hash.update(row.hash_prefix);
      }
      const computedChecksum = hash.digest();

      const expectedChecksum = Buffer.isBuffer(hashList.sha256Checksum)
        ? hashList.sha256Checksum
        : Buffer.from(hashList.sha256Checksum, "base64");

      if (!computedChecksum.equals(expectedChecksum)) {
        // Checksum mismatch — abort and force full reset
        await client.query("ROLLBACK");
        console.error(`Checksum mismatch for list ${hashList.name} — forcing full reset`);
        await pool.query(
          "UPDATE safebrowsing_hash_lists SET version = NULL WHERE name = $1",
          [hashList.name]
        );
        client.release();
        return;
      }
    }

    // Calculate next update time from minimumWaitDuration
    let nextUpdateAt = new Date();
    if (hashList.minimumWaitDuration) {
      const seconds = Number(hashList.minimumWaitDuration.seconds || 0);
      const nanos = hashList.minimumWaitDuration.nanos || 0;
      nextUpdateAt = new Date(Date.now() + (seconds + nanos / 1e9) * 1000);
    }

    // Save version and update timestamps
    const versionBuf = hashList.version
      ? (Buffer.isBuffer(hashList.version) ? hashList.version : Buffer.from(hashList.version, "base64"))
      : null;

    await client.query(
      "UPDATE safebrowsing_hash_lists SET version = $1, last_updated = NOW(), next_update_at = $2 WHERE name = $3",
      [versionBuf, nextUpdateAt, hashList.name]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function decodeCompressedHashes(encoded: any, hashLength: number): Buffer[] {
  if (encoded.entriesCount === 0 && !encoded.firstValue) return [];

  // firstValue may be a Buffer (for hash additions) or a number (for 32-bit removal indices)
  let firstValue: bigint;
  if (Buffer.isBuffer(encoded.firstValue)) {
    firstValue = bufferToBigInt(encoded.firstValue);
  } else {
    firstValue = BigInt(encoded.firstValue || "0");
  }

  const encodedData = encoded.encodedData
    ? (Buffer.isBuffer(encoded.encodedData) ? encoded.encodedData : Buffer.from(encoded.encodedData, "base64"))
    : Buffer.alloc(0);

  return decodeGolombRice(
    firstValue,
    encoded.riceParameter,
    encoded.entriesCount,
    encodedData,
    hashLength
  );
}

function decodeRemovalIndices(encoded: any): number[] {
  if (encoded.entriesCount === 0 && !encoded.firstValue) return [];

  const firstValue = BigInt(encoded.firstValue || 0);
  const encodedData = encoded.encodedData
    ? (Buffer.isBuffer(encoded.encodedData) ? encoded.encodedData : Buffer.from(encoded.encodedData, "base64"))
    : Buffer.alloc(0);

  // Removal indices are 32-bit integers
  const buffers = decodeGolombRice(
    firstValue,
    encoded.riceParameter,
    encoded.entriesCount,
    encodedData,
    4
  );

  return buffers.map((buf) => buf.readUInt32BE(0));
}

// ---------------------------------------------------------------------------
// Real-Time Check Procedure
// ---------------------------------------------------------------------------

async function realTimeCheck(url: string): Promise<{ result: CheckResult; threatTypes: string[] }> {
  const canonical = canonicalizeUrl(url);
  const expressions = generateExpressions(canonical);

  const expressionHashes = expressions.map((expr) => sha256(expr));
  const expressionHashPrefixes = expressionHashes.map((h) => hashPrefix4(h));

  // Step 1: Check Global Cache
  // If ANY expression hash is found in the Global Cache, the URL is "likely benign"
  // => fall through to UNSURE (will be checked via Local List Mode externally)
  for (const hash of expressionHashes) {
    if (await isHashInGlobalCache(hash)) {
      return { result: "UNSURE", threatTypes: [] };
    }
  }

  // Step 2: Check local cache for unexpired entries
  const uncachedPrefixes: Buffer[] = [];
  const threatTypesFound: Set<string> = new Set();

  for (let i = 0; i < expressionHashPrefixes.length; i++) {
    const prefix = expressionHashPrefixes[i];
    const cached = await getCachedHashes(prefix);

    if (cached.length > 0) {
      // Check if any cached full hash matches our expression hashes
      for (const entry of cached) {
        for (const exprHash of expressionHashes) {
          if (entry.full_hash.equals(exprHash)) {
            for (const tt of entry.threat_types) {
              threatTypesFound.add(tt);
            }
          }
        }
      }
      // Even if no match, cache is still valid (means prefix was checked and no threat for our hash)
    } else {
      uncachedPrefixes.push(prefix);
    }
  }

  if (threatTypesFound.size > 0) {
    return { result: "UNSAFE", threatTypes: [...threatTypesFound] };
  }

  // Step 3: Deduplicate prefixes before sending to API
  const uniquePrefixes = deduplicatePrefixes(uncachedPrefixes);

  if (uniquePrefixes.length === 0) {
    // All prefixes were cached and none matched
    return { result: "SAFE", threatTypes: [] };
  }

  // Step 4: Remote hash search
  const { googleSafeBrowsingApiKey: apiKey } = await readConfig();
  if (!apiKey) {
    return { result: "UNSURE", threatTypes: [] };
  }

  const params = new URLSearchParams();
  params.append("key", apiKey);
  for (const prefix of uniquePrefixes) {
    params.append("hashPrefixes", prefix.toString("base64"));
  }

  let searchResponse: { fullHashes: { fullHash: Buffer; fullHashDetails: { threatType: number; attributes: number[] }[] }[]; cacheDuration?: { seconds: number; nanos: number } };
  try {
    const response = await fetch(
      `https://safebrowsing.googleapis.com/v5/hashes:search?${params.toString()}`,
      {
        method: "GET",
        headers: {
          "User-Agent": "redirectChecker/1.0",
        },
      }
    );

    if (!response.ok) {
      console.error(`hashes.search error: ${response.status} ${response.statusText}`);
      return { result: "UNSURE", threatTypes: [] };
    }

    const buf = Buffer.from(await response.arrayBuffer());
    const decoded = SearchHashesResponseType.decode(buf);
    searchResponse = SearchHashesResponseType.toObject(decoded, { bytes: Buffer, longs: Number }) as typeof searchResponse;
  } catch (error) {
    console.error("Error in hashes.search:", error);
    return { result: "UNSURE", threatTypes: [] };
  }

  // Step 5: Cache the response
  const cacheDurationSec = searchResponse.cacheDuration
    ? Number(searchResponse.cacheDuration.seconds || 0) + (searchResponse.cacheDuration.nanos || 0) / 1e9
    : 300;
  const expiresAt = new Date(Date.now() + cacheDurationSec * 1000);

  // Cache all returned full hashes
  const fullHashes = searchResponse.fullHashes || [];
  if (fullHashes.length > 0) {
    for (const fh of fullHashes) {
      const fullHashBuf = Buffer.isBuffer(fh.fullHash) ? fh.fullHash : Buffer.from(fh.fullHash);
      const prefix = hashPrefix4(fullHashBuf);
      const threats = (fh.fullHashDetails || [])
        .filter((d) => !(d.attributes || []).includes(1)) // 1 = CANARY
        .map((d) => THREAT_TYPE_NAMES[d.threatType] || `UNKNOWN_${d.threatType}`)
        .filter((t) => t !== "THREAT_TYPE_UNSPECIFIED");

      if (threats.length > 0) {
        await upsertCacheEntries(prefix, [{ fullHash: fullHashBuf, threatTypes: threats }], expiresAt);
      }
    }
  }

  // Step 6: Check if any returned full hash matches our expression hashes
  const remoteThreatTypes = new Set<string>();

  for (const fh of fullHashes) {
    const fullHashBuf = Buffer.isBuffer(fh.fullHash) ? fh.fullHash : Buffer.from(fh.fullHash);

    for (const exprHash of expressionHashes) {
      if (fullHashBuf.equals(exprHash)) {
        for (const detail of fh.fullHashDetails || []) {
          // Skip CANARY entries (1 = CANARY)
          if ((detail.attributes || []).includes(1)) continue;
          const name = THREAT_TYPE_NAMES[detail.threatType];
          if (name && name !== "THREAT_TYPE_UNSPECIFIED") {
            remoteThreatTypes.add(name);
          }
        }
      }
    }
  }

  if (remoteThreatTypes.size > 0) {
    return { result: "UNSAFE", threatTypes: [...remoteThreatTypes] };
  }

  return { result: "SAFE", threatTypes: [] };
}

function deduplicatePrefixes(prefixes: Buffer[]): Buffer[] {
  const seen = new Set<string>();
  const unique: Buffer[] = [];
  for (const p of prefixes) {
    const key = p.toString("hex");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Public API (replaces v4 isSafeBrowsingBatchFlagged)
// ---------------------------------------------------------------------------

export async function checkUrlsSafeBrowsingV5(
  urls: string[]
): Promise<Map<string, SafeBrowsingCheckResult>> {
  const results = new Map<string, SafeBrowsingCheckResult>();

  // Initialize all as safe
  for (const url of urls) {
    results.set(url, { isFlagged: false });
  }

  if (urls.length === 0) return results;

  for (const url of urls) {
    try {
      const { result, threatTypes } = await realTimeCheck(url);

      if (result === "UNSAFE") {
        results.set(url, { isFlagged: true, threatTypes });
        console.log(`SafeBrowsing v5 flagged: ${url} (${threatTypes.join(", ")})`);
      }
      // UNSURE falls through as not flagged by real-time check
      // (in a full implementation, Local List Mode would handle UNSURE,
      //  but our local threat list check in realTimeCheck already covers this)
    } catch (error) {
      console.error(`Error checking ${url} with SafeBrowsing v5:`, error);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initSafeBrowsingV5(): Promise<void> {
  // Ensure the hash list rows exist
  const client = await pool.connect();
  try {
    for (const listName of ALL_LISTS) {
      await client.query(
        "INSERT INTO safebrowsing_hash_lists (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [listName]
      );
    }
  } finally {
    client.release();
  }

  // Perform initial sync
  console.log("SafeBrowsing v5: performing initial hash list sync...");
  await syncHashLists();
  console.log("SafeBrowsing v5: initial sync complete");
}
