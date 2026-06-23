-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('bullish', 'bearish', 'neutral');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('open', 'resolved', 'void');

-- CreateTable
CREATE TABLE "market_mood_reading" (
    "date" DATE NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'us',
    "score" DOUBLE PRECISION NOT NULL,
    "label" TEXT NOT NULL,
    "components" JSONB,
    "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_mood_reading_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "house_view_call" (
    "id" TEXT NOT NULL,
    "signal_key" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'us',
    "claim" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL DEFAULT 'neutral',
    "ref_value" DOUBLE PRECISION,
    "ref_symbol" TEXT,
    "madeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolve_at" TIMESTAMP(3) NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'open',
    "outcome_value" DOUBLE PRECISION,
    "correct" BOOLEAN,
    "resolvedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "house_view_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "house_view_call_signal_key_market_status_idx" ON "house_view_call"("signal_key", "market", "status");

-- CreateIndex
CREATE INDEX "house_view_call_resolve_at_status_idx" ON "house_view_call"("resolve_at", "status");

-- CreateIndex
CREATE INDEX "house_view_call_madeAt_idx" ON "house_view_call"("madeAt");

