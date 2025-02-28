import { chromium, Browser } from "patchright";
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
        const context = await this.browser.newContext({
            proxy: {
                server: proxy
            },
        });
        const page = await context.newPage();

        try {
            await page.goto(redirectUrl);

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