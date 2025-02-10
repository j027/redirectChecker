interface ChromeRelease {
  version: string;
}

async function getLatestChromeVersion(): Promise<number> {
  const response = await fetch(
    "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1&offset=0",
  );

  if (!response.ok) {
    throw new Error("Failed to fetch Chrome version");
  }

  const [latest] = (await response.json()) as ChromeRelease[];
  return parseInt(latest.version.split(".")[0]);
}

// Helper function to get the latest Windows Chrome user agent
export async function getLatestWindowsChromeUserAgent(): Promise<string> {
  try {
    const version = await getLatestChromeVersion();
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
  } catch (error) {
    console.error("Error getting Chrome version:", error);
    // Fallback to a recent version if API fails
    return "";
  }
}
