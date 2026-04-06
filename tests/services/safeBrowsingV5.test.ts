import { describe, it, expect } from 'vitest';
import {
  canonicalizeUrl,
  generateExpressions,
  decodeGolombRice,
} from '../../src/services/safeBrowsingV5Service.js';

describe('SafeBrowsing V5 Service', () => {
  
  describe('URL Canonicalization', () => {
    
    it('should remove tabs, CR, and LF', () => {
      const result = canonicalizeUrl('http://example\t.\rcom\n/path');
      expect(result).toBe('example.com/path');
    });

    it('should remove fragment', () => {
      const result = canonicalizeUrl('http://example.com/path#frag');
      expect(result).toBe('example.com/path');
    });

    it('should repeatedly percent-unescape', () => {
      // %25 is %, so %2541 -> %41 -> A
      const result = canonicalizeUrl('http://example.com/%2541');
      expect(result).toBe('example.com/A');
    });

    it('should strip leading/trailing dots from hostname', () => {
      const result = canonicalizeUrl('http://..example.com../path');
      expect(result).toBe('example.com/path');
    });

    it('should collapse consecutive dots', () => {
      const result = canonicalizeUrl('http://example..com/path');
      expect(result).toBe('example.com/path');
    });

    it('should lowercase hostname', () => {
      const result = canonicalizeUrl('http://EXAMPLE.COM/Path');
      expect(result).toBe('example.com/Path');
    });

    it('should resolve /../ in path', () => {
      const result = canonicalizeUrl('http://example.com/a/b/../c');
      expect(result).toBe('example.com/a/c');
    });

    it('should resolve /./ in path', () => {
      const result = canonicalizeUrl('http://example.com/a/./b');
      expect(result).toBe('example.com/a/b');
    });

    it('should collapse consecutive slashes', () => {
      const result = canonicalizeUrl('http://example.com/a//b///c');
      expect(result).toBe('example.com/a/b/c');
    });

    it('should ensure path starts with /', () => {
      const result = canonicalizeUrl('http://example.com');
      expect(result).toBe('example.com/');
    });

    it('should preserve query parameters', () => {
      const result = canonicalizeUrl('http://example.com/path?foo=bar');
      expect(result).toBe('example.com/path?foo=bar');
    });

    it('should handle URL without scheme', () => {
      const result = canonicalizeUrl('example.com/path');
      expect(result).toBe('example.com/path');
    });
  });

  describe('Expression Generation', () => {
    
    it('should generate expressions for simple URL', () => {
      const expressions = generateExpressions('example.com/');
      expect(expressions).toContain('example.com/');
    });

    it('should generate host suffixes and path prefixes for a.b.com/1/2.html?param=1', () => {
      const expressions = generateExpressions('a.b.com/1/2.html?param=1');
      
      // From the Google spec example
      expect(expressions).toContain('a.b.com/1/2.html?param=1');
      expect(expressions).toContain('a.b.com/1/2.html');
      expect(expressions).toContain('a.b.com/');
      expect(expressions).toContain('a.b.com/1/');
      expect(expressions).toContain('b.com/1/2.html?param=1');
      expect(expressions).toContain('b.com/1/2.html');
      expect(expressions).toContain('b.com/');
      expect(expressions).toContain('b.com/1/');
    });

    it('should generate expressions for IP address', () => {
      const expressions = generateExpressions('1.2.3.4/1/');
      
      expect(expressions).toContain('1.2.3.4/1/');
      expect(expressions).toContain('1.2.3.4/');
      // IP addresses should NOT generate host suffixes
      expect(expressions.length).toBeLessThanOrEqual(6);
    });

    it('should handle eTLD+1 correctly for co.uk', () => {
      const expressions = generateExpressions('example.co.uk/1');
      
      expect(expressions).toContain('example.co.uk/1');
      expect(expressions).toContain('example.co.uk/');
      // co.uk is the eTLD, so example.co.uk IS the eTLD+1, no further suffixes
    });

    it('should limit host suffixes to 5', () => {
      const expressions = generateExpressions('a.b.c.d.e.f.com/1.html');
      
      // Should include exact hostname
      expect(expressions).toContain('a.b.c.d.e.f.com/1.html');
      // Should include eTLD+1 (f.com)
      expect(expressions).toContain('f.com/1.html');
      
      // Count unique hosts
      const hosts = new Set(expressions.map(e => e.split('/')[0]));
      expect(hosts.size).toBeLessThanOrEqual(5);
    });
  });

  describe('Golomb-Rice Decoding', () => {
    
    it('should return empty array for zero entries with zero first value', () => {
      const result = decodeGolombRice(0n, 30, 0, Buffer.alloc(0), 4);
      expect(result).toEqual([]);
    });

    it('should return single entry when entriesCount is 0 but firstValue is non-zero', () => {
      const result = decodeGolombRice(0x1d32c508n, 30, 0, Buffer.alloc(0), 4);
      expect(result.length).toBe(1);
      expect(result[0].toString('hex')).toBe('1d32c508');
    });

    it('should decode the Google spec example correctly', () => {
      // From the spec: hash prefixes 0x1d32c508, 0x291bc542, 0xf7a502e5
      // firstValue = 0x1d32c508 (489866504)
      // riceParameter = 30
      // entriesCount = 2
      // encodedData = "t\x00\xd2\x97\x1b\xedIt\x00" (base64: dADSly3tSXQA)
      const encodedData = Buffer.from([0x74, 0x00, 0xd2, 0x97, 0x1b, 0xed, 0x49, 0x74, 0x00]);
      
      const result = decodeGolombRice(
        0x1d32c508n,
        30,
        2,
        encodedData,
        4
      );

      expect(result.length).toBe(3);
      expect(result[0].toString('hex')).toBe('1d32c508');
      expect(result[1].toString('hex')).toBe('291bc542');
      expect(result[2].toString('hex')).toBe('f7a502e5');
    });
  });
});
