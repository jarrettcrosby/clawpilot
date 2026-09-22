import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Next's CLI type checker includes test fixtures that its older worker skipped.
  // Keep strict application checks separate from independently executed test suites.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  outputFileTracingIncludes: {
    '/api/settings/architecture': ['./server-assets/architecture/manifest.json'],
    '/api/settings/architecture/viewer': ['./server-assets/architecture/viewer.html', './server-assets/architecture/manifest.json'],
    '/api/docs': [
      '../docs/**/*.md',
      '../README.md',
      '../CONTRIBUTING.md',
      '../PRODUCT_REQUIREMENTS.md',
      '../REQUIREMENTS_TRACEABILITY.md',
      '../USER_GUIDE.md',
      '../SPEC.md',
      '../AGENT_MEMORY.md',
    ],
  },
  allowedDevOrigins: [
    '192.168.4.48',
    '192.168.4.*',
    'localhost',
    '127.0.0.1',
  ],
  devIndicators: false,

  // Prevent iOS Safari from getting stuck on stale HTML that references old chunk hashes.
  async headers() {
    return [
      {
        source: '/((?!_next/static|api/public/crm-product-images/).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ]
  },
};

export default nextConfig;
