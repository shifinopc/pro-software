/**
 * WHAT AN ERROR IS ALLOWED TO SAY.
 *
 * Routes ended `catch (e) { res.json({ error: e.message }) }`, which is right for the errors this
 * code throws on purpose — "That person is not an active staff account" is written for the person
 * reading it — and wrong for everything else. A Prisma failure's message carries the table, the
 * column, the shape of the query and, in the generic CRUD, the ABSOLUTE SERVER PATH with a printed
 * extract of our own source. All of that was going to the browser.
 *
 * So a message is shown only when it was WRITTEN for somebody. Anything from the database layer, and
 * any built-in thrown by a bug (TypeError, ReferenceError, RangeError, SyntaxError), is a fault
 * rather than a message. The detail always reaches the server log either way — hiding it from the
 * user must not mean losing it.
 *
 * Found by forcing a foreign-key violation rather than by reading the code. The nineteen sites in
 * index.ts were the visible ones; the generic CRUD sitting behind them leaked considerably more.
 */
const DB_ERRORS = /^Prisma/;
const BUG_ERRORS = new Set(["TypeError", "ReferenceError", "RangeError", "SyntaxError", "EvalError"]);

export function safeError(e: any): string {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? e ?? "");
  const isDbFault =
    DB_ERRORS.test(name) ||
    /^P\d{4}$/.test(String(e?.code ?? "")) ||
    /prisma|invocation in\s|Argument `|Unknown argument|Foreign key constraint|Unique constraint/i.test(msg);
  const isBug = BUG_ERRORS.has(name);
  // A sentence, not a stack, a query or a file path. Length and line breaks give the rest away.
  const looksWritten = msg.length > 0 && msg.length <= 300 && msg.indexOf("\n") === -1;
  return !isDbFault && !isBug && looksWritten ? msg : "Something went wrong. Please try again.";
}

/** Log the truth, return only what is safe. */
export function fail(res: any, status: number, e: any, where: string) {
  // eslint-disable-next-line no-console
  console.error(`[${where}]`, e);
  return res.status(status).json({ error: safeError(e) });
}
