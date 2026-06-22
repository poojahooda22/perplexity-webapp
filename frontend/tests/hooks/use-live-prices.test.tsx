// Hook test — useLivePrices: the Supabase-Realtime live-tick subscription that merges worker
// ticks into the cached /finance/stocks (US) + /finance/crypto queries in place.
// (Archetype: realtime side-effect hook.) The shared Supabase fake reports SUBSCRIBED but does
// NOT expose the broadcast handler, so we spy on supabase.channel HERE (in this file only — the
// shared fake is untouched) to capture the handler and drive a real tick → cache-merge.
import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { act, renderHookWithProviders, waitFor } from "@tests/helpers/utils";
import { useLivePrices } from "@/hooks/use-live-prices";
import { supabase } from "@/lib/supabase";
import type { CryptoPayload, QuotesPayload } from "@/lib/finance-api";

const prov = { source: "test", commercialOk: false, attribution: "test" };

// The default test QueryClient uses gcTime: 0, which immediately garbage-collects any query data
// that has no active observer. useLivePrices only WRITES to the finance cache (it never observes
// it), so the merge tests need a client that retains data with no observers.
function persistentClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 }, mutations: { retry: false } },
  });
}

// A controllable channel that mirrors the shared fake's chainable shape but captures the
// "broadcast"/"tick" handler so the test can push a tick. subscribe() still reports SUBSCRIBED.
function makeCapturingChannel() {
  let tickHandler: ((msg: { payload: unknown }) => void) | undefined;
  const channel = {
    on(_event: string, filter: { event?: string }, cb: (msg: { payload: unknown }) => void) {
      if (filter?.event === "tick") tickHandler = cb;
      return channel;
    },
    subscribe(cb?: (status: string) => void) {
      cb?.("SUBSCRIBED");
      return channel;
    },
    unsubscribe: async () => ({ error: null }),
    send: async () => ({ error: null }),
  };
  return { channel, emitTick: (symbols: { s: string; p: number; t: number }[]) => tickHandler?.({ payload: { symbols } }) };
}

