/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@mvp/shared", "three"],
  webpack: (config) => {
    config.externals = config.externals ?? [];
    return config;
  },
};
export default nextConfig;
