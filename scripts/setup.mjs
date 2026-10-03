#!/usr/bin/env node
// Creates or completes .env from .env.example and generates local secrets.
// Existing values are never overwritten, so it is safe to re-run.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const EXAMPLE = '.env.example';
const TARGET = '.env';
const GENERATED = {
  AUTH_SECRET: () => randomBytes(32).toString('base64'),
  ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  WHATSAPP_VERIFY_TOKEN: () => randomBytes(16).toString('hex'),
};

const parse = (text) =>
  new Map(
    text
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.trim()]),
  );

const example = readFileSync(EXAMPLE, 'utf8');
const existingText = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
const existing = parse(existingText);

const additions = [];
const filled = [];
for (const [key, exampleValue] of parse(example)) {
  const current = existing.get(key);
  if (current === undefined) {
    const value = !exampleValue && GENERATED[key] ? GENERATED[key]() : exampleValue;
    additions.push(`${key}=${value}`);
  } else if (!current && GENERATED[key]) {
    filled.push(key);
  }
}

let output = existingText;
for (const key of filled) {
  output = output.replace(new RegExp(`^(\\s*${key}\\s*=)\\s*$`, 'm'), `$1${GENERATED[key]()}`);
}
if (additions.length) {
  output = (output && !output.endsWith('\n') ? output + '\n' : output) +
    (existingText ? '\n# Added by npm run setup\n' : '') +
    additions.join('\n') + '\n';
}

writeFileSync(TARGET, output);
console.log(
  existingText
    ? `Updated ${TARGET}: ${additions.length} key(s) added, ${filled.length} secret(s) generated.`
    : `Created ${TARGET} from ${EXAMPLE} with generated secrets.`,
);
console.log('Next: docker compose up -d && npx prisma migrate dev && npm run db:seed && npm run dev');
