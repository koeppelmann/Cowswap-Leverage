/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lint separately (npm run lint); don't fail the production build on lint. TS is still enforced.
  eslint: { ignoreDuringBuilds: true },
  // better-sqlite3 is a native module — don't bundle it into the server build.
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
};
export default nextConfig;
