// @vitest-environment jsdom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { expect, test } from 'vitest';
import { useState } from 'preact/hooks';
import { useSearchSelects } from './searchSelect';

let picked = '';
function Page() {
  useSearchSelects();
  const [v, setV] = useState('');
  picked = v;
  return (
    <label>
      Supplier
      <select value={v} onChange={(e) => setV(e.currentTarget.value)}>
        <option value="">Choose…</option>
        <option value="a">Sunil jain</option>
        <option value="b">Goenka</option>
        <option value="c">Shyam</option>
      </select>
    </label>
  );
}

test('a "Choose…" list becomes a search box; typing filters and a pick sets the real select', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => render(<Page />, host));
  const input = host.querySelector<HTMLInputElement>('input.ss-input')!;
  expect(input).not.toBeNull();
  expect(host.querySelector('select')!.classList.contains('ss-native')).toBe(true);
  input.focus();
  input.value = 'go';
  input.dispatchEvent(new Event('input'));
  const hits = Array.from(host.querySelectorAll('.ss-list li')).map((li) => li.textContent);
  expect(hits).toEqual(['Goenka']);
  await act(async () => {
    host.querySelector('.ss-list li')!.dispatchEvent(new MouseEvent('mousedown'));
  });
  expect(picked).toBe('b');
  expect(input.value).toBe('Goenka');
  render(null, host);
});
