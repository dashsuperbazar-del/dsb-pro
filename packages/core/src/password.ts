const MIN_LENGTH = 8;

// UI-only guidance (DSB_PRO_BUILD_PLAN.md §2: "JS validation is UX only") —
// Supabase Auth's configured policy (supabase/config.toml [auth],
// minimum_password_length / password_requirements) is the enforced source of
// truth; a signup can still fail server-side even if this passes, and that
// failure is surfaced through the normal error taxonomy (classifyError).
export function passwordStrength(password: string): { valid: boolean; message: string } {
  if (password.length < MIN_LENGTH) {
    return { valid: false, message: `Use at least ${MIN_LENGTH} characters.` };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Include at least one number.' };
  }
  return { valid: true, message: '' };
}
