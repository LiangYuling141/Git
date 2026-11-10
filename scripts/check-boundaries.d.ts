export type BoundaryRule = 'forbidden-import' | 'relative-escape';

export interface BoundaryViolation {
  file: string;
  specifier: string;
  rule: BoundaryRule;
  message: string;
}

export interface PackageBoundary {
  root: string;
  scanDir: string;
  forbidden: Array<{ prefix: string; message: string }>;
}

export interface BoundaryScanResult {
  fileCount: number;
  violations: BoundaryViolation[];
}

export const PACKAGES: PackageBoundary[];

export function extractSpecifiers(source: string): string[];

export function checkSource(filePath: string, source: string): BoundaryViolation[];

export function scanPackages(): BoundaryScanResult;

export function main(): number;
