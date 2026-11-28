/**
 * THE GOVERNMENT PORTALS A CLIENT ENDS UP WITH AN ACCOUNT ON.
 *
 * Every Saudi business setup finishes with a dozen logins nobody wrote down in one place: Qiwa for
 * labour, Muqeem for residency, GOSI for insurance, Absher and Nafath for the identity that opens
 * all of them. They were typed free-hand into the credential screen, which is how one client's
 * vault reads "Qiwa", the next "QIWA portal" and the third "qiwa.sa" — three spellings of one
 * account that no report can group and no handover can be checked against.
 *
 * So the setup step offers the list. It lives in code rather than a table on purpose, for now:
 * these are the portals of one country and they change about once a year, and a table is a screen,
 * a permission and a migration for something nobody has yet asked to edit. The moment somebody
 * does, this becomes the seed for it.
 *
 * `expires` marks the ones that LAPSE. Absher and Nafath are identities and do not; a Qiwa
 * subscription, a Chamber membership and a MISA licence all do, and when one does the account
 * stops working on the morning somebody needs it.
 *
 * `nafath` marks the one that is not a username and password at all — it is a national ID and a
 * phone that approves the login.
 */
export type Portal = { name: string; url: string; expires?: boolean; nafath?: boolean; note?: string };

export const PORTALS: Portal[] = [
  { name: "Nafath", url: "https://www.absher.sa", nafath: true, note: "National ID — the login every other portal defers to" },
  { name: "Absher Business", url: "https://www.absher.sa" },
  { name: "Qiwa", url: "https://qiwa.sa", expires: true, note: "Subscription lapses" },
  { name: "Muqeem", url: "https://muqeem.sa", expires: true },
  { name: "GOSI", url: "https://www.gosi.gov.sa" },
  { name: "MHRSD", url: "https://www.hrsd.gov.sa" },
  { name: "MISA", url: "https://misa.gov.sa", expires: true, note: "Investment licence" },
  { name: "Chamber of Commerce", url: "https://www.csc.org.sa", expires: true, note: "Membership lapses" },
  { name: "Saudi Business Centre", url: "https://business.sa" },
  { name: "ZATCA", url: "https://zatca.gov.sa" },
  { name: "Mudad", url: "https://mudad.com.sa", expires: true },
  { name: "SPL — National Address", url: "https://splonline.com.sa" },
  { name: "Baladiya / Balady", url: "https://balady.gov.sa", expires: true },
  { name: "Etimad", url: "https://etimad.sa" },
  { name: "Najiz (Ministry of Justice)", url: "https://najiz.sa" },
  { name: "Tawakkalna Services", url: "https://ta.sdaia.gov.sa" },
];

export const portalNames = () => PORTALS.map(p => p.name);
export const expiringPortals = () => PORTALS.filter(p => p.expires).map(p => p.name);
export const portalUrl = (name: string) =>
  PORTALS.find(p => p.name.toLowerCase() === String(name ?? "").trim().toLowerCase())?.url ?? "";
export const isNafath = (name: string) =>
  !!PORTALS.find(p => p.name.toLowerCase() === String(name ?? "").trim().toLowerCase())?.nafath;
