import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('produces an 11-character id', () => {
    expect(generatePublicId()).toHaveLength(11);
  });

  it('produces only URL-safe characters', () => {
    // base64url uses [A-Za-z0-9_-] — no '+', '/' or '=' that would need
    // percent-encoding in a path segment.
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('does not repeat across a large batch', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generatePublicId());
    }

    expect(ids.size).toBe(1000);
  });
});
