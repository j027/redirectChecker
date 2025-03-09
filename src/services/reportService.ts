import { readConfig } from "../config.js";
import { fetch } from "undici";
import { discordClient } from "../discordBot.js";
import { TextChannel } from "discord.js";
import { userAgentService } from "./userAgentService.js";
import { enqueueReport } from "./batchReportService.js";
import { browserReportService } from "./browserReportService.js";

async function reportToGoogleSafeBrowsing(site: string) {
  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  // request format can be found here
  // https://github.com/chromium/suspicious-site-reporter/blob/444666114ec758df1c151514cfd9e2218141da42/extension/client_request.proto#L21
  const reportBody = [site, null];
  const additionalDetails = await browserReportService.collectSafeBrowsingReportDetails(site);

  // if we have the details, add them to the report
  if (additionalDetails != null) {
    reportBody.push(...additionalDetails);
  }

  try {
    const response = await fetch(
      "https://safebrowsing.google.com/safebrowsing/clientreport/crx-report",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": userAgent },
        body: JSON.stringify(reportBody),
      },
    );
    
    if (response.status === 200) {
      console.info(`Successfully reported to Google Safe Browsing: ${site}`);
    } else {
      // Try to include response body for better error context
      let responseText = '';
      try {
        responseText = await response.text();
        responseText = responseText ? ` - ${responseText}` : '';
      } catch (e) {
        // Ignore text extraction errors
      }
      console.error(`Google Safe Browsing report failed for ${site}: Status ${response.status}${responseText}`);
    }
  } catch (err) {
    console.error(`Error reporting to Google Safe Browsing: ${err}`);
  }
}

interface NetcraftApiResponse {
  message: string;
  uuid: string;
}

async function reportToNetcraft(site: string) {
  const { netcraftReportEmail } = await readConfig();

  const response = await fetch("https://report.netcraft.com/api/v3/report/urls", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: netcraftReportEmail,
      urls: [{ url: site, country: "US" }],
    }),
  }).then(r => r.json()) as NetcraftApiResponse;

  console.info(`Netcraft report message: ${response?.message} uuid: ${response?.uuid}`);
}

interface UrlscanResponse {
  message: string;
  uuid: string;
  visibility: string;
  url: string;
}

async function reportToUrlscan(site: string) {
  const { urlscanApiKey } = await readConfig();
  
  try {
    const response = await fetch("https://urlscan.io/api/v1/scan/", {
      method: "POST",
      headers: {
        "API-Key": urlscanApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: site,
        visibility: "public",
      }),
    });
    
    if (response.ok) {
      const data = await response.json() as UrlscanResponse;
      console.info(`Reported to URLScan: ${site} (uuid: ${data.uuid}, message: ${data.message})`);
    } else {
      console.error(`URLScan report failed for ${site}: ${response.status}`);
    }
  } catch (err) {
    console.error(`Error reporting to URLScan: ${err}`);
  }
}

interface VirusTotalResponse {
  data: {
    id: string;
    type: string;
  };
}

async function reportToVirusTotal(site: string) {
  const { virusTotalApiKey } = await readConfig();
  const response = await fetch("https://www.virustotal.com/api/v3/urls", {
    method: "POST",
    headers: {
      "x-apikey": virusTotalApiKey
    },
    body: new URLSearchParams({
      url: site
    })
  }).then(r => r.json()) as VirusTotalResponse;

  console.info(`VirusTotal report id: ${response?.data?.id}`);
}

interface KasperskyResponse {
  Zone?: string;
  UrlGeneralInfo?: {
    Url: string;
    Host: string;
    Categories: string[];
  };
}

async function reportToKaspersky(site: string) {
  const { kasperskyApiKey } = await readConfig();
  
  const url = new URL('https://opentip.kaspersky.com/api/v1/search/url');
  url.searchParams.append('request', site);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": kasperskyApiKey
      }
    });
    
    if (response.ok) {
      const data = await response.json() as KasperskyResponse;
      console.info(`Reported to Kaspersky: ${site} (Zone: ${data.Zone || 'unknown'})`);
    } else {
      console.error(`Kaspersky report failed for ${site}: ${response.status}`);
    }
  } catch (err) {
    console.error(`Error reporting to Kaspersky: ${err}`);
  }
}

