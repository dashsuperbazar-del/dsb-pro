import { useEffect, useRef, useState } from 'preact/hooks';
import {
  barcodeDetectorCtor,
  cameraErrorMessage,
  cameraScanSupported,
  createStabilizer,
} from '../lib/cameraScan';

// A "Scan with camera" button that opens a live preview, reports one confirmed code, then closes and
// releases the camera. Rendered nothing at all where the browser cannot scan.
export function CameraScanner({
  onCode,
  disabled,
}: {
  onCode: (code: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    void (async () => {
      try {
        const Detector = barcodeDetectorCtor();
        if (!Detector) throw new Error('unsupported');
        const detector = new Detector();
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const el = video.current;
        if (!el) return release();
        el.srcObject = s;
        await el.play();
        const stable = createStabilizer();
        const tick = async () => {
          if (stopped) return;
          try {
            const found = await detector.detect(el);
            const code = stable(found.map((f) => f.rawValue));
            if (code && !stopped) {
              release();
              setOpen(false);
              onCodeRef.current(code);
              return;
            }
          } catch {
            // a frame that cannot be read is skipped; the next one is tried
          }
          if (!stopped) timer = setTimeout(() => void tick(), 200);
        };
        void tick();
      } catch (e) {
        if (!stopped) {
          release();
          setOpen(false);
          setError(cameraErrorMessage(e));
        }
      }
    })();
    return release;
  }, [open]);

  if (!cameraScanSupported()) return null;
  return (
    <span class="camera-scanner">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setError('');
          setOpen((o) => !o);
        }}
      >
        {open ? 'Stop camera' : 'Scan with camera'}
      </button>
      {open && (
        <video ref={video} playsInline muted aria-label="Camera preview" class="camera-preview" />
      )}
      {error && (
        <span class="alert" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
