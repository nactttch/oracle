import { describe, expect, test } from "bun:test"
import { createHoneypot, runInHoneypot } from "./sandbox.js"

const PAGE = "https://site.tld/embed/5"

function values(code: string, timeout = 4000): string[] {
  return runInHoneypot(code, { pageUrl: PAGE, timeout }).hits.map((hit) => hit.value)
}

describe("survivability", () => {
  test("a script that touches the DOM does not throw", () => {
    const result = runInHoneypot(
      `var el = document.getElementById('player');
       el.style.width = window.innerWidth + 'px';
       document.querySelectorAll('.x')[0].classList.add('y');`,
      { pageUrl: PAGE },
    )
    expect(result.error).toBeUndefined()
  })

  test("an unknown global resolves instead of throwing ReferenceError", () => {
    const result = runInHoneypot(`SomeLibraryNobodyHasEverHeardOf.init({a: 1}).start();`, { pageUrl: PAGE })
    expect(result.error).toBeUndefined()
  })

  test("real intrinsics still work", () => {
    const result = runInHoneypot(
      `var out = JSON.stringify({a: Math.max(1, 2)});
       if (out !== '{"a":2}') { throw new Error('intrinsics broken: ' + out); }
       if (typeof undefined !== 'undefined') { throw new Error('undefined was shadowed'); }`,
      { pageUrl: PAGE },
    )
    expect(result.error).toBeUndefined()
  })

  test("an infinite loop is cut off rather than hanging", () => {
    const result = runInHoneypot(`while (true) {}`, { pageUrl: PAGE, timeout: 300 })
    expect(result.timedOut).toBe(true)
  })
})

describe("capture", () => {
  test("records a player setup call", () => {
    const found = values(`jwplayer('v').setup({file: 'https://cdn.tld/live/index.m3u8', type: 'hls'});`)
    expect(found).toContain("https://cdn.tld/live/index.m3u8")
  })

  test("records a constructor argument", () => {
    const found = values(`new SomePlayer({sources: [{src: 'https://cdn.tld/a.mpd'}]});`)
    expect(found).toContain("https://cdn.tld/a.mpd")
  })

  test("records an element src assignment", () => {
    const result = runInHoneypot(
      `var s = document.createElement('script'); s.src = 'https://cdn.tld/x.m3u8';`,
      { pageUrl: PAGE },
    )
    const hit = result.hits.find((entry) => entry.value === "https://cdn.tld/x.m3u8")
    expect(hit?.network).toBe("script")
  })

  test("records network calls with their kind", () => {
    const result = runInHoneypot(
      `var x = new XMLHttpRequest(); x.open('GET', '/api/token?ch=5'); x.send();
       fetch('/api/manifest');`,
      { pageUrl: PAGE },
    )
    expect(result.hits.find((hit) => hit.value === "/api/token?ch=5")?.network).toBe("xhr")
    expect(result.hits.find((hit) => hit.value === "/api/manifest")?.network).toBe("fetch")
  })

  test("drains deferred work so setTimeout payloads are seen", () => {
    const found = values(`setTimeout(function () { jwplayer('v').setup({file: 'https://cdn.tld/late.m3u8'}); }, 50);`)
    expect(found).toContain("https://cdn.tld/late.m3u8")
  })
})

describe("layers", () => {
  test("cracks base64 assembled at runtime", () => {
    const host = Buffer.from("https://cdn.tld/").toString("base64")
    const path = Buffer.from("live/ch5/index.m3u8").toString("base64")
    const found = values(`jwplayer('v').setup({file: atob('${host}') + atob('${path}')});`)
    expect(found).toContain("https://cdn.tld/live/ch5/index.m3u8")
  })

  test("captures the source handed to eval", () => {
    const inner = Buffer.from(`var u = "https://cdn.tld/inner.m3u8";`).toString("base64")
    const result = runInHoneypot(`eval(atob('${inner}'));`, { pageUrl: PAGE })
    expect(result.evaluated.join("\n")).toContain("https://cdn.tld/inner.m3u8")
  })

  test("captures document.write markup", () => {
    const result = runInHoneypot(`document.write('<iframe src="https://cdn.tld/real/"></iframe>');`, {
      pageUrl: PAGE,
    })
    expect(result.written.join("")).toContain("https://cdn.tld/real/")
  })

  test("sees through a hex-named string table", () => {
    const found = values(
      `var _0x1a2b = ['https://cdn.tld/', 'obf.m3u8'];
       var target = _0x1a2b[0] + _0x1a2b[1];
       new Hls().loadSource(target);`,
    )
    expect(found).toContain("https://cdn.tld/obf.m3u8")
  })
})

