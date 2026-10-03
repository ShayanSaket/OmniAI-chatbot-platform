/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === 'production';

// Baseline security headers. The embeddable widget (phase 2) is served from
// /widget/* with its own framing policy, so it is excluded from frame-ancestors 'none'.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }] : []),
];

const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  experimental: {
    // Loaded from node_modules at runtime instead of bundled (native/ESM-heavy parsers).
    serverComponentsExternalPackages: ['@prisma/client', 'bcryptjs', 'ioredis', 'unpdf', 'mammoth', 'linkedom', '@mozilla/readability'],
    // instrumentation.ts starts the background job scheduler.
    instrumentationHook: true,
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        source: '/((?!widget/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
