import { chromium, Browser, devices } from "patchright";
import { readConfig } from "../config.js";

export class BrowserRedirectService {
    private browser: Browser | null;

    constructor() {
        this.browser = null;
    }

    async init() {
        this.browser = await chromium.launch();
    }

    async handleRedirect(redirectUrl: string): Promise<string | null> {
        if (this.browser == null) {
            console.error("Browser has not been initialized - redirect handling failed");
            return null;
        }

        const { proxy } = await readConfig();

        // Parse proxy URL to extract username and password
        let proxyServer = proxy;
        let username = undefined;
        let password = undefined;
        
        try {
            const proxyUrl = new URL(proxy);
            
            // Check if there are auth credentials in the URL
            if (proxyUrl.username || proxyUrl.password) {
                username = decodeURIComponent(proxyUrl.username);
                password = decodeURIComponent(proxyUrl.password);
                
                // Reconstruct proxy URL without auth for server parameter
                proxyServer = `${proxyUrl.protocol}//${proxyUrl.host}${proxyUrl.pathname}${proxyUrl.search}`;
            }
        } catch (err) {
            console.error(`Failed to parse proxy URL: ${err}`);
        }
        
        // Create context with explicit auth parameters if available
        const context = await this.browser.newContext({
          proxy: {
            server: proxyServer,
            username,
            password,
          },
          ...devices["Desktop Chrome"],
        });

        const page = await context.newPage();

        try {
            await page.goto(redirectUrl, {waitUntil: "commit"});

            // wait for the url to change
            await page.waitForURL("**");
            const destinationUrl = page.url();

            return destinationUrl != redirectUrl ? destinationUrl : null;
        } catch (error) {
            console.log(`Error when handling redirect: ${error}`);
            return null;
        } finally {
            await page.close();
            await context.close();
        }
    }

    async close() {
        if (this.browser == null) {
            return;
        }

        await this.browser.close();
    }
}

export const browserRedirectService = new BrowserRedirectService();