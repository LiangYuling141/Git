import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // workspace 包直接以 TypeScript 源码被应用引用，Next 需要转译它们。
  transpilePackages: [
    '@lymatrix/tef-core',
    '@lymatrix/tef-mcp-kit',
    '@lymatrix/tef-runtime',
    '@lymatrix/vertical-crm-erp',
  ],
};

export default nextConfig;
