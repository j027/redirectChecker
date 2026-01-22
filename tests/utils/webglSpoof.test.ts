import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Browser, BrowserContext, Page } from 'patchright';
import { spoofWebGL } from '../../src/utils/playwrightUtilities.js';
import { BrowserManagerService } from '../../src/services/browserManagerService.js';
import { WebGLConfig } from '../../src/utils/webglConfigs.js';

describe('WebGL Spoofing', () => {
  let browser: Browser;
  let context: BrowserContext;
  let browserInitializing = false;

  beforeAll(async () => {
    await BrowserManagerService.ensureBrowserHealth(
      null,
      browserInitializing,
      async () => {
        browserInitializing = true;
        browser = await BrowserManagerService.createBrowser();
        browserInitializing = false;
      }
    );
  });

  afterAll(async () => {
    if (browser) {
      await BrowserManagerService.closeBrowser(browser);
    }
  });

  beforeEach(async () => {
    context = await browser.newContext();
  });

  afterEach(async () => {
    if (context) {
      await context.close();
    }
  });

  /**
   * Extract WebGL info from browserleaks.com/webgl page
   */
  async function getWebGLInfoFromBrowserLeaks(page: Page): Promise<{ vendor: string; renderer: string }> {
    // Wait for the page to load the WebGL info
    await page.waitForSelector('table', { timeout: 10000 });
    
    return await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      
      let vendor = '';
      let renderer = '';
      
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const label = cells[0].textContent?.trim() || '';
          let value = cells[1].textContent?.trim() || '';
          
          // Remove "! " prefix that browserleaks adds for some unknown reasons
          if (value.startsWith('! ')) {
            value = value.substring(2);
          }
          
          if (label.includes('Unmasked Vendor')) {
            vendor = value;
          } else if (label.includes('Unmasked Renderer')) {
            renderer = value;
          }
        }
      }
      
      return { vendor, renderer };
    });
  }

  it('should spoof WebGL vendor and renderer as detected by browserleaks.com', async () => {
    const page = await context.newPage();
    
    const spoofConfig: WebGLConfig = {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    };

    await spoofWebGL(page, spoofConfig);
    await page.goto('https://browserleaks.com/webgl', { waitUntil: 'networkidle' });

    const detectedInfo = await getWebGLInfoFromBrowserLeaks(page);

    console.log('Expected:', spoofConfig);
    console.log('Detected:', detectedInfo);

    expect(detectedInfo.vendor).toBe(spoofConfig.vendor);
    expect(detectedInfo.renderer).toBe(spoofConfig.renderer);

    await page.close();
  }, 30000);

  it('should spoof with Intel GPU config', async () => {
    const page = await context.newPage();
    
    const spoofConfig: WebGLConfig = {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    };

    await spoofWebGL(page, spoofConfig);
    await page.goto('https://browserleaks.com/webgl', { waitUntil: 'networkidle' });

    const detectedInfo = await getWebGLInfoFromBrowserLeaks(page);

    console.log('Expected:', spoofConfig);
    console.log('Detected:', detectedInfo);

    expect(detectedInfo.vendor).toBe(spoofConfig.vendor);
    expect(detectedInfo.renderer).toBe(spoofConfig.renderer);

    await page.close();
  }, 30000);

  it('should spoof with AMD GPU config', async () => {
    const page = await context.newPage();
    
    const spoofConfig: WebGLConfig = {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)'
    };

    await spoofWebGL(page, spoofConfig);
    await page.goto('https://browserleaks.com/webgl', { waitUntil: 'networkidle' });

    const detectedInfo = await getWebGLInfoFromBrowserLeaks(page);

    console.log('Expected:', spoofConfig);
    console.log('Detected:', detectedInfo);

    expect(detectedInfo.vendor).toBe(spoofConfig.vendor);
    expect(detectedInfo.renderer).toBe(spoofConfig.renderer);

    await page.close();
  }, 30000);
});
