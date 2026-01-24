export const EMOJI = {
  SAFEBROWSING: "<:google_safe_browsing:1347648584727662713>",
  NETCRAFT: "<:netcraft:1347647539616157787>",
  SMARTSCREEN: "<:ms_smartscreen:1347648053045231636>",
  DNS: "🌐",
  // Signal emojis (compact icons)
  FULLSCREEN: "📺",
  KEYBOARD_LOCK: "⌨️",
  POINTER_LOCK: "🖱️",
  THIRD_PARTY: "🏠",
  IP_ADDRESS: "🔢",
  PAGE_FROZEN: "🧊",
  WORKER_BOMB: "💣",
};

/**
 * Signal data from database columns
 */
export interface SignalData {
  fullscreen: boolean;
  keyboardLock: boolean;
  pointerLock: boolean;
  thirdPartyHosting: boolean;
  ipAddress: boolean;
  pageFrozen: boolean;
  workerBomb: boolean;
}

/**
 * Formats detected signals into a compact emoji string
 * @param signals The signal data from the database
 * @returns A compact string of signal emojis, or empty string if no signals
 */
export function formatSignals(signals: SignalData): string {
  const signalEmojis: string[] = [];
  
  if (signals.fullscreen) signalEmojis.push(EMOJI.FULLSCREEN);
  if (signals.keyboardLock) signalEmojis.push(EMOJI.KEYBOARD_LOCK);
  if (signals.pointerLock) signalEmojis.push(EMOJI.POINTER_LOCK);
  if (signals.thirdPartyHosting) signalEmojis.push(EMOJI.THIRD_PARTY);
  if (signals.ipAddress) signalEmojis.push(EMOJI.IP_ADDRESS);
  if (signals.pageFrozen) signalEmojis.push(EMOJI.PAGE_FROZEN);
  if (signals.workerBomb) signalEmojis.push(EMOJI.WORKER_BOMB);
  
  return signalEmojis.join('');
}

/**
 * Formats confidence score as a percentage string
 * @param confidence The confidence score (0-1)
 * @returns Formatted percentage string like "95%"
 */
export function formatConfidence(confidence: number | null): string {
  if (confidence === null) return 'N/A';
  return `${Math.round(confidence * 100)}%`;
}

export function formatTimeDifference(startDate: Date, endDate: Date): string {
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  
  const days = Math.floor(diffSeconds / 86400);
  const hours = Math.floor((diffSeconds % 86400) / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  
  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    return `${diffSeconds}s`;
  }
}

export function formatUrl(url: string): { display: string, full: string } {
  try {
    const urlObj = new URL(url);
    return {
      display: urlObj.hostname,
      full: url
    };
  } catch {
    // If URL parsing fails, return the original
    return {
      display: url,
      full: url
    };
  }
}