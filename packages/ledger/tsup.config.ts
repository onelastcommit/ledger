import { cp, mkdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  platform: 'node',
  external: ['pg'],
  async onSuccess() {
    await mkdir('dist/migrations', { recursive: true });
    await cp('src/migrations', 'dist/migrations', { recursive: true });
  },
});
