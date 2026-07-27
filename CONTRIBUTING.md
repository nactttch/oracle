# Contributing

Thanks for looking. Oracle is small on purpose — the whole engine is seven files with no
dependencies — so changes are easy to reason about if we keep them that way.

## Getting set up

```bash
bun install
bun test
bun run dev https://example.com/some/embed/
```

## Before opening a PR

```bash
bun run typecheck
bun test
bun run build
```

CI runs exactly these.

## What makes a good change

**New obfuscation formats** are the most valuable contribution. Add the pass to
`src/core/deobfuscate.ts`, keep it pure (`string -> string`, no I/O), and add a test with a
real-world-shaped sample rather than a synthetic one. If a format can only be cracked by
running it, don't add a pass — the honeypot in `src/core/sandbox.ts` already covers it.

**New server-URL shapes** go in `src/core/servers.ts`. The rule that matters: a variant is
only real if its body differs from both the baseline *and* the "parameter I ignore"
control response. Anything that accepts a variant on a `200` alone will be rejected —
phantom servers are worse than missing ones.

**Don't add a headless browser.** The Proxy-global honeypot exists specifically so Oracle
stays a few megabytes and hard to fingerprint. A PR that pulls in Puppeteer or Playwright
is a different tool.

**Keep the engine dependency-free.** `fetch`, `node:vm`, and regex have been enough so far.

## Testing against real sites

Please don't commit tests that hit third-party sites — they break, they're slow, and they
hammer someone else's server on every CI run. Use `Bun.serve` to stand up a fixture that
reproduces the shape you care about; `src/core/servers.test.ts` shows the pattern.

## Style

Match the surrounding code. Comments explain *why* something is the way it is — the
non-obvious constraint, the trap that was hit — not what the next line does.

## Scope

Oracle finds and verifies stream URLs. It does not download, transcode, decrypt, or bypass
authentication, and PRs adding those are out of scope. An encrypted stream gets reported as
encrypted.