interface MetaDefenderResponse {
  status: string;
  in_queue: number;
  queue_priority: string;
  sandbox_id: string;
}

async function reportToMetaDefender(site: string) {
  const { metaDefenderApiKey } = await readConfig();
  
  try {
    const response = await fetch("https://api.metadefender.com/v4/sandbox", {
      method: "POST",
      headers: {
        "apikey": metaDefenderApiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: site
      })
    });
    
    if (response.ok) {
      const data = await response.json() as MetaDefenderResponse;
      console.info(`Reported to MetaDefender: ${site} (sandbox_id: ${data.sandbox_id}, status: ${data.status})`);
    } else {
      console.error(`MetaDefender report failed for ${site}: ${response.status}`);
    }
  } catch (err) {
    console.error(`Error reporting to MetaDefender: ${err}`);
  }
}

interface CheckPhishResponse {
  jobID: string;
  timestamp: number;
}

async function reportToCheckPhish(site: string) {
  const { checkPhishApiKey } = await readConfig();
  
  try {
    const response = await fetch("https://developers.bolster.ai/api/neo/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: checkPhishApiKey,
        urlInfo: { url: site },
        scanType: "full"
      })
    });
    
    if (response.ok) {
      const data = await response.json() as CheckPhishResponse;
      console.info(`Reported to CheckPhish: ${site} (jobID: ${data.jobID})`);
    } else {
      console.error(`CheckPhish report failed for ${site}: ${response.status}`);
    }
  } catch (err) {
    console.error(`Error reporting to CheckPhish: ${err}`);
  }
}

interface HybridAnalysisResponse {
  job_id: string;
  submission_id: string;
  environment_id: number;
  sha256: string;
}

async function reportToHybridAnalysis(site: string) {
  const { hybridAnalysisApiKey } = await readConfig();

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }
  
  try {
    const response = await fetch("https://www.hybrid-analysis.com/api/v2/submit/url", {
      method: "POST",
      headers: {
        "api-key": hybridAnalysisApiKey,
        "User-Agent": userAgent,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        url: site,
        environment_id: "140" // win11 64bit
      })
    });
    
    if (response.ok) {
      const data = await response.json() as HybridAnalysisResponse;
      console.info(`Reported to Hybrid Analysis: ${site} (job_id: ${data.job_id})`);
    } else {
      console.error(`Hybrid Analysis report failed for ${site}: ${response.status} ${await response.text()}`);
    }
  } catch (err) {
    console.error(`Error reporting to Hybrid Analysis: ${err}`);
  }
}

export async function reportSite(site: string, redirect: string) {
  // report to google safe browsing, netcraft, virustotal, kaspersky, metadefender, microsoft smartscreen,
  // checkphish, hybrid analysis, and urlscan
  const reports = [];
  reports.push(reportToNetcraft(site));
  reports.push(reportToGoogleSafeBrowsing(site));
  reports.push(reportToVirusTotal(site));
  reports.push(reportToKaspersky(site));
  reports.push(reportToMetaDefender(site));
  reports.push(browserReportService.reportToSmartScreen(site));
  reports.push(reportToCheckPhish(site));
  reports.push(reportToHybridAnalysis(site));
  reports.push(reportToUrlscan(site));

  // send a message in the discord server with a link to the popup
  reports.push(sendMessageToDiscord(site, redirect));

  // crdf labs reports go into a queue that is reported every minute
  enqueueReport(site);

  // wait for all the reports to finish
  await Promise.allSettled(reports);
}

async function sendMessageToDiscord(site: string, redirect: string) {
  const { channelId } = await readConfig();
  const channel = discordClient.channels.cache.get(channelId) as TextChannel;
  if (channel) {
    await channel.send(`Found ${site} from ${redirect}`);
  } else {
    console.error("Channel not found");
  }
}
