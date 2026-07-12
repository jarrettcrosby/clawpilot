import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        source: '/((?!_next/static).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ]
  },
};

export default nextConfig;