describe("useLivePrices", () => {
  test("mounts without throwing and returns both statuses starting 'off'", () => {
    const { result } = renderHookWithProviders(() => useLivePrices());
    expect(result.current).toEqual({ stockStatus: "off", cryptoStatus: "off" });
  });

  test("subscribes to the channel name it is given (defaults to 'prices:top')", () => {
    const channelSpy = spyOn(supabase, "channel");
    try {
      renderHookWithProviders(() => useLivePrices());
      expect(channelSpy).toHaveBeenCalledWith("prices:top");
    } finally {
      channelSpy.mockRestore();
    }
  });

  test("honors a custom channel name", () => {
    const channelSpy = spyOn(supabase, "channel");
    try {
      renderHookWithProviders(() => useLivePrices("prices:custom"));
      expect(channelSpy).toHaveBeenCalledWith("prices:custom");
    } finally {
      channelSpy.mockRestore();
    }
  });

  test("unmounts cleanly — removeChannel is called, no error thrown", () => {
    const removeSpy = spyOn(supabase, "removeChannel");
    try {
      const { unmount } = renderHookWithProviders(() => useLivePrices());
      expect(() => unmount()).not.toThrow();
      expect(removeSpy).toHaveBeenCalledTimes(1);
    } finally {
      removeSpy.mockRestore();
    }
  });

  test("survives a channel that throws at subscribe time (caught, status stays 'off')", () => {
    const channelSpy = spyOn(supabase, "channel").mockImplementation(() => {
      throw new Error("realtime down");
    });
    try {
      const { result, unmount } = renderHookWithProviders(() => useLivePrices());
      // The try/catch in the effect swallows it: hook still returns, both statuses 'off'.
      expect(result.current).toEqual({ stockStatus: "off", cryptoStatus: "off" });
      expect(() => unmount()).not.toThrow();
    } finally {
      channelSpy.mockRestore();
    }
  });

  // --- Tick → cache-merge (covered here via a capturing channel spy; shared fake untouched) ---

  test("a stock tick merges into the cached US /finance/stocks query in place", async () => {
    const { channel, emitTick } = makeCapturingChannel();
    const channelSpy = spyOn(supabase, "channel").mockReturnValue(channel as never);
    try {
      const queryClient = persistentClient();
      const { result } = renderHookWithProviders(() => useLivePrices(), { queryClient });
      // Seed the cache exactly as useStocks("us") would.
      const seed: QuotesPayload = {
        items: [
          { symbol: "AAPL", name: "Apple", price: 100, change: 0, changePercent: 0 },
          { symbol: "MSFT", name: "Microsoft", price: 200, change: 0, changePercent: 0 },
        ],
        provenance: prov,
      };
      act(() => {
        queryClient.setQueryData<QuotesPayload>(["finance", "stocks", "us"], seed);
      });

      // Push a stock tick (no ":" → treated as a stock symbol).
      act(() => {
        emitTick([{ s: "AAPL", p: 123.45, t: Date.now() }]);
      });

      // Flush runs every 250ms; wait for the in-place merge.
      await waitFor(
        () => {
          const next = queryClient.getQueryData<QuotesPayload>(["finance", "stocks", "us"]);
          expect(next?.items.find((q) => q.symbol === "AAPL")?.price).toBe(123.45);
        },
        { timeout: 3000 },
      );
      // Untouched symbol keeps its seeded price; merge is in-place, not a refetch.
      const after = queryClient.getQueryData<QuotesPayload>(["finance", "stocks", "us"]);
      expect(after?.items.find((q) => q.symbol === "MSFT")?.price).toBe(200);

      // Status eventually reports a live stock feed (connected + a fresh tick).
      await waitFor(() => expect(result.current.stockStatus).toBe("live"), { timeout: 4000 });
    } finally {
      channelSpy.mockRestore();
    }
  });

  test("a crypto tick (EXCHANGE:BASEUSDT) merges into the cached /finance/crypto query", async () => {
    const { channel, emitTick } = makeCapturingChannel();
    const channelSpy = spyOn(supabase, "channel").mockReturnValue(channel as never);
    try {
      const queryClient = persistentClient();
      renderHookWithProviders(() => useLivePrices(), { queryClient });
      const seed: CryptoPayload = {
        coins: [
          { id: "btc", symbol: "BTC", name: "Bitcoin", image: "", price: 50000, change24h: 0, marketCap: 0, sparkline: [] },
          { id: "eth", symbol: "ETH", name: "Ethereum", image: "", price: 3000, change24h: 0, marketCap: 0, sparkline: [] },
        ],
        provenance: prov,
      };
      act(() => {
        queryClient.setQueryData<CryptoPayload>(["finance", "crypto"], seed);
      });

      // "BINANCE:BTCUSDT" → base "BTC" (matches coin.symbol).
      act(() => {
        emitTick([{ s: "BINANCE:BTCUSDT", p: 67890, t: Date.now() }]);
      });

      await waitFor(
        () => {
          const next = queryClient.getQueryData<CryptoPayload>(["finance", "crypto"]);
          expect(next?.coins.find((c) => c.symbol === "BTC")?.price).toBe(67890);
        },
        { timeout: 3000 },
      );
      const after = queryClient.getQueryData<CryptoPayload>(["finance", "crypto"]);
      expect(after?.coins.find((c) => c.symbol === "ETH")?.price).toBe(3000);
    } finally {
      channelSpy.mockRestore();
    }
  });

  test("a tick with no matching cache (query absent) is a no-op, not a crash", async () => {
    const { channel, emitTick } = makeCapturingChannel();
    const channelSpy = spyOn(supabase, "channel").mockReturnValue(channel as never);
    try {
      const queryClient = persistentClient();
      renderHookWithProviders(() => useLivePrices(), { queryClient });
      // No cache seeded for ["finance","stocks","us"].
      act(() => {
        emitTick([{ s: "AAPL", p: 123.45, t: Date.now() }]);
      });
      // Give the flush interval a couple of cycles; nothing should be created/thrown.
      await new Promise((r) => setTimeout(r, 300));
      expect(queryClient.getQueryData(["finance", "stocks", "us"])).toBeUndefined();
    } finally {
      channelSpy.mockRestore();
    }
  });

  test("an empty tick payload is ignored (no merge, no error)", async () => {
    const { channel, emitTick } = makeCapturingChannel();
    const channelSpy = spyOn(supabase, "channel").mockReturnValue(channel as never);
    try {
      const queryClient = persistentClient();
      renderHookWithProviders(() => useLivePrices(), { queryClient });
      const seed: QuotesPayload = {
        items: [{ symbol: "AAPL", name: "Apple", price: 100, change: 0, changePercent: 0 }],
        provenance: prov,
      };
      act(() => {
        queryClient.setQueryData<QuotesPayload>(["finance", "stocks", "us"], seed);
      });
      act(() => {
        emitTick([]); // empty → early return in the handler
      });
      await new Promise((r) => setTimeout(r, 300));
      const after = queryClient.getQueryData<QuotesPayload>(["finance", "stocks", "us"]);
      expect(after?.items[0]?.price).toBe(100);
    } finally {
      channelSpy.mockRestore();
    }
  });
});
