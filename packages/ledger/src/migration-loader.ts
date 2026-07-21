import { readFile } from 'node:fs/promises';

export const MIGRATION_NAMES = ['001_init.sql', '002_subscription_failures.sql'] as const;

export const loadMigrationSql = async (name: string): Promise<string> =>
  readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
