/**
 * Throwaway check: does every field the pack claims to ship actually exist on its model?
 *
 * A name that is not a column fails silently at BOTH ends — JSON.stringify drops an undefined value
 * on export, and Prisma ignores an undefined argument on install. So the field looks shipped, travels
 * as nothing, and the installed row quietly takes the schema default. Read-only.
 */
import { Prisma } from "@prisma/client";
import { KINDS } from "../src/packs.js";

const modelOf = (name: string) =>
  Prisma.dmmf.datamodel.models.find(m => m.name.toLowerCase() === name.toLowerCase());

let bad = 0;
for (const kind of KINDS) {
  const model = modelOf(kind.model)!;
  const columns = new Set(model.fields.map(f => f.name));
  // Call the mapper with a probe row so the field NAMES it reads are the ones we check.
  const shipped = Object.keys(kind.fields({} as any));
  const missing = shipped.filter(f => !columns.has(f));
  const status = missing.length ? `MISSING: ${missing.join(", ")}` : "all real";
  console.log(`${kind.model.padEnd(18)} ships ${String(shipped.length).padStart(2)} → ${status}`);
  bad += missing.length;

  // The other direction: columns that exist, are settable, and are not shipped. Not necessarily
  // wrong — some are deliberately local — but worth seeing rather than assuming.
  const skip = new Set(["id", "packKey", "packVersion", "packModified", "country", "retired", "createdAt", "updatedAt"]);
  const notShipped = model.fields
    .filter(f => f.kind !== "object" && !f.isList && !skip.has(f.name) && !shipped.includes(f.name) && !f.isId)
    .map(f => f.name);
  if (notShipped.length) console.log(`${" ".repeat(18)} not shipped: ${notShipped.join(", ")}`);
}
console.log(`\nfields named that do not exist: ${bad}`);
process.exit(bad ? 1 : 0);
