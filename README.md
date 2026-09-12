# opencode-context-saver

An [opencode](https://github.com/sst/opencode) plugin that keeps long sessions fast by condensing far-back tool outputs into dense digests — **without ever touching your conversation**.

Long coding sessions bloat because every raw tool output (file reads, greps, build logs) ships on the wire forever. This plugin condenses old ones into compact digests while preserving the full raw output on disk, so your model keeps a lean, accurate working memory and your messages stop waiting on giant context payloads.

**Highlights**

- **Never blocks your turn, starts instantly** — summarization kicks off in the background the moment a large tool output is detected (even mid-turn); digests apply on an upcoming request
- **Never touches conversation text** — only tool-call outputs/inputs are eligible; AI replies are the floor and stay verbatim
- **Nothing is lost** — every digest carries a `FULL TOOL CALL AVAILABLE HERE:` pointer to the verbatim raw output on disk; the TUI still shows originals
- **Fail-safe & cancel-proof** — if the summarizer fails, tool outputs are left inline untouched (one retry, then a cooldown); recent messages are always protected; cancelling a turn never cancels in-flight summaries
- **Reuses your existing opencode providers** — one config line naming a provider id; keys stay in your local files

## Install

Copy [`index.js`](./index.js) to your opencode plugins directory:

```sh
cp index.js ~/.config/opencode/plugin/context-saver.js
```

Restart opencode. It shows up in the session as `context-saver`.

## Configure the summarizer

Create `~/.config/opencode/context-saver.json` (**do not commit this file — keep keys local**):

```jsonc
{
  "summarizer": { "provider": "agnes", "model": "agnes-3.0-flash" }
}
```

`"provider"` must match an id in your opencode.json `provider` map — its stored `baseURL` and `apiKey` are reused, so keys never leave your local files.

No config file (or an unresolvable provider/model) means the plugin does nothing — tool outputs stay inline.

## Options

| Key | Default | Meaning |
|---|---|---|
| `summarizer.provider` | — | opencode provider id to reuse (its baseURL/apiKey) |
| `summarizer.model` | — | summarizer model id (required) |
| `dataDir` | `.opencode-findings` | directory (in `$HOME`) for digests, logs, state |

Tunables (thresholds, timeouts, group sizes) are constants at the top of `index.js` and documented inline.

## Coexisting with magic-context

If you run [magic-context](https://www.npmjs.com/package/@cortexkit/opencode-magic-context) alongside this plugin, they complement each other: magic-context compacts the outgoing request (trimming old messages into its own compartments), while context-saver shrinks the stored history itself. Because magic-context removes old messages from the hook's message list, context-saver also runs a throttled **DB backfill scan**: it finds old, oversized, undigested tool parts directly in opencode's `part` table (source of truth) and schedules them in the background, oldest first — so stored history gets digested even when the transform never shows it.

## How it works

**Stage 1 — tool-output groups.** On each turn the plugin finds far-back oversized tool outputs (≥ 2,000 chars, older than the protected recent window) and condenses them in chronological groups of ~3 with one summarizer call each. Additionally, **tool-call streaks** — 4+ consecutive tool calls with no assistant text in between — are condensed as a single group in one summarizer call, *including* smaller sub-threshold outputs (only tiny <50-char outputs stay inline). Address/hex-heavy outputs are never sent to the summarizer — raw bytes go to disk verbatim, their inline part shows a short head + pointer. Digests are marked in-flight and applied durably (chat part + SQLite write-through + sidecar map, so undo/restart can't resurrect the bloat)

**Stage 2 — editing-history digest.** Every 4 turns, a compact "what was done" digest of recent turns is written to the running history record, so far-back context stays reconstructable without re-reading raw outputs.

**Safety design**

- Conversation/AI-reply text is never summarized, trimmed, or sent anywhere
- The last N messages per session are always protected
- Summarizer failure ⇒ outputs stay inline (never truncated on failure), one retry, then a 15-min per-part cooldown
- Originals: group MD files under `~/.opencode-findings/checkpoints/`, per-call before/after logs under `context-saver-summaries/`, and the TUI still renders the original output
- Everything stays on your machine; only tool outputs you're condensing go to **your** chosen summarizer endpoint

## Files it writes

```
~/.opencode-findings/
├── checkpoints/                      # group MDs: full verbatim raw + digests
├── context-saver-summaries/          # {before,after,meta}.json per summarization
├── context-saver-stats.json          # run stats (saved chars/tokens)
├── context-saver-map.json            # durable replacement map
└── context-saver-turn-tracker.json   # stage-2 baseline per session
```

## License

MIT
