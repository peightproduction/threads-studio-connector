import { describe, expect, it } from "vitest";
import { build, duplicateOf, findByRef, fromQueue, shortcodeOf } from "../src/posts.js";
import { fromMetaPost, normTs } from "../src/threads.js";
import { parseWhen } from "../src/tools.js";
import type { Post, QueueItem } from "../src/types.js";

describe("Threads timestamps and posts", () => {
  it("normalises the offset without a colon", () => {
    expect(normTs("2026-11-24T04:00:00+0000")).toBe("2026-11-24T04:00:00.000Z");
    expect(normTs("2026-11-24T12:00:00+0800")).toBe("2026-11-24T04:00:00.000Z");
    expect(normTs(undefined)).toBe("1970-01-01T00:00:00.000Z");
    expect(normTs("rubbish")).toBe("1970-01-01T00:00:00.000Z");
  });
  it("maps a Threads post", () => {
    const p = fromMetaPost({ id: "t1", text: "  Halo  ", timestamp: "2026-11-24T04:00:00+0000", permalink: "https://threads.net/x", media_type: "IMAGE" });
    expect(p).toMatchObject({ id: "t1", platformId: "t1", text: "Halo", status: "published", at: "2026-11-24T04:00:00.000Z", url: "https://threads.net/x", media: 1, source: "native", metricsKnown: false });
    expect(fromMetaPost({ id: "t2", media_type: "TEXT_POST" }).media).toBe(0);
  });
});

const Q = (over: Partial<QueueItem>): QueueItem => ({ id: "q_1", status: "draft", parts: ["Teks"], hook: "Teks", createdAt: "2026-11-24T01:00:00.000Z", attempts: 0, ...over });
const P = (over: Partial<Post>): Post => ({ id: "i", text: "t", status: "published", at: "2026-11-20T04:00:00Z", media: 0, source: "native", metricsKnown: false, ...over });
const emptyState = { queue: {}, metricsCache: {}, results: {} };

describe("pointing at a post by link, short code or id", () => {
  const live = [
    P({ id: "17900000000000001", platformId: "17900000000000001", url: "https://www.threads.com/@demo_user/post/DgHfKpkleHF" }),
    P({ id: "17900000000000002", platformId: "17900000000000002", url: "https://www.threads.net/@demo_user/post/DgHfMIOlT-s?xmt=abc" }),
    P({ id: "d1", status: "draft", url: "https://www.threads.com/@demo_user/post/DraftCode123" }),
  ];
  it("reads the short code from links on either domain, or a bare code", () => {
    expect(shortcodeOf("https://www.threads.com/@demo_user/post/DgHfKpkleHF")).toBe("DgHfKpkleHF");
    expect(shortcodeOf("  https://threads.net/@x/post/DgHfMIOlT-s?xmt=1  ")).toBe("DgHfMIOlT-s");
    expect(shortcodeOf("DgHfNqnld1S")).toBe("DgHfNqnld1S");
    expect(shortcodeOf("17900000000000001")).toBeUndefined();
    expect(shortcodeOf("post tadi")).toBeUndefined();
  });
  it("finds a live post by id, link or short code, and never a draft", () => {
    expect(findByRef(live, "17900000000000001")?.id).toBe("17900000000000001");
    expect(findByRef(live, "https://www.threads.com/@demo_user/post/DgHfKpkleHF")?.id).toBe("17900000000000001");
    expect(findByRef(live, "https://www.threads.com/@demo_user/post/DgHfMIOlT-s")?.id).toBe("17900000000000002"); // domain and query do not matter
    expect(findByRef(live, "DgHfMIOlT-s")?.id).toBe("17900000000000002");
    expect(findByRef(live, "DgHfkpkleHF")).toBeUndefined(); // short codes are case sensitive
    expect(findByRef(live, "DraftCode123")).toBeUndefined();
    expect(findByRef(live, "")).toBeUndefined();
  });
});

describe("queue items as posts", () => {
  it("maps each status to the right time", () => {
    expect(fromQueue(Q({ status: "draft" }))).toMatchObject({ status: "draft", at: "2026-11-24T01:00:00.000Z", source: "studio" });
    expect(fromQueue(Q({ status: "scheduled", scheduledFor: "2026-12-01T01:00:00.000Z" }))).toMatchObject({ status: "scheduled", at: "2026-12-01T01:00:00.000Z" });
    expect(fromQueue(Q({ status: "publishing", scheduledFor: "2026-12-01T01:00:00.000Z" }))).toMatchObject({ status: "scheduled" });
    expect(fromQueue(Q({ status: "failed", scheduledFor: "2026-12-01T01:00:00.000Z", error: "boom" }))).toMatchObject({ status: "failed", error: "boom" });
    expect(fromQueue(Q({ status: "published", threadsId: "t9", publishedAt: "2026-11-24T02:00:00.000Z" }))).toMatchObject({ status: "published", id: "t9", at: "2026-11-24T02:00:00.000Z" });
  });
});

