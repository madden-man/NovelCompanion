import { describe, expect, test } from 'vitest';
import { EXTERNAL_HOSTS, checkExternalUrl } from '../../src/main/links';

describe('ARCH-1 external links', () => {
  test('ARCH-1 only allowlisted https hosts are opened', () => {
    expect([...EXTERNAL_HOSTS].sort()).toEqual(['console.anthropic.com', 'github.com'].sort());
    for (const host of EXTERNAL_HOSTS) {
      expect(checkExternalUrl(`https://${host}/some/path?x=1`)).toEqual({
        ok: true,
        url: `https://${host}/some/path?x=1`,
      });
    }
  });

  test('ARCH-1 every other link is refused with a plain message', () => {
    for (const bad of [
      'https://example.com/',
      'https://evil.github.com.example/',
      'https://docs.google.com.evil.example/',
      'https://notgithub.com/',
      'http://github.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pw@github.com/',
      'https://github.com:8443/',
      'not a url',
    ]) {
      const r = checkExternalUrl(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/^The app|^That link/);
    }
  });
});
