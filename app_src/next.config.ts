import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  outputFileTracingIncludes: {
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
