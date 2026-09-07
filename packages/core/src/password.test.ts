import { describe, expect, it } from 'vitest';
import { passwordStrength } from './password';

describe('passwordStrength', () => {
  it('rejects passwords shorter than 8 characters', () => {
    const result = passwordStrength('a1b2c3');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/8 characters/);
  });

  it('rejects passwords with no digit', () => {
    const result = passwordStrength('longenoughpassword');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/number/);
  });

  it('accepts a password with 8+ characters and at least one digit', () => {
    const result = passwordStrength('shop2026');
    expect(result.valid).toBe(true);
    expect(result.message).toBe('');
  });
});
