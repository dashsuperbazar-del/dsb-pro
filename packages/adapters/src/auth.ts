import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient } from './client';

export type { Session };

export async function signUp(email: string, password: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.signUp({ email, password });
  if (error) throw error;
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

// Default scope is 'global' (signs this device out, matching a normal logout
// button). Task 6 passes 'others' for the self-revoke-a-lost-device case:
// Supabase can't selectively invalidate one OTHER session, but 'others'
// invalidates every session for this account except the current one, which
// is the closest real enforcement available without new backend work.
export async function signOut(scope: 'global' | 'local' | 'others' = 'global'): Promise<void> {
  const { error } = await getSupabaseClient().auth.signOut({ scope });
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthStateChange(cb: (session: Session | null) => void): () => void {
  const { data } = getSupabaseClient().auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

export function isEmailVerified(session: Session): boolean {
  return Boolean(session.user.email_confirmed_at);
}

export async function resendVerificationEmail(email: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.resend({ type: 'signup', email });
  if (error) throw error;
}

export async function resetPasswordForEmail(email: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email);
  if (error) throw error;
}
