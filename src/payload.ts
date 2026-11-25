// What the server sends to the widget in `structuredContent`. Types only: both sides import this file.
import type { Baseline, Cell, Features, HookStat, Slot, TrackerData } from "./metrics.js";
import type { Metrics } from "./types.js";

export type PostOut = {
  id: string;
  text: string;
  hook: string;
  at: string;
  status: string;
  url?: string;
  topic?: string;
  metrics?: Metrics;
  metricsKnown: boolean;
  leads?: number;
  source: "studio" | "native";
};

export type PhotoOut = { id: string; url: string; name: string; desc?: string; editUrl?: string; size: number; uploadedAt: string };

/** Drafts, scheduled and failed posts: what can still be changed or deleted from the tracker. */
export type QueueRow = { id: string; status: "draft" | "scheduled" | "failed"; at?: string; hook: string; error?: string; photos: number };

export type Rec = {
  angle: string; // may be empty: an angle is only a label Claude may add
  type?: string;
  hook: string;
  text: string;
  parts?: string[];
  photoIds?: string[];
  // set when the card is an existing draft / scheduled / failed post being changed in place (not a new suggestion)
  queueId?: string;
  status?: "draft" | "scheduled" | "failed";
  scheduledFor?: string;
  extraMedia?: string[]; // picture addresses on the post that are not in the photo bank; kept as they are
  why: string;
  topic?: string;
  lint: { errors: string[]; warnings: string[]; chars: number[] };
};

export type WinnerOut = {
  post: PostOut;
  score: number;
  labels: string[];
  vsViews: number;
  vsEng: number;
  engRate: number;
  ageDays: number;
  features: Features;
};

export type Payload =
  | { kind: "tracker"; data: TrackerData; slots: Slot[]; queue: QueueRow[]; notes: string[] }
  | { kind: "recs"; recs: Rec[]; slots: Slot[]; photos: PhotoOut[]; defaultTopic?: string }
  | { kind: "photos"; photos: PhotoOut[]; ready: boolean; note?: string }
  | { kind: "winners"; winners: WinnerOut[]; baseline: Baseline; days: number; notes: string[] }
  | {
      kind: "analysis";
      post: PostOut;
      features: Features;
      vsViews: number;
      vsEng: number;
      read: { hookType?: string; why: string[]; reuse: string[]; avoid: string[] };
    }
  | {
      kind: "analytics";
      days: number;
      followers?: number;
      posts: number;
      totalViews: number;
      avgViews: number;
      medianViews: number;
      engRate: number;
      withMetrics: number;
      grid: Cell[][];
      best: { label: string; n: number; avgViews: number }[];
      hooks: HookStat[];
      notes: string[];
    }
  | { kind: "result"; ok: boolean; message: string; post?: PostOut };
