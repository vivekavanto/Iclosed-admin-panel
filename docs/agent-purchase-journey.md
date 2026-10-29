# Agent Portal purchase journey

The Agent Portal at `/admin/agent-portal` presents eight purchase sections, independently of the ordering of the client's existing milestones. It reads the same family deal/task records; this change does not rename, move, complete or reseed client tasks or templates. Sale and refinance grouping retains its existing mapping.

| Agent section / row | Existing source |
| --- | --- |
| Intake: purchase agreement | Agreement of Purchase and Sale milestone and matching APS task |
| Intake: client information | Personal Information, Ownership shares, Solicitor Information and Confirm your property details; all relevant family tasks must be complete |
| Intake: IDs uploaded | Identification tasks, complete for every purchaser; Treefort verification stays a separate row |
| Intake: lender contact | Mortgage Representative Details (client display: Your mortgage) |
| Due diligence: title search | Title Search milestone |
| Due diligence: writ search | Existing explicit Writ Search record, otherwise staff tracking |
| Due diligence: status certificate | Existing Status Certificate task, when present; moved out of the APS row |
| Due diligence: property tax certificate | Visible only when the Tax Certificate task response to `Would you like us to obtain a property tax certificate?` is `yes`. Completing that decision never proves receipt; staff separately records fulfilment |
| Mortgage instructions: received | Mortgage Instructions milestone |
| Client documents: insurance | Home Insurance Policy task (preferred over its parent milestone) |
| Client documents: Void Cheque | Per-person Void Cheque tasks, independently of Home Insurance, even though they share a milestone |
| Signing: scheduled / completed | Appointment Scheduled + Book your signing appointment / Documents Signed |
| Closing funds: client / lender | Closing Funds Confirmed + Deposit Funds Into Our Trust Account / Lender Funds Received (legacy purchase Funds Received) |
| Keys transferred | Transaction Completed remains a separate Closing completed row; actual transfer is an explicit transfer record or staff tracking. A lockbox code alone does not prove handover |
| Post closing: package sent | All existing final-report documents must have `emailed_at` send stamps. A completed Final Report Received milestone alone does not prove sending |
| Post closing: ownership submitted | Explicit source record or staff tracking. Default iClosed; Mississauga is Client. Staff can assign Client for other municipalities |
| Post closing: gas / utilities | Client's Set up your utilities task, which includes gas; there is no separate gas-only client task |

Initial Call and Closing Date Coordination remain visible as supporting rows. Unknown custom purchase records remain visible rather than being discarded. Shared tasks count once, while per-person tasks retain their completion counts and waiting names. Explicit cash-purchase answers mark lender contact, mortgage instructions and lender funds not applicable; missing answers do not imply cash. Not-applicable and unactivated client tasks do not inflate progress totals. The current stage opens by default; rows expand to reveal source details and subtasks.

## Staff tracking

Writ search, tax-certificate fulfilment, keys transferred and ownership submitted can be confirmed/reopened by staff who already have Tasks or All Files permissions. Agent Portal/Partners permission alone grants no tracking writes. The existing staff preview labels these controls as staff actions; they are not agent self-certification controls.

`PUT /api/admin/agent-portal/:partnerId/files/:rootLeadId/journey` validates the referring agent's family, the root purchase deal, the staff session, an allowlisted tracking key and the expected previous completion timestamp. A deterministic UUID per root/key prevents duplicate inserts across retries or referring agents. Each successful update is audited. Cancelled/inactive files are locked; closed files allow only keys and post-closing ownership confirmation.

Records use the existing `tasks` table, with reserved `[Agent journey]` titles, role Admin, no task template or milestone, and `activation_required=true, activated_at=null`. This deliberately keeps them outside both active and locked client task lists and the existing all-client-tasks-complete notification pool. They do not run milestone recalculation, send notices, upload documents or mutate a client response. No migration or existing-file backfill is required. Reading the portal never creates these records.

Municipal responsibility indicates who must perform the action. Recording completion confirms that it occurred; it does not submit a notice. Existing Legal Assistant COO workflow storage remains a separate source and is not silently equated with a completed client task.

## Verification and rollback

Synthetic regressions cover the actual purchase template relationships, per-person completion, opt-in vs fulfilment, cash applicability, inactive funds tasks, final-report send evidence, tracking validation, stale updates, audit calls, locked files and permission boundaries. No ordinary test loads credentials or writes provider/client records.

Feature branch: `codex/agent-portal-purchase-journey`, based on `9f563a73cd968d3ecb564ae2662c69c75dac7d49`. Revert the feature merge to restore the prior view. Reserved tracking rows can remain: they are hidden from client task lists, remain inactive in notification calculations, and have no milestone dependencies.
