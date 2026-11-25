// The one door to Threads for the rest of the connector. Two backends behind it:
//   - Zernio (zernio.ts), used when ZERNIO_API_KEY is set: no Meta app, one API key, the Threads account is linked inside Zernio.
//   - Meta's own Threads API (threads-meta.ts), used otherwise: needs a Meta app and a tester invite.
// Callers keep importing "./threads.js" and never need to know which one is active.
import * as meta from "./threads-meta.js";
import * as z from "./zernio.js";
import type { Metrics, Post } from "./types.js";

export { ThreadsError, SCOPES, publicUrl, redirectUri, normTs, authorizeUrl, exchangeCode, saveConnection, disconnect, parseSignedRequest, fromMetaPost } from "./threads-meta.js";
export type { MetaPost, Published, Reply } from "./threads-meta.js";

/** true when Zernio is the backend */
export const zernio = (): boolean => z.enabled();

export const appConfigured = (): boolean => (z.enabled() ? true : meta.appConfigured());
export const connected = (): Promise<boolean> => (z.enabled() ? z.connected() : meta.connected());
export const accessToken = (now?: Date): Promise<string> => (z.enabled() ? z.accessToken() : meta.accessToken(now));
export const me = (token: string): Promise<{ id: string; username: string }> => (z.enabled() ? z.me() : meta.me(token));
export const listPosts = (token: string, days: number, maxPages?: number): Promise<Post[]> => (z.enabled() ? z.listPosts(days) : meta.listPosts(token, days, maxPages));
export const insights = (token: string, id: string): Promise<Metrics> => (z.enabled() ? z.insights(id) : meta.insights(token, id));
export const followers = (token: string): Promise<number | undefined> => (z.enabled() ? z.followers() : meta.followers(token));
export const publish = (token: string, parts: string[], opts: { mediaUrls?: string[]; topic?: string; idempotencyKey?: string } = {}): Promise<meta.Published> =>
  z.enabled() ? z.publish(parts, opts) : meta.publish(token, parts, opts);
export const remove = (token: string, id: string): Promise<void> => (z.enabled() ? z.remove(id) : meta.remove(token, id));
export const replies = (token: string, postId: string, limit?: number): Promise<meta.Reply[]> => (z.enabled() ? z.replies(postId, limit) : meta.replies(token, postId, limit));
