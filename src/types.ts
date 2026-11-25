// Shared shapes. A "Post" is the connector's own normalised view of a Threads post, whatever it came from
// (Meta's Threads API for live posts, our own queue for drafts and scheduled ones).

export type Metrics = {
  views?: number;
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  shares?: number;
};

export type PostStatus = "published" | "scheduled" | "draft" | "failed" | "other";

export type Post = {
  id: string; // Threads post id for live posts, queue id (q_...) for drafts / scheduled / failed ones
  platformId?: string; // Threads post id
  text: string;
  status: PostStatus;
  at: string; // ISO time: when it went live, when it is scheduled for, or when the draft was made
  url?: string;
  topic?: string;
  media: number;
  source: "studio" | "native"; // studio = created through this connector; native = typed in Threads itself
  angle?: string;
  metrics?: Metrics;
  metricsKnown: boolean; // false when Threads gave no numbers: unknown is not zero
  leads?: number;
  error?: string;
};

/** Threads' API has no drafts and no scheduling, so the connector keeps its own queue. */
export type QueueStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";

export type QueueItem = {
  id: string;
  status: QueueStatus;
  parts: string[]; // first = the post, the rest = thread continuation
  topic?: string;
  mediaUrls?: string[];
  angle?: string;
  type?: string;
  hook: string;
  createdAt: string;
  scheduledFor?: string;
  nextAttemptAt?: string;
  lockedAt?: string;
  attempts: number;
  publishedAt?: string;
  threadsId?: string;
  url?: string;
  error?: string;
};

/** A picture in the photo bank. Meta only accepts a public https address for a picture, so uploads live in Vercel Blob. */
export type Photo = { id: string; url: string; name: string; mime: "image/jpeg" | "image/png"; size: number; desc?: string; editUrl?: string; uploadedAt: string }; // editUrl: where it was designed (a Canva edit link), so the owner can tweak it again

export type Insight = { id: string; at: string; text: string; postId?: string };

export type Settings = { goalPerDay: number; defaultTopic?: string };

export type PlaybookEdits = {
  pillars?: string[];
  voice?: string[];
  facts?: string[];
  banned?: string[];
};

export type ThreadsConnection = {
  token: string; // 60-day Threads token, renewed weekly
  expiresAt: string;
  refreshedAt: string;
  userId?: string;
  username?: string;
};

export type State = {
  v: 2;
  settings: Settings;
  playbookEdits: PlaybookEdits; // additions on top of the default playbook (and removals recorded in `removed`)
  removed: PlaybookEdits;
  threads?: ThreadsConnection;
  lastPingAt?: string; // last time the /tick scheduler endpoint was called (so create_post can warn when no pinger is set up)
  nonces: Record<string, string>; // one-time connect links: nonce -> expiry (ISO)
  photos: Record<string, Photo>;
  queue: Record<string, QueueItem>;
  metricsCache: Record<string, { at: string; m: Metrics }>;
  results: Record<string, { leads?: number; note?: string }>;
  insights: Insight[];
  recHistory: { at: string; hooks: string[] }[];
  publishLog: Record<string, number>; // MYT date -> number of posts the connector created for that day
};

export class StudioError extends Error {}
