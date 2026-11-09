import { useEffect, useRef, useState } from 'preact/hooks';
import { getDefaultShopId, openOrderPulse } from '@dsb-pro/adapters';

// Staff alert for online orders (old DSB badge + notify): polls a light read every 30 s and when the app comes back
// to the front. A NEW order that was not seen before beeps, vibrates and puts the count in the tab title. Nothing is
// stored on the server; "seen" is just this device's memory of order ids.
export type OrderPulse = { fresh: number; open: number; expiring: number };
const EXPIRING_MS = 10 * 60 * 1000;

export function summarise(
  rows: { id: string; status: string; expiresAt: string }[],
  now: number,
): OrderPulse {
  return {
    fresh: rows.filter((r) => r.status === 'NEW').length,
    open: rows.length,
    expiring: rows.filter(
      (r) =>
        ['NEW', 'CONFIRMED', 'PREPARING', 'READY'].includes(r.status) &&
        new Date(r.expiresAt).getTime() - now < EXPIRING_MS,
    ).length,
  };
}

/** Ids that are NEW now and were not NEW in the previous poll (the first poll never alerts). */
export function newlyArrived(
  prev: Set<string> | null,
  rows: { id: string; status: string }[],
): string[] {
  if (prev === null) return [];
  return rows.filter((r) => r.status === 'NEW' && !prev.has(r.id)).map((r) => r.id);
}

function beep() {
  try {
    const Ctx = (window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      typeof AudioContext | undefined;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
    o.onended = () => void ctx.close();
  } catch {
    /* sound is a convenience; the badge still shows */
  }
  try {
    navigator.vibrate?.([120, 80, 120]);
  } catch {
    /* no vibration on this device */
  }
}

export function useOrderAlerts(enabled: boolean): OrderPulse {
  const [pulse, setPulse] = useState<OrderPulse>({ fresh: 0, open: 0, expiring: 0 });
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let shop = '';
    const base = document.title.replace(/^\(\d+\) /, '');
    async function poll() {
      if (!navigator.onLine) return;
      try {
        shop ||= await getDefaultShopId();
        const rows = await openOrderPulse(shop);
        if (!live) return;
        if (newlyArrived(seen.current, rows).length) beep();
        seen.current = new Set(rows.filter((r) => r.status === 'NEW').map((r) => r.id));
        const p = summarise(rows, Date.now());
        setPulse(p);
        document.title = p.fresh ? `(${p.fresh}) ${base}` : base;
      } catch {
        /* orders not set up yet, or offline: show nothing */
      }
    }
    void poll();
    const t = setInterval(() => void poll(), 30000);
    const onShow = () => document.visibilityState === 'visible' && void poll();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
      document.title = base;
    };
  }, [enabled]);
  return pulse;
}
