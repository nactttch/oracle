import { describe, expect, test } from "bun:test"
import { applySignature, findTokenEndpoints } from "./token.js"

const MEDIA = "https://cdn.tld/live/ch5/playlist.m3u8"

describe("findTokenEndpoints", () => {
  test("an explicit config key outranks a lucky-looking url", () => {
    const found = findTokenEndpoints(
      ["https://cdn.tld/auth/thing"],
      `TOKEN_SERVER_URL:"https://token.easybroadcast.io/all"`,
    )
    expect(found[0]).toBe("https://token.easybroadcast.io/all")
  })

  test("spots a signing service by name", () => {
    expect(findTokenEndpoints(["https://token.tld/all", "https://cdn.tld/x.js"])).toEqual(["https://token.tld/all"])
  })

  test("never mistakes the manifest for the signer", () => {
    expect(findTokenEndpoints(["https://cdn.tld/auth/playlist.m3u8"])).toHaveLength(0)
  })
})

describe("applySignature", () => {
  test("appends a returned query string", () => {
    expect(applySignature(MEDIA, "token=abc&token_path=%2Flive")).toEqual([
      `${MEDIA}?token=abc&token_path=%2Flive`,
    ])
  })

  test("merges with an existing query string", () => {
    const withQuery = `${MEDIA}?a=1`
    expect(applySignature(withQuery, "token=abc")[0]).toBe(`${withQuery}&token=abc`)
  })

  test("pulls a token out of json", () => {
    expect(applySignature(MEDIA, `{"token":"xyz789"}`)).toContain(`${MEDIA}?token=xyz789`)
  })

  test("a complete url in the response wins outright", () => {
    const signed = "https://cdn.tld/live/ch5/playlist.m3u8?hdnts=exp"
    expect(applySignature(MEDIA, JSON.stringify({ url: signed }))[0]).toBe(signed)
  })

  test("handles a bare token", () => {
    expect(applySignature(MEDIA, "abcdef1234567890")).toContain(`${MEDIA}?token=abcdef1234567890`)
  })

  test("returns nothing for an error page", () => {
    expect(applySignature(MEDIA, "<html>nope</html>")).toHaveLength(0)
  })
})
