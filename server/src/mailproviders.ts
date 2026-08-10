/**
 * THE TWO ADAPTERS, AND NOTHING ELSE.
 *
 * Everything interesting about mailbox sync — what counts as a match, what is refused, how a reply
 * time is measured — lives in mailbox.ts and is provider-blind. This file is the seam: it turns
 * "Gmail" and "Microsoft Graph" into the same four fields, and it is kept small on purpose because
 * it is the ONLY part of this feature that cannot be verified without live credentials.
 *
 * WHAT THIS FIRM WILL NEED, whichever it is: an app registered on its own tenant, and its own
 * client id/secret in the environment. Because it is an internal app on a domain the firm owns,
 * an admin consents once for everybody — this is NOT the public-distribution path that requires a
 * security assessment, and confusing the two is why people believe this is a months-long project.
 *
 * SCOPES ARE THE MINIMUM THAT WORKS. Read-only, and no bodies are ever requested beyond what the
 * metadata endpoints return. A scope is a promise to the person granting it, and asking for more
 * than the feature uses makes every later reassurance about privacy unbelievable.
 */
import type { MailboxProvider, FetchResult, RawMessage } from "./mailbox.js";

const env = (k: string) => String(process.env[k] ?? "").trim();

/** True when this firm has actually configured the provider. Nothing pretends to work without it. */
export const providerConfigured = (p: "google" | "microsoft") =>
  p === "google" ? !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET"))
                 : !!(env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET") && env("MS_TENANT_ID"));

/** Where the provider sends the person back. One route, both providers, distinguished by state. */
export const redirectUri = () => env("OAUTH_REDIRECT_URI") || "http://localhost:4100/api/mailbox/callback";

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "email"];
const MS_SCOPES = ["offline_access", "Mail.Read", "User.Read"];

/** The URL a person is sent to in order to grant access. */
export function authorizeUrl(provider: "google" | "microsoft", state: string): string {
  if (provider === "google") {
    const q = new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      // Both required to be given a refresh token at all — without them the connection dies in an
      // hour and every rep is asked to sign in again daily.
      access_type: "offline", prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  const q = new URLSearchParams({
    client_id: env("MS_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code",
    scope: MS_SCOPES.join(" "), response_mode: "query", state,
  });
  return `https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/authorize?${q}`;
}

const expiryFrom = (seconds: unknown) =>
  new Date(Date.now() + (Number(seconds) || 3600) * 1000).toISOString();

/** Turn the one-time code into tokens, plus the address that was actually connected. */
export async function exchangeCode(provider: "google" | "microsoft", code: string):
  Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string; address: string }> {
  const isG = provider === "google";
  const tokenUrl = isG
    ? "https://oauth2.googleapis.com/token"
    : `https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    code, redirect_uri: redirectUri(), grant_type: "authorization_code",
    client_id: isG ? env("GOOGLE_CLIENT_ID") : env("MS_CLIENT_ID"),
    client_secret: isG ? env("GOOGLE_CLIENT_SECRET") : env("MS_CLIENT_SECRET"),
  });
  const r = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || `Token exchange failed (${r.status})`);

  // Which mailbox was granted. Asked rather than assumed: somebody may well grant a different
  // account from the one they signed into the console with, and filing their mail under the wrong
  // person is worse than refusing.
  const meUrl = isG ? "https://www.googleapis.com/oauth2/v2/userinfo" : "https://graph.microsoft.com/v1.0/me";
  const me: any = await (await fetch(meUrl, { headers: { Authorization: `Bearer ${j.access_token}` } })).json();
  const address = String(me.email ?? me.mail ?? me.userPrincipalName ?? "").trim();
  if (!address) throw new Error("The provider did not say which mailbox was connected.");

  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: expiryFrom(j.expires_in), address };
}

async function refreshToken(provider: "google" | "microsoft", refresh: string) {
  const isG = provider === "google";
  const url = isG ? "https://oauth2.googleapis.com/token"
                  : `https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    refresh_token: refresh, grant_type: "refresh_token",
    client_id: isG ? env("GOOGLE_CLIENT_ID") : env("MS_CLIENT_ID"),
    client_secret: isG ? env("GOOGLE_CLIENT_SECRET") : env("MS_CLIENT_SECRET"),
  });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || "Could not renew this mailbox connection");
  return { accessToken: j.access_token as string, expiresAt: expiryFrom(j.expires_in) };
}

const header = (headers: any[], name: string) =>
  headers?.find((h: any) => String(h.name).toLowerCase() === name)?.value ?? null;

export const googleProvider: MailboxProvider = {
  name: "google",
  refresh: (t) => refreshToken("google", t),
  async fetchSince(accessToken, cursor): Promise<FetchResult> {
    // `q=newer_than` rather than a stored historyId for the first pass: a history cursor that has
    // expired (Gmail drops them after about a week) returns 404, and starting from a date is a
    // recovery that needs no special case.
    const q = cursor ? `after:${cursor}` : "newer_than:14d";
    const list: any = await (await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } })).json();
    if (list.error) throw new Error(list.error.message ?? "Gmail rejected the request");

    const messages: RawMessage[] = [];
    for (const stub of (list.messages ?? [])) {
      // METADATA ONLY. This format cannot return a body even if something later asked it to.
      const m: any = await (await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      if (m.error) continue;
      const h = m.payload?.headers ?? [];
      messages.push({
        externalId: m.id, threadId: m.threadId,
        from: header(h, "from") ?? "",
        to: String(header(h, "to") ?? "").split(",").map(s => s.trim()).filter(Boolean),
        subject: header(h, "subject"),
        sentAt: new Date(Number(m.internalDate) || Date.now()).toISOString(),
      });
    }
    return { messages, cursor: String(Math.floor(Date.now() / 1000)) };
  },
};

export const microsoftProvider: MailboxProvider = {
  name: "microsoft",
  refresh: (t) => refreshToken("microsoft", t),
  async fetchSince(accessToken, cursor): Promise<FetchResult> {
    // Graph's delta link IS the cursor, and it already carries its own paging state — so when we
    // have one it is used verbatim rather than rebuilt from parts.
    const url = cursor || `https://graph.microsoft.com/v1.0/me/messages/delta?$select=id,conversationId,from,toRecipients,subject,sentDateTime&$top=100`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const j: any = await r.json();
    if (!r.ok) throw new Error(j.error?.message ?? `Microsoft Graph rejected the request (${r.status})`);

    const messages: RawMessage[] = (j.value ?? [])
      .filter((m: any) => m.id && m.sentDateTime)
      .map((m: any) => ({
        externalId: m.id,
        threadId: m.conversationId ?? m.id,
        from: m.from?.emailAddress?.address ?? "",
        to: (m.toRecipients ?? []).map((t: any) => t.emailAddress?.address).filter(Boolean),
        subject: m.subject ?? null,
        sentAt: new Date(m.sentDateTime).toISOString(),
      }));
    return { messages, cursor: j["@odata.deltaLink"] ?? cursor };
  },
};

export const providerFor = (name: string): MailboxProvider =>
  name === "microsoft" ? microsoftProvider : googleProvider;
