import { describe, expect, it } from "vitest";
import { addDays, baseline, bestWindows, features, heatmap, hookOf, hookType, language, mytDate, mytParts, rankWinners, suggestSlots, tracker, weekStart } from "../src/metrics.js";
import type { Post } from "../src/types.js";

const mk = (text: string, at: string, over: Partial<Post> = {}): Post => ({
  id: Math.random().toString(36).slice(2), text, status: "published", at, media: 0, source: "native", metricsKnown: false, ...over,
});
const withViews = (text: string, at: string, views: number, likes = 0, replies = 0, over: Partial<Post> = {}) =>
  mk(text, at, { metrics: { views, likes, replies }, metricsKnown: true, ...over });

describe("Malaysia day boundaries", () => {
  it("rolls over at 16:00 UTC", () => {
    expect(mytDate("2026-11-23T15:59:59Z")).toBe("2026-11-23");
    expect(mytDate("2026-11-23T16:00:00Z")).toBe("2026-11-24");
  });
  it("knows weekday (Monday = 0) and hour in MYT", () => {
    const p = mytParts("2026-11-24T10:00:00Z"); // Tuesday 18:00 MYT
    expect(p).toEqual({ date: "2026-11-24", hour: 18, dow: 1 });
    expect(weekStart("2026-11-24")).toBe("2026-11-23");
    expect(weekStart("2026-11-22")).toBe("2026-11-16"); // Sunday belongs to the week that started Monday 16th
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  });
});

describe("tracker", () => {
  const now = new Date("2026-11-24T10:00:00Z"); // Tue 18:00 MYT
  it("counts today, week, month and a streak that meets the goal", () => {
    const posts = [
      mk("a", "2026-11-24T02:00:00Z"), mk("b", "2026-11-24T08:00:00Z"), // Tue x2
      mk("c", "2026-11-23T04:00:00Z"), // Mon
      mk("d", "2026-11-22T04:00:00Z"), // Sun
    ];
    const t = tracker(posts, now, 1);
    expect(t.today).toBe(2);
    expect(t.week).toBe(3);
    expect(t.month).toBe(4);
    expect(t.streak).toBe(3);
    expect(t.todayPending).toBe(false);
    expect(t.last30).toHaveLength(30);
  });
  it("keeps the streak alive until today is over", () => {
    const t = tracker([mk("c", "2026-11-23T04:00:00Z"), mk("d", "2026-11-22T04:00:00Z")], now, 1);
    expect(t.today).toBe(0);
    expect(t.todayPending).toBe(true);
    expect(t.streak).toBe(2);
  });
  it("a higher goal needs more posts per day", () => {
    const t = tracker([mk("a", "2026-11-24T02:00:00Z"), mk("c", "2026-11-23T04:00:00Z"), mk("c2", "2026-11-23T05:00:00Z")], now, 2);
    expect(t.todayLeft).toBe(1);
    expect(t.streak).toBe(1); // only Monday met 2/day; today still pending
  });
  it("does not count drafts, failed or scheduled posts, and lists upcoming ones", () => {
    const posts = [
      mk("draft", "2026-11-24T02:00:00Z", { status: "draft" }),
      mk("failed", "2026-11-24T02:00:00Z", { status: "failed" }),
      mk("later", "2026-11-24T14:00:00Z", { status: "scheduled" }),
      mk("past-scheduled", "2026-11-20T14:00:00Z", { status: "scheduled" }),
    ];
    const t = tracker(posts, now, 1);
    expect(t.today).toBe(0);
    expect(t.scheduled.map((s) => s.text)).toEqual(["later"]);
    expect(t.drafts).toBe(1);
  });
  it("counts a post made just after midnight MYT on the new day", () => {
    const t = tracker([mk("x", "2026-11-23T16:30:00Z")], now, 1);
    expect(t.today).toBe(1);
  });
});

