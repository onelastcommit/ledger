import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string | null;
  }
}

const SKIP_NOTICE = `
  ────────────────────────────────────────────────────────────────────────────
  Integration tests skipped: no PostgreSQL available.

  Either start Docker (testcontainers will provision postgres:16 for you), or
  point the suite at an existing database:

      DATABASE_URL=postgres://user:pass@localhost:5432/ledger_test pnpm test:integration

  The target database is TRUNCATEd between tests, so do not aim this at
  anything you care about.
  ────────────────────────────────────────────────────────────────────────────
`;

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const fromEnv = process.env['DATABASE_URL'];
  if (fromEnv !== undefined && fromEnv !== '') {
    provide('databaseUrl', fromEnv);
    return async () => undefined;
  }

  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    provide('databaseUrl', container.getConnectionUri());
    return async () => {
      await container.stop();
    };
  } catch (error) {
    console.warn(SKIP_NOTICE);
    console.warn(`  Reason: ${error instanceof Error ? error.message : String(error)}\n`);
    provide('databaseUrl', null);
    return async () => undefined;
  }
}
