// context-saver — opencode plugin (classic Hooks API) — v6
// STAGE 1 (groups of ~3): far-back oversized TOOL outputs are condensed in
//   chronological groups of up to GROUP_SIZE (tool + the 2 calls around it),
//   ONE summarizer call per group. Digest text goes INLINE in the chat part (the agent
//   gets a summary directly) plus a loud "FULL TOOL CALL AVAILABLE HERE" banner
//   pointing at a group MD file containing the FULL VERBATIM raw output of every
//   tool in the group. Address/hex-heavy outputs are NEVER sent to the LLM — raw
//   bytes go to the group MD verbatim; their inline part shows a short head + banner.
//   Summarizer failure: EXACTLY ONE retry; then tools are left INLINE untouched (never
//   truncated — pre-bloat baseline preserved on failure).
// STAGE 2 (every CHECKPOINT_EVERY_TURNS turns): light editing-history digest of the
//   last N turns (history record, not a checkpoint). Baseline advances only on
//   success; on failure a cooldown defers the next attempt.
// LOGGING: every summarization writes {before,after,meta}.json + .before.txt +
//   .after.md to ~/.opencode-findings/context-saver-summaries/.
// TEXT/conversation parts are NEVER touched. DB write-through + sidecar map keep
//   replacements durable across undo/restart.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/* ---------- summarizer config: reuse a provider from your opencode.json ----------
   ~/.config/opencode/context-saver.json (NEVER commit keys):
     { "summarizer": { "provider": "agnes", "model": "agnes-3.0-flash" } }
   "provider" = an id from your opencode.json "provider" map — its stored
   baseURL + apiKey are reused, so keys stay in your local files only.
   No config (or unresolvable provider/model) = the plugin does nothing. */
const PLUGIN_CONFIG = (() => {
  const candidates = [
    process.env.OPENCODE_CONTEXT_SAVER_CONFIG || "",
    path.join(os.homedir(), ".config", "opencode", "context-saver.json"),
  ];
  for (const f of candidates) {
    if (!f) continue;
    try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")) || {}; }
    catch (e) { console.error("[context-saver] bad config", f + ":", e?.message); }
  }
  return {};
})();
const SUMMARIZER = (() => {
  const c = PLUGIN_CONFIG.summarizer || {};
  const out = { baseURL: "", apiKey: "", model: c.model || "", headers: {} };
  if (c.provider) {
    try {
      const oc = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "opencode", "opencode.json"), "utf8"));
      const opts = oc.provider?.[c.provider]?.options || {};
      out.baseURL = opts.baseURL || "";
      out.apiKey = opts.apiKey || "";
      out.headers = { ...(opts.headers || {}) };
    } catch {}
  }
  out.baseURL = String(out.baseURL || "").replace(/\/+$/, "");
  out.ok = !!(out.baseURL && out.apiKey && out.model);
  return out;
})();

const SUMMARIZE_THRESHOLD = 2000;
const MAX_TO_SUMMARIZE = 6;          // max far-back tool parts touched per turn
const GROUP_SIZE = 3;                // summarize in chronological groups of ~3
const STREAK_MIN = 4;                // min consecutive no-chat tool calls for a streak group
const STREAK_MIN_CHARS = 50;         // outputs shorter than this stay inline even inside streaks
const STREAK_MAX_MEMBERS = 20;       // cap streak groups — one giant prompt would time out and retry-loop
const MAX_MEMBER_FEED = 60000;       // max chars of ONE tool sent per group call
const GROUP_MAX_TOTAL = 80000;       // hard cap on the whole group-call prompt
const MAX_TURN_MATERIAL = 40000;
const CHECKPOINT_EVERY_TURNS = 4;
const RECENT_TOOL_PREVIEW = 1200;
const ASSISTANT_TEXT_TRIM = 1000;
const USER_TEXT_TRIM = 2000;
const KEEP_RECENT_MESSAGES = 6;
const MIN_MESSAGES_BEFORE_SUMMARIZE = 8;
const AGENT_TIMEOUT = 120000;        // ms initial — background now, so latency no longer blocks the turn
const RETRY_AGENT_TIMEOUT = 45000;   // ms single retry
const FAIL_COOLDOWN_MS = 15 * 60 * 1000;   // failed parts wait 15 min before another summarizer attempt
const PENDING_STALE_MS = 15 * 60 * 1000;   // in-flight markers older than this are crash debris -> clear
const DATA_DIRNAME = PLUGIN_CONFIG?.dataDir || ".opencode-findings";
const GROUP_DIGEST_DIRNAME = path.join(DATA_DIRNAME, "checkpoints");
const SUMMARY_LOG_DIRNAME = path.join(DATA_DIRNAME, "context-saver-summaries");
const STATS_DIR = DATA_DIRNAME;
const STATS_FILE = "context-saver-stats.json";
const MAP_FILE = "context-saver-map.json";
const HISTORY_PROMPT_FILE = "context-saver-history-prompt.md";
const TRACKER_FILE = "context-saver-turn-tracker.json";
const DB_PATH = path.join(os.homedir(), ".local/share/opencode/opencode.db");
const HEAD_PREVIEW = 220;            // head chars of address-heavy tools shown inline
const INPUT_MAX = 150;               // max chars per state.input string leaf kept (args are redundant once digest exists)
const ADDR_HEX_RE = /0x[0-9a-fA-F]{2,}/g;
const ADDR_LINE_RE = /^\s*0x[0-9a-fA-F]{4,}\s+/m;

