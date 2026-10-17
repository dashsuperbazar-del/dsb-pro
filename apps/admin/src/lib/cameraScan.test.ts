import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cameraErrorMessage,
  cameraScanSupported,
  createStabilizer,
  normalizeScannedCode,
} from './cameraScan';

afterEach(() => vi.unstubAllGlobals());

describe('createStabilizer', () => {
  it('accepts a code only after consecutive identical reads', () => {
    const s = createStabilizer();
    expect(s(['8901234'])).toBeNull();
    expect(s(['8901234'])).toBe('8901234');
  });
  it('a different code in between restarts the count (one misread frame is never accepted)', () => {
    const s = createStabilizer();
    expect(s(['111'])).toBeNull();
    expect(s(['999'])).toBeNull();
    expect(s(['111'])).toBeNull();
    expect(s(['111'])).toBe('111');
  });
  it('two different labels in one frame is ambiguous and resets', () => {
    const s = createStabilizer();
    expect(s(['111'])).toBeNull();
    expect(s(['111', '222'])).toBeNull();
    expect(s(['111'])).toBeNull();
  });
  it('an empty frame resets and the same code twice in one frame is one read', () => {
    const s = createStabilizer();
    expect(s(['111', '111'])).toBeNull();
    expect(s([])).toBeNull();
    expect(s(['111'])).toBeNull();
    expect(s(['111'])).toBe('111');
  });
  it('can accept the same code again after returning it', () => {
    const s = createStabilizer();
    s(['5']);
    expect(s(['5'])).toBe('5');
    expect(s(['5'])).toBeNull();
    expect(s(['5'])).toBe('5');
  });
});

describe('normalizeScannedCode', () => {
  it('trims and refuses empty, over-long and control characters', () => {
    expect(normalizeScannedCode(' 123 ')).toBe('123');
    expect(normalizeScannedCode('   ')).toBeNull();
    expect(normalizeScannedCode('x'.repeat(65))).toBeNull();
    expect(normalizeScannedCode('12\n3')).toBeNull();
  });
});

describe('cameraScanSupported', () => {
  it('is false without BarcodeDetector and true with it plus getUserMedia', () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    expect(cameraScanSupported()).toBe(false);
    vi.stubGlobal('BarcodeDetector', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } });
    expect(cameraScanSupported()).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(cameraScanSupported()).toBe(false);
  });
});

describe('cameraErrorMessage', () => {
  it('explains denial, no camera, busy camera and the rest', () => {
    expect(cameraErrorMessage({ name: 'NotAllowedError' })).toMatch(/denied/);
    expect(cameraErrorMessage({ name: 'NotFoundError' })).toMatch(/No camera/);
    expect(cameraErrorMessage({ name: 'NotReadableError' })).toMatch(/in use/);
    expect(cameraErrorMessage(new Error('x'))).toMatch(/could not be started/);
  });
});
