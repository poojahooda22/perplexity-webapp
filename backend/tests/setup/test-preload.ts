// Preload (runs once, before any test file). Two jobs:
//   1. Deterministic env so modules that read env don't throw or hit real services.
//   2. mock.module-replace the seams that throw / do I/O without creds: Prisma (db.ts) and the
//      Supabase admin client (client.ts). Bun runs all tests in ONE process and import statements
//      hoist, so module mocks MUST be registered here (preload) — not in a test file body.
import { mock } from "bun:test";

import { prismaFake } from "../helpers/prisma-fake";
import { createSupabaseClient } from "../helpers/supabase-fake";

// 32-byte (AES-256) key, base64 — connectors/crypto.ts validates the length.
process.env.GMAIL_TOKEN_ENC_KEY ||= Buffer.from(new Uint8Array(32)).toString("base64");
process.env.SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
process.env.TAVILY_API_KEY ||= "test-tavily-key";
process.env.AI_GATEWAY_API_KEY ||= "test-gateway-key";

// Replace the real Prisma client + Supabase factory process-wide. Tests drive them via the
// fakes' exported setters/mocks. Anything importing './db.js' or './client.js' gets these.
mock.module("../../db.ts", () => ({ prisma: prismaFake }));
mock.module("../../client.ts", () => ({ createSupabaseClient }));
