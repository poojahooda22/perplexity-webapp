import { mock } from "bun:test";

// A controllable fake of the Prisma client. Each method is a Bun mock: set behavior per test
// with `.mockResolvedValue(...)` / `.mockResolvedValueOnce(...)`, assert via `.mock.calls`.
// Call resetPrisma() in beforeEach to clear state between tests (Bun shares one process).
const fn = () => mock(async (..._args: unknown[]) => undefined as unknown);

export const prismaFake = {
  user: { upsert: fn() },
  conversation: {
    findMany: fn(),
    findFirst: fn(),
    create: fn(),
    updateMany: fn(),
    delete: fn(),
  },
  message: { create: fn(), deleteMany: fn() },
  // Finance scorecard ("Track Record") models — falsifiable house-view calls + daily mood readings.
  houseViewCall: { findMany: fn(), findFirst: fn(), create: fn(), update: fn() },
  marketMoodReading: { findMany: fn(), upsert: fn() },
  $transaction: mock(async (ops: unknown) => (Array.isArray(ops) ? ops : ops)),
  $queryRaw: fn(),
  $executeRaw: fn(),
};

export function resetPrisma() {
  const all = [
    prismaFake.user.upsert,
    ...Object.values(prismaFake.conversation),
    ...Object.values(prismaFake.message),
    ...Object.values(prismaFake.houseViewCall),
    ...Object.values(prismaFake.marketMoodReading),
    prismaFake.$transaction,
    prismaFake.$queryRaw,
    prismaFake.$executeRaw,
  ];
  for (const m of all) (m as ReturnType<typeof mock>).mockReset();
}