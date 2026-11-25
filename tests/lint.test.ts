import { describe, expect, it } from "vitest";
import { lintPost, sameText, topicError } from "../src/lint.js";

describe("lintPost", () => {
  it("allows exactly 500 characters and rejects 501", () => {
    expect(lintPost(["a".repeat(500)]).ok).toBe(true);
    const r = lintPost(["a".repeat(501)]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("501/500");
  });
  it("counts emoji as one character each, not two", () => {
    expect(lintPost(["😀".repeat(500)]).ok).toBe(true);
  });
  it("checks every thread part", () => {
    const r = lintPost(["ok", "b".repeat(600)]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("Bahagian 2");
  });
  it("rejects an empty post", () => {
    expect(lintPost([""]).ok).toBe(false);
    expect(lintPost(["  "]).ok).toBe(false);
  });
  it("validates the Threads topic", () => {
    expect(topicError("Business")).toBeUndefined();
    expect(topicError("")).toBeUndefined();
    expect(topicError("a.b")).toBeTruthy();
    expect(topicError("R&D")).toBeTruthy();
    expect(topicError("x".repeat(51))).toBeTruthy();
    expect(lintPost(["hi"], { topic: "bad.topic" }).ok).toBe(false);
  });
  it("never judges style: any shape passes and produces no warnings", () => {
    const shapes = [
      "Semalam client aku call 9 kali. Korang pernah kena?",                 // question ending, 'korang pernah' formula
      "Ini 🔥🔥🔥🔥🔥 #satu #dua — guna LLM untuk game-changer",             // many emoji, hashtags, em-dash, jargon
      "SATU\n\n- dua\n- tiga\n\n1. empat\n2. lima",                          // list shape
      "Same opening as the last one. Same opening as the last one.",
      "English only, long-ish, with a link https://example.com/a?b=c",
    ];
    for (const s of shapes) expect(lintPost([s])).toMatchObject({ ok: true, errors: [], warnings: [] });
  });
  it("warns only about words the owner put on their own avoid-list", () => {
    expect(lintPost(["guna LLM untuk game-changer"]).warnings).toHaveLength(0);
    const r = lintPost(["guna LLM untuk game-changer"], { banned: ["LLM", "synergy"] });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/LLM/);
  });
  it("a long text can be split into a thread instead of being refused outright", () => {
    const r = lintPost(["a".repeat(501)]);
    expect(r.errors[0]).toMatch(/thread \(parts\)/);
    expect(lintPost(["a".repeat(500), "b".repeat(500), "c".repeat(500)]).ok).toBe(true);
  });
});

describe("sameText", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(sameText("Hello,  Dunia!", "hello dunia")).toBe(true);
    expect(sameText("a", "b")).toBe(false);
  });
});
