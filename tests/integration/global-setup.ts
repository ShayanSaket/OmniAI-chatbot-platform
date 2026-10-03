import { execSync } from 'node:child_process';

/** Applies migrations to the dedicated test database before integration tests run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the stack with `docker compose up -d` and copy it from .env.example.',
    );
  }
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to run integration tests against a non-test database: ${new URL(url).pathname}`);
  }
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });
}
