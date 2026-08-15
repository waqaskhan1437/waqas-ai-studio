/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "https://waqas-ai-studio.waqaskhan1437.workers.dev/api/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
