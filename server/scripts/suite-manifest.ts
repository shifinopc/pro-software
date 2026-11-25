/**
 * WHICH OF THE 178 SCRIPTS IN THIS FOLDER ARE A REGRESSION SUITE, AND WHICH ARE NOT.
 *
 * Read by suite-run.ts. Three lists, and the runner treats them differently:
 *
 *   EXPECTED    must pass against a freshly seeded scratch database (see suite-seed.ts). A failure
 *               fails the build. This is the suite.
 *   QUARANTINE  does not pass, each with the reason. Reported, never fatal — but the runner says so
 *               when one starts passing, because a quarantine nobody revisits is a list of things
 *               that will never be fixed.
 *   TOOLS       not checks: importers, installers, exporters, fixture makers, one-off migrations.
 *               They print usage and exit non-zero forever. Excluded rather than quarantined, so
 *               the quarantine stays a list of real problems.
 *
 * A script on disk that appears in none of the three fails the run as UNLISTED, and a name here
 * that no longer exists on disk fails it too. Both on purpose: the default for a new check should
 * be that it runs, and the way to learn it does not should not be noticing six months later.
 *
 * API_GROUP is the subset that signs in over HTTP rather than talking to the database directly. CI
 * runs those in their own step, after starting a server against the same scratch database.
 */

/** Checks that must pass, named in the order the runner runs them (alphabetical). */
export const EXPECTED: string[] = [
  "auth-failure-check",
  "auth-limit-gate-check",
  "chain-docs-check",
  "check-date-fields",
  "client-ip-check",
  "client-report-pdf-check",
  "company-merge-check",
  "credential-scope-check",
  "delivery-rules-check",
  "disbursement-billing-check",
  "finance-guards-check",
  "first-paint-check",
  "group-counts-check",
  "imap-check",
  "import-template-check",
  "invoice-correct-check",
  "invoice-lock-check",
  "island-minify-check",
  "list-capping-check",
  "lead-details-fields-check",
  "lead-export-check",
  "lead-import-check",
  "lifecycle-guard-check",
  "mail-send-check",
  "milestone-invoice-check",
  "master-data-pdf-check",
  // Drives the real engine over a one-step CR template: does finishing that step register the
  // client? Creates and deletes its own fixture client, and refuses a database off this machine.
  "business-setup-cr-check",
  // Where the one-press run of steps stops, and that the engine really opens each next task the
  // moment the one before it closes — the assumption the whole chain rests on.
  "step-chain-check",
  "step-draft-check",
  // The lead report's counting rules on a fixture whose answer is known: bounces counted once,
  // re-opens are not new leads, "still open" reconstructed as at the end date. Local DBs only.
  "lead-status-report-check",
  "money-capture-check",
  "node-types-check",
  "number-format-pool-check",
  "permit-term-expiry-check",
  "phone-split-check",
  "payment-receipt-check",
  "probe-addon-deal",
  "probe-agents",
  "probe-agents-bank-visits",
  "probe-agents-twenty",
  "probe-ai-compat",
  "probe-assignable-owners",
  "probe-install-visible",
  "probe-booking",
  "probe-assignee-email",
  "probe-band-schemes",
  "probe-billing-amounts",
  "probe-checklist-vocabulary",
  "probe-client-team",
  "probe-compliance",
  "probe-counting-rules",
  "probe-courier-job-types",
  "probe-dates",
  "probe-delete-guards",
  "probe-digest",
  "probe-duplicates",
  "probe-establishments",
  "probe-fee-vat",
  "probe-file-embedding",
  "probe-intake-agent",
  "probe-invitations",
  "probe-job-rules",
  "probe-lead-edit",
  "probe-lead-scoring",
  "probe-mail-log",
  "probe-master-data-sheet",
  "probe-money",
  "probe-ops-report",
  "probe-owner-audience",
  "probe-pack-fields",
  "probe-pack-roundtrip",
  "probe-pack-visibility",
  "probe-permission-coverage",
  "probe-permissions",
  "probe-picklists",
  "probe-pipeline",
  "profitability-check",
  "probe-portal-queue",
  "probe-probation-cap",
  "probe-quote-chase",
  "probe-recurring-trigger",
  "probe-reply-to",
  "probe-retired-template",
  "probe-sales-scoping",
  "probe-stage-rules",
  "probe-status-ladders",
  "probe-step-portals",
  "probe-step-roles",
  "probe-suspend-lockout",
  "probe-task-run-sync",
  "probe-team-powers",
  "probe-team-visibility",
  "probe-unstaffed-roles",
  "probe-upgrade-adopts",
  "probe-web-intake",
  "probe-workforce",
  "quote-convert-check",
  "self-approval-check",
  "branch-routing-check",
  "session-expiry-check",
  "task-delegate-check",
  "task-drawer-check",
  "audit-cats-check",
  "fee-prefill-check",
  "money-paid-rule-check",
  "client-form-check",
  "inbox-zero-check",
  "duplicate-run-check",
  "renewal-claim-check",
  "step-handover-check",
  "search-debounce-check",
  "capture-typing-check",
  "render-gate-check",
  "crash-reporter-check",
  "whatsapp-check",
  "whatsapp-webhook-check",
  "payment-terms-check",
  "quotation-typing-check",
  "route-review-check",
  "crud-secrets-check",
  "scripts-parse-check",
  "fast-fields-check",
  "probe-setup-handover",
  "render-scope-check",
  "signature-check",
  "site-lookup-check",
];

