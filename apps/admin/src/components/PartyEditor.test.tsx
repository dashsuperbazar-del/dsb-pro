// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { PartyEditor } from './PartyEditor';

const host = document.createElement('div');
afterEach(() => act(() => render(null, host)));
const initial = {
  name: 'Sharma Traders',
  phone: '98765',
  gstin: '',
  address: '',
  creditLimitPaise: 150000,
  notes: '',
};
const input = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.trim().startsWith(label))!
    .querySelector('input,textarea') as HTMLInputElement;
async function type(label: string, value: string) {
  await act(async () => {
    const el = input(label);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function openIt() {
  await act(async () => {
    const d = host.querySelector('details')!;
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
  });
}
const submit = () =>
  act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

test('shows the current details and saves the edited ones', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    render(<PartyEditor kind="supplier" initial={initial} onSave={onSave} />, host),
  );
  expect(host.querySelector('form')).toBeNull(); // closed: no fields in the page
  await openIt();
  expect(input('Name').value).toBe('Sharma Traders');
  expect(host.textContent).not.toContain('Credit limit'); // suppliers have no credit limit
  await type('Name', 'Sharma & Sons');
  await type('Phone', '99999 11111');
  await submit();
  expect(onSave).toHaveBeenCalledWith({
    name: 'Sharma & Sons',
    phone: '99999 11111',
    gstin: '',
    address: '',
  });
  expect(host.querySelector('[role="status"]')?.textContent).toContain('saved');
});

test('a customer also edits the credit limit in rupees, sent as integer paise', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    render(<PartyEditor kind="customer" initial={initial} onSave={onSave} />, host),
  );
  await openIt();
  expect(input('Credit limit').value).toBe('1500.00');
  await type('Credit limit', '2500.50');
  await submit();
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ creditLimitPaise: 250050 }));
});

test('a blank credit limit means no limit (null), and an unset limit opens blank', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    render(
      <PartyEditor
        kind="customer"
        initial={{ ...initial, creditLimitPaise: null }}
        onSave={onSave}
      />,
      host,
    ),
  );
  await openIt();
  expect(input('Credit limit').value).toBe('');
  await submit();
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ creditLimitPaise: null }));
});

test('a bad credit limit is refused before anything is sent', async () => {
  const onSave = vi.fn();
  await act(async () =>
    render(<PartyEditor kind="customer" initial={initial} onSave={onSave} />, host),
  );
  await openIt();
  await type('Credit limit', 'abc');
  await submit();
  expect(onSave).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/credit limit/i);
});

test('a credit limit with more than two decimals is refused, never silently rounded', async () => {
  const onSave = vi.fn();
  await act(async () =>
    render(<PartyEditor kind="customer" initial={initial} onSave={onSave} />, host),
  );
  await openIt();
  await type('Credit limit', '1500.505');
  await submit();
  expect(onSave).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/credit limit/i);
});

test('a failed save shows the reason and keeps what was typed', async () => {
  const onSave = vi.fn().mockRejectedValue(new Error('Another customer already has this name.'));
  await act(async () =>
    render(<PartyEditor kind="customer" initial={initial} onSave={onSave} />, host),
  );
  await openIt();
  await type('Name', 'Asha');
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('already has this name');
  expect(input('Name').value).toBe('Asha');
});

test('a second submit while saving is ignored', async () => {
  let finish!: () => void;
  const onSave = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  await act(async () =>
    render(<PartyEditor kind="supplier" initial={initial} onSave={onSave} />, host),
  );
  await openIt();
  await submit();
  await submit();
  expect(onSave).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});

const archiveButton = () =>
  [...host.querySelectorAll('button')].find((b) => /^Archive /.test(b.textContent ?? ''));

test('there is no archive control unless the caller offers one', async () => {
  await act(async () =>
    render(<PartyEditor kind="supplier" initial={initial} onSave={vi.fn()} />, host),
  );
  await openIt();
  expect(archiveButton()).toBeUndefined();
});

test('archiving asks first, then archives, and a cancelled prompt does nothing', async () => {
  const onArchive = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    render(
      <PartyEditor kind="supplier" initial={initial} onSave={vi.fn()} onArchive={onArchive} />,
      host,
    ),
  );
  await openIt();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => archiveButton()!.click());
  expect(confirm).toHaveBeenCalled();
  expect(confirm.mock.calls[0]![0]).toContain('Sharma Traders');
  expect(onArchive).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => archiveButton()!.click());
  expect(onArchive).toHaveBeenCalledTimes(1);
  confirm.mockRestore();
});

test('a refused archive (the party has history) shows the reason and nothing else changes', async () => {
  const onArchive = vi
    .fn()
    .mockRejectedValue(new Error('This supplier has bills and cannot be archived.'));
  await act(async () =>
    render(
      <PartyEditor kind="supplier" initial={initial} onSave={vi.fn()} onArchive={onArchive} />,
      host,
    ),
  );
  await openIt();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => archiveButton()!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot be archived');
  expect(host.querySelector('form')).not.toBeNull();
});

test('a second archive click while archiving is ignored', async () => {
  let finish!: () => void;
  const onArchive = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  await act(async () =>
    render(
      <PartyEditor kind="customer" initial={initial} onSave={vi.fn()} onArchive={onArchive} />,
      host,
    ),
  );
  await openIt();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => archiveButton()!.click());
  await act(async () => archiveButton()?.click());
  expect(onArchive).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});
