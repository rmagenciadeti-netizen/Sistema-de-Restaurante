import type { NextConfig } from 'next';

const apiTarget = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000/api/v1').replace(/\/$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_RM_APP: 'admin' },
  async rewrites() {
    return [{ source: '/api-proxy/:path*', destination: `${apiTarget}/:path*` }];
  },
};

export default nextConfig;
