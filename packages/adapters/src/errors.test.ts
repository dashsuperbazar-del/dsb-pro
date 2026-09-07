import { describe, expect, it, vi } from 'vitest';
import { classifyError, errorMessage } from './errors';

describe('classifyError', () => {
  it('classifies a session error as auth-expired', () => {
    expect(classifyError(new Error('JWT expired'))).toBe('auth-expired');
  });

  it('classifies a fetch failure as server', () => {
    expect(classifyError(new Error('Failed to fetch'))).toBe('server');
  });

  it('classifies an RPC-raised business error as user', () => {
    expect(classifyError(new Error('invite invalid, expired, or already used'))).toBe('user');
  });

  it('classifies as offline when the browser reports offline, regardless of message', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(classifyError(new Error('anything'))).toBe('offline');
    vi.restoreAllMocks();
  });

  it('extracts the message from a bare PostgREST/RPC error object (not an Error instance)', () => {
    // supabase-js's default non-throwing path returns errors like this —
    // instanceof Error is false, which previously fell through to
    // String(error) and produced the literal "[object Object]".
    const rpcError = { message: 'invite invalid, expired, or already used', code: 'P0001' };
    expect(classifyError(rpcError)).toBe('user');
    expect(errorMessage('user', rpcError)).toBe('invite invalid, expired, or already used');
  });
});

describe('errorMessage', () => {
  it('passes the raw message through for user errors', () => {
    expect(errorMessage('user', new Error('not permitted'))).toBe('not permitted');
  });

  it('uses the fixed copy for the other three classes', () => {
    expect(errorMessage('offline', new Error('x'))).toMatch(/offline/i);
    expect(errorMessage('auth-expired', new Error('x'))).toMatch(/session expired/i);
    expect(errorMessage('server', new Error('x'))).toMatch(/try again/i);
  });
});
