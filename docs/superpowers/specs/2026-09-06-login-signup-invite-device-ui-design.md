# Login / Signup / Invite / Device UI — Design

Status: approved by user, ready for implementation planning.
Source of truth this design implements: `DSB_PRO_BUILD_PLAN.md` v1.5 §7.1, §8, §13 (Phase 1 gate item
"login/signup/invite/device UI"). Phase 1's tables, RPCs (`create_tenant`, `accept_invite`,
`set_user_role`, `revoke_invite`, `next_doc_no`), RLS, and pgTAP suite are assumed already built and
gate-verified — this spec covers only the UI layer that calls them, in `apps/admin` (Vite + Preact, no
shared `packages/ui` yet).

## 1. Scope

In scope: login, signup, the post-signup "no tenant yet" landing, create-tenant, invite creation /
sharing / acceptance, a Team management screen (owner-only), and device registration / listing /
revocation (self-service + owner-wide).

Explicitly out of scope for this spec (deferred):
- **TOTP** enrollment/verification for owners — `§8` lists it as optional and it isn't in the Phase 1
  gate. Gets its own spec when an owner actually needs it.
- **Multi-shop assignment UI** — `§11` confirms v1 UI uses one shop per tenant even though the schema
  allows many. Invites auto-assign the tenant's single shop; a shop picker is Phase 8 work.
- **Local-data purge on device revocation** — depends on the Dexie mirror/outbox that Phase 4 builds.
  This spec defines the intended behavior (§6) and ships the part that already works today
  (forced logout via the auth/RLS check); the purge step is wired in when Phase 4 lands.

## 2. Screens & routing

Route resolution is driven by auth state + tenant membership, checked in that order:

| State | Route shown |
|---|---|
| Not logged in | Login (default), with a link to Signup |
| Logged in, zero tenant memberships | No-tenant landing: "Create your shop" / "Have an invite code?" |
| Logged in, has a tenant, email unverified | Normal app + persistent dismissible verification banner |
| Logged in, has a tenant, email verified | Normal app, no banner |
| This device has been revoked | Full-screen "removed" notice, forced logout (see §6) |

Team and Devices are not new top-level nav items. They live under the existing mobile-first bottom
nav's "More" tab (`§10`), as two rows inside Settings.

## 3. Login / Signup

**Login:** email + password. "Forgot password?" uses Supabase Auth's standard reset-email flow — this
is the account holder recovering their *own* address, not an invite being delivered to someone else,
so depending on email here is fine (unlike invites, §4).

Errors map onto the build plan's fixed taxonomy (`§10`), never a generic message:
- Wrong credentials → user error ("Incorrect email or password").
- No network and no usable cached session → offline ("You're offline. Connect to sign in.").
- Session dies mid-action elsewhere in the app → auth-expired (redirect to login, any in-progress
  draft preserved, per §10's rule).

**Signup:** email + password + confirm, with inline password-strength validation (Supabase Auth's
configured policy is the enforced source of truth; the UI mirrors it for immediate feedback, never
invents a stricter client-only rule). On success, the user lands directly on the no-tenant landing
screen (§4) — no email-verification gate in front of it, per §6.

## 4. No-tenant landing & create-tenant

Shown whenever a logged-in user has zero tenant memberships (fresh signup, or an existing user who
left/was removed from their only tenant). Always presents both paths side by side, never forces a
branch earlier at signup time:

- **Create your shop** — one field, shop name, calls `create_tenant()`. Nothing else is asked here;
  GSTIN, address, invoice prefix, etc. are prompted later from Settings when a feature first needs
  them (e.g. the first invoice). The creator becomes `owner`.
- **Have an invite code?** — a code input, calls `accept_invite(code)`.

## 5. Invites & Team screen (owner-only)

One screen, three parts, all backed by the already-built RPCs:

**Invite button** opens a modal asking only for a role (`manager` / `cashier` / `accountant`) — no
shop picker (§1), no email field. Submitting returns a short code and a link
(`dsbpro.in/join/<code>`) with copy and WhatsApp-share buttons. No email address is required to send
it: the owner shares the code/link through whatever channel they already use. The `send-invite` edge
function (`DSB_PRO_BUILD_PLAN.md` §4) remains available as an optional convenience email if the owner
chooses to add one, but is never the only delivery path.

Invite codes are **single-use and unbound to any specific email** — whoever calls `accept_invite()`
with a valid, unexpired code first claims that role and shop assignment, and the code is then consumed
(cannot be reused). The owner's own label for the invite (e.g. "for Ramesh") is just a display note in
the pending-invites list, not an enforcement mechanism.

**Pending invites list:** code, assigned role, created date, expiry, a revoke action
(`revoke_invite`).

**Active members list:** name/email, role (owner can change via `set_user_role`), a status toggle
(deactivate / reactivate), and remove.

**Accept-invite deep link:** opening `/join/<code>` while logged out routes through login-or-signup
first, carrying the code through the redirect, then auto-submits `accept_invite(code)` once the user
is authenticated — so a shared link works whether the recipient already has an account or not.

## 6. Devices

A `devices` row is created silently on first successful login per browser/device — no naming prompt at
registration (avoids adding friction to the login moment). It's auto-labeled from a browser/OS guess
(e.g. "Chrome on Android"); any user can rename their own device afterward from the device list, once
it's actually useful to tell devices apart.

**My devices** (Settings, every role): the signed-in user's own device(s) only — rename, revoke ("log
this device out remotely"). This is the self-service device RLS pattern already in place; no new
permission tier needed.

**All devices** (Team screen, owner only): every tenant member's devices, grouped by user, showing
last_seen and app_version, with a revoke action — matching the incident-response runbook's
owner-level "Revoke a device" action (`DSB_PRO_BUILD_PLAN.md` §14/runbook list).

**Revocation semantics:** because the app is offline-first, revocation cannot reach a device instantly
— it takes effect the next time that device contacts the server (auth refresh, sync attempt, or
realtime channel). At that point the device is forced to log out with "This device was removed.
Contact your shop owner," and — once Phase 4's Dexie mirror/outbox exists — its local data is also
purged, trading any unsynced offline drafts on that device for not leaving customer/financial data
readable indefinitely on a lost or stolen device. Phase 1 ships the forced-logout half of this (already
enforceable via the auth/RLS check); the purge half is wired in when Phase 4 lands and gets verified
then, not assumed working before it exists.

## 7. Cross-cutting rules

- **Email verification** is a soft gate: a persistent, dismissible banner nags an unverified user
  app-wide, but only two actions are hard-blocked until verified — sending an invite, and exporting
  data. Everything else (billing, browsing, creating the tenant itself) works unverified.
- Every screen in this spec follows the build plan's blanket UI rules (`§10`) with no auth-screen
  carve-out: Hindi/English strings from day one, dark mode, empty/loading/error states, focus and
  contrast basics, and a Playwright smoke test per screen.
- Role visibility: Team screen and the all-devices view are owner-only, matching §8's role table
  ("owner: + settings/users/exports/void"). No new permission code names are introduced — visibility
  follows the existing role check.

## 8. Explicitly deferred (not this spec)

- TOTP enrollment/verification (§1).
- Multi-shop picker on the invite form (§1).
- Local Dexie/outbox purge on device revocation — defined here, implemented and gate-tested in Phase 4
  (§6).
- Owner-configurable invite expiry length, GSTIN/address collection at tenant creation, and any
  billing/plan UI — none are called for by the Phase 1 gate.
