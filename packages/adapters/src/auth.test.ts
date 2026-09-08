import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __setSupabaseClientForTest } from './client';
import {
  signUp,
  signIn,
  signOut,
  getSession,
  isEmailVerified,
  resendVerificationEmail,
  resetPasswordForEmail,
} from './auth';

function makeMockClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      signUp: vi.fn().mockResolvedValue({ error: null }),
      signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      resend: vi.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
      ...overrides,
    },
  };
}

describe('auth adapter', () => {
  beforeEach(() => {
    __setSupabaseClientForTest(makeMockClient() as never);
  });

  it('signUp calls supabase.auth.signUp with email/password', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await signUp('a@example.com', 'shop2026');
    expect(client.auth.signUp).toHaveBeenCalledWith({ email: 'a@example.com', password: 'shop2026' });
  });

  it('signUp throws the underlying error on failure', async () => {
    const client = makeMockClient({
      signUp: vi.fn().mockResolvedValue({ error: new Error('already registered') }),
    });
    __setSupabaseClientForTest(client as never);
    await expect(signUp('a@example.com', 'shop2026')).rejects.toThrow();
  });

  it('signIn calls supabase.auth.signInWithPassword', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await signIn('a@example.com', 'shop2026');
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@example.com',
      password: 'shop2026',
    });
  });

  it('signOut defaults to scope "global"', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await signOut();
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
  });

  it('signOut passes through an explicit scope', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await signOut('others');
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('getSession returns the session from supabase', async () => {
    const fakeSession = { user: { id: 'u1' } };
    const client = makeMockClient({
      getSession: vi.fn().mockResolvedValue({ data: { session: fakeSession }, error: null }),
    });
    __setSupabaseClientForTest(client as never);
    await expect(getSession()).resolves.toBe(fakeSession);
  });

  it('isEmailVerified reads email_confirmed_at off the session user', () => {
    expect(isEmailVerified({ user: { email_confirmed_at: '2026-01-01' } } as never)).toBe(true);
    expect(isEmailVerified({ user: { email_confirmed_at: null } } as never)).toBe(false);
  });

  it('resendVerificationEmail calls supabase.auth.resend with type "signup"', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await resendVerificationEmail('a@example.com');
    expect(client.auth.resend).toHaveBeenCalledWith({ type: 'signup', email: 'a@example.com' });
  });

  it('resetPasswordForEmail calls supabase.auth.resetPasswordForEmail', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await resetPasswordForEmail('a@example.com');
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith('a@example.com');
  });
});