describe("text features", () => {
  it("labels hooks", () => {
    expect(hookType("Kenapa customer ghosting kau?")).toBe("soalan");
    expect(hookType("RM300 hilang setiap minggu sebab tak balas")).toBe("angka");
    expect(hookType("Unpopular opinion: chatbot bukan untuk semua")).toBe("pendapat");
    expect(hookType("Semalam client aku call 9 kali tak dapat jawapan")).toBe("cerita");
    expect(hookType("3 cara jimat masa balas WhatsApp")).toBe("tip");
    expect(hookType("Balas lambat bunuh bisnes")).toBe("pernyataan");
  });
  it("takes the first line as the hook", () => {
    expect(hookOf("Baris satu\nBaris dua")).toBe("Baris satu");
  });
  it("detects language", () => {
    expect(language("Aku dah penat tengok customer tak balas dan kau pun tak buat apa")).toBe("ms");
    expect(language("You are losing customers because the reply is slow and it is not fixed")).toBe("en");
  });
  it("builds a feature summary with the MYT slot", () => {
    const f = features(mk("Soalan hari ni?\nRM50 je", "2026-11-24T10:00:00Z"));
    expect(f).toMatchObject({ hookType: "soalan", lines: 2, hasRinggit: true, hasQuestion: true, day: "Sel", slot: "Sel 18:00-21:00" });
  });
});

describe("winners", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const posts = [
    withViews("biasa 1", "2026-11-10T04:00:00Z", 100, 3, 0),
    withViews("biasa 2", "2026-11-11T04:00:00Z", 110, 3, 0),
    withViews("biasa 3", "2026-11-12T04:00:00Z", 90, 2, 0),
    withViews("HIT besar", "2026-11-20T04:00:00Z", 1500, 90, 12),
    withViews("sederhana", "2026-11-15T04:00:00Z", 160, 5, 1),
    mk("belum ada nombor", "2026-11-23T04:00:00Z"), // metrics unknown: must not count as zero
  ];
  it("uses only posts whose numbers are known for the baseline", () => {
    const b = baseline(posts);
    expect(b.n).toBe(5);
    expect(b.medianViews).toBe(110);
  });
  it("ranks the post that beats their own median first and labels it", () => {
    const w = rankWinners(posts, now, 3);
    expect(w[0].post.text).toBe("HIT besar");
    expect(w[0].vsViews).toBeGreaterThan(10);
    expect(w[0].labels).toContain("Tontonan tinggi");
    expect(w.some((x) => x.post.text === "belum ada nombor")).toBe(false);
  });
  it("lets hand-logged leads outrank raw views and tags 'Paling convert'", () => {
    const withLeads = posts.map((p) => (p.text === "biasa 2" ? { ...p, leads: 4 } : p));
    const w = rankWinners(withLeads, now, 3);
    expect(w[0].post.text).toBe("biasa 2");
    expect(w[0].labels).toContain("Paling convert");
  });
  it("returns nothing when no post has numbers", () => {
    expect(rankWinners([mk("a", "2026-11-20T04:00:00Z")], now)).toEqual([]);
  });
});

describe("heatmap and slots", () => {
  const now = new Date("2026-11-24T10:00:00Z"); // Tue 18:00 MYT
  // Saturdays 18:00-21:00 MYT do well
  const sat = (day: string, views: number) => withViews("sat", `${day}T11:00:00Z`, views); // 19:00 MYT
  const posts = [sat("2026-11-07", 800), sat("2026-11-14", 900), withViews("tue", "2026-11-10T04:00:00Z", 100), withViews("tue2", "2026-11-17T04:00:00Z", 120)];
  it("finds the best window", () => {
    const g = heatmap(posts);
    const best = bestWindows(g, 1);
    expect(best[0].label).toBe("Sab 18:00-21:00");
    expect(best[0].avgViews).toBe(850);
  });
  it("suggests slots in the future, spaced out, best window first", () => {
    const g = heatmap(posts);
    const s = suggestSlots(g, [], now, 3);
    expect(s.length).toBe(3);
    for (const x of s) expect(Date.parse(x.at)).toBeGreaterThan(now.getTime() + 20 * 60_000);
    expect(s.some((x) => x.why.includes("Sab 18:00-21:00"))).toBe(true); // the best window is picked before the generic defaults
    const times = s.map((x) => Date.parse(x.at));
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(90 * 60_000);
  });
  it("avoids slots near what is already scheduled", () => {
    const g = heatmap(posts);
    const first = suggestSlots(g, [], now, 1)[0];
    const next = suggestSlots(g, [first.at], now, 3);
    for (const x of next) expect(Math.abs(Date.parse(x.at) - Date.parse(first.at))).toBeGreaterThanOrEqual(90 * 60_000);
  });
  it("falls back to default times with no history", () => {
    const s = suggestSlots(heatmap([]), [], now, 3);
    expect(s.length).toBe(3);
    expect(s[0].why).toContain("belum cukup data");
  });
});
