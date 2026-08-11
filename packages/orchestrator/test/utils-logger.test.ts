import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, createLogger } from '../src/observability/logger.js';

// Mock context module
vi.mock('../src/utils/context.js', () => ({
  getCurrentContext: vi.fn(() => ({})),
}));

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.LOG_LEVEL;
  });

  // ─── Level filtering ──────────────────────────────────────────────

  it('filters debug when min level is info', () => {
    const logger = new Logger('test', { level: 'info' });
    logger.debug('ignored');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('allows info when min level is info', () => {
    const logger = new Logger('test', { level: 'info' });
    logger.info('allowed');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it('allows warn when min level is info', () => {
    const logger = new Logger('test', { level: 'info' });
    logger.warn('warning');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('filters info when min level is warn', () => {
    const logger = new Logger('test', { level: 'warn' });
    logger.info('ignored');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('allows error when min level is error', () => {
    const logger = new Logger('test', { level: 'error' });
    logger.error('failure');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('reads LOG_LEVEL from environment', () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = new Logger('test');
    logger.info('should be filtered');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // ─── Output routing ───────────────────────────────────────────────

  it('writes debug to stdout', () => {
    const logger = new Logger('test', { level: 'debug' });
    logger.debug('message');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes info to stdout', () => {
    const logger = new Logger('test', { level: 'info' });
    logger.info('message');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes warn to stderr', () => {
    const logger = new Logger('test', { level: 'info' });
    logger.warn('message');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('writes error to stderr', () => {
    const logger = new Logger('test', { level: 'info' });
    logger.error('message');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // ─── JSON structure ───────────────────────────────────────────────

  it('outputs valid JSON with correct fields', () => {
    const logger = new Logger('my.component', { level: 'info' });
    logger.info('test_event', { key: 'value' });

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.timestamp).toBeDefined();
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('my.component.test_event');
    expect(parsed.context.key).toBe('value');
  });

  it('omits context when empty', () => {
    vi.resetModules();
    const logger = new Logger('test', { level: 'info' });
    logger.info('no_ctx');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.context).toBeUndefined();
  });

  // ─── Error serialization ──────────────────────────────────────────

  it('serialises Error objects to { message, name, stack }', () => {
    const logger = new Logger('test', { level: 'error' });
    const err = new TypeError('bad input');
    logger.error('fail', err);

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.context.error.message).toBe('bad input');
    expect(parsed.context.error.name).toBe('TypeError');
    expect(parsed.context.error.stack).toBeDefined();
  });

  it('handles non-Error objects as error parameter', () => {
    const logger = new Logger('test', { level: 'error' });
    logger.error('fail', 'string error');

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.context.error.message).toBe('string error');
    expect(parsed.context.error.name).toBe('UnknownError');
  });

  it('omits error info when error param is undefined', () => {
    const logger = new Logger('test', { level: 'error' });
    logger.error('fail', undefined, { extra: 'data' });

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.context.error).toBeUndefined();
    expect(parsed.context.extra).toBe('data');
  });

  // ─── Child context ────────────────────────────────────────────────

  it('creates a child logger with merged default context', () => {
    const parent = new Logger('test', { level: 'info', context: { parent_key: 'a' } });
    const child = parent.child({ child_key: 'b' });

    child.info('event');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.context.parent_key).toBe('a');
    expect(parsed.context.child_key).toBe('b');
  });

  it('child context overrides parent on conflict', () => {
    const parent = new Logger('test', { level: 'info', context: { key: 'parent' } });
    const child = parent.child({ key: 'child' });

    child.info('event');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.context.key).toBe('child');
  });
});

describe('createLogger', () => {
  it('returns a Logger instance', () => {
    const logger = createLogger('test.component');
    expect(logger).toBeInstanceOf(Logger);
  });

  it('accepts optional default context', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const logger = createLogger('test', { req_id: '123' });
    logger.info('event');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.context.req_id).toBe('123');

    stdoutSpy.mockRestore();
  });
});