describe("containment", () => {
  test("the page url is what the script sees", () => {
    const result = runInHoneypot(`location.assign(location.href + '?x=1');`, { pageUrl: PAGE })
    expect(result.hits.find((hit) => hit.network === "navigate")?.value).toBe(`${PAGE}?x=1`)
  })

  test("no host globals leak in", () => {
    const result = runInHoneypot(
      `if (typeof process !== 'undefined' && process.exit) { throw new Error('process reachable'); }
       if (typeof require === 'function') { throw new Error('require reachable'); }`,
      { pageUrl: PAGE },
    )
    expect(result.error).toBeUndefined()
  })
})

describe("shared session", () => {
  test("later scripts see what earlier ones registered", () => {
    // The bundler case: a runtime chunk that later chunks push into. Run these
    // in separate contexts and the second one registers into a global the
    // first cannot see, so the app never boots.
    const session = createHoneypot({ pageUrl: PAGE })
    session.run(`window.__chunks = []; window.__push = function (f) { window.__chunks.push(f); };`, "runtime.js")
    session.run(`window.__push(function () { jwplayer('v').setup({file: 'https://cdn.tld/bundled.m3u8'}); });`, "chunk.js")
    session.run(`window.__chunks.forEach(function (f) { f(); });`, "boot.js")
    session.drain()
    expect(session.hits.map((hit) => hit.value)).toContain("https://cdn.tld/bundled.m3u8")
  })

  test("a chunk that throws does not stop the ones after it", () => {
    const session = createHoneypot({ pageUrl: PAGE })
    const bad = session.run(`throw new Error('boom');`, "bad.js")
    session.run(`new Hls().loadSource('https://cdn.tld/after.m3u8');`, "good.js")
    session.drain()
    expect(bad.error).toContain("boom")
    expect(session.hits.map((hit) => hit.value)).toContain("https://cdn.tld/after.m3u8")
  })
})

describe("deferred callbacks", () => {
  test("a callback handed to an unknown api still runs", () => {
    // The honeypot's own document fires listeners immediately, so the value is
    // only at risk when the page has moved to some *other* object first. An
    // anti-adblock script that rebuilds the document inside an iframe leaves
    // the real player registering on a ghost, and a ghost that only records
    // its arguments drops the callback — taking the stream with it.
    const session = createHoneypot({ pageUrl: PAGE })
    session.run(
      `SomeLoader.whenReady(function () { jwplayer('v').setup({file: 'https://cdn.tld/deferred.m3u8'}); });`,
      "player.js",
    )
    session.drain()
    expect(session.hits.map((hit) => hit.value)).toContain("https://cdn.tld/deferred.m3u8")
  })

  test("it finds the callback through apply and through an options object", () => {
    const session = createHoneypot({ pageUrl: PAGE })
    session.run(
      `document.createElement('iframe').contentWindow.document.addEventListener.apply(null,
         ['DOMContentLoaded', function () { new Hls().loadSource('https://cdn.tld/applied.m3u8'); }]);`,
      "applied.js",
    )
    session.run(
      `Api.request({url: '/x', success: function () { new Hls().loadSource('https://cdn.tld/optioned.m3u8'); }});`,
      "optioned.js",
    )
    session.drain()
    const values = session.hits.map((hit) => hit.value)
    expect(values).toContain("https://cdn.tld/applied.m3u8")
    expect(values).toContain("https://cdn.tld/optioned.m3u8")
  })

  test("an onload assignment is a registration too", () => {
    const session = createHoneypot({ pageUrl: PAGE })
    session.run(
      `var s = SomeThing.make(); s.onload = function () { new Hls().loadSource('https://cdn.tld/onload.m3u8'); };`,
      "onload.js",
    )
    session.drain()
    expect(session.hits.map((hit) => hit.value)).toContain("https://cdn.tld/onload.m3u8")
  })

  test("a handler that throws does not stop the others", () => {
    const session = createHoneypot({ pageUrl: PAGE })
    session.run(
      `Loader.on('a', function () { throw new Error('boom'); });
       Loader.on('b', function () { new Hls().loadSource('https://cdn.tld/survivor.m3u8'); });`,
      "mixed.js",
    )
    session.drain()
    expect(session.hits.map((hit) => hit.value)).toContain("https://cdn.tld/survivor.m3u8")
  })
})
