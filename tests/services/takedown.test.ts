import { describe, it, expect } from 'vitest';
import {
  isDnsResolvable,
  isSmartScreenFlagged,
  isNetcraftFlagged,
  isSafeBrowsingBatchFlagged,
} from "../../src/services/takedownMonitorService.js";

describe('Takedown Service Tests', () => {
  
  describe('DNS Resolvability', () => {
    
    it('should confirm a valid domain is resolvable', async () => {
      // Test with a known-good domain
      const result = await isDnsResolvable('https://www.google.com');
      expect(result).toBe(true);
    });
    
    it('should confirm a non-existent domain is unresolvable', async () => {
      // Test with a domain that should not exist
      // Using random string to ensure it doesn't resolve
      const randomDomain = `test-${Math.random().toString(36).substring(2, 10)}-nonexistent.com`;
      const result = await isDnsResolvable(`https://${randomDomain}`);
      expect(result).toBe(false);
    });
    
    it('should handle invalid URLs gracefully', async () => {
      // Should not throw and return a sensible default (true treats as possibly working)
      try {
        const result = await isDnsResolvable('not-a-valid-url');
        // If it didn't throw, we expect it handled the error
        expect(typeof result).toBe('boolean');
      } catch (error) {
        // If it throws, the test fails
        expect(true).toBe(false); // Force test to fail
      }
    });
  });
  
  describe('SmartScreen Detection', () => {
    
    // This test may be flaky due to external API dependency
    it('should identify a safe website', async () => {
      const result = await isSmartScreenFlagged('https://www.microsoft.com');
      expect(result.isFlagged).toBe(false);
    }, 10000); // Increase timeout for API call
    
    // This test uses Microsoft's demonstration phishing page
    it('should identify Microsoft test phishing page', async () => {
      const result = await isSmartScreenFlagged('https://nav.smartscreen.msft.net/phishingdemo.html');
      expect(result.isFlagged).toBe(true);
      expect(result.category).toBe('Phishing');
    }, 10000); // Increase timeout for API call
    
    // This test uses Microsoft's demonstration malware page
    it('should identify Microsoft test malware page', async () => {
      const result = await isSmartScreenFlagged('https://nav.smartscreen.msft.net/other/malware.html');
      expect(result.isFlagged).toBe(true);
      expect(result.category).toBe('Malicious');
    }, 10000); // Increase timeout for API call
    
    it('should handle network errors gracefully', async () => {
      // Testing with a URL that won't connect
      const result = await isSmartScreenFlagged('https://this-is-not-a-real-domain-name-that-exists-anywhere.com');
      // Should return not flagged on error
      expect(result.isFlagged).toBe(false);
    }, 10000);
  });

  describe('Netcraft Detection', () => {
  
    it('should identify a safe website', async () => {
      const result = await isNetcraftFlagged('https://www.microsoft.com');
      expect(result).toBe(false);
    }, 10000);
    
    it('should identify Netcraft test phishing URL', async () => {
      // This is Netcraft's test URL for phishing detection
      const result = await isNetcraftFlagged('https://www.examp1eb4nk.com/');
      
      // This URL should be flagged by Netcraft
      expect(result).toBe(true);
    }, 15000); // Longer timeout as Netcraft API can be slow
    
    it('should handle network errors gracefully', async () => {
      // Testing with a URL that won't connect
      const result = await isNetcraftFlagged('https://not-even-a-real-tld.INVALID');
      expect(result).toBe(false);
    });
    
    it('should handle malformed URLs without crashing', async () => {
      const result = await isNetcraftFlagged('not-a-valid-url');
      // Even though URL is invalid, the function should gracefully handle it
      expect(typeof result).toBe('boolean');
    });
  });

  describe('SafeBrowsing Detection', () => {
  
    it('should identify a safe website', async () => {
      const urls = ['https://www.google.com'];
      const results = await isSafeBrowsingBatchFlagged(urls);
      const result = results.get(urls[0]);
      
      expect(result?.isFlagged).toBe(false);
    }, 10000);
    
    it('should identify Google test malware URL', async () => {
      const urls = ['https://testsafebrowsing.appspot.com/s/malware.html'];
      const results = await isSafeBrowsingBatchFlagged(urls);
      const result = results.get(urls[0]);
      
      expect(result?.isFlagged).toBe(true);
      expect(result?.threatTypes).toContain('MALWARE');
    }, 10000);
    
    it('should process multiple URLs in one batch', async () => {
      const urls = [
        'https://www.google.com',                                // safe
        'https://testsafebrowsing.appspot.com/s/malware.html',   // malware
        'https://testsafebrowsing.appspot.com/s/phishing.html'   // phishing
      ];
      
      const results = await isSafeBrowsingBatchFlagged(urls);
      
      // Safe URL should not be flagged
      expect(results.get(urls[0])?.isFlagged).toBe(false);
      
      // Malware URL should be flagged
      expect(results.get(urls[1])?.isFlagged).toBe(true);
      expect(results.get(urls[1])?.threatTypes).toContain('MALWARE');
      
      // Phishing URL should be flagged
      expect(results.get(urls[2])?.isFlagged).toBe(true);
      expect(results.get(urls[2])?.threatTypes).toContain('SOCIAL_ENGINEERING');
    }, 10000);
    
    it('should handle empty URL arrays', async () => {
      const results = await isSafeBrowsingBatchFlagged([]);
      expect(results.size).toBe(0);
    });
  });
});