import { contentSecurityPolicy } from './src/security/csp.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Phase 20 Checkpoint 2: the production image used to copy the whole
  // monorepo `node_modules`, so vitest, testing-library, eslint and the Prisma
  // CLI all shipped in the public web image. Standalone output traces exactly
  // the modules the built server actually imports and writes them beside it,
  // so the runtime stage copies one directory and a devDependency cannot get
  // in by being installed.
  output: 'standalone',
  // The trace has to start at the workspace root: the app imports
  // @palcert/contracts and @palcert/config from there, and tracing from
  // apps/web alone would miss them.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  poweredByHeader: false,
  transpilePackages: ['@palcert/contracts', '@palcert/config'],
  async headers() {
    // Security baseline for the browser surface (§38).
    //
    // Including the Content-Security-Policy, which Checkpoint 20.1 raised as
    // missing entirely (F-007). It is a constant, derived in
    // `src/security/csp.mjs` from what this application actually loads — the
    // note there explains why it carries no nonce and what that costs.
    // Declaring it here rather than in middleware means it also covers the
    // paths the middleware matcher deliberately skips.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // Kept alongside `frame-ancestors 'none'` in the CSP, not replaced
          // by it: the CSP directive is the modern control, this is the one
          // older browsers obey, and they cost nothing together.
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          // Production only. On plain HTTP a browser ignores it, and in
          // development it would pin `localhost` to https in the developer's
          // own browser for a year (Phase 20 Checkpoint 7, finding F-007).
          ...(process.env.NODE_ENV === 'production'
            ? [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=31536000; includeSubDomains',
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
