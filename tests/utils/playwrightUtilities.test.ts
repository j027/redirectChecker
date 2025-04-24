import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Browser, BrowserContext, Page } from 'patchright';
import { trackRedirectionPath } from '../../src/utils/playwrightUtilities.js';
import { BrowserManagerService } from '../../src/services/browserManagerService.js';

describe('Redirect Path Tracker', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let browserInitializing = false;

  beforeAll(async () => {
    // Use BrowserManagerService instead of direct chromium.launch
    await BrowserManagerService.ensureBrowserHealth(
      null, 
      browserInitializing, 
      async () => {
        browserInitializing = true;
        const newBrowser = await BrowserManagerService.createBrowser();
        browserInitializing = false;
        browser = newBrowser;
      }
    );
    context = await browser.newContext();
  });

  afterAll(async () => {
    if (browser) {
      await BrowserManagerService.closeBrowser(browser);
    }
  });

  beforeEach(async () => {
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) {
      await page.close();
    }
  });

  it('should track HTTP 301/302 redirect chains', async () => {
    // httpbin.org provides redirect services for testing
    const startUrl = 'https://httpbin.org/redirect/3';
    const redirectTracker = trackRedirectionPath(page, startUrl);
    
    await page.goto(startUrl, { waitUntil: 'networkidle' });
    
    const redirectPaths = redirectTracker.getPath();
    console.log('Redirect paths captured:', redirectPaths);
    
    // Should include the initial URL + 3 redirects
    expect(redirectPaths.length).toBeGreaterThanOrEqual(4);
    
    // First URL should be our starting point
    expect(redirectPaths[0]).toBe(startUrl);
    
    // Final URL should be different from the start
    expect(redirectPaths[redirectPaths.length - 1]).not.toBe(startUrl);
  }, 30000); // Increase timeout for this test

  it('should track JavaScript client-side redirects', async () => {
    // Create a page with a JavaScript redirect
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head>
        <script>
          setTimeout(() => {
            window.location.href = 'https://example.com';
          }, 100);
        </script>
      </head>
      <body>Redirecting...</body>
      </html>
    `);
    
    const redirectTracker = trackRedirectionPath(page, page.url());
    
    // Wait for navigation to complete
    await page.waitForURL('https://example.com/**');
    
    const redirectPaths = redirectTracker.getPath();
    console.log('Client-side redirect paths:', redirectPaths);
    
    // Should have at least 2 URLs (start + destination)
    expect(redirectPaths.length).toBeGreaterThanOrEqual(2);
    
    // Last URL should be example.com
    expect(redirectPaths[redirectPaths.length - 1]).toContain('example.com');
  });
});