// @vitest-environment jsdom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { expect, test } from 'vitest';
import { useInfoNotes } from './infoNotes';

function Page() {
  useInfoNotes();
  return (
    <section>
      <h2>Pay supplier</h2>
      <p class="hint">Saved on this device first.</p>
      <div>
        <p class="hint">No heading here.</p>
      </div>
    </section>
  );
}

test('a hint is tied to its heading and shown as a floating note on tap; another tap hides it', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => render(<Page />, host));
  const h2 = host.querySelector('h2')!;
  // The second hint has no sibling heading: the section heading explains both.
  expect(h2.dataset.info?.split(' ').length).toBe(2);
  expect(h2.getAttribute('aria-describedby')).toBe(h2.dataset.info);
  h2.click();
  const card = document.querySelector('.info-float')!;
  expect(card.textContent).toContain('Saved on this device first.');
  expect(card.textContent).toContain('No heading here.');
  document.body.click();
  expect(document.querySelector('.info-float')).toBeNull();
  render(null, host);
});

function Field() {
  useInfoNotes();
  return (
    <section>
      <h2>Units</h2>
      <label>
        Small unit <input />
        <small class="hint field">Only the big unit is needed.</small>
      </label>
    </section>
  );
}

test('a field hint gets its own ⓘ beside the field and leaves the heading alone', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => render(<Field />, host));
  expect(host.querySelector('h2')!.dataset.info).toBeUndefined();
  const dot = host.querySelector<HTMLElement>('label .info-dot')!;
  expect(dot.tagName).toBe('SPAN');
  dot.click();
  expect(document.querySelector('.info-float')!.textContent).toBe('Only the big unit is needed.');
  document.body.click();
  render(null, host);
});
