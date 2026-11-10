import { describe, expect, it } from 'vitest';
import { parseEvalOptions } from './cli-options';

describe('parseEvalOptions', () => {
  it('applies defaults and keeps allow-missing-db disabled', () => {
    const options = parseEvalOptions([]);
    expect(options.layerMode).toBe('all');
    expect(options.samples).toBe('packages/tef-eval/samples');
    expect(options.live).toBe(false);
    expect(options.allowMissingDb).toBe(false);
    expect(options.evalMode).toBe('deterministic');
  });

  it('accepts --allow-missing-db for an explicitly requested e2e layer', () => {
    const options = parseEvalOptions([
      '--mode',
      'e2e',
      '--recorded',
      'packages/tef-eval/recordings',
      '--allow-missing-db',
    ]);
    expect(options.layerMode).toBe('e2e');
    expect(options.evalMode).toBe('recorded');
    expect(options.allowMissingDb).toBe(true);
  });

  it('maps --live to live mode and --verbose to logging', () => {
    const options = parseEvalOptions(['--mode', 'offline', '--live', '--verbose']);
    expect(options.layerMode).toBe('offline');
    expect(options.evalMode).toBe('live');
    expect(options.verbose).toBe(true);
  });

  it('rejects invalid mode, unknown flags and live/recorded conflicts', () => {
    expect(() => parseEvalOptions(['--mode', 'bogus'])).toThrow(/invalid --mode/);
    expect(() => parseEvalOptions(['--nope'])).toThrow();
    expect(() => parseEvalOptions(['--live', '--recorded', 'dir'])).toThrow(
      /mutually exclusive/,
    );
  });
});
