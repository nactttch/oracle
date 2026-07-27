import { describe, expect, test } from "bun:test"
import { extractIdentifiers, looksLikeApiResponse, rankApiBases, synthesizeEndpoints } from "./api.js"

describe("extractIdentifiers", () => {
  test("separates the id from the collection around it", () => {
    const parsed = extractIdentifiers("https://player.tld/events/73_arryadia_k2tgcj0")
    expect(parsed.ids).toContain("73_arryadia_k2tgcj0")
    expect(parsed.collections).toContain("events")
  })

  test("ignores route structure", () => {
    const parsed = extractIdentifiers("https://player.tld/en/live/player")
    expect(parsed.ids).toHaveLength(0)
  })

  test("takes ids out of the query string", () => {
    const parsed = extractIdentifiers("https://player.tld/embed?id=abc12345")
    expect(parsed.ids).toContain("abc12345")
  })

  test("survives a url it cannot parse", () => {
    expect(extractIdentifiers("nonsense").ids).toHaveLength(0)
  })
})

describe("synthesizeEndpoints", () => {
  const pageUrl = "https://snrt.player.easybroadcast.io/events/73_arryadia_k2tgcj0"

  test("mirrors the spa route onto the api host, which is the common case", () => {
    const endpoints = synthesizeEndpoints({ pageUrl, bases: ["https://api.easybroadcast.io"] })
    // The shape that actually serves this player.
    expect(endpoints).toContain("https://api.easybroadcast.io/api/events/73_arryadia_k2tgcj0")
  })

  test("puts the likeliest shape first, because the budget is small", () => {
    const endpoints = synthesizeEndpoints({ pageUrl, bases: ["https://api.easybroadcast.io"] })
    expect(endpoints[0]).toBe("https://api.easybroadcast.io/api/events/73_arryadia_k2tgcj0")
  })

  test("produces nothing without an identifier to build on", () => {
    expect(synthesizeEndpoints({ pageUrl: "https://a.tld/live", bases: ["https://api.a.tld"] })).toHaveLength(0)
  })

  test("produces nothing without a base", () => {
    expect(synthesizeEndpoints({ pageUrl, bases: [] })).toHaveLength(0)
  })

  test("respects the probe limit", () => {
    const endpoints = synthesizeEndpoints({ pageUrl, bases: ["https://api.a.tld", "https://b.tld"] }, 6)
    expect(endpoints.length).toBeLessThanOrEqual(6)
  })
})

describe("rankApiBases", () => {
  test("an api-named host outranks a cdn", () => {
    const ranked = rankApiBases(
      ["https://cdn.easybroadcast.io/x.js", "https://api.easybroadcast.io/y", "https://fonts.gstatic.com/f"],
      "https://player.easybroadcast.io/events/1",
    )
    expect(ranked[0]).toBe("https://api.easybroadcast.io")
  })

  test("the page origin is always worth a try", () => {
    const ranked = rankApiBases([], "https://player.tld/events/1")
    expect(ranked).toContain("https://player.tld")
  })
})

describe("looksLikeApiResponse", () => {
  test("json by content type or by shape", () => {
    expect(looksLikeApiResponse("{}", "application/json")).toBe(true)
    expect(looksLikeApiResponse('  [{"a":1}]', "text/html")).toBe(true)
    expect(looksLikeApiResponse("<html>", "text/html")).toBe(false)
  })
})
