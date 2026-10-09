/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Skip the image optimiser (needs extra native libraries in the container); our logos are already small.
  images: { unoptimized: true },
  // In production Caddy sends /api/* straight to the API container.
  // This rewrite only matters for local development (web on :3000, API on :4000).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/api/:path*` }];
  },
};
export default nextConfig;
