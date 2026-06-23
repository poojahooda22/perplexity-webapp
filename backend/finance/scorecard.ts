// ─────────────────────────────────────────────────────────────────────────
// The public track-record scorecard — the moat ("no bank shows its miss rate").
//
// Each trading day a falsifiable, point-in-time house view is emitted from the Market Mood
// BEFORE the outcome is knowable (the S&P level at call time is frozen as refValue). After the
// horizon, the call is graded MECHANICALLY — current S&P vs refValue, never an LLM opinion —
// and the result (hit OR miss) is kept, never hidden. Honesty by construction: until enough
// calls resolve, the surface shows "establishing track record", not a fabricated win rate.
// ─────────────────────────────────────────────────────────────────────────

import { prisma } from "../db.js";
import { getOrRefresh } from "../lib/cache.js";
import { fetchIndices, type Quote } from "./sources.js";
import { fetchMarketMood } from "./sentiment-sources.js";

const SIGNAL = "market_mood.us";
const HORIZON_DAYS = 7;
const DAY_MS = 86_400_000;

function utcMidnight(d = new Date()): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

// Current S&P 500 level from the cached indices (the mechanical grading reference).
async function spLevel(): Promise<number | null> {
  try {
    const r = await getOrRefresh("finance:indices", 300, () => fetchIndices("us"));
    const items = (r.data as { items: Quote[] }).items ?? [];
    const sp = items.find((q) => /s&p|gspc|\b500\b/i.test(q.name) || q.symbol === "^GSPC");
    return sp?.price ?? null;
  } catch {
    return null;
  }
}

// Persist today's mood reading (idempotent on the date PK).
export async function recordMoodReading(): Promise<void> {
  const r = await getOrRefresh("finance:mood", 3_600, () => fetchMarketMood("us"));
  const m = r.data as { score: number; label: string; components: unknown };
  const date = utcMidnight();
  await prisma.marketMoodReading.upsert({
    where: { date },
    update: { score: m.score, label: m.label, components: m.components as object, asOf: new Date() },
    create: { date, market: "us", score: m.score, label: m.label, components: m.components as object },
  });
}

// Emit ONE falsifiable directional call from today's mood (idempotent: one per signal per day).
export async function emitDailyCalls(): Promise<{ emitted: number }> {
  await recordMoodReading();
  const r = await getOrRefresh("finance:mood", 3_600, () => fetchMarketMood("us"));
  const m = r.data as { score: number; label: string };
  const today = utcMidnight();
  const existing = await prisma.houseViewCall.findFirst({ where: { signalKey: SIGNAL, madeAt: { gte: today } } });
  if (existing) return { emitted: 0 };

  const sp = await spLevel();
  // Mood ≥ 55 (greed) = constructive/bullish lean; ≤ 45 (fear) = cautious/bearish; else neutral.
  const direction: "bullish" | "bearish" | "neutral" =
    m.score >= 55 ? "bullish" : m.score <= 45 ? "bearish" : "neutral";
  await prisma.houseViewCall.create({
    data: {
      signalKey: SIGNAL,
      market: "us",
      claim: `Market Mood at ${m.score}/100 (${m.label}) — a ${direction} lean for the S&P 500 over the next ${HORIZON_DAYS} days.`,
      direction,
      refValue: sp,
      refSymbol: "S&P 500",
      resolveAt: new Date(Date.now() + HORIZON_DAYS * DAY_MS),
    },
  });
  return { emitted: 1 };
}

// Grade open calls past their resolveAt: current S&P vs the frozen refValue. Mechanical, no LLM.
export async function resolveDueCalls(): Promise<{ resolved: number }> {
  const now = new Date();
  const due = await prisma.houseViewCall.findMany({ where: { status: "open", resolveAt: { lte: now } } });
  if (due.length === 0) return { resolved: 0 };
  const sp = await spLevel();
  let resolved = 0;
  for (const call of due) {
    if (sp == null || call.refValue == null) continue; // can't grade without both legs
    const change = sp - call.refValue;
    const movedPct = (Math.abs(change) / call.refValue) * 100;
    const up = change > 0;
    const correct =
      call.direction === "bullish" ? up : call.direction === "bearish" ? !up : movedPct < 1; // neutral = "no big move"
    await prisma.houseViewCall.update({
      where: { id: call.id },
      data: {
        status: "resolved",
        outcomeValue: sp,
        correct,
        resolvedAt: now,
        notes: `S&P ${call.refValue.toFixed(0)} → ${sp.toFixed(0)} (${change >= 0 ? "+" : ""}${movedPct.toFixed(1)}%)`,
      },
    });
    resolved++;
  }
  return { resolved };
}

export type ScorecardCall = {
  id: string;
  claim: string;
  direction: string;
  status: string;
  correct: boolean | null;
  madeAt: string;
  resolveAt: string;
  resolvedAt: string | null;
  notes: string | null;
};
export type ScorecardPayload = {
  signalKey: string;
  summary: { total: number; resolved: number; correct: number; hitRate: number | null; open: number };
  calls: ScorecardCall[];
  moodHistory: { date: string; score: number; label: string }[];
};

export async function getScorecard(): Promise<ScorecardPayload> {
  const calls = await prisma.houseViewCall.findMany({ where: { signalKey: SIGNAL }, orderBy: { madeAt: "desc" }, take: 50 });
  const resolved = calls.filter((c) => c.status === "resolved");
  const correct = resolved.filter((c) => c.correct === true).length;
  const mood = await prisma.marketMoodReading.findMany({ orderBy: { date: "desc" }, take: 30 });

  return {
    signalKey: SIGNAL,
    summary: {
      total: calls.length,
      resolved: resolved.length,
      correct,
      hitRate: resolved.length ? Math.round((correct / resolved.length) * 100) : null,
      open: calls.filter((c) => c.status === "open").length,
    },
    calls: calls.map((c) => ({
      id: c.id,
      claim: c.claim,
      direction: c.direction,
      status: c.status,
      correct: c.correct,
      madeAt: c.madeAt.toISOString(),
      resolveAt: c.resolveAt.toISOString(),
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      notes: c.notes,
    })),
    moodHistory: mood
      .map((m) => ({ date: m.date.toISOString().slice(0, 10), score: m.score, label: m.label }))
      .reverse(),
  };
}
