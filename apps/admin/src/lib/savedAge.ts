/** How long ago a device copy was saved, in plain words ("saved 5 minutes ago"). Unknown/invalid time
 * (a copy saved by an older app version) says so instead of guessing. */
export function savedAgo(savedAt: string | null | undefined, now: number = Date.now()): string {
  const at = savedAt ? Date.parse(savedAt) : NaN;
  if (!Number.isFinite(at)) return 'saved at an unknown time';
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'saved just now';
  if (minutes < 60) return `saved ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `saved ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `saved ${days} day${days === 1 ? '' : 's'} ago`;
}
