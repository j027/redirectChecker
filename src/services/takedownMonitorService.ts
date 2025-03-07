import pool from "../dbPool.js";
import dns from "dns";
import { promisify } from "util";
import { PatentHash } from "../utils/patentHash.js";
import { v4 as uuidv4 } from 'uuid';
import { lookup } from 'dns/promises';

// Configuration
const BATCH_SIZE = 500; // Maximum URLs to check in one SafeBrowsing batch

interface TakedownStatusRecord {
  id: number;
  redirect_destination_id: number;
  destination_url: string;
  safebrowsing_flagged_at: Date | null;
  netcraft_flagged_at: Date | null;
  smartscreen_flagged_at: Date | null;
  dns_unresolvable_at: Date | null;
  last_checked: Date;
  check_active: boolean;
}

// Interface for Netcraft API response
interface NetcraftApiResponse {
  patterns?: NetcraftPattern[];
}

interface NetcraftPattern {
  message_override: string;  // Description of the threat, e.g. "Suspected Tech Support Scam"
  pattern: string;           // Regex pattern to match URLs
  subtype: string;           // Subcategory of threat, e.g. "support"
  type: string;              // Main threat category, e.g. "scam"
}

interface SmartScreenRequest {
  correlationId: string;
  destination: {
    uri: string;
  };
  identity: {
    client: {
      version: string;
    };
    device: {
      id: string;
    };
    user: {
      locale: string;
    };
  };
  userAgent: string;
}

interface SmartScreenAuthObject {
  authId: string;
  hash: string;
  key: string;
}

interface SmartScreenResponse {
  responseCategory: string;
  allow: boolean;
}

export async function initTakedownStatusForDestination(destinationId: number, isPopup: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "INSERT INTO takedown_status (redirect_destination_id, check_active) VALUES ($1, $2) ON CONFLICT (redirect_destination_id) DO NOTHING",
      [destinationId, isPopup] // Only actively monitor popups by default
    );
  } catch (error) {
    console.error("Error initializing takedown status:", error);
  } finally {
    client.release();
  }
}

export async function monitorTakedownStatus(): Promise<void> {
  console.log("Starting takedown monitoring...");
  
  try {
    const destinations = await getDestinationsToCheck();
    
    if (destinations.length === 0) {
      return;
    }
    
    console.log(`Checking takedown status for ${destinations.length} destinations`);
    
    // Batch process SafeBrowsing checks
    await processSafeBrowsingChecks(destinations);
    
    // Process individual service checks concurrently (with rate limiting)
    const checks = destinations.map(async dest => {
      // Only check services that haven't been flagged yet
      const tasks: Promise<void>[] = [];
      
      // Check DNS resolvability first
      if (dest.dns_unresolvable_at === null) {
        tasks.push(checkDnsResolvability(dest));

        // only do other checks if dns is resolvable and the checks
        // haven't been flagged already
        if (dest.netcraft_flagged_at === null) {
          tasks.push(checkNetcraft(dest));
        }
        if (dest.smartscreen_flagged_at === null) {
          tasks.push(checkSmartScreen(dest));
        }
      }
      
      // Wait for all checks to complete
      await Promise.allSettled(tasks);
      
      // Update last_checked timestamp
      await updateLastChecked(dest.id);
    });
    
    // Process all checks with some concurrency control
    await processInBatches(checks, 10);
    
  } catch (error) {
    console.error("Error in takedown monitoring:", error);
  }
}

async function getDestinationsToCheck(): Promise<TakedownStatusRecord[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT ss.*, rd.destination_url 
      FROM takedown_status ss
      JOIN redirect_destinations rd ON ss.redirect_destination_id = rd.id
      WHERE ss.check_active = TRUE
    `);
    
    return result.rows;
  } finally {
    client.release();
  }
}


async function processSafeBrowsingChecks(destinations: TakedownStatusRecord[]): Promise<void> {
  // Only process destinations that haven't been flagged yet
  const urlsToCheck = destinations
    .filter(d => d.safebrowsing_flagged_at === null)
    .map(d => d.destination_url);
  
  if (urlsToCheck.length === 0) return;
  
  // Process in batches
  for (let i = 0; i < urlsToCheck.length; i += BATCH_SIZE) {
    const batch = urlsToCheck.slice(i, i + BATCH_SIZE);
    await checkSafeBrowsingBatch(batch);
  }
}

async function checkSafeBrowsingBatch(urls: string[]): Promise<void> {
  // TODO: Implement Google SafeBrowsing API call
  console.log(`Checking ${urls.length} URLs against SafeBrowsing`);
  
  // For each flagged URL, update the database
  const flaggedUrls: string[] = []; // This would come from the API response
  
  if (flaggedUrls.length > 0) {
    const client = await pool.connect();
    try {
      // For each flagged URL, update the database
      for (const url of flaggedUrls) {
        await client.query(`
          UPDATE takedown_status ss
          SET safebrowsing_flagged_at = NOW()
          FROM redirect_destinations rd 
          WHERE rd.id = ss.redirect_destination_id
          AND rd.destination_url = $1
        `, [url]);
      }
    } finally {
      client.release();
    }
  }
}

async function checkNetcraft(destination: TakedownStatusRecord): Promise<void> {
  try {
    console.log(`Checking Netcraft status for ${destination.destination_url}`);
    
    // Extract the base domain without the path
    const urlObj = new URL(destination.destination_url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
    
    // Encode the base URL in base64
    const encodedUrl = Buffer.from(baseUrl).toString('base64');
    
    // Construct the Netcraft API URL
    const netcraftApiUrl = `https://mirror2.extension.netcraft.com/check_url/v4/${encodedUrl}/dodns`;
    
    // Make the request to Netcraft API
    const response = await fetch(netcraftApiUrl);
    
    if (!response.ok) {
      console.log(`Netcraft API error: ${response.status} ${response.statusText}`);
      return;
    }
    
    const data = await response.json() as NetcraftApiResponse;
    
    // Check if there are any patterns to match against
    if (data.patterns && Array.isArray(data.patterns) && data.patterns.length > 0) {
      // Try to match each pattern against our full URL
      const isFlagged = data.patterns.some(patternObj => {
        try {
          // The pattern comes as base64 encoded regex string
          const regexStr = patternObj.pattern;
          const regex = new RegExp(regexStr);
          return regex.test(destination.destination_url);
        } catch (error) {
          console.error(`Error with Netcraft regex pattern: ${error}`);
          return false;
        }
      });
      
      // If flagged, update the database
      if (isFlagged) {
        const client = await pool.connect();
        try {
          await client.query(
            "UPDATE takedown_status SET netcraft_flagged_at = NOW() WHERE id = $1",
            [destination.id]
          );
          console.log(`Netcraft flagged: ${destination.destination_url}`);
        } finally {
          client.release();
        }
      }
    }
  } catch (error) {
    console.error(`Error checking Netcraft status for ${destination.destination_url}: ${error}`);
  }
}

