import { afterEach, describe, expect, it } from "vitest";
import { fetchImage, imageNet, isPrivateIp, MAX_DOWNLOAD } from "../src/fetch-image.js";

const realLookup = imageNet.lookup;
const realFetch = imageNet.fetch;
afterEach(() => { imageNet.lookup = realLookup; imageNet.fetch = realFetch; });

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const publicDns = () => { imageNet.lookup = async () => ["93.184.216.34"]; };
const respond = (fn: (url: string, n: number) => Response) => { let n = 0; imageNet.fetch = async (url) => fn(url, n++); };

describe("which addresses count as private", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5", "::ffff:7f00:1", "64:ff9b::1", "2001:db8::1",
  ])("%s is private", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.255.255", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s is public", (ip) => expect(isPrivateIp(ip)).toBe(false));
  it("anything that is not an IP is unsafe", () => expect(isPrivateIp("not-an-ip")).toBe(true));
});

describe("downloading a picture from a link", () => {
  it("returns the bytes of a public https link", async () => {
    publicDns();
    respond(() => new Response(PNG_BYTES, { headers: { "content-length": String(PNG_BYTES.length) } }));
    expect((await fetchImage("https://export-download.canva.com/abc/design.png?sig=1")).equals(PNG_BYTES)).toBe(true);
  });
  it.each([
    ["http://example.com/a.png", /https/],
    ["https://user:pass@example.com/a.png", /kata laluan/],
    ["https://example.com:8443/a.png", /port/],
    ["https://localhost/a.png", /dalaman/],
    ["https://printer.local/a.png", /dalaman/],
    ["https://metadata.internal/a.png", /dalaman/],
    ["https://10.0.0.5/a.png", /dalaman|persendirian/],
    ["https://[::1]/a.png", /dalaman|persendirian/],
    ["https://169.254.169.254/latest/meta-data", /dalaman|persendirian/],
    ["not a url", /tak sah/],
  ])("refuses %s without fetching", async (url, why) => {
    publicDns();
    let fetched = 0;
    imageNet.fetch = async () => { fetched++; return new Response(PNG_BYTES); };
    await expect(fetchImage(url)).rejects.toThrow(why);
    expect(fetched).toBe(0);
  });
  it("refuses a name that resolves to a private address", async () => {
    imageNet.lookup = async () => ["93.184.216.34", "10.0.0.9"];
    let fetched = 0;
    imageNet.fetch = async () => { fetched++; return new Response(PNG_BYTES); };
    await expect(fetchImage("https://sneaky.example.com/a.png")).rejects.toThrow(/persendirian/);
    expect(fetched).toBe(0);
  });
  it("follows a redirect to another public address, but checks every hop", async () => {
    publicDns();
    respond((url, n) => (n === 0 ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/real.png" } }) : new Response(PNG_BYTES)));
    expect((await fetchImage("https://short.example.com/x")).length).toBe(PNG_BYTES.length);

    respond(() => new Response(null, { status: 302, headers: { location: "http://example.com/a.png" } }));
    await expect(fetchImage("https://short.example.com/x")).rejects.toThrow(/https/);

    imageNet.lookup = async (h) => (h === "evil.example.com" ? ["10.0.0.1"] : ["93.184.216.34"]);
    respond(() => new Response(null, { status: 301, headers: { location: "https://evil.example.com/a.png" } }));
    await expect(fetchImage("https://short.example.com/x")).rejects.toThrow(/persendirian/);

    respond(() => new Response(null, { status: 302, headers: { location: "/again" } }));
    await expect(fetchImage("https://loop.example.com/x")).rejects.toThrow(/lencongan/);
  });
  it("refuses a file that is too big, by header and while streaming", async () => {
    publicDns();
    respond(() => new Response(PNG_BYTES, { headers: { "content-length": String(MAX_DOWNLOAD + 1) } }));
    await expect(fetchImage("https://example.com/big.png")).rejects.toThrow(/terlalu besar/);
    respond(() => new Response(new Uint8Array(MAX_DOWNLOAD + 10))); // no length header
    await expect(fetchImage("https://example.com/big2.png")).rejects.toThrow(/terlalu besar/);
  });
  it("explains an expired link, an empty answer and a network failure", async () => {
    publicDns();
    respond(() => new Response("denied", { status: 403 }));
    await expect(fetchImage("https://example.com/a.png")).rejects.toThrow(/403.*tamat tempoh/);
    respond(() => new Response(new Uint8Array(0)));
    await expect(fetchImage("https://example.com/a.png")).rejects.toThrow(/kosong/);
    imageNet.fetch = async () => { throw new Error("boom"); };
    await expect(fetchImage("https://example.com/a.png")).rejects.toThrow(/sambungan gagal/);
    imageNet.lookup = async () => { throw new Error("ENOTFOUND"); };
    await expect(fetchImage("https://nowhere.example.com/a.png")).rejects.toThrow(/Tak dapat cari alamat/);
  });
});
