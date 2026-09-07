// The four error classes are fixed by DSB_PRO_BUILD_PLAN.md §10: "one message
// per class, never 'Something went wrong'": user error (fix and retry) ·
// offline ("saved locally, will sync") · auth expired (re-login, draft kept) ·
// server error ("not saved; your draft is preserved"). This module maps
// whatever Supabase/network throws onto one of those four classes.
export type ErrorClass = 'user' | 'offline' | 'auth-expired' | 'server';

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function classifyError(error: unknown): ErrorClass {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline';
  }

  const message = messageOf(error).toLowerCase();

  if (
    message.includes('jwt expired') ||
    message.includes('invalid refresh token') ||
    message.includes('session missing') ||
    message.includes('not authenticated')
  ) {
    return 'auth-expired';
  }

  // Supabase Postgres errors we deliberately raise from RPCs (e.g. "invite
  // invalid, expired, or already used", "not permitted", "user already
  // belongs to a tenant") are always user-facing, correctable mistakes — a
  // Postgres error with no 5xx/network signal is a user error, not a server
  // error.
  if (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('failed to fetch')
  ) {
    return 'server';
  }

  return 'user';
}

const CLASS_MESSAGES: Record<ErrorClass, string> = {
  user: '',
  offline: "You're offline. Changes will sync once you're back online.",
  'auth-expired': 'Your session expired. Please sign in again.',
  server: "Something didn't save. Please try again in a moment.",
};

export function errorMessage(errorClass: ErrorClass, error: unknown): string {
  if (errorClass === 'user') return messageOf(error);
  return CLASS_MESSAGES[errorClass];
}
