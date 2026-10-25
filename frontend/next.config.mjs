/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone', // small production image for the frontend container
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
