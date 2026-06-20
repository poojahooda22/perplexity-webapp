import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase";
import type { CryptoPayload, QuotesPayload } from "@/lib/finance-api";

type Tick = { s: string; p: number; t: number };
export type LiveStatus = "off" | "idle" | "live";

// "BINANCE:BTCUSDT" -> "BTC" (matches CoinGecko coin.symbol). Stock symbols have no ":".
function cryptoBase(sym: string): string | null {
  if (!sym.includes(":")) return null;
  const pair = sym.split(":")[1] ?? "";
  return pair.replace(/(USDT|USDC|USD)$/i, "").toUpperCase() || null;
}

// Subscribe to live ticks the worker broadcasts via Supabase Realtime, and merge them into
// the cached /finance/stocks AND /finance/crypto queries so the Watchlist + Crypto cards
// update in place — no refetch, no flicker. Ticks are buffered and flushed ~4×/sec.
// Browsers hold ONLY the Supabase anon key here; they never touch Finnhub.
// Status is per-class & honest: stocks read "idle" when the market's closed (no ticks),
// crypto reads "live" while it's ticking 24/7.
export function useLivePrices(channel = "prices:top") {
  const qc = useQueryClient();
  const stockBuf = useRef<Map<string, number>>(new Map()); // symbol -> price
  const cryptoBuf = useRef<Map<string, number>>(new Map()); // base symbol -> price
  const lastStock = useRef<number | null>(null);
  const lastCrypto = useRef<number | null>(null);
  const connected = useRef(false);
  const [stockStatus, setStockStatus] = useState<LiveStatus>("off");
  const [cryptoStatus, setCryptoStatus] = useState<LiveStatus>("off");

  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    try {
      ch = supabase.channel(channel);
      ch.on("broadcast", { event: "tick" }, (msg) => {
        const symbols = (msg.payload as { symbols?: Tick[] } | undefined)?.symbols;
        if (!symbols?.length) return;
        const now = Date.now();
        for (const t of symbols) {
          const base = cryptoBase(t.s);
          if (base) {
            cryptoBuf.current.set(base, t.p);
            lastCrypto.current = now;
          } else {
            stockBuf.current.set(t.s, t.p);
            lastStock.current = now;
          }
        }
      }).subscribe((s) => {
        connected.current = s === "SUBSCRIBED";
      });
    } catch (e) {
      console.warn("[live-prices] subscribe failed:", e);
    }

    const flush = setInterval(() => {
      if (stockBuf.current.size) {
        const ticks = stockBuf.current;
        stockBuf.current = new Map();
        // US watchlist only — India stocks are delayed (no live worker feed).
        qc.setQueryData<QuotesPayload>(["finance", "stocks", "us"], (prev) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((q) =>
                  ticks.has(q.symbol) ? { ...q, price: ticks.get(q.symbol)! } : q,
                ),
              }
            : prev,
        );
      }
      if (cryptoBuf.current.size) {
        const ticks = cryptoBuf.current;
        cryptoBuf.current = new Map();
        qc.setQueryData<CryptoPayload>(["finance", "crypto"], (prev) =>
          prev
            ? {
                ...prev,
                coins: prev.coins.map((c) =>
                  ticks.has(c.symbol) ? { ...c, price: ticks.get(c.symbol)! } : c,
                ),
              }
            : prev,
        );
      }
    }, 250);

    const statusTimer = setInterval(() => {
      const fresh = (t: number | null) => t != null && Date.now() - t < 15000;
      setStockStatus(!connected.current ? "off" : fresh(lastStock.current) ? "live" : "idle");
      setCryptoStatus(!connected.current ? "off" : fresh(lastCrypto.current) ? "live" : "idle");
    }, 2000);

    return () => {
      clearInterval(flush);
      clearInterval(statusTimer);
      if (ch) supabase.removeChannel(ch);
    };
  }, [channel, qc]);

  return { stockStatus, cryptoStatus };
}
