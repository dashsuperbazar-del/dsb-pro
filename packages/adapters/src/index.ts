export { getSupabaseClient } from './client';
export type { ErrorClass } from './errors';
export { classifyError, errorMessage } from './errors';
export {
  signUp,
  signIn,
  signOut,
  getSession,
  onAuthStateChange,
  isEmailVerified,
  resendVerificationEmail,
  resetPasswordForEmail,
} from './auth';
export type { Session } from './auth';
export type { Membership, Invite, TenantUser } from './tenancy';
export {
  createTenant,
  getDefaultShopId,
  createInvite,
  revokeInvite,
  acceptInvite,
  setUserRole,
  getCurrentMembership,
  listTenantUsers,
  listInvites,
} from './tenancy';
