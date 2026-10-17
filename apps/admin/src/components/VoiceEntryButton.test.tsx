// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { VoiceEntryButton } from './VoiceEntryButton';

const host = document.createElement('div');
let last: { onresult: (e: unknown) => void; onend: () => void; onerror: (e: unknown) => void };
beforeEach(() => document.body.append(host));
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
  vi.unstubAllGlobals();
});

test('hidden without speech recognition', async () => {
  await act(async () => render(<VoiceEntryButton onText={() => {}} />, host));
  expect(host.querySelector('button')).toBeNull();
});

test('reports the heard text once and resets after the recogniser ends', async () => {
  vi.stubGlobal(
    'webkitSpeechRecognition',
    class {
      start = vi.fn();
      stop = vi.fn();
      constructor() {
        last = this as never;
      }
    },
  );
  const onText = vi.fn();
  await act(async () => render(<VoiceEntryButton onText={onText} />, host));
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain('Stop listening');
  await act(async () => {
    last.onresult({ results: [[{ transcript: 'oil 2' }]] });
    last.onend();
  });
  expect(onText).toHaveBeenCalledWith('oil 2');
  expect(host.textContent).toContain('Speak line');
  await act(async () => host.querySelector('button')!.click());
  await act(async () => {
    last.onerror({ error: 'not-allowed' });
    last.onend();
  });
  expect(host.textContent).toContain('Microphone permission was denied');
});
