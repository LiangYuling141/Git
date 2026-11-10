import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // workspace 包直接以 TypeScript 源码被应用引用，Next 需要转译它们。
  transpilePackages: [
    '@lymtrix/tef-core',
    '@lymtrix/tef-mcp-kit',
    '@lymtrix/tef-runtime',
    '@lymtrix/vertical-crm-erp',
  ],
};

export default nextConfig;
