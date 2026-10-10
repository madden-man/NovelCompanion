import { describe, expect, test } from 'vitest';
import { BibleSlug, slugify } from '../../src/shared/bible';
import { contentSecurityPolicy } from '../../src/shared/csp';

describe('ARCH-8 bible IDs', () => {
  test('ARCH-8 a bible ID is derived from its name', () => {
    expect(slugify('East Winds')).toBe('east-winds');
    expect(slugify('  Tide Lines: Book 1 ')).toBe('tide-lines-book-1');
    expect(slugify('Café Noël')).toBe('cafe-noel');
    expect(slugify('晓曦')).toBe('');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
  });

  test('ARCH-8 bible IDs are validated', () => {
    for (const ok of ['eastwinds', 'east-winds', 'b2', 'a_b'])
      expect(BibleSlug.safeParse(ok).success).toBe(true);
    for (const bad of ['', 'East', 'dot.name', '-x', 'x'.repeat(41), 'bibles', 'has space']) {
      expect(BibleSlug.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('ARCH-1 Content-Security-Policy', () => {
  test('ARCH-1 the built policy allows connections only to the app itself', () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain('ws:');
    expect(csp).not.toMatch(/https?:/);
  });

  test('ARCH-1 the development policy adds only local dev server needs and nothing remote', () => {
    const dev = contentSecurityPolicy(true);
    expect(dev).toContain("connect-src 'self' ws://localhost:*");
    expect(dev).not.toMatch(/https?:/);
    expect(dev).not.toMatch(/ws:\/\/(?!localhost:\*)/);
  });
});
