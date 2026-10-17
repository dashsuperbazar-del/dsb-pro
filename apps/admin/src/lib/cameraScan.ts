// Camera barcode scanning uses the browser's built-in BarcodeDetector only (no third-party decoder ships in
// the app). Where it is missing the scan button is simply not offered; typing and scanner-wedge entry keep
// working. A code is accepted only after the same value is read on 3 consecutive frames, so one misread frame
// can never add the wrong item to a bill.
export const REQUIRED_CONSECUTIVE_READS = 3;
// Retail product barcodes only; QR/Data Matrix text is never treated as an item code.
export const RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
export const MAX_CODE_LENGTH = 64;

type DetectorCtor = {
  new (opts?: { formats?: string[] }): {
    detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]>;
  };
  getSupportedFormats?: () => Promise<string[]>;
};

// The retail formats this browser can read, or null when it can read none of them.
export async function retailFormats(Detector: DetectorCtor): Promise<string[] | null> {
  if (typeof Detector.getSupportedFormats !== 'function') return RETAIL_FORMATS;
  const supported = await Detector.getSupportedFormats();
  const usable = RETAIL_FORMATS.filter((f) => supported.includes(f));
  return usable.length ? usable : null;
}

export function barcodeDetectorCtor(): DetectorCtor | null {
  const g = globalThis as unknown as { BarcodeDetector?: DetectorCtor };
  return typeof g.BarcodeDetector === 'function' ? g.BarcodeDetector : null;
}

export function cameraScanSupported(): boolean {
  return (
    barcodeDetectorCtor() !== null &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export function normalizeScannedCode(raw: string): string | null {
  const code = raw.trim();
  if (code === '' || code.length > MAX_CODE_LENGTH) return null;
  for (const ch of code) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return null;
  }
  return code;
}

// Feed one frame's reads; returns a code once it has been seen on enough consecutive frames.
export function createStabilizer(required = REQUIRED_CONSECUTIVE_READS) {
  let last: string | null = null;
  let count = 0;
  return (reads: string[]): string | null => {
    const codes = [...new Set(reads.map(normalizeScannedCode).filter((c): c is string => !!c))];
    // Several different codes in one frame is ambiguous (two labels in view): wait for a single one.
    if (codes.length !== 1) {
      last = null;
      count = 0;
      return null;
    }
    const code = codes[0]!;
    count = code === last ? count + 1 : 1;
    last = code;
    if (count >= required) {
      last = null;
      count = 0;
      return code;
    }
    return null;
  };
}

export function cameraErrorMessage(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  if ((e as { message?: string } | null)?.message === 'unsupported')
    return 'This browser cannot read shop barcodes with the camera. Type the barcode instead.';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera permission was denied. Allow it in the browser, or type the barcode instead.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No camera was found on this device. Type the barcode instead.';
  if (name === 'NotReadableError')
    return 'The camera is in use by another app. Close it and retry.';
  return 'The camera could not be started. Type the barcode instead.';
}
