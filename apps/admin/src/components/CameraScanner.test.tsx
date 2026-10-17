// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { CameraScanner } from './CameraScanner';

const host = document.createElement('div');
const stop = vi.fn();
let detect: ReturnType<typeof vi.fn>;
const getUserMedia = vi.fn();
const button = () => host.querySelector('button')!;

beforeEach(() => {
  document.body.append(host);
  stop.mockReset();
  detect = vi.fn().mockResolvedValue([]);
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop }] });
  vi.stubGlobal(
    'BarcodeDetector',
    class {
      detect = detect;
    },
  );
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
  vi.unstubAllGlobals();
});

test('renders nothing where the browser cannot scan', async () => {
  vi.stubGlobal('BarcodeDetector', undefined);
  await act(async () => render(<CameraScanner onCode={() => {}} />, host));
  expect(host.querySelector('button')).toBeNull();
});

test('reports one code after two consistent frames, then releases the camera', async () => {
  const onCode = vi.fn();
  detect.mockResolvedValue([{ rawValue: '8901234' }]);
  await act(async () => render(<CameraScanner onCode={onCode} />, host));
  await act(async () => button().click());
  await vi.waitFor(() => expect(onCode).toHaveBeenCalledWith('8901234'), { timeout: 3000 });
  expect(onCode).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalled();
  expect(host.querySelector('video')).toBeNull();
});

test('a denied camera shows a plain message and nothing is reported', async () => {
  const onCode = vi.fn();
  getUserMedia.mockRejectedValue({ name: 'NotAllowedError' });
  await act(async () => render(<CameraScanner onCode={onCode} />, host));
  await act(async () => button().click());
  await vi.waitFor(() => expect(host.textContent).toContain('Camera permission was denied'));
  expect(onCode).not.toHaveBeenCalled();
});

test('stopping the camera releases the stream', async () => {
  await act(async () => render(<CameraScanner onCode={() => {}} />, host));
  await act(async () => button().click());
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  await act(async () => button().click());
  expect(stop).toHaveBeenCalled();
});

test('becoming disabled closes the camera and reports nothing', async () => {
  const onCode = vi.fn();
  detect.mockResolvedValue([{ rawValue: '8901234' }]);
  await act(async () => render(<CameraScanner onCode={onCode} />, host));
  await act(async () => button().click());
  await act(async () => render(<CameraScanner onCode={onCode} disabled />, host));
  expect(host.querySelector('video')).toBeNull();
  await new Promise((r) => setTimeout(r, 800));
  expect(onCode).not.toHaveBeenCalled();
});

test('a browser that reads no retail format says so instead of scanning', async () => {
  vi.stubGlobal(
    'BarcodeDetector',
    Object.assign(
      class {
        detect = detect;
      },
      { getSupportedFormats: async () => ['qr_code'] },
    ),
  );
  await act(async () => render(<CameraScanner onCode={() => {}} />, host));
  await act(async () => button().click());
  await vi.waitFor(() => expect(host.textContent).toContain('cannot read shop barcodes'));
  expect(getUserMedia).not.toHaveBeenCalled();
});
