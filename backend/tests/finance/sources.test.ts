import { afterEach, describe, expect, test } from "bun:test";

import { fetchCrypto, fetchPredictions, fetchStocks } from "../../finance/sources";
import { mockFetch, type FetchMock } from "../helpers/fetch-mock";

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
});

describe("fetchCrypto (CoinGecko)", () => {
  test("maps rows to CryptoCoin and gates commercialOk=false (Demo tier)", async () => {
    fm = mockFetch({
      "/coins/markets": {
        json: [
          {
            id: "bitcoin",
            symbol: "btc",
            name: "Bitcoin",
            image: "img",
            current_price: 100,
            price_change_percentage_24h: 1.5,
            market_cap: 9,
            sparkline_in_7d: { price: [1, 2, 3] },
          },
        ],
      },
    });
    const { coins, provenance } = await fetchCrypto();
    expect(coins).toHaveLength(1);
    expect(coins[0]).toMatchObject({
      id: "bitcoin",
      symbol: "BTC", // upper-cased
      name: "Bitcoin",
      price: 100,
      change24h: 1.5,
      marketCap: 9,
      sparkline: [1, 2, 3],
    });
    expect(provenance.source).toBe("CoinGecko");
    expect(provenance.commercialOk).toBe(false); // not cleared for public display
  });

  test("throws on a non-OK CoinGecko response", async () => {
    fm = mockFetch({ "/coins/markets": { status: 500 } });
    await expect(fetchCrypto()).rejects.toThrow(/CoinGecko 500/);
  });
});

describe("fetchStocks", () => {
  test("US with no Twelve Data key → needsKey, and short-circuits before any fetch", async () => {
    fm = mockFetch({});
    const r = await fetchStocks("us");
    expect(r.needsKey).toBe(true);
    expect(r.items).toEqual([]);
    expect(fm.calls).toHaveLength(0); // no network call when the key is missing
  });

  test("India path uses keyless Yahoo and strips the .NS/.BO suffix", async () => {
    fm = mockFetch({
      "query1.finance.yahoo.com": {
        json: {
          chart: {
            result: [
              {
                meta: { regularMarketPrice: 50, chartPreviousClose: 40 },
                indicators: { quote: [{ close: [40, 50] }] },
              },
            ],
          },
        },
      },
    });
    const r = await fetchStocks("in");
    expect(r.currency).toBe("INR");
    expect(r.items.length).toBeGreaterThan(0);
    for (const q of r.items) expect(q.symbol).not.toMatch(/\.(NS|BO)$/i);
  });
});

describe("fetchPredictions (Polymarket → Manifold fallback)", () => {
  test("falls back to Manifold when Polymarket is unavailable", async () => {
    fm = mockFetch({
      "gamma-api.polymarket.com": { status: 503 }, // Polymarket down
      "api.manifold.markets": {
        json: [{ id: "m1", question: "Will X happen?", url: "https://manifold/x", probability: 0.5 }],
      },
    });
    const { markets, provenance } = await fetchPredictions();
    expect(provenance.source).toBe("Manifold Markets");
    expect(provenance.unit).toBe("mana");
    expect(markets[0]).toMatchObject({ id: "m1", question: "Will X happen?" });
    expect(markets[0]!.outcomes).toEqual([
      { label: "Yes", probability: 0.5 },
      { label: "No", probability: 0.5 },
    ]);
  });
});