let lastSummarizeAt = 0;
let transformCount = 0;
let lastDbScanMs = 0;   // DB backfill scan throttle (magic-context coexistence)
let dbSync = null;
let mapCache = null;
let mapCacheMtime = 0;

function statsPath() { return path.join(os.homedir(), STATS_DIR, STATS_FILE); }
function mapPath() { return path.join(os.homedir(), STATS_DIR, MAP_FILE); }
function historyPromptPath() { return path.join(os.homedir(), STATS_DIR, HISTORY_PROMPT_FILE); }
function trackerPath() { return path.join(os.homedir(), STATS_DIR, TRACKER_FILE); }
function loadStats() {
  const base = { totalOriginal: 0, totalReplaced: 0, totalSaved: 0, totalTokensSaved: 0, runs: 0, skippedRateLimit: 0, skippedNoCandidates: 0, skippedMidTurn: 0, dbWrites: 0, dbWriteFails: 0, fallbacks: 0, groups: 0, leftInlineOnFail: 0, checkpoints: 0, turns: 0, toolCalls: 0, summarizerCalls: 0, summarizerFails: 0, history: [], lastRun: null };
  try {
    const p = statsPath();
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        totalOriginal: j.totalOriginal || 0, totalReplaced: j.totalReplaced || 0,
        totalSaved: j.totalSaved || 0, totalTokensSaved: j.totalTokensSaved || Math.round((j.totalSaved||0)/4),
        runs: j.runs || 0, skippedRateLimit: j.skippedRateLimit || 0,
        skippedNoCandidates: j.skippedNoCandidates || 0, skippedMidTurn: j.skippedMidTurn || 0,
        dbWrites: j.dbWrites || 0, dbWriteFails: j.dbWriteFails || 0, fallbacks: j.fallbacks || 0,
        groups: j.groups || 0, leftInlineOnFail: j.leftInlineOnFail || 0,
        checkpoints: j.checkpoints || 0, turns: j.turns || 0, toolCalls: j.toolCalls || 0,
        summarizerCalls: j.summarizerCalls || j.agnesCalls || 0, summarizerFails: j.summarizerFails || j.agnesFails || 0,
        history: Array.isArray(j.history) ? j.history.slice(-50) : [], lastRun: j.lastRun || null,
      };
    }
  } catch (e) { console.error("[context-saver] loadStats failed:", e?.message); }
  return base;
}
function saveStats(s) {
  try {
    const p = statsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (e) { console.error("[context-saver] saveStats failed:", e?.message); }
}
function fmt(n) { return n.toLocaleString(); }/* ---------- DB write-through (tool parts only) ---------- */
function getDb() {
  if (dbSync) return dbSync;
  try {
    try {
      const { DatabaseSync } = require("node:sqlite");
      dbSync = new DatabaseSync(DB_PATH, { timeout: 5000 });
      dbSync.exec("PRAGMA busy_timeout=5000");
      return dbSync;
    } catch { /* not Node — fall through to bun:sqlite */ }
    const { Database } = require("bun:sqlite");
    dbSync = new Database(DB_PATH, { readwrite: true });
    dbSync.exec("PRAGMA busy_timeout=5000");
    return dbSync;
  } catch (e) { console.error("[context-saver] no sqlite driver, falling back to map-only:", e?.message); return null; }
}
function writePartToDb(part, stats) {
  if (part?.type !== "tool") return false;
  try {
    const db = getDb();
    if (!db) throw new Error("no-db");
    const clean = { type: "tool", tool: part.tool, callID: part.callID, state: part.state };
    if (part.metadata) clean.metadata = part.metadata;
    const stmt = db.prepare("UPDATE part SET data=?, time_updated=? WHERE id=? AND session_id=?");
    const res = stmt.run(JSON.stringify(clean), Date.now(), part.id, part.sessionID);
    if (res.changes > 0) { stats.dbWrites = (stats.dbWrites || 0) + 1; return true; }
    throw new Error("row-not-found");
  } catch (e) {
    console.error("[context-saver] DB write failed:", e?.message);
    stats.dbWriteFails = (stats.dbWriteFails || 0) + 1;
    return false;
  }
}

/* ---------- sidecar map ---------- */
function loadMap() {
  try {
    const p = mapPath();
    const m = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
    if (m !== mapCacheMtime) { mapCacheMtime = m; mapCache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {}; }
  } catch (e) { mapCache = mapCache || {}; }
  return mapCache || {};
}
function saveMap(map) {
  try {
    const p = mapPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (e) { console.error("[context-saver] map save failed:", e?.message); }
}

/* ---------- per-session turn tracker (stage-2 cadence + fail cooldown) ---------- */
function loadTracker() {
  try {
    const p = trackerPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) { console.error("[context-saver] tracker load failed:", e?.message); }
  return {};
}
function saveTracker(t) {
  try {
    const p = trackerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (e) { console.error("[context-saver] tracker save failed:", e?.message); }
}
function sessionIdOf(messages, out) {
  if (out?.sessionID) return out.sessionID;
  for (const m of messages) {
    if (m && (m.sessionID || m.session_id)) return m.sessionID || m.session_id;
  }
  return "global";
}

/* ---------- logging: ALWAYS record before + after ---------- */
function logSummary(kind, id, meta, before, after) {
  try {
    const dir = path.join(os.homedir(), SUMMARY_LOG_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    const base = path.join(dir, `${ts}-${kind}-${safeId}`);
    fs.writeFileSync(base + ".json", JSON.stringify({ at: new Date().toISOString(), kind, id, meta, before, after }, null, 2), "utf8");
    fs.writeFileSync(base + ".before.txt", before ?? "(none)", "utf8");
    fs.writeFileSync(base + ".after.md", after ?? "(none)", "utf8");
  } catch (e) { console.error("[context-saver] summary log write failed:", e?.message); }
}/* ---------- prompts ---------- */
// Stage 1: ONE call per group of up to GROUP_SIZE tools; digests requested per
// light tool as "### TOOL #N DIGEST"; heavy members are never sent.
function toolGroupDigestPrompt(group) {
  const lines = [];
  lines.push(`You are condensing ${group.length} RAW TOOL OUTPUTS (a chronological group: the target call and the calls around it) into dense, byte-faithful digests that stay in the chat history. Raw bytes you cannot capture are preserved verbatim on disk — you will receive markers for those.`);
  lines.push("");
  lines.push(`Output ONE block per tool that has actual content, in order, labeled exactly with the index: use a heading "### TOOL #N DIGEST" (same #N as the input listing). For each: what the tool was asked to do, then exact addresses/offsets/hex/symbols/register values (transcribe CHARACTER-FOR-CHARACTER), exact error lines/log lines/verdicts verbatim, key numbers/timings/evidence paths.`);
  lines.push("");
  lines.push("Hard rules:");
  lines.push("- Addresses must come from the text below, character-for-character. NEVER re-spell, reformat, or 'fix' them.");
  lines.push("- If not 100% sure of an exact token, write [omitted] — never guess. A wrong offset is worse than a missing one.");
  lines.push("- If a tool section is a long table/list, transcribe the first entries verbatim then note '…remaining N entries (full raw on disk)'.");
  lines.push("- For tools marked [ADDRESS-HEAVY / RAW ON DISK — NOT SENT]: do NOT describe their content. One line: 'address-heavy tool, raw preserved on disk (see FULL TOOL CALL AVAILABLE HERE)'.");
  lines.push("");
  group.forEach((m, i) => {
    const n = i + 1;
    if (m.heavy) {
      lines.push(`--- TOOL #${n} (${m.tool}, ${m.text.length} chars) [ADDRESS-HEAVY / RAW ON DISK — NOT SENT] ---`);
      lines.push(m.text.slice(0, 200) + (m.text.length > 200 ? " …" : ""));
    } else {
      let raw = m.text;
      if (raw.length > MAX_MEMBER_FEED) raw = raw.slice(0, 30000) + "\n…[middle omitted: full raw on disk]…\n" + raw.slice(-30000);
      lines.push(`--- TOOL #${n} (${m.tool}, callID ${m.callID.slice(0,12)}, ${m.text.length} chars, ${raw.length} chars sent) ---`);
      lines.push(raw);
    }
  });
  let out = lines.join("\n");
  if (out.length > GROUP_MAX_TOTAL) {
    out = out.slice(0, GROUP_MAX_TOTAL) + "\n…[group prompt trimmed: full raw on disk]…";
  }
  return out;
}

const HISTORY_DIGEST_BUILTIN = `You are writing a compact digest of the MOST RECENT EDITING HISTORY for a long-running development session. This is a running history record, NOT an operational checkpoint: do not write future-facing state, intent, or action plans. You are recording what was actually done so the session's history can be reconstructed later without re-reading raw tool outputs.

The material below covers the last few completed user turns. For EACH turn include ONE short block with:
- what the user asked (1 line)
- what was changed/done: files created/edited/deleted (exact paths), commands run, tools invoked, key results, evidence (outputs, errors, numbers)
- decisions made and why (1 line each)
- deferred items / open threads (1 line each)
- pointer to the per-tool digest files where exact bytes/offsets/addresses live

Rules:
- Never invent file paths, addresses, numbers, or results. If not 100% sure, write [omitted].
- Do not copy long tool outputs verbatim; the per-tool digests already hold that detail.
- Dense, flat, chronological, no prose padding.`;

function getHistoryBase() {
  try {
    if (fs.existsSync(historyPromptPath())) {
      const t = fs.readFileSync(historyPromptPath(), "utf8").trim();
      if (t) return t;
    }
  } catch (e) { console.error("[context-saver] history prompt file read failed:", e?.message); }
  return HISTORY_DIGEST_BUILTIN;
}
function historyDigestPrompt(material) {
  return getHistoryBase() + "\n\n--- RECENT TURNS (material; tool outputs already condensed to digests) ---\n" + material;
}

/* ---------- summarizer call: initial + exactly ONE retry ---------- */
async function summarizerOnce(prompt, timeoutMs) {
  if (!SUMMARIZER.ok) return { ok:false, text:null, status:null }; // no config = do nothing
  const ctrl = new AbortController(); const to = setTimeout(()=>ctrl.abort(), timeoutMs || AGENT_TIMEOUT);
  try {
    const res = await fetch(`${SUMMARIZER.baseURL}/chat/completions`, { method:"POST", signal: ctrl.signal, headers: { "Content-Type":"application/json", Authorization: `Bearer ${SUMMARIZER.apiKey}`, ...SUMMARIZER.headers }, body: JSON.stringify({ model: SUMMARIZER.model, messages:[{role:"user", content: prompt}], temperature:0.15, max_tokens:4000 }) });
    clearTimeout(to);
    if (!res.ok) { const t = await res.text().catch(()=> ""); console.error(`[context-saver] summarizer ${res.status}: ${t.slice(0,300)}`); return { ok:false, text:null, status:res.status }; }
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content || j.choices?.[0]?.text || null;
    return { ok: !!text, text, status: res.status };
  } catch (e) { clearTimeout(to); console.error("[context-saver] summarizer fetch failed:", e?.message||e); return { ok:false, text:null, status:null }; }
}
async function summarizeWithRetry(prompt) {
  let first = await summarizerOnce(prompt, AGENT_TIMEOUT);
  let attempts = 1;
  if (!first.ok) {
    first = await summarizerOnce(prompt, RETRY_AGENT_TIMEOUT);
    attempts = 2;
  }
  return { ...first, attempts };
}/* ---------- helpers ---------- */
function isToolPart(part) {
  return !!part && (part.type === "tool" || (part.state && typeof part.state.output === "string"));
}
function extractToolOutput(part) {
  if (!isToolPart(part)) return null;
  let text = null;
  if (part.state && typeof part.state.output === "string") text = part.state.output;
  else if (part.data && part.data.state && typeof part.data.state.output === "string") text = part.data.state.output;
  else if (typeof part.output === "string") text = part.output;
  return text;
}
function isAddressHeavy(text) {
  const hex = (text.match(ADDR_HEX_RE) || []).length;
  if (hex >= 8) return true;
  return (text.match(ADDR_LINE_RE) || []).length >= 4;
}
function setToolOutput(part, replacement) {
  if (part.state && typeof part.state.output === "string") part.state.output = replacement;
  else if (part.data && part.data.state && typeof part.data.state.output === "string") part.data.state.output = replacement;
  else if (typeof part.output === "string") part.output = replacement;
  else if (part.state) part.state.output = replacement;
}
// trim a tool part's state.input (its original tool args) down — the OUTPUT is
// the interesting part; the args are redundant for continuation and opencode
// serializes them. Keeps a short gist so intent stays legible.
function trimInputValue(v) {
  if (typeof v === "string") return v.length <= INPUT_MAX ? v : v.slice(0, INPUT_MAX) + ` …[input trimmed: ${v.length} chars]`;
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = trimInputValue(v[k]);
    return out;
  }
  return v;
}
function trimPartInput(part) {
  if (!part) return;
  if (part.state && part.state.input !== undefined && !Array.isArray(part.state.input)) part.state.input = trimInputValue(part.state.input);
  else if (part.data && part.data.state && part.data.state.input !== undefined && !Array.isArray(part.data.state.input)) part.data.state.input = trimInputValue(part.data.state.input);
  const st = part.state || (part.data && part.data.state);
  if (st && Array.isArray(st.attachments) && st.attachments.length) st.attachments = []; // embedded file contents ship verbatim; digest covers them
}
function partSessionId(part) {
  return part?.sessionID || part?.data?.sessionID || (part?.messageID && part.messageID.slice(0,8)) || "x";
}
function banner(groupFile) {
  return `FULL TOOL CALL AVAILABLE HERE: ${groupFile}`;
}
// inline replacement: summary (digest text) + banner pointing at verbatim raw copy
function inlineReplacement(m, digestText, groupFile) {
  const head = `[context-saver digest] ${m.tool} (${m.text.length} chars): ${digestText}`;
  return `${head}\n${banner(groupFile)}`;
}
function heavyInlineReplacement(m, groupFile) {
  const head = m.text.slice(0, HEAD_PREVIEW).replace(/\s+/g, " ").trim();
  return `[context-saver digest] ${m.tool} (${m.text.length} chars, ADDRESS-HEAVY — raw bytes preserved verbatim, not summarized)\nhead: ${head}${m.text.length > HEAD_PREVIEW ? " …" : ""}\n${banner(groupFile)}`;
}
// split a group digest response into per-tool sections; fallback = whole text
function splitGroupDigest(text, nTools) {
  const sections = new Array(nTools).fill(null);
  const re = /###\s*TOOL\s*#?(\d+)\s*DIGEST\s*\n?([\s\S]*?)(?=###\s*TOOL\s*#?\d+\s*DIGEST|$)/gi;
  let m;
  while ((m = re.exec(text))) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < nTools) sections[idx] = m[2].trim();
  }
  const found = sections.filter(s => s !== null).length;
  if (found === 0) return { found: 0, whole: text.trim(), sections };
  return { found, whole: null, sections };
}

/* ---------- stage 2: build the last N completed turns' compact material ---------- */
function buildBatchMaterial(messages, stage1ByPartId) {
  const userIdx = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if ((m?.info?.role ?? m?.role) === "user") userIdx.push(i);
  }
  if (userIdx.length < 2) return null;                    // need >=1 completed turn + the new prompt
  const lastUser = userIdx[userIdx.length - 1];           // the NEW user prompt (trigger)
  const completed = userIdx.slice(0, -1);                 // turns already answered
  const start = completed[Math.max(0, completed.length - CHECKPOINT_EVERY_TURNS)];
  const lines = [];
  let total = 0;
  let toolCount = 0;
  const push = (s) => { if (total < MAX_TURN_MATERIAL) { lines.push(s); total += s.length; } };
  for (let i = start; i < lastUser; i++) {                // walk completed turns only (exclude new prompt)
    const m = messages[i];
    const role = m?.info?.role ?? m?.role;
    if (role === "user") {
      for (const part of m.parts || []) {
        if (typeof part.text === "string" && part.text.trim()) push(`USER: ${part.text.slice(0, USER_TEXT_TRIM)}`);
      }
      push("---TURN END---");
    } else if (role === "assistant") {
      for (const part of m.parts || []) {
        if (isToolPart(part)) {
          const t = extractToolOutput(part);
          if (!t) continue;
          toolCount++;
          const key = part.id;
          if (key && stage1ByPartId[key]) push(`TOOL(${part.tool}): digest ref ${stage1ByPartId[key]}`);
          else push(`TOOL(${part.tool}): ${t.slice(0, RECENT_TOOL_PREVIEW)}${t.length > RECENT_TOOL_PREVIEW ? " …(" + t.length + " chars, on disk)" : ""}`);
        } else if (typeof part.text === "string" && part.text.trim()) {
          push(`ASST: ${part.text.slice(0, ASSISTANT_TEXT_TRIM)}`);
        }
      }
    }
  }
  if (toolCount === 0 && !lines.some(l => l.startsWith("ASST:"))) return null; // nothing of substance
  return { text: lines.join("\n"), toolCount, meta: { turnsInBatch: completed.length >= CHECKPOINT_EVERY_TURNS ? CHECKPOINT_EVERY_TURNS : completed.length, toolCount, totalUserTurns: completed.length } };
}/** @type {import("@opencode-ai/plugin").Plugin} */
export default async function ContextSaverPlugin(input) {
  const stats = loadStats();
  const notify = (title, message, variant = "info") => {
    try {
      const c = input?.client;
      const tui = c?.tui ?? input?.tui;
      if (tui?.showToast) {
        tui.showToast({ body: { title, message, variant, duration: 15000 } }).catch(()=>{});
      } else if (c?.tui?.showToast) {
        c.tui.showToast({ body: { title, message, variant, duration: 15000 } }).catch(()=>{});
      }
    } catch {}
  };

  return {
    "experimental.chat.messages.transform": async (_in, out) => {
      try {
        transformCount++;
        const messages = out.messages;
        if (!Array.isArray(messages) || messages.length < MIN_MESSAGES_BEFORE_SUMMARIZE) return;

        /* apply previously saved replacements (map safety net) — tool parts only */
        const map = loadMap();
        const visibleIds = new Set();   // tool parts present in out.messages — magic-context may trim old ones out
        /* crash recovery: clear stale in-flight markers so their parts can retry */
        let sweptPending = 0;
        for (const pid of Object.keys(map)) { if (map[pid].pending && Date.now() - (map[pid].at||0) > PENDING_STALE_MS) { delete map[pid]; sweptPending++; } }
        if (sweptPending > 0) saveMap(map);
        for (const msg of messages) {
          if (msg.info?.role !== "assistant" && msg.role !== "assistant") continue;
          for (const part of msg.parts || []) {
            if (!isToolPart(part) || !part.id) continue;
            visibleIds.add(part.id);
            const entry = map[part.id];
            if (!entry || entry.replacement === undefined) continue;
            const cur = extractToolOutput(part);
            if (cur && entry.sourceLen === cur.length) setToolOutput(part, entry.replacement);
          }
        }

        const last = messages[messages.length - 1];
        const lastRole = last?.info?.role ?? last?.role ?? "";
        const isTurnStart = lastRole === "user";
        /* Mid-turn scheduling: the map's pending markers dedup, so candidate
           detection runs on EVERY provider request — a large tool output starts
           summarizing as soon as it ages past KEEP_RECENT_MESSAGES, even mid-turn. */

        /* ---- STAGE 1: grouped far-back tool condensing (never on failure) ---- */
        const cutoff = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
        const candidates = [];

        /* ---- DB backfill: parts magic-context trimmed out of out.messages ----
           magic-context compacts the request and drops old messages; those parts
           are invisible to the in-memory scan but still live in the part table
           (source of truth) and re-enter context whenever magic-context re-injects
           them. Scan the DB for old, big, undigested tool parts and schedule them
           in the background, oldest first. Throttled to once per 60s. */
        if (candidates.length < MAX_TO_SUMMARIZE && Date.now() - lastDbScanMs > 60000) {
          lastDbScanMs = Date.now();
          try {
            const recentMsgIds = new Set();
            for (let mi = Math.max(0, messages.length - KEEP_RECENT_MESSAGES); mi < messages.length; mi++) {
              const mid_ = messages[mi]?.info?.id || messages[mi]?.id;
              if (mid_) recentMsgIds.add(mid_);
            }
            const db = getDb();
            const sidDb = sessionIdOf(messages, out);
            if (db && sidDb && sidDb !== "global") {
              const rows = db.prepare("SELECT id, message_id, data FROM part WHERE session_id=? ORDER BY time_created ASC").all(sidDb);
              for (const row of rows) {
                if (candidates.length >= MAX_TO_SUMMARIZE) break;
                let pd = null; try { pd = JSON.parse(row.data); } catch { continue; }
                if (!pd || pd.type !== "tool") continue;
                const st = pd.state || {};
                if (typeof st.output !== "string" || st.output.length < SUMMARIZE_THRESHOLD) continue;
                if (st.output.trimStart().startsWith("[context-saver")) continue;
                if (map[row.id]) continue;                    // already digested/in-flight
                if (recentMsgIds.has(row.message_id)) continue; // keep-6 window
                if (visibleIds.has(row.id)) continue;          // visible in-memory scan handles it
                if (stats.failCooldown && stats.failCooldown[row.id] && Date.now() - stats.failCooldown[row.id] < FAIL_COOLDOWN_MS) continue;
                const part = { id: row.id, type: "tool", tool: pd.tool, callID: pd.callID, state: st, sessionID: sidDb, messageID: row.message_id };
                candidates.push({ msg: null, part, text: st.output, tool: String(pd.tool || "tool"), callID: String(pd.callID || row.id) });
              }
            }
          } catch (e) { console.error("[context-saver] db backfill scan failed:", e?.message); }
        }

        /* ---- STREAK scan: STREAK_MIN+ consecutive tool calls with NO assistant
           chat in between → summarized as ONE group in a single summarizer call,
           sub-threshold outputs included (tiny outputs stay inline). Must be
           STREAK_MIN undigested calls in a row to qualify. ---- */
        const streakGroups = [];
        const streakScheduledIds = new Set();
        {
          let run = [];
          const flushRun = () => {
            const members = run.filter(m =>
              m.text.length >= STREAK_MIN_CHARS &&
              !m.text.trimStart().startsWith("[context-saver") &&
              !(m.part.id && map[m.part.id]) &&
              !(m.part.id && stats.failCooldown && stats.failCooldown[m.part.id] && Date.now() - stats.failCooldown[m.part.id] < FAIL_COOLDOWN_MS));
            if (members.length >= STREAK_MIN) {
              for (let i = 0; i < members.length; i += STREAK_MAX_MEMBERS) {
                const chunk = members.slice(i, i + STREAK_MAX_MEMBERS);
                chunk.isStreak = true;
                streakGroups.push(chunk);
                chunk.forEach(m => streakScheduledIds.add(m.part.id));
              }
            }
            run = [];
          };
          for (let mi = 0; mi < cutoff; mi++) {
            const msg = messages[mi];
            const role = msg?.info?.role ?? msg?.role;
            if (role !== "assistant") { if (run.length) flushRun(); continue; }
            const parts = msg.parts || [];
            const hasChat = parts.some(p => p.type === "text" && (p.text || "").trim().length > 0);
            const toolParts = parts.filter(p => isToolPart(p));
            if (hasChat || toolParts.length === 0) { if (run.length) flushRun(); continue; }
            for (const part of toolParts) {
              const t = extractToolOutput(part);
              if (t != null) run.push({ msg, part, text: t, tool: String(part.tool ?? part.data?.tool ?? "tool"), callID: String(part.callID ?? part.data?.callID ?? part.id ?? "streak") });
            }
          }
          if (run.length) flushRun();
        }

        for (let mi=0; mi<cutoff; mi++) {
          const msg = messages[mi];
          if (msg.info?.role !== "assistant" && msg.role !== "assistant") continue;
          for (const part of msg.parts || []) {
            if (!isToolPart(part)) continue;       // NEVER text/conversation parts
            const t = extractToolOutput(part);
            if (t==null || t.length < SUMMARIZE_THRESHOLD) continue;
            if (t.trimStart().startsWith("[context-saver")) continue;
            if (part.id && map[part.id]) continue;
            if (streakScheduledIds.has(part.id)) continue;   // already in a streak group this run
            if (part.id && stats.failCooldown && stats.failCooldown[part.id] && Date.now() - stats.failCooldown[part.id] < FAIL_COOLDOWN_MS) continue; // summarizer recently failed on this part — cooldown
            candidates.push({ msg, part, text: t, tool: String(part.tool ?? part.data?.tool ?? "tool"), callID: String(part.callID ?? part.data?.callID ?? part.id ?? String(mi)) });
          }
        }
        const toSummarize = candidates.slice(0, MAX_TO_SUMMARIZE); // already chronological
        const chunkArr = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
        const groups = [...streakGroups, ...chunkArr(toSummarize, GROUP_SIZE)];
        groups.forEach(gr => gr.forEach(c => c.heavy = isAddressHeavy(c.text)));
        const numGroups = groups.length;
        const totalMembers = groups.reduce((s,gr) => s + gr.length, 0);
        const stage1ByPartId = {};
        let replacedTotal = 0;
        const scheduledBg = new Set();

        if (numGroups > 0) {
          const nHeavy = groups.reduce((s,gr) => s + gr.filter(c => c.heavy).length, 0);
          const nStreak = streakGroups.length;
          notify("Summarizing", `${totalMembers} far-back tools in ${numGroups} group${numGroups>1?"s":""}${nStreak ? ` incl. ${nStreak} tool-streak${nStreak>1?"s":""}` : ""} (${nHeavy} address-heavy -> raw on disk, not summarized)`, "info");
          const dir = path.join(os.homedir(), GROUP_DIGEST_DIRNAME);
          fs.mkdirSync(dir, {recursive:true});
          const ts = new Date().toISOString().replace(/[:.]/g,"-");

          for (let g=0; g<groups.length; g++) {
            const group = groups[g];
            const lightCount = group.filter(m=>!m.heavy).length;
            const groupFile = path.join(dir, `group-${ts}-g${g+1}.md`);

            // ---- group MD: FULL verbatim raw of EVERY member (light AND heavy) FIRST
            const mdLines = [`# GROUP DIGEST + FULL TOOL CALLS — ${ts}`, `group ${g+1}/${numGroups}${group.isStreak ? " · TOOL-CALL STREAK (no chat between calls)" : ""} · ${group.length} tools · ${lightCount} summarized, ${group.length-lightCount} address-heavy (raw only)`, ""];
            group.forEach((m,i)=>{
              mdLines.push(`## TOOL ${i+1} — ${m.tool} (callID ${m.callID.slice(0,12)} · ${m.text.length} chars)`);
              mdLines.push(`> FULL RAW TOOL CALL (verbatim, complete).`);
              mdLines.push("```");
              mdLines.push(m.text);
              mdLines.push("```");
              if (m.heavy) mdLines.push(`> [ADDRESS-HEAVY: not summarized; raw verbatim above]`);
              mdLines.push("");
            });
            mdLines.push("## DIGESTS");
            const mdBody = mdLines.join("\n");

            const applyAndPersist = (m, repl) => {
              trimPartInput(m.part);                       // shrink redundant tool args (biggest chunk)
              setToolOutput(m.part, repl);
              replacedTotal += repl.length;
              if (m.part.id) {
                const ok = writePartToDb(m.part, stats);
                map[m.part.id] = { tool: m.tool, replacement: repl, sourceLen: m.text.length, text: m.text, at: Date.now() };
                if (!ok) saveMap(map);
                stage1ByPartId[m.part.id] = groupFile;
              }
              logSummary(g===0?"group":"group", `${m.tool}-${m.callID.slice(0,16)}`, { group: g+1, groupFile, tool: m.tool, callID: m.callID, chars: m.text.length, heavy: m.heavy, session: partSessionId(m.part) }, m.text, repl);
            };

            if (lightCount === 0) {
              // all-heavy: no LLM at all; MD is raw-only
              fs.writeFileSync(groupFile, mdBody + `\n(no LLM digests — all tools address-heavy; full raw above)\n`, "utf8");
              stats.groups = (stats.groups||0) + 1;
              group.forEach(m => applyAndPersist(m, heavyInlineReplacement(m, groupFile)));
            } else {
              /* BACKGROUND: never block the turn on the summarizer (it can take 60s+).
                 Mark members in-flight so the next turn skips them; digests are
                 applied via the map on subsequent turns. */
              stats.summarizerCalls = (stats.summarizerCalls||0) + 1;
              group.forEach(m => { if (m.part.id) { map[m.part.id] = { tool: m.tool, replacement: undefined, sourceLen: m.text.length, text: m.text, at: Date.now(), pending: true }; scheduledBg.add(m); } });
              saveMap(map);
              const members = group.map(m=>({tool:m.tool,callID:m.callID,chars:m.text.length,heavy:m.heavy}));
              const gIdx = g+1;
              void (async () => {
                try {
                  const res = await summarizeWithRetry(toolGroupDigestPrompt(group));
                  if (!res.ok || !res.text) {
                    // NEVER prune on failure: leave every member inline, untouched; cooldown before retry
                    stats.summarizerFails = (stats.summarizerFails||0) + 1;
                    stats.leftInlineOnFail = (stats.leftInlineOnFail||0) + group.length;
                    stats.failCooldown = stats.failCooldown || {};
                    group.forEach(m => { if (m.part.id) { delete map[m.part.id]; stats.failCooldown[m.part.id] = Date.now(); } });
                    saveMap(map); saveStats(stats);
                    logSummary("group-fail", `g${gIdx}-${ts.slice(0,13)}`, { group: group.length, members, attempts: res.attempts, mode: "left-inline-on-fail-background", cooldownMs: FAIL_COOLDOWN_MS }, mdBody, "(left inline — summarizer failed twice; will retry after cooldown)");
                    return;
                  }
                  const split = splitGroupDigest(res.text, group.length);
                  const digestLines = [...mdLines];
                  group.forEach((m,i)=>{
                    const d = split.sections && split.sections[i];
                    if (m.heavy) digestLines.push(`### TOOL ${i+1} DIGEST — address-heavy (raw verbatim above)`);
                    else if (d) { digestLines.push(`### TOOL ${i+1} DIGEST`, d); }
                    else digestLines.push(`### TOOL ${i+1} DIGEST — [unavailable]`);
                    digestLines.push("");
                  });
                  fs.writeFileSync(groupFile, digestLines.join("\n"), "utf8");
                  stats.groups = (stats.groups||0) + 1;
                  stats.toolCalls = (stats.toolCalls||0) + group.filter(m=>!m.heavy).length;
                  let replaced = 0, original = 0;
                  group.forEach((m,i)=>{
                    original += m.text.length;
                    let repl;
                    if (m.heavy) repl = heavyInlineReplacement(m, groupFile);
                    else if (split.sections && split.sections[i]) repl = inlineReplacement(m, split.sections[i], groupFile);
                    else repl = inlineReplacement(m, `group digest: ${split.whole ? split.whole.slice(0, 600) : "(unavailable)"}`, groupFile);
                    replaced += repl.length;
                    trimPartInput(m.part);
                    setToolOutput(m.part, repl);
                    if (m.part.id) {
                      const ok = writePartToDb(m.part, stats);
                      map[m.part.id] = { tool: m.tool, replacement: repl, sourceLen: m.text.length, text: m.text, at: Date.now() };
                      if (!ok) saveMap(map);
                      logSummary("group", `${m.tool}-${m.callID.slice(0,16)}`, { group: gIdx, groupFile, tool: m.tool, callID: m.callID, chars: m.text.length, heavy: m.heavy, background: true, session: partSessionId(m.part) }, m.text, repl);
                    }
                  });
                  const savedBg = Math.max(0, original - replaced);
                  stats.totalOriginal = (stats.totalOriginal||0) + original;
                  stats.totalReplaced = (stats.totalReplaced||0) + replaced;
                  stats.totalSaved = (stats.totalSaved||0) + savedBg;
                  stats.totalTokensSaved = (stats.totalTokensSaved||0) + Math.round(savedBg/4);
                  stats.lastRun = { at: new Date().toISOString(), count: group.length, groups: 1, background: true, originalChars: original, replacedChars: replaced, savedChars: savedBg, tokensSaved: Math.round(savedBg/4), summarizerCalls: stats.summarizerCalls, summarizerFails: stats.summarizerFails };
                  stats.history.push({ ...stats.lastRun });
                  if (stats.history.length > 50) stats.history = stats.history.slice(-50);
                  saveMap(map); saveStats(stats);
                  notify("Saved (background)", `${fmt(savedBg)} chars (~${fmt(Math.round(savedBg/4))} tok) — applies on an upcoming request`, "success");
                } catch (e) {
                  console.error("[context-saver] background group crashed:", e?.message||e);
                  group.forEach(m => { if (m.part.id) delete map[m.part.id]; });
                  saveMap(map);
                }
              })();
            }
          }
          saveMap(map);
        }
        /* Stage 2 + run stats are turn-boundary bookkeeping — mid-turn requests stop here */
        if (!isTurnStart) return;
        /* ---- STAGE 2: every CHECKPOINT_EVERY_TURNS turns, editing-history digest
                (baseline advances on success; on failure cooldown via fails%N) ---- */
        const sid = sessionIdOf(messages, out);
        const tracker = loadTracker();
        const userCount = messages.filter(m => (m?.info?.role ?? m?.role) === "user").length;
        const ent = tracker[sid];
        let batchFile = null;
        const fails = ent?.fails || 0;
        if (!ent) {
          tracker[sid] = { baseline: userCount, fails: 0, at: Date.now() };
        } else if (userCount - ent.baseline >= CHECKPOINT_EVERY_TURNS && (fails % CHECKPOINT_EVERY_TURNS === 0)) {
          const mat = buildBatchMaterial(messages, stage1ByPartId);
          if (mat) {
            stats.summarizerCalls = (stats.summarizerCalls||0) + 1;
            saveStats(stats);
            void (async () => {
              try {
                const res = await summarizeWithRetry(historyDigestPrompt(mat.text));
                if (res.ok && res.text) {
                  const dir = path.join(os.homedir(), GROUP_DIGEST_DIRNAME);
                  fs.mkdirSync(dir, {recursive:true});
                  const ts = new Date().toISOString().replace(/[:.]/g,"-");
                  const batchFile = path.join(dir, `batch-${sid.slice(0,8)}-${ts}.md`);
                  fs.writeFileSync(batchFile, res.text, "utf8");
                  logSummary("batch", `${sid.slice(0,8)}-${ts.slice(0,13)}`, { ...mat.meta, batchFile, stage1Tools: Object.keys(stage1ByPartId).length, session: sid, background: true }, mat.text, res.text);
                  stats.checkpoints = (stats.checkpoints||0) + 1;
                  stats.turns = (stats.turns||0) + mat.meta.turnsInBatch;
                  tracker[sid] = { baseline: userCount, fails: 0, at: Date.now(), lastBatch: batchFile };
                  saveTracker(tracker); saveStats(stats);
                } else {
                  stats.summarizerFails = (stats.summarizerFails||0) + 1;
                  tracker[sid] = { ...ent, baseline: ent.baseline, fails: fails + 1, at: Date.now() };
                  saveTracker(tracker); saveStats(stats);
                  logSummary("batch", `${sid.slice(0,8)}-${tsId()}`, { ...mat.meta, summarizerFailed: true, attempts: res.attempts, cooldownTurns: CHECKPOINT_EVERY_TURNS, background: true }, mat.text, "(summarizer failed; baseline NOT advanced — retry after cooldown)");
                }
              } catch (e) { console.error("[context-saver] background batch crashed:", e?.message||e); }
            })();
          }
        }
        saveTracker(tracker);

        /* record run stats — sync (all-heavy) work only; background groups book their own stats */
        if (numGroups > 0) {
          const allMembers = groups.flat();
          const syncOriginal = allMembers.filter(c => !scheduledBg.has(c)).reduce((s,c)=> s + c.text.length, 0);
          const saved = Math.max(0, syncOriginal - replacedTotal);
          if (syncOriginal > 0) {
            stats.totalOriginal += syncOriginal;
            stats.totalReplaced += replacedTotal;
            stats.totalSaved += saved;
            stats.totalTokensSaved += Math.round(saved / 4);
          }
          stats.runs += 1;
          stats.lastRun = { at: new Date().toISOString(), count: totalMembers, groups: numGroups, streaks: streakGroups.length, backgrounded: scheduledBg.size, candidates: candidates.length, originalChars: syncOriginal, replacedChars: replacedTotal, savedChars: saved, tokensSaved: Math.round(saved/4), leftInlineOnFail: stats.leftInlineOnFail, summarizerCalls: stats.summarizerCalls, summarizerFails: stats.summarizerFails };
          stats.history.push({ ...stats.lastRun });
          if (stats.history.length > 50) stats.history = stats.history.slice(-50);
          saveStats(stats);
          lastSummarizeAt = transformCount;
          if (syncOriginal > 0) notify("Saved", `${fmt(saved)} chars (~${fmt(Math.round(saved/4))} tok): ${fmt(syncOriginal)}→${fmt(replacedTotal)} | groups: ${numGroups} (${scheduledBg.size} in background)`, "success");
          else notify("Summarizing (background)", `${scheduledBg.size} tool calls sent to the summarizer — applies on an upcoming request`, "info");
        }
      } catch (e) { console.error("[context-saver] unexpected:", e?.message, e?.stack); }
    },
  };
}

function tsId() { return new Date().toISOString().replace(/[:.]/g,"-").slice(0,13); }