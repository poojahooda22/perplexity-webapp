// Throwaway Finnhub WebSocket probe. Settles: (1) is free WS real-time or ~15-min delayed,
// (2) do stock / crypto / forex classes stream on the free key. Prints NO key. Run, read, delete.
const key = process.env.FINNHUB_API_KEY || process.env.FINHUB_API_KEY; // accept the common 1-N typo
if (!key) {
  console.log("FINNHUB_API_KEY missing — add it to backend/.env.local and re-run.");
  process.exit(1);
}
console.log("key present: true | length:", key.length);

const SYMBOLS = ["AAPL", "BINANCE:BTCUSDT", "OANDA:EUR_USD"];
const seen: Record<string, { count: number; firstLagSec: number | null }> = {};
for (const s of SYMBOLS) seen[s] = { count: 0, firstLagSec: null };

const ws = new WebSocket(`wss://ws.finnhub.io?token=${key}`);

ws.addEventListener("open", () => {
  console.log("WS open — subscribing:", SYMBOLS.join(", "));
  for (const s of SYMBOLS) ws.send(JSON.stringify({ type: "subscribe", symbol: s }));
});

ws.addEventListener("message", (ev) => {
  let msg: any;
  try {
    msg = JSON.parse(ev.data as string);
  } catch {
    return;
  }
  if (msg.type === "ping") return;
  if (msg.type === "error") {
    console.log("server error:", msg.msg ?? JSON.stringify(msg));
    return;
  }
  if (msg.type !== "trade" || !Array.isArray(msg.data)) return;
  const now = Date.now();
  for (const tr of msg.data) {
    const rec = seen[tr.s];
    if (!rec) continue;
    rec.count++;
    if (rec.firstLagSec === null) rec.firstLagSec = Math.round((now - tr.t) / 1000);
  }
});

ws.addEventListener("error", (e: any) => console.log("WS error:", e?.message ?? String(e)));
ws.addEventListener("close", (e: any) => console.log("WS closed:", e?.code ?? "", e?.reason ?? ""));

setTimeout(() => {
  console.log("\n=== PROBE SUMMARY (after ~25s) ===");
  for (const s of SYMBOLS) {
    const r = seen[s]!;
    const cls = s.includes("BINANCE") ? "crypto" : s.includes("OANDA") ? "forex" : "stock";
    const verdict =
      r.count === 0
        ? "NO DATA (not on free tier, or market closed)"
        : r.firstLagSec != null && r.firstLagSec > 600
          ? `DELAYED ~${Math.round(r.firstLagSec / 60)} min`
          : `REAL-TIME (first-tick lag ${r.firstLagSec}s)`;
    console.log(`${s} [${cls}]: ${r.count} ticks → ${verdict}`);
  }
  console.log("(Stocks only stream during US market hours ≈ 19:00–01:30 IST.)");
  try {
    ws.close();
  } catch {}
  process.exit(0);
}, 25000);