/**
 * Checks that do not pass yet. Every entry carries the reason, so the list stays actionable.
 *
 * The reasons were once mostly "assertion fails against the seeded state — unreviewed", which is
 * not a reason, it is a note that nobody had looked. Each was then run on its own against a freshly
 * seeded scratch database, and what follows is what each actually did. That mattered: three of them
 * PASS, three fail only because they import constants src/jobs.ts no longer exports, and
 * probe-all-services turned out to be reporting two genuinely broken SEEDED workflows rather than
 * being broken itself.
 *
 * A quarantined check is a check that is not protecting anything. Prefer fixing or deleting one
 * over leaving it here.
 */
export const QUARANTINE: { name: string; why: string }[] = [
  { name: "probe-agents-ops", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-all-services", why: "REAL FINDING, not a test fault. Two SEEDED workflows are broken: 'Visa Processing (dynamic docs)' points at a checklist rule that no longer exists, and 'Work Permit Renewal' issues a document type filed under no country while the workflow is SA. 8 problems in total. Fix the seeded templates, not this check" },
  { name: "probe-assignment-rules", why: "assertion fails against the seeded state — unreviewed" },
  { name: "paid-gate-check", why: "needs the three renewal workflow templates the seed builds, and probe-upgrade-adopts destroys them earlier in the run: it upgrades and uninstalls the SA pack, which correctly removes pack-CREATED rows, and nothing puts them back. Passes on its own against a fresh seed. Fix probe-upgrade-adopts to restore what it removes, or reseed after it — then move this back to EXPECTED" },
  { name: "probe-cr-renewal", why: "needs the three renewal workflow templates the seed builds, and probe-upgrade-adopts destroys them earlier in the run: it upgrades and uninstalls the SA pack, which correctly removes pack-CREATED rows, and nothing puts them back. Passes on its own against a fresh seed. Fix probe-upgrade-adopts to restore what it removes, or reseed after it — then move this back to EXPECTED" },
  { name: "probe-misa-renewal", why: "needs the three renewal workflow templates the seed builds, and probe-upgrade-adopts destroys them earlier in the run: it upgrades and uninstalls the SA pack, which correctly removes pack-CREATED rows, and nothing puts them back. Passes on its own against a fresh seed. Fix probe-upgrade-adopts to restore what it removes, or reseed after it — then move this back to EXPECTED" },
  { name: "probe-cap-live", why: "fixture, not product: it answers 'Create Employee Profile' without Employment Type / Visa Required, which the step requires. Give it complete answers" },
  { name: "probe-courier-step", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-crm-dashboard", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-crm-lifecycle", why: "fails inside Prisma — read scripts/triage notes; needs its own fixture" },
  { name: "probe-deal-checklist", why: "WORTH READING: says the facts a rule conditions on disagree with the record they came from. Could be a real rule-evaluation bug" },
  { name: "probe-document-integrity", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-employee-mapping", why: "passes ALONE against a fresh seed but still fails in a full suite run, so it depends on state an earlier script leaves behind — it needs its own fixture" },
  { name: "probe-employee-renewals", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-followups", why: "STALE IMPORT: it wants STALE_DEAL_DAYS from src/jobs.ts, which no longer exports it. The check is out of date with the code, not the other way round" },
  { name: "probe-government-outcomes", why: "WORTH READING: says 'iqama_transfer' never asks what the authority decided. If that is true of the seeded workflow it is a content gap, not a test fault" },
  { name: "probe-home-market", why: "fails inside Prisma — needs its own fixture" },
  { name: "probe-lead-to-deal", why: "STALE IMPORT: wants IDLE_LEAD_DAYS from src/jobs.ts, which no longer exports it" },
  { name: "probe-mailbox", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-managed-lists", why: "fixture, not product: it answers Visa Required? with 'y' and the field accepts yes/no. One-word fix in the check" },
  { name: "probe-mrz-reader", why: "PASSES STANDALONE — it is the real-OCR step timing out under suite CPU load, not a broken check. Verified by running it alone. Give it headroom or split the OCR case out, then move it back to EXPECTED" },
  { name: "probe-onboarding-hiring-type", why: "the seeded workflow it needs is still a draft, so nothing can run. Needs the seed to activate one, or its own fixture" },
  { name: "probe-owner-rotation", why: "fails inside Prisma — needs its own fixture" },
  { name: "probe-pack-export", why: "wants fixture data the seed does not create" },
  { name: "probe-pack-publish", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-pack-uninstall", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-pack-upgrade", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-parked-and-numbers", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-phantom-document", why: "passes ALONE against a fresh seed but still fails in a full suite run — same: it needs its own fixture rather than the suite's leftovers" },
  { name: "probe-refusal-live", why: "crashes on a null row — it needs a fixture it does not create" },
  { name: "probe-reissue-supersedes", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-sales-performance", why: "STALE IMPORT: wants RENEWAL_LEAD_DAYS from src/jobs.ts, which no longer exports it" },
  { name: "probe-statutory-clocks", why: "WORTH READING: says fewer than two steps declare a deadline, so the three statutory clocks are not modelled in the seeded templates" },
  { name: "probe-statutory-deadline", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-step-credential", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-subcr-renewal", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-tail-live", why: "crashes on a null row — it needs a fixture it does not create" },
  { name: "probe-workflow-hardening", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-workflow-integrity", why: "WORTH READING: says System Access is still not owned by IT — a seeded ownership gap rather than a broken check" },
  { name: "probe-workforce-alerts", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-workforce-bands", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-workforce-history", why: "assertion fails against the seeded state — unreviewed" },
  { name: "read-scan-check", why: "wants document-type aliases that no pack or seed carries" },
];

/** Not checks — they take arguments and do work. They print usage and exit non-zero forever. */
export const TOOLS: string[] = [
  "build-business-setup",
  "schema-drift-check",
  "fix-duplicate-renewal-runs",
  // Retires the duplicate Company Acquisition workflow and, with --undo, puts it back. A one-off
  // migration with a flag, not a check.
  "retire-company-acquisition",
  // Corrects the installed Business Setup template's CR step (it filed nothing) and clears the
  // CR-pending waiver from clients that already hold a registration. Idempotent, --apply to write.
  "fix-business-setup-cr",
  // Raises a pipeline card for the leads captured before every lead got one automatically.
  // Deliberately NOT run by the deploy: it puts a card on the board for every open lead.
  "leads-into-pipeline",
  // Removes the unkeyed twin of every SLA breach notification. notify.ts no longer writes one;
  // this clears what is already filed. Idempotent, --apply to delete.
  "dedupe-sla-notifications",
  // Takes the work permit fee off "Issue Work Permit" — the capture, the rule it feeds and the
  // instruction line, because removing only the first deadlocks the step. Idempotent, --apply.
  "drop-permit-fee-capture",
  "drop-renewed-iqama-checklist",
  "repoint-old-fee-steps",
  "repoint-step",
  "rerate-untaxed-drafts",
  "vat-per-line-check",
  "whatsapp-send-test",
  "render-map",
  "add-staff-user",
  // Mints a throwaway staff login for local testing, because the local database is a copy of live
  // and its super_admin is a real person whose password hash cannot be recovered once overwritten.
  "dev-user",
  "import-employees",
  "try-business-setup",
  "try-self-approval",
  "install-country-pack",
  "install-pack-kinds",
];

/**
 * ONE-OFF DATA OPERATIONS. A check asserts; these change rows and exit 0 because they SUCCEEDED.
 *
 * Most of them pass against a seeded database, which is exactly what makes them dangerous here:
 * in EXPECTED they would run forty-odd migrations against the database on every build and report
 * a green suite that had verified nothing. Several are destructive by intent —
 * `keep-only-onboarding`, `retire-dangling-services`, `stop-duplicate-permit-renewals`.
 *
 * Told apart by name, which this folder is consistent about: `probe-*`, `*-check` and `check-*`
 * assert, while an imperative verb (add-, fix-, set-, migrate-, backfill-, activate-, retire-,
 * keep-, rebuild-, restart-, stop-, split-, normalize-, seed-, bind-, apply-) does work.
 */
export const MIGRATIONS: string[] = [
  "_zs-local-login",
  "_zs-task-fixture",
  "activate-employee-renewals",
  "activate-workflows",
  "add-company-doc-types",
  "add-cr-renewal",
  "add-employee-doc-fields",
  "add-employee-renewals",
  "add-employment-contract-type",
  "add-final-three",
  "add-it-hr-roles",
  "add-misa-renewal",
  "add-onboarding-hiring-type",
  "add-passport-renewal",
  "add-remaining-services",
  "add-sa-nitaqat-bands",
  "add-uae-centers",
  "apply-client-workflow-changes",
  "backfill-assignee-id",
  "backfill-doc-figures",
  "backfill-probation-days",
  "bind-services-to-workflows",
  "export-country-pack",
  "fix-dangling-doc-references",
  "fix-uae-doctype-country",
  "fix-work-visa-prereq",
  "keep-only-onboarding",
  "migrate-band-sets",
  "migrate-contacts",
  "migrate-country-fields",
  "migrate-ownership",
  "migrate-private-files",
  "money-capture-backfill",
  "money-capture-fixture",
  "money-capture-migrate",
  "normalize-dates",
  "rebuild-iqama-renewal",
  "restart-stranded-iqama-runs",
  "retire-dangling-services",
  "seed-employee-card-types",
  "set-document-scope",
  "set-employee-card",
  "set-sa-authorities",
  "set-step-portals",
  "set-step-roles",
  "set-step-slas",
  "split-permission-modules",
  "stop-duplicate-permit-renewals",
  "throwaway-staff",
];

/**
 * NOT SCRIPTS AT ALL — shared helpers that live in this folder and are IMPORTED by the checks.
 *
 * `_scratch-guard` is the one that matters: it is how the pack probes refuse to rewrite a real
 * database's configuration. Run on its own it does nothing and exits 0, which would have made it
 * look like a passing check and put a library into the regression suite.
 *
 * Found mechanically rather than by the leading underscore — a file in this folder that another
 * file in this folder imports.
 */
export const MODULES: string[] = ["_pickpack", "_scratch-guard", "_scratch-db", "_suite-auth", "_live-guard"];

/** Of EXPECTED, the ones that sign in over HTTP. CI runs one sequence; this is for `--group api` locally. */
export const API_GROUP: string[] = [
  "crud-secrets-check",
  "route-review-check",
  "disbursement-billing-check",
  "lifecycle-guard-check",
  "invoice-correct-check",
  "milestone-invoice-check",
  "invoice-lock-check",
  "task-delegate-check",
  "payment-receipt-check",
  "probe-billing-amounts",
  "probe-booking",
  "probe-cap-live",
  "probe-checklist-vocabulary",
  "probe-courier-job-types",
  "probe-delete-guards",
  "probe-document-integrity",
  "probe-employee-mapping",
  "probe-file-embedding",
  "probe-invitations",
  "probe-lead-edit",
  "probe-managed-lists",
  "probe-master-data-sheet",
  "probe-misa-renewal",
  "probe-parked-and-numbers",
  "probe-permission-coverage",
  "probe-phantom-document",
  "probe-picklists",
  "probe-pipeline",
  "probe-reply-to",
  "probe-sales-scoping",
  "probe-stage-rules",
  "probe-status-ladders",
  "probe-statutory-deadline",
  "probe-step-roles",
  "probe-suspend-lockout",
  "probe-web-intake",
  "probe-workflow-integrity",
  "quote-convert-check",
  "site-lookup-check",
];
