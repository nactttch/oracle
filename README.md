<div align="center">

```
█▀█ █▀▄ █▀█ █▀▀ █   █▀▀
█ █ █▀▄ █▀█ █   █   █▀▀
▀▀▀ ▀ ▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀
```

**dig any iframe. surface the raw stream.**

A terminal tool that unpacks, deobfuscates and *executes* player embeds until the real
`.m3u8` / `.mpd` falls out — and finds the sibling servers while it's at it.

[Install](#install) · [Use it](#use-it) · [How it works](#how-it-works) · [Options](#options)

</div>

---

## What it does

Point Oracle at a page or at an iframe URL. It follows the embed graph, peels every
obfuscation layer it meets, runs the player's own JavaScript against a fake browser,
verifies what it finds, and hands you URLs that actually play.

```
$ oracle https://site.tld/match/live-5

 ╭─ 6 streams · 5 verified ────────────────────────────────────────────────╮
 │ ❯ ● edge2.cdn-x.net/…/index.m3u8                              [serv=2]  │
 │   ● edge3.cdn-x.net/…/index.m3u8                              [serv=3]  │
 │   ● edge1.cdn-x.net/…/master.m3u8                                       │
 ╰─────────────────────────────────────────────────────────────────────────╯
 ╭─ selected ──────────────────────────────────────────────────────────────╮
 │ what  HLS · 1920x1080 · live · 3 renditions                             │
 │ via   packer → base64 → sandbox                                         │
 │ state master · 3 renditions  ████████░░                                 │
 ╰─────────────────────────────────────────────────────────────────────────╯

 ↑↓ select  ·  ↵ copy  ·  c command  ·  d detail  ·  s json  ·  m m3u
```

## Install

Oracle runs on [Bun](https://bun.sh) — free, one line, no admin rights:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then clone and link it:

```bash
git clone https://github.com/nactttch/oracle.git
cd oracle
bun install
bun run build
bun link          # puts `oracle` on your PATH
```

Now type `oracle` anywhere. (Restart your shell if the command isn't found —
`bun link` installs into `~/.bun/bin`, which Bun's installer adds to your `PATH`.)

Once it's published to npm, `bun install -g oracle-stream` will do the same in one step.

## Use it

```bash
oracle                                     # prompts for a url
oracle https://site.tld/match/live-5       # a page that embeds a player
oracle https://cdn.tld/albaplayer/max-5/   # the iframe itself
```

Interactive keys: `↑↓` select · `↵` copy the URL · `c` copy an `mpv`/`ffmpeg` command ·
`d` full detail · `s` save JSON · `m` save an `.m3u` playlist · `r` dig again · `^t` cycle theme.

### In a pipeline

Oracle switches to headless output automatically when stdout isn't a terminal, so it
composes:

```bash
oracle -f urls https://site.tld/x | xargs -n1 mpv           # play everything it found
oracle -f json -o streams.json https://site.tld/x           # machine-readable report
oracle -f m3u  -o live.m3u https://site.tld/x && vlc live.m3u
oracle --print https://site.tld/x                           # human-readable report
```

Exit code is `0` when streams were found, `2` when none were, so `if oracle …; then` works.

## How it works

Most extractors are a regex for `.m3u8` over a page's HTML. That finds the easy 20% and
nothing else, because the interesting cases hide the URL behind packing, base64, a hex
string table, and a runtime string concatenation — often all four at once.

Oracle runs six layers, escalating: each one only exists because the ones above it
come back empty on real sites.

**Formats it looks for** — not just HLS: `.m3u8`/`.m3u`, DASH `.mpd`, Smooth Streaming
(`.ism`/`Manifest`), Adobe HDS `.f4m`, MP4/WebM/MKV/MOV, FLV, raw MPEG-TS, audio-only
(AAC/MP3/M4A/Opus), and the streaming protocols `rtmp(s)`, `rtsp`, `srt`, `ws(s)`, and
WebRTC `whep`/`whip`. Extensionless manifests behind a signing CDN are caught too, by
probing rather than by pattern.

### 1. The document graph

Page → iframes → nested iframes → their scripts → the XHR endpoints those scripts call.
Traversal is breadth-first, because the stream is almost always one or two hops in, and
every request carries the `Referer` a browser would have sent — most player hosts `403`
without it. Cookies set on the first hop are replayed on the next.

### 2. Static deobfuscation

No code runs, so a script that tries to detect an automated client never gets the chance:

- **Dean Edwards packer** (`eval(function(p,a,c,k,e,d)…)`) — decoded directly, including packs nested in packs
- **Escapes** — `\xNN`, `\uNNNN`, octal, `%NN` runs
- **`String.fromCharCode(…)`** folded into literals
- **String concatenation** — `"ht" + "tps://" + host` collapsed
- **base64 and hex payloads** that decode to something URL-shaped

Passes re-run until the text stops changing, because obfuscators stack.

### 3. The honeypot 🍯

The first part that makes Oracle different.

Player bootstraps are written against a browser and nothing else. Run one in a bare VM
and it dies on line 1 at `document.getElementById` — long before it reveals anything. The
usual answer is to drive headless Chromium: 300 MB, slow, and trivially detected.

Instead, Oracle contextifies a **Proxy as the VM's global object**. Every identifier the
script reaches for — `window`, `jwplayer`, `Clappr`, some minified `_0x4f21` — resolves to
a recording *ghost* that accepts any property access, call, or construction and returns
another ghost. Scripts run to completion because nothing is ever `undefined`, and every
string passing through an assignment or a function argument is scanned for URLs on the way.

The consequence: **no per-player shims**. A player Oracle has never seen still gives up its
stream, because `new WhateverPlayer({file: "…"}).play()` records `file` exactly the way
`jwplayer().setup({file: "…"})` does.

It also hooks the places URLs surface at runtime — `atob`, `eval`, `Function`,
`document.write`, `XMLHttpRequest.open`, `fetch`, `<script>.src`, `location.assign` — and
drains pending timers, so a URL assembled inside a `setTimeout` is caught too. Endpoints
the script asked for get queued and followed, so the manifest that only exists as a JSON
API response is found as well.

**One session per page.** All of a page's scripts — inline and external — run in *one*
shared global, in document order. This matters more than it sounds: a webpack, Nuxt or
Vite build is a runtime chunk plus N payload chunks that hand each other modules through a
shared global. Run each file in its own context and every chunk registers into a global
nobody else can see, so the app never boots and never asks for its stream.

Containment: `node:vm` with a wall-clock timeout, no network, no filesystem, no host
globals — `process` and `require` are absent, exactly as they are in a browser.

### 4. API synthesis — the "open the Network tab" move

Sometimes the bundle still won't boot: it wants a router, a real DOM, a mounted component
tree. The page ships **no stream URL at all** — it boots, reads an id out of its own route,
calls its backend, and the manifest arrives in a JSON response. There is nothing for static
analysis to find, because there is nothing there.

A human debugging this doesn't fight the bundle. They open DevTools, watch one XHR go past,
and read the manifest out of the response. Oracle does the same thing deductively:

1. Take the API origins the bundle mentions (ranked — a host named `api` beats a CDN, and
   platform hosts are excluded so a page embedding YouTube doesn't send it chasing
   `youtube.com/api/...`).
2. Take the identifiers out of the page's own route — `/events/73_arryadia_k2tgcj0` yields
   the id, and `events` as its collection.
3. Reconstruct the request the app would have made, likeliest shape first.

The winning shape is usually the dullest: an SPA route of `/events/{id}` is served by
`/api/events/{id}` on the API host, because the same team wrote both and mirrored the paths.
JSON that comes back is walked recursively — config endpoints chain, and the manifest is
often one more hop in.

This only fires for a page that gave up nothing playable, since it costs a burst of requests.

### 5. Token signing

A large share of "I found the m3u8 but it 403s" is neither geo-blocking nor a missing
`Referer`. The CDN wants a short-lived signature, and the player gets one by asking a token
service that hands them to anybody — no login, no credential. The player does this in the
open on every page load, and a dig that stops at the 403 has stopped one request too early.

So on a 401/403, Oracle finds the signing service among URLs it already saw (by name, or
from a config key like `TOKEN_SERVER_URL`), asks it to sign the manifest, and retries. It's
shape-driven — parameter names and response formats are tried in turn, handling a returned
query string, a JSON token, a complete replacement URL, or a bare token — so it isn't tied
to any one provider.

**Signatures propagate to renditions.** HLS resolves the URIs inside a playlist against the
*path*, discarding the query — so a signed master hands a player rendition URLs with no
signature, and every one of them 403s. (This is the single most common way a "working"
extracted URL fails in `mpv`.) Oracle carries the signature down to each rendition and then
**probes each one individually** rather than trusting the master's word, so what it reports
verified is what it actually requested. A signed master ranks *below* its own renditions,
because it is the one URL there that cannot be played directly.

The report gives you both: the bare URL plus its signer (the reusable pair) and the signed
URL that plays right now.

This deliberately stops short of decryption. An AES-128 or Widevine stream is **reported as
encrypted and left alone** — signing a request is authorisation plumbing, not breaking DRM.

The one thing Oracle does repeat is ClearKey. That is the key system with no protection by
design: the page ships `keyId` and `key` to every visitor in the clear, and Oracle reports
what the page already said out loud, as `clearKeys` on the stream. A key that lives behind a
licence server — Widevine, PlayReady, FairPlay — is never requested and never appears.

### 6. Verification

A `.m3u8` sitting in a page proves nothing; plenty are stale demos or decoys. Oracle
replays each candidate with the right `Referer`, parses the manifest, and reports what is
actually there: master vs media, live vs VOD, the renditions, the duration, and the
`#EXT-X-KEY` URI when segments are AES-encrypted.

Failed probes are **kept**, not discarded — a geo-blocked stream answers `403` to a server
in the wrong country while still being exactly the URL you want. They rank last instead.

### Sibling servers

The same match is usually mirrored across several servers, and the shape differs per site:
`?serv=2`, `?server=3`, `?id=b`, `/embed-2/`. Hardcoding `?serv=` would fit exactly one site.

Oracle instead:

1. **Mines** the documents it already has for URLs that are siblings of the player — which
   discovers the real parameter name for free, whatever it happens to be, including from
   `onclick` handlers and `data-*` attributes rather than just `href`.
2. **Infers** parameter names from the player URL itself, then a curated fallback list.
3. **Proves** each guess by *novelty*, not by status code.

Step 3 is what makes it reliable. Most sites answer `200` to `?madeUpParam=7` and serve the
default stream — a status check would report dozens of phantom servers. So Oracle first
requests a deliberately nonsense parameter to learn what "I ignore that" looks like on this
host, then accepts a variant only when its body diverges from *both* the baseline and that
ignored response. A variant resolving to genuinely different stream URLs is accepted outright.
A parameter that produces two duds in a row is abandoned rather than burning the budget.

It never increments a number already in the last path segment: `/max-5/` → `/max-6/` is a
*different match*, not another server for the same one, and returning someone else's stream
is worse than returning nothing.

## Options

```
-p, --print              run headless and print the report
-f, --format <fmt>       text | json | m3u | urls   (implies --print)
-o, --output <file>      write the report to a file
-d, --depth <n>          how many document hops to follow      (default 4)
    --server-depth <n>   values to try per server parameter    (default 8)
-t, --timeout <ms>       per-request timeout                   (default 15000)
-c, --concurrency <n>    parallel requests                     (default 8)
    --stop-after <n>     stop once n streams are verified
    --no-servers         skip sibling-server discovery
    --no-sandbox         skip the honeypot (static analysis only)
    --no-probe           do not verify candidates
-r, --referer <url>      Referer for the first request
-A, --user-agent <ua>    override the user agent
-H, --header <h>         extra header, repeatable ("Name: value")
    --theme <mode>       auto | dark | light
-h, --help               show this help
-v, --version            show version
```

Nothing found? Dig harder:

```bash
oracle --depth 6 --server-depth 12 --timeout 25000 https://site.tld/x
```

## Playing what you get

Most of these hosts reject a request without the right `Referer`, so Oracle's exports carry
the headers with the URL. Press `c` in the UI for a ready-to-run command, or:

```bash
mpv "$URL" --http-header-fields="Referer: $REFERER"
ffmpeg -headers "Referer: $REFERER"$'\r\n' -i "$URL" -c copy out.mp4
```

The generated `.m3u` includes `#EXTVLCOPT:http-referrer=…`, which VLC and mpv honour.

## Dependencies

Three, all runtime, all free: `@opentui/core`, `@opentui/react`, `react`.

The extraction engine itself has **zero** dependencies — `fetch`, `node:vm` and regex.
No headless browser, no `yt-dlp`, no `ffmpeg` required to find a stream. Nothing paid,
no API keys, no account, no third-party service. The only hosts Oracle talks to are the
ones the page you gave it talks to.

## Development

```bash
bun install
bun run dev https://site.tld/x   # run from source
bun test                         # 120 tests
bun run typecheck
bun run build
```

Layout:

```
src/
  core/
    engine.ts        breadth-first orchestrator
    http.ts          fetch + cookie jar + manual redirects + concurrency gate
    extract.ts       URL harvesting and classification
    deobfuscate.ts   packer, escapes, charcodes, concat, base64, hex
    sandbox.ts       the Proxy-global honeypot DOM (shared session per page)
    api.ts           API endpoint synthesis from route ids + bundle origins
    token.ts         signing services, for manifests that 403 unsigned
    servers.ts       sibling-server discovery by novelty
    platforms.ts     YouTube/Dailymotion embeds, reported not chased
    hls.ts           m3u8 / mpd parsing
    probe.ts         verification and confidence scoring
  components/        logo, panels, shortcut bar
  lib/               args, formatting, clipboard (OSC 52), exports
  app.tsx            the TUI
  cli.tsx            entry point
```

## Fair use

Oracle only reads what a browser reading the same page would read. It doesn't break DRM,
strip watermarks, or bypass authentication — an encrypted stream is reported as encrypted,
not decrypted.

Use it on streams you're entitled to watch: your own infrastructure, content you have a
licence for, or debugging a player you're building. Respect the terms of the sites you point
it at and the rights of whoever owns the stream. What you do with it is on you.

## Credits

Visual language borrowed, with thanks, from [yoinks](https://github.com/pablostanley/yoinks)
by Pablo Stanley. Built on [OpenTUI](https://github.com/sst/opentui).

## Licence

MIT — see [LICENSE](LICENSE).
