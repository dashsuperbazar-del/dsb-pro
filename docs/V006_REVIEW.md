# V006 builder adjudication — 14 October 2026

Codex owns building; the other AI owns independent verification, per the user's current instruction.
This supersedes assistant-name assignments in older verification logs. One migration sequence remains:
0058 is reserved by DW2b #72; D3b must not reuse it. No D3b patch is available in this workspace.

Main was freshly fetched at `41dfd4b6e4202a3fc90de29a143247d6f82e9885`.
The correction candidate is based on DW3 #74 at `f2d965c82af20173eaa5ad6c673d2d6b3105e1a1`.
This builder check does not independently approve its own pending packets or replace human gates.

| Finding                     | Disposition                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VF-011                      | Correct on main. Candidate STATE records main, all drafts, deployment lag and DW3's final CI. Main remains stale until this documentation merges.                                                                                                                                                                                                                                  |
| VF-012                      | Reproduced by actual-screen regression tests. Full now changes only the selected bill allocation, preserving entered cash. A linked bill selects its allocation but leaves cash blank. Existing review and server limits remain.                                                                                                                                                   |
| VF-013                      | Stack is intentional; coordination risk is valid. Codex is builder, other AI verifier. Release order and migration reservation are recorded below. No automatic merge.                                                                                                                                                                                                             |
| VF-014                      | Confirmed: latest dispatch is CI #801 / run 38280419051 at `4a4c172dc952ea87e112b38f33e822f0f59bfd01`, 12 October. Main DW1 is not deployed. Source tests cannot substitute for a shop test of the deployed build.                                                                                                                                                                 |
| VF-015                      | Root-wide formatting debt is real (102 files reported on main; 101 on the DW3 candidate before this correction). CI now checks the complete documented app scope and every supported changed file against the PR base. Existing unrelated debt remains, without claiming repository-wide formatting. SQL migrations retain their immutable bytes and existing formatter exclusion. |
| #74 failed e2e              | Stale snapshot: exact final head `f2d965c` has full CI #832 / run 38505404467 SUCCESS, all nine validation jobs. 352 app unit + 17 archive tests, 940 pgTAP, 56 browser passes + 1 scale skip, 20 repetitions. Independent source approval is still pending.                                                                                                                       |
| Retained unused attachments | Real retention cost, deliberately report-only. DW2c backs up all immutable originals; cleanup needs a separate retention/recovery design. No unreviewed deletion is introduced.                                                                                                                                                                                                    |

## Review and release sequence

Review #71 → #72 → #73 → #74 → this correction draft, bottom-up. Each dependent targets its predecessor
so reviewers see one packet. After an approved predecessor is squash-merged, rebase its dependent onto
the resulting main, retarget its base to main and obtain full CI on the new exact head before merging.
Do not merge or simply retarget a dependent first: its previous-head CI no longer covers the rebased tree.
Migration #72 additionally needs the unchanged-head validate dispatch/upgrade proof, independent review
and the attended live preflight listing every pending group before any separately authorized application.

After approved merges, deployment is a separate authorized operation on the intended main head.
H3 offline/restart/reconnect, phone/printer acceptance, opening balances, cutover and the clean shop week
remain unchecked. D3b needs its actual patch, a rebase onto the approved target, review and renewed tests.
Claude App write permission is unrelated to Codex's existing GitHub connection and is not changed here.

## Correction risks and evidence

Silent money-entry risk: replacing the actual payment with allocated bill totals loses intended advance.
The new screen tests failed on the old implementation for all three scenarios, then passed on the fix:
₹10,000 cash / ₹8,000 bill / ₹2,000 advance; Full with blank or smaller cash; linked bill with blank cash.
Browser coverage checks Full's preserved cash and review remainder, retains partial-payment/advance/
release/void coverage, and checks the linked-bill requirement in the full purchase workflow.
No money RPC, request durability/retry handling, allocation rule, migration, RLS or production operation changes.
Formatting checks use argument arrays and a validated base SHA; changed filenames are passed after `--`.
Full CI for this candidate is required before acceptance; exact final evidence belongs in its PR and log.
