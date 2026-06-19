// ─────────────────────────────────────────────────────────────────────────
// Always-on price worker.
//
// Holds ONE Finnhub WebSocket, coalesces the trade-tick firehose into a per-symbol
// latest-price map, and broadcasts the changed symbols to Supabase Realtime (channel
// "prices:top") on a fixed timer (~1/sec). Browsers subscribe to Supabase Realtime —
// never to Finnhub — so there is exactly ONE upstream Finnhub socket no matter how many
// people are watching ("subscribe once, fan out to many").
//
// The Finnhub API key lives ONLY here (it rides in the WS URL, so it must never reach a
// browser). Deploy on a small ALWAYS-ON host (Fly.io ~$2/mo) — NOT Vercel (serverless
// can't hold a persistent socket) and NOT a free PaaS that sleeps/scales-to-zero.
// ─────────────────────────────────────────────────────────────────────────

// Canonical name is FINNHUB_API_KEY; also accept the common FINHUB_API_KEY (1-N) typo.
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || process.env.FINHUB_API_KEY;
// Reuse the backend's var names if present, so `bun --env-file=../backend/.env.local` works locally.
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.BUN_PUBLIC_SUPABASE_URL ||
  "https://rgwdybuczqcoenmxmosd.supabase.co";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_API_SECRET;

const CHANNEL = process.env.PRICE_CHANNEL || "prices:top";
const FLUSH_MS = Number(process.env.FLUSH_MS) || 1000;
// Symbols to stream live — keep ≤ Finnhub's free symbol cap (~50) and in sync with the
// frontend watchlist. Indices (^GSPC etc.) are NOT on the WS; they stay on Yahoo REST.
const SYMBOLS = (
  process.env.SYMBOLS ||
  // Watchlist stocks (stream during US market hours) + crypto pairs (stream 24/7, free).
  "GOOGL,NVDA,TSLA,META,AAPL,AMZN,BINANCE:BTCUSDT,BINANCE:ETHUSDT,BINANCE:SOLUSDT,BINANCE:XRPUSDT,BINANCE:BNBUSDT"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!FINNHUB_API_KEY || !SUPABASE_SERVICE_KEY) {
  console.error(
    "Missing env. Required: FINNHUB_API_KEY and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_API_SECRET). " +
      "Optional: SUPABASE_URL, PRICE_CHANNEL, FLUSH_MS, SYMBOLS.",
  );
  process.exit(1);
}

const latest = new Map<string, { p: number; t: number }>();
const dirty = new Set<string>();

let ws: WebSocket | null = null;
let backoff = 1000;
let lastFrameAt = Date.now();
let broadcastOk = 0;

function connect() {
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);

  ws.addEventListener("open", () => {
    console.log(`[finnhub] open — subscribing to ${SYMBOLS.length} symbols`);
    backoff = 1000;
    lastFrameAt = Date.now();
    for (const s of SYMBOLS) ws!.send(JSON.stringify({ type: "subscribe", symbol: s }));
  });

  ws.addEventListener("message", (ev) => {
    lastFrameAt = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(ev.data as string); // ALWAYS parse before branching (Finnhub sends {type:"ping"})
    } catch {
      return;
    }
    if (msg.type === "ping") return;
    if (msg.type === "error") {
      console.error("[finnhub] error:", msg.msg ?? JSON.stringify(msg));
      return;
    }
    if (msg.type !== "trade" || !Array.isArray(msg.data)) return;
    for (const tr of msg.data) {
      const prev = latest.get(tr.s);
      if (prev && tr.t <= prev.t) continue; // drop out-of-order ticks
      latest.set(tr.s, { p: tr.p, t: tr.t });
      dirty.add(tr.s);
    }
  });

  ws.addEventListener("close", () => {
    console.warn("[finnhub] closed — reconnecting");
    scheduleReconnect();
  });
  ws.addEventListener("error", (e: any) => {
    console.error("[finnhub] ws error:", e?.message ?? String(e));
    try {
      ws?.close();
    } catch {}
  });
}

function scheduleReconnect() {
  const jitter = 0.5 + Math.random() * 0.5; // avoid thundering-herd reconnects
  const delay = Math.min(backoff, 30000) * jitter;
  backoff = Math.min(backoff * 2, 30000);
  setTimeout(connect, delay);
}

// Watchdog: no frame (trade OR ping) for >35s ⇒ the socket is dead, force a reconnect.
setInterval(() => {
  if (Date.now() - lastFrameAt > 35000) {
    console.warn("[watchdog] no frames for 35s — reconnecting");
    try {
      ws?.close();
    } catch {}
  }
}, 10000);

// Coalesced broadcast loop — ONE bounded message per interval regardless of tick volume.
setInterval(async () => {
  if (dirty.size === 0) return;
  const symbols = [...dirty].map((s) => ({ s, ...latest.get(s)! }));
  dirty.clear();
  try {
    const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_KEY!,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        messages: [{ topic: CHANNEL, event: "tick", payload: { symbols } }],
      }),
    });
    if (!res.ok) console.error("[broadcast] failed:", res.status, await res.text());
    else if (broadcastOk++ === 0)
      console.log(`[broadcast] ok — live pipe up (${symbols.length} symbols this tick)`);
  } catch (e) {
    console.error("[broadcast] error:", e instanceof Error ? e.message : e);
  }
}, FLUSH_MS);

connect();
console.log(
  `[worker] up — channel "${CHANNEL}", flush ${FLUSH_MS}ms, symbols: ${SYMBOLS.join(", ")}`,
);
