export const EMOJI = {
  SAFEBROWSING: "<:google_safe_browsing:1347648584727662713>",
  NETCRAFT: "<:netcraft:1347647539616157787>",
  SMARTSCREEN: "<:ms_smartscreen:1347648053045231636>",
  DNS: "🌐",
};

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