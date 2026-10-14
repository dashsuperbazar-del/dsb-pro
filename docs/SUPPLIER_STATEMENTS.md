# Supplier statements (DW3)

From Suppliers → select supplier → Ledger, prepare a statement with optional From and required
Through business dates. The initial period is all recorded history through the shop's current
business date. Both endpoints are inclusive; an empty period still carries the exact server opening
and closing. Date edits immediately invalidate the prepared output. Prepare again to refresh.

The existing permission-checked `get_party_ledger_v2(shop, party, from, to)` returns the whole ledger
in one JSON value, including posted purchases, purchase returns, both payment directions and account
openings. Its server running/opening/closing integer-text paise values remain exact through BigInt
checks and string formatting; this feature never totals the separately loaded bills or payment list.
Shop profile is fetched fresh, with no cached/invented issuer fallback. No new migration, money RPC,
allocation rule, financial write, attachment download or secret is introduced.

Statements describe **current posted records for selected business dates**. Later voids restate this
history; it is not an original historical snapshot. Unconfirmed device entries are excluded.
Positive balances mean owed to supplier; negative balances mean credit/advance. Period, shop and
supplier identities, retrieved UTC timestamp, source basis, opening, every entry and closing travel
with text, CSV and print output. The timestamp is when the client retrieved the result, not a
server attestation or immutable financial cutoff. Shop header and financial read are separate reads.

Text sharing opens the browser's native share sheet where supported. Otherwise Copy text uses the
clipboard; failure offers full selectable text and Download text. Canceling a share produces no
error. No message is automatically sent and no contact/provider integration is added. CSV neutralizes
formula-like free text (including whitespace prefixes), preserves signed numeric decimal cells and
quotes commas/newlines. CSV bytes preserve arbitrary-size amounts; spreadsheet software can impose
its own precision limits. Download names use IDs and dates, not free-text filenames.

Print A4 / PDF uses Pro's existing A4 receipt layout and the browser's print dialog / Save as PDF.
A print-only receipt renders the same prepared immutable statement as the preview, with a shared
table renderer and Preact's text escaping. Includes full shop/supplier identities, source basis,
period, client-retrieved UTC time, opening, all rows and closing. On-screen controls and other shop
content are hidden in print; long references wrap and table headers repeat. The prepared receipt
is already rendered before the user clicks Print, with no asynchronous data/asset/window setup.
The existing compiled app stylesheet and strict hosting CSP remain; no new popup, script, image,
file download or security-policy relaxation is involved. Unavailable printing is reported and text
download remains available. Physical printer/device/share-provider acceptance remains a human gate.

Silent output-corruption risks before crashes: rounded aggregate amounts, partial history labelled
complete, wrong-party/date late response, stale output after failed refresh, omitted credits/openings,
mistaking restated history for an original cutoff, and spreadsheet formula execution. Scope/date
metadata, entry types/order/uniqueness and every running/closing balance are checked before enabling
exports. Any malformed/inconsistent result fails closed. Requests use generation and context guards;
the screen remounts statement state on shop/party changes and removes it when leaving Ledger.
Whole-ledger rendering/export scale is unchanged from the existing unpaginated JSON RPC; a bounded
streaming statement service is later work if that payload becomes too large. A failure never claims a
partial statement is complete. Statements are generated online and not persisted on the device.

Verification: pure exact-money/malformed-scope/incomplete-ledger/text-escaping/CSV tests; component
late-result/date-edit/failed-refresh/share-cancel/fallback/unavailable-print tests; a negative control
removing the request guard must fail. Real-browser fixture posts ₹100 then pays ₹30, requires two
server rows and ₹70 closing in shared/downloaded text/CSV/the actual A4 print area, prepares an empty later
period carrying ₹70 opening, and denies exports after a failed refresh. Production CSP is injected
into the fixture's supplier document through every full navigation. Phone and print screenshots
are CI artifacts. CI evidence is recorded in the PR and verifier log after freezing the head.
Only this online browser fixture blocks service-worker navigation (to prevent cached HTML bypassing
injected hosting headers) and grants access to the disposable loopback API. Existing offline tests
retain their service workers. It requires the real A4 receipt layout and native print callback.

Stacked draft after #73; review, merge and rollout are separate. No live action is performed.
