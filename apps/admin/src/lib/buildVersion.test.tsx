// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render } from 'preact';
import { buildVersionJson, resolveCommit, shortCommit } from './buildVersion';
import { BuildVersion } from '../components/BuildVersion';

const SHA = '84969ec0123456789abcdef0123456789abcdef0';
test('the commit comes from GITHUB_SHA, else git, else "unknown"', () => {
  expect(resolveCommit(SHA, () => 'ignored')).toBe(SHA);
  expect(resolveCommit(undefined, () => `${SHA}\n`)).toBe(SHA);
  expect(resolveCommit('', () => SHA)).toBe(SHA);
  // Anything that is not a commit id (or git failing) never ends up in the page.
  expect(resolveCommit('<script>', () => 'not a sha')).toBe('unknown');
  expect(
    resolveCommit(undefined, () => {
      throw new Error('no git');
    }),
  ).toBe('unknown');
});
test('version.json holds the commit and the build time', () => {
  expect(JSON.parse(buildVersionJson(SHA, '2026-10-20T10:00:00.000Z'))).toEqual({
    commit: SHA,
    builtAt: '2026-10-20T10:00:00.000Z',
  });
});
test('Settings shows the short commit in plain words', () => {
  expect(shortCommit(SHA)).toBe('84969ec');
  expect(shortCommit('unknown')).toBe('unknown');
  const host = document.createElement('div');
  render(<BuildVersion commit={SHA} builtAt="2026-10-20T10:00:00.000Z" />, host);
  expect(host.textContent).toContain('App version 84969ec');
  expect(host.textContent).toContain('built 2026-10-20');
  render(<BuildVersion />, host);
  // The running build's own marker (vite define), never empty.
  expect(host.textContent).toMatch(/App version ([0-9a-f]{7}|unknown)/);
});
