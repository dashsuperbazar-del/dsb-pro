import { describe, expect, it } from 'vitest';
import { toSlug, makeTenantSlug } from './slug';

describe('toSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(toSlug("Ramesh's Store")).toBe('ramesh-s-store');
  });

  it('collapses repeated separators and trims edges', () => {
    expect(toSlug('  Hello   World!! ')).toBe('hello-world');
  });

  it('returns "shop" for input with no alphanumeric characters', () => {
    expect(toSlug('!!!')).toBe('shop');
  });
});

describe('makeTenantSlug', () => {
  it('appends a random suffix so two shops with the same name never collide', () => {
    const a = makeTenantSlug('Ramesh Store');
    const b = makeTenantSlug('Ramesh Store');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ramesh-store-[a-z0-9]{4}$/);
  });
});
