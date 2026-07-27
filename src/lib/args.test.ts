import { describe, expect, test } from "bun:test"
import { looksLikeUrl, parseArgs } from "./args.js"

describe("parseArgs", () => {
  test("takes a bare url", () => {
    expect(parseArgs(["https://site.tld/x"]).url).toBe("https://site.tld/x")
  })

  test("accepts --key value and --key=value alike", () => {
    expect(parseArgs(["--depth", "6"]).depth).toBe(6)
    expect(parseArgs(["--depth=6"]).depth).toBe(6)
  })

  test("--format implies headless", () => {
    const parsed = parseArgs(["--format", "json"])
    expect(parsed.format).toBe("json")
    expect(parsed.headless).toBe(true)
  })

  test("collects repeated headers, lower-casing names", () => {
    const parsed = parseArgs(["-H", "X-Token: abc", "-H", "Cookie: a=1"])
    expect(parsed.headers).toEqual({ "x-token": "abc", cookie: "a=1" })
  })

  test("understands the negating flags", () => {
    const parsed = parseArgs(["--no-servers", "--no-sandbox", "--no-probe"])
    expect(parsed.noServers).toBe(true)
    expect(parsed.noSandbox).toBe(true)
    expect(parsed.noProbe).toBe(true)
  })

  test("rejects an unknown option", () => {
    expect(parseArgs(["--nope"]).error).toContain("unknown option")
  })

  test("rejects an unknown theme and format", () => {
    expect(parseArgs(["--theme", "neon"]).error).toContain("unknown theme")
    expect(parseArgs(["--format", "yaml"]).error).toContain("unknown format")
  })

  test("rejects a malformed header", () => {
    expect(parseArgs(["-H", "nocolon"]).error).toContain("malformed header")
  })

  test("rejects two urls", () => {
    expect(parseArgs(["https://a.tld", "https://b.tld"]).error).toContain("only one url")
  })

  test("reports a missing value rather than eating the next flag", () => {
    expect(parseArgs(["--depth", "abc"]).error).toContain("--depth needs a number")
  })

  test("help and version short-circuit", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["-v"]).version).toBe(true)
  })
})

describe("looksLikeUrl", () => {
  test("accepts urls with and without a scheme", () => {
    expect(looksLikeUrl("https://site.tld/x")).toBe(true)
    expect(looksLikeUrl("site.tld/embed/1")).toBe(true)
  })

  test("rejects prose and multi-line clipboard content", () => {
    expect(looksLikeUrl("just some words")).toBe(false)
    expect(looksLikeUrl("https://a.tld\nhttps://b.tld")).toBe(false)
    expect(looksLikeUrl("")).toBe(false)
  })
})
