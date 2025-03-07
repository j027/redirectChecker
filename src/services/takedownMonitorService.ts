import pool from "../dbPool.js";
import dns from "dns";
import { promisify } from "util";

// DNS lookup as a promise
const dnsLookup = promisify(dns.lookup);

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


export async function initTakedownStatusForDestination(destinationId: number, isPopup: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    // Only create takedown status entry if it doesn't exist yet
    const result = await client.query(
      "SELECT * FROM takedown_status WHERE redirect_destination_id = $1",
      [destinationId]
    );
    
    if (result.rows.length === 0) {
      // Initialize takedown status entry - set check_active based on popup status
      await client.query(
        "INSERT INTO takedown_status (redirect_destination_id, check_active) VALUES ($1, $2)",
        [destinationId, isPopup] // Only actively monitor popups by default
      );
    }
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
      }
      
      // Don't perform other checks if DNS is unresolvable
      if (dest.dns_unresolvable_at === null) {
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
      AND (NOW() - ss.last_checked > INTERVAL '4 hours' 
           OR ss.last_checked IS NULL)
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
  // TODO: Implement Netcraft check
  console.log(`Checking Netcraft status for ${destination.destination_url}`);
  
  // If flagged, update the database
  const isFlagged = false; // This would come from the API
  
  if (isFlagged) {
    const client = await pool.connect();
    try {
      await client.query(
        "UPDATE takedown_status SET netcraft_flagged_at = NOW() WHERE id = $1",
        [destination.id]
      );
    } finally {
      client.release();
    }
  }
}

async function checkSmartScreen(destination: TakedownStatusRecord): Promise<void> {
  // TODO: Implement SmartScreen check
  console.log(`Checking SmartScreen status for ${destination.destination_url}`);
  
  // If flagged, update the database
  const isFlagged = false; // This would come from the API
  
  if (isFlagged) {
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

async function checkDnsResolvability(destination: TakedownStatusRecord): Promise<void> {
  const url = new URL(destination.destination_url);
  const hostname = url.hostname;
  
  try {
    await dnsLookup(hostname);
    // DNS resolved successfully
  } catch (error) {
    // DNS resolution failed, mark as unresolvable
    const client = await pool.connect();
    try {
      await client.query(`
        UPDATE takedown_status 
        SET dns_unresolvable_at = NOW(),
            check_active = FALSE
        WHERE id = $1
      `, [destination.id]);
      
      console.log(`Marked ${hostname} as DNS unresolvable`);
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