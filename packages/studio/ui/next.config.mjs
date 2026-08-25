/** @type {import('next').NextConfig} */
export default {
  output: 'export',
  // Served by the studio's own node server from dist/server/app; relative
  // asset paths keep it host-agnostic on loopback.
  trailingSlash: true,
  // The monorepo standardizes on TypeScript 7, whose native compiler lacks
  // the API this Next version type-checks through. `npm run lint` runs the
  // real tsc over ui/ instead.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
