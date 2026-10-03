import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL ?? '';
  // globalSetup runs in this process, not in the per-project env.
  if (testDatabaseUrl) process.env.TEST_DATABASE_URL = testDatabaseUrl;

  const sharedEnv = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    REDIS_URL: '',
  };

  return {
    plugins: [tsconfigPaths()],
    resolve: {
      // `server-only` throws outside React Server Components; tests run server code directly.
      alias: { 'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)) },
    },
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['tests/unit/**/*.test.ts'],
            environment: 'node',
            env: { ...sharedEnv, DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused' },
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['tests/integration/**/*.test.ts'],
            environment: 'node',
            env: {
              ...sharedEnv,
              DATABASE_URL: testDatabaseUrl,
              TEST_DATABASE_URL: testDatabaseUrl,
              APP_URL: 'http://localhost:3000',
              // Real S3-compatible storage from docker compose (uploads are tested end to end).
              S3_ENDPOINT: fileEnv.S3_ENDPOINT ?? '',
              S3_REGION: fileEnv.S3_REGION ?? 'us-east-1',
              S3_ACCESS_KEY: fileEnv.S3_ACCESS_KEY ?? '',
              S3_SECRET_KEY: fileEnv.S3_SECRET_KEY ?? '',
              S3_BUCKET: 'omniai-test',
              S3_FORCE_PATH_STYLE: 'true',
            },
            globalSetup: ['tests/integration/global-setup.ts'],
            // Files share one database and truncate it, so they must run one at a time.
            fileParallelism: false,
            pool: 'forks',
            poolOptions: { forks: { singleFork: true } },
            testTimeout: 30_000,
            hookTimeout: 60_000,
          },
        },
      ],
    },
  };
});