describe("building the post list", () => {
  it("marks live posts the connector published as studio, with their angle, and attaches numbers and leads", () => {
    const meta = [P({ id: "t1", text: "A", at: "2026-11-23T04:00:00Z" }), P({ id: "t2", text: "B", at: "2026-11-22T04:00:00Z" })];
    const out = build(meta, {
      queue: { q_1: Q({ id: "q_1", status: "published", threadsId: "t1", angle: "cerita", topic: "Business" }) },
      metricsCache: { t1: { at: "2026-11-24T00:00:00Z", m: { views: 50 } } },
      results: { t2: { leads: 3 } },
    });
    expect(out).toHaveLength(2); // the published queue item is not listed twice
    const t1 = out.find((p) => p.id === "t1")!, t2 = out.find((p) => p.id === "t2")!;
    expect(t1).toMatchObject({ source: "studio", angle: "cerita", topic: "Business", metricsKnown: true });
    expect(t1.metrics?.views).toBe(50);
    expect(t2).toMatchObject({ source: "native", metricsKnown: false, leads: 3 });
  });
  it("adds drafts, scheduled and failed items, and a just-published item Threads has not listed yet", () => {
    const out = build([P({ id: "t1", text: "Live" })], {
      ...emptyState,
      queue: {
        d: Q({ id: "d", status: "draft", parts: ["Draf"] }),
        s: Q({ id: "s", status: "scheduled", parts: ["Jadual"], scheduledFor: "2026-12-01T01:00:00.000Z" }),
        f: Q({ id: "f", status: "failed", parts: ["Gagal"], scheduledFor: "2026-11-21T01:00:00.000Z" }),
        n: Q({ id: "n", status: "published", threadsId: "t_new", parts: ["Baru"], publishedAt: "2026-11-24T02:00:00.000Z" }),
      },
    });
    expect(out.map((p) => p.status).sort()).toEqual(["draft", "failed", "published", "published", "scheduled"]);
    expect(out.find((p) => p.text === "Baru")).toMatchObject({ id: "t_new", source: "studio" });
  });
  it("sorts newest first", () => {
    const out = build([P({ id: "old", text: "o", at: "2026-11-01T00:00:00Z" }), P({ id: "new", text: "n", at: "2026-11-22T00:00:00Z" })], emptyState);
    expect(out[0].id).toBe("new");
  });
});

describe("duplicate guard", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  it("blocks the same text posted within 24 hours", () => {
    expect(duplicateOf([P({ id: "a", text: "Hello dunia", at: "2026-11-24T02:00:00Z" })], "hello, dunia!", "publish", now)).toBeTruthy();
  });
  it("allows it after 24 hours, and allows finishing a draft", () => {
    expect(duplicateOf([P({ id: "a", text: "x y", at: "2026-11-22T02:00:00Z" })], "x y", "publish", now)).toBeUndefined();
    expect(duplicateOf([P({ id: "d", text: "x y", status: "draft", at: "2026-11-24T02:00:00Z" })], "x y", "publish", now)).toBeUndefined();
    expect(duplicateOf([P({ id: "d", text: "x y", status: "draft", at: "2026-11-24T02:00:00Z" })], "x y", "draft", now)).toBeTruthy();
  });
  it("ignores failed posts", () => {
    expect(duplicateOf([P({ id: "f", text: "x y", status: "failed", at: "2026-11-24T02:00:00Z" })], "x y", "publish", now)).toBeUndefined();
  });
});

describe("parseWhen", () => {
  it("treats a time without an offset as Malaysia time", () => {
    expect(parseWhen("2026-11-25T19:30")).toBe(Date.parse("2026-11-25T11:30:00Z"));
    expect(parseWhen("2026-11-25 19:30")).toBe(Date.parse("2026-11-25T11:30:00Z"));
  });
  it("respects an explicit offset or Z", () => {
    expect(parseWhen("2026-11-25T19:30:00Z")).toBe(Date.parse("2026-11-25T19:30:00Z"));
    expect(parseWhen("2026-11-25T19:30:00+07:00")).toBe(Date.parse("2026-11-25T12:30:00Z"));
  });
  it("is NaN for nonsense", () => {
    expect(Number.isNaN(parseWhen("besok petang"))).toBe(true);
  });
});