export async function isSmartScreenFlagged(url: string): Promise<{
  isFlagged: boolean;
  category?: string;
}> {
  try {
    const urlObj = new URL(url);
    const normalizedHostPath = `${urlObj.hostname}${urlObj.pathname}`.toLowerCase();
    
    const payload: SmartScreenRequest = {
      correlationId: uuidv4(),
      destination: {
        uri: normalizedHostPath
      },
      identity: {
        client: {
          version: "1664"
        },
        device: {
          id: uuidv4()
        },
        user: {
          locale: "en-US"
        }
      },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
    };
    
    const payloadStr = JSON.stringify(payload);
    
    // Generate the authorization hash using the PatentHash utility
    const hashResult = PatentHash.hash(payloadStr);
    
    const authObj: SmartScreenAuthObject = {
      authId: "6D2E7D9C-1334-4FC2-A549-5EC504F0E8F1", // SmartScreen fixed auth ID
      hash: hashResult.hash,
      key: hashResult.key
    };
    
    // Create the authorization header
    const authHeader = "SmartScreenHash " + Buffer.from(JSON.stringify(authObj)).toString('base64');
    
    // Make request to SmartScreen API
    const response = await fetch("https://bf.smartscreen.microsoft.com/api/browser/Navigate/1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": authHeader,
        "User-Agent": payload.userAgent
      },
      body: payloadStr
    });
    
    if (!response.ok) {
      console.log(`SmartScreen API error: ${response.status} ${response.statusText}`);
      return { isFlagged: false };
    }
    
    const data = await response.json() as SmartScreenResponse;
    
    // Check if the URL is flagged by SmartScreen
    const isFlagged = !data.allow || 
        data.responseCategory === "Malicious" || 
        data.responseCategory === "Phishing";
        
    if (isFlagged) {
      console.log(`SmartScreen flagged: ${url} as ${data.responseCategory}`);
    }
    
    return { 
      isFlagged: isFlagged,
      category: data.responseCategory 
    };
  } catch (error) {
    console.error(`Error checking SmartScreen status for ${url}: ${error}`);
    return { isFlagged: false };
  }
}

async function checkSmartScreen(destination: TakedownStatusRecord): Promise<void> {
  const result = await isSmartScreenFlagged(destination.destination_url);
  
  // Only update database if SmartScreen flagged the URL
  if (result.isFlagged) {
    const client = await pool.connect();
    try {
      await client.query(
        "UPDATE takedown_status SET smartscreen_flagged_at = NOW() WHERE id = $1",
        [destination.id]
      );
    } finally {
      client.release();
    }
  }
}

// New function that only checks DNS and returns a result
export async function isDnsResolvable(url: string): Promise<boolean> {
  try {
    const hostname = new URL(url).hostname;
    await lookup(hostname);
    return true; // DNS resolved successfully
  } catch (error: unknown) {
    // Type-safe error handling
    if (error && typeof error === 'object' && 'code' in error) {
      const dnsError = error as NodeJS.ErrnoException;
      
      // Only ENOTFOUND means the domain truly doesn't exist
      if (dnsError.code === 'ENOTFOUND') {
        console.log(`DNS unresolvable (NXDOMAIN): ${url}`);
        return false;
      }
      
      // Other DNS errors (timeouts, server failures, etc.) are likely temporary
      console.log(`Temporary DNS error for ${url}: ${dnsError.code} - ${dnsError.message}`);
    } else {
      console.error(`Unknown DNS error type for ${url}:`, error);
    }
    
    // For all other errors, treat as "possibly resolvable" (temporary issue)
    return true;
  }
}

// Keep the original function but have it use the new one
async function checkDnsResolvability(destination: TakedownStatusRecord): Promise<void> {
  const isResolvable = await isDnsResolvable(destination.destination_url);
  
  // Only update database if DNS is unresolvable
  if (!isResolvable) {
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE takedown_status 
         SET dns_unresolvable_at = NOW(),
             check_active = FALSE
         WHERE id = $1`,
        [destination.id]
      );
      
      const hostname = new URL(destination.destination_url).hostname;
      console.log(`Marked ${hostname} as DNS unresolvable (NXDOMAIN)`);
    } finally {
      client.release();
    }
  }
}

async function updateLastChecked(statusId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE takedown_status SET last_checked = NOW() WHERE id = $1",
      [statusId]
    );
  } finally {
    client.release();
  }
}


async function processInBatches<T>(tasks: Promise<T>[], batchSize: number): Promise<T[]> {
  const results: T[] = [];
  
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
  }
  
  return results;
}