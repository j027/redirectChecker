import { Browser, Page } from "patchright";
import crypto from "crypto";
import { blockGoogleAnalytics, parseProxy, spoofWindowsChrome } from "../utils/playwrightUtilities.js";

export class AdSpyGlassHunter {
  private browser: Browser | null = null;

  constructor(browser: Browser) {
    this.browser = browser;
  }

  async huntAdSpyGlassAds() {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - AdSpyGlass hunter failed"
      );
      return false;
    }

    let site = this.getRandomWebsite();

    const context = await this.browser.newContext({
        proxy: await parseProxy(true),
        viewport: null
    })

    const page = await context.newPage();
    const popupPromises: Promise<void>[] = [];

    try {
        await spoofWindowsChrome(context, page);
        await blockGoogleAnalytics(page);

        await page.goto(site, {
            waitUntil: "load",
            timeout: 60000
        });

        // setup the popup listener before we do any clicking
        context.on("page", (page: Page) => {popupPromises.push(this.handleAdClick(page))});

        // Navigate to video page without clicking to avoid popunder
        try {
            const videos = page.locator('a[href*="video/"]');
            const videoCount = await videos.count();
            
            if (videoCount > 0) {
                // Get the href attribute from the first video link
                const videoUrl = await videos.first().getAttribute('href');
                
                if (videoUrl) {
                    // Handle relative URLs
                    const fullVideoUrl = videoUrl.startsWith('http') 
                        ? videoUrl 
                        : new URL(videoUrl, site).toString();
                    
                    console.log(`Navigating to video page: ${fullVideoUrl}`);
                    
                    // Navigate instead of clicking to avoid popunder
                    await page.goto(fullVideoUrl, {
                        waitUntil: "load",
                        timeout: 30000
                    });
                    
                    // Now look for iframe in video-embedded div and click multiple times
                    const videoEmbeddedDiv = page.locator('div.video-embedded');
                    const iframe = videoEmbeddedDiv.locator('iframe');
                    
                    if (await iframe.count() > 0) {
                        const frameLocator = page.frameLocator('div.video-embedded iframe');
                        
                        // Click multiple times with delays to trigger ads
                        for (let i = 0; i < 5; i++) {
                            try {
                                await frameLocator.locator('body').click({ 
                                    timeout: 5000,
                                    force: true 
                                });
                                
                                await page.waitForTimeout(2000 + Math.random() * 1000);
                                
                            } catch (clickError) {
                                console.log(`Iframe click ${i + 1} failed:`, clickError);
                            }
                        }
                    }
                }
            } else {
                console.log("No video links found");
            }
        } catch (error) {
            console.log("Error navigating to video page:", error);
        }
    }
    catch (error) {
        console.error("Error navigating to site with AdSpyGlass ads:", error);
        return false;
    }

    try {
        await Promise.all(popupPromises);
    }
    catch (error) {
        console.error("Error handling adspyglass popup ads:", error);
        return false;
    } finally {
        await page.close();
        await context.close();
    }

    // if we got here, we probably found some ads and didn't break anything
    return true;
  }

  private async handleAdClick(page: Page): Promise<void> {
    await spoofWindowsChrome(page.context(), page);
    await blockGoogleAnalytics(page);

    let screenshot: Buffer | null = null;
    let html: string | null = null;
    let redirectionPath: string[] | null = null;
  }

  private getRandomWebsite() {
    const adSpyGlassWebsites = [
      "https://reallifecam.to/",
      "https://camcaps.to/",
    ];

    const randomWebsite = adSpyGlassWebsites[crypto.randomInt(adSpyGlassWebsites.length)];
    return randomWebsite;
  }
}