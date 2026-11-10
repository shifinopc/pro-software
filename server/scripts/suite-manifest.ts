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
  "check-date-fields",
  "client-ip-check",
  "company-merge-check",
  "credential-scope-check",
  "disbursement-billing-check",
  "finance-guards-check",
  "first-paint-check",
  "group-counts-check",
  "imap-check",
  "import-template-check",
  "island-minify-check",
  "list-capping-check",
  "lead-details-fields-check",
  "lead-export-check",
  "lead-import-check",
  "lifecycle-guard-check",
  "mail-send-check",
  "money-capture-check",
  "node-types-check",
  "number-format-pool-check",
  "paid-gate-check",
  "phone-split-check",
  "probe-addon-deal",
  "probe-agents",
  "probe-agents-bank-visits",
  "probe-agents-twenty",
  "probe-ai-compat",
  "probe-assignable-owners",
  "probe-band-schemes",
  "probe-billing-amounts",
  "probe-checklist-vocabulary",
  "probe-client-team",
  "probe-compliance",
  "probe-counting-rules",
  "probe-courier-job-types",
  "probe-cr-renewal",
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
  "probe-misa-renewal",
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
  "render-scope-check",
  "signature-check",
  "site-lookup-check",
];

/** Checks that do not pass yet. Every entry carries the reason, so the list stays actionable. */
export const QUARANTINE: { name: string; why: string }[] = [
  { name: "probe-agents-ops", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-all-services", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-assignee-email", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-assignment-rules", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-booking", why: "still hitting the auth rate limiter — it signs in somewhere _suite-auth.ts does not cover" },
  { name: "probe-cap-live", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-courier-step", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-crm-dashboard", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-crm-lifecycle", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-deal-checklist", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-document-integrity", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-employee-mapping", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-employee-renewals", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-followups", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-government-outcomes", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-home-market", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-install-visible", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-lead-to-deal", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-mailbox", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-managed-lists", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-mrz-reader", why: "PASSES STANDALONE — it is the real-OCR step timing out under suite CPU load, not a broken check. Verified by running it alone. Give it headroom or split the OCR case out, then move it back to EXPECTED" },
  { name: "probe-onboarding-hiring-type", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-owner-rotation", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-pack-export", why: "wants fixture data the seed does not create" },
  { name: "probe-pack-publish", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-pack-uninstall", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-pack-upgrade", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-parked-and-numbers", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-phantom-document", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-refusal-live", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-reissue-supersedes", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-sales-performance", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-statutory-clocks", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-statutory-deadline", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-step-credential", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-subcr-renewal", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-tail-live", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-workflow-hardening", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-workflow-integrity", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-workforce-alerts", why: "assertion fails against the seeded state — unreviewed" },
  { name: "probe-workforce-bands", why: "depends on rows an earlier script left behind, which suite-sweep now clears between scripts — it needs to make its own fixture" },
  { name: "probe-workforce-history", why: "assertion fails against the seeded state — unreviewed" },
  { name: "read-scan-check", why: "wants document-type aliases that no pack or seed carries" },
];

/** Not checks — they take arguments and do work. They print usage and exit non-zero forever. */
export const TOOLS: string[] = [
  "add-staff-user",
  // Mints a throwaway staff login for local testing, because the local database is a copy of live
  // and its super_admin is a real person whose password hash cannot be recovered once overwritten.
  "dev-user",
  "import-employees",
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
export const MODULES: string[] = ["_pickpack", "_scratch-guard", "_scratch-db", "_suite-auth"];

/** Of EXPECTED, the ones that sign in over HTTP. CI runs one sequence; this is for `--group api` locally. */
export const API_GROUP: string[] = [
  "disbursement-billing-check",
  "lifecycle-guard-check",
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
