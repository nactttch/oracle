import { describe, expect, test } from "bun:test"
import type { Candidate } from "../core/types.js"
import { describeCandidate, describeTechniques, formatBytes, formatDuration, hostOf, shortenUrl, statusGlyph, truncate } from "./format.js"

const base: Candidate = {
  url: "https://edge.cdn.tld/live/ch5/index.m3u8?tk=abc",
  kind: "hls",
  origin: "https://site.tld/embed/",
  via: ["sandbox", "base64", "sandbox"],
  depth: 2,
  confidence: 80,
  headers: {},
}

describe("units", () => {
  test("bytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(999)).toBe("999 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
  })

  test("durations", () => {
    expect(formatDuration(undefined)).toBe("—")
    expect(formatDuration(45)).toBe("45s")
    expect(formatDuration(125)).toBe("2m05s")
    expect(formatDuration(3725)).toBe("1h02m")
  })
})

describe("urls", () => {
  test("host extraction survives junk", () => {
    expect(hostOf("https://edge.cdn.tld/x")).toBe("edge.cdn.tld")
    expect(hostOf("not a url")).toBe("not a url")
  })

  test("shortening keeps the host and the filename", () => {
    const short = shortenUrl(base.url, 34)
    expect(short.length).toBeLessThanOrEqual(34)
    expect(short).toContain("edge.cdn.tld")
    expect(short).toContain("index.m3u8")
  })

  test("a short url is left alone", () => {
    expect(shortenUrl("https://a.tld/x.m3u8", 40)).toBe("https://a.tld/x.m3u8")
  })

  test("truncate never exceeds the width", () => {
    expect(truncate("abcdefghij", 5)).toHaveLength(5)
    expect(truncate("abc", 10)).toBe("abc")
  })
})

describe("candidate summaries", () => {
  test("describes a live encrypted master", () => {
    const summary = describeCandidate({
      ...base,
      live: true,
      encrypted: true,
      keyMethod: "AES-128",
      resolution: "1920x1080",
      variants: [{ url: "x" }, { url: "y" }],
    })
    expect(summary).toContain("HLS")
    expect(summary).toContain("1920x1080")
    expect(summary).toContain("live")
    expect(summary).toContain("enc:AES-128")
    expect(summary).toContain("2 renditions")
  })

  test("technique chains are de-duplicated and readable", () => {
    expect(describeTechniques(base)).toBe("sandbox → base64")
  })

  test("status glyphs reflect verification", () => {
    expect(statusGlyph({ ...base, verified: true }).tone).toBe("ok")
    expect(statusGlyph({ ...base, verified: false }).tone).toBe("bad")
    expect(statusGlyph(base).tone).toBe("warn")
  })
})
