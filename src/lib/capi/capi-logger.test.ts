import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'capi-logger-'));
  vi.resetModules();
});

afterEach(async () => {
  const { closeCapiLogger } = await import('./capi-logger');
  await closeCapiLogger();
  delete process.env.CAPI_LOG_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('logCapiAttempt', () => {
  it('appends one NDJSON line per attempt to CAPI_LOG_PATH, creating the directory', async () => {
    const logPath = join(tempDir, 'nested', 'capi.log');
    process.env.CAPI_LOG_PATH = logPath;
    const { logCapiAttempt } = await import('./capi-logger');

    logCapiAttempt({
      datasetId: 'ds-1',
      url: 'https://graph.facebook.com/v21.0/ds-1/events',
      body: { data: [{ event_id: 'event-1' }] },
      outcome: 'success',
      httpStatus: 200,
    });
    logCapiAttempt({
      datasetId: 'ds-1',
      url: 'https://graph.facebook.com/v21.0/ds-1/events',
      body: { data: [{ event_id: 'event-2' }] },
      outcome: 'failed',
      httpStatus: 401,
      error: 'Invalid OAuth access token',
    });

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.datasetId).toBe('ds-1');
    expect(first.outcome).toBe('success');
    expect(first.httpStatus).toBe(200);
    expect(first.body).toEqual({ data: [{ event_id: 'event-1' }] });
    expect(first.time).toBeDefined();

    const second = JSON.parse(lines[1]);
    expect(second.outcome).toBe('failed');
    expect(second.error).toBe('Invalid OAuth access token');
  });

  it('never throws when the destination is unwritable', async () => {
    // A path that cannot be created as a directory (parent is a file).
    process.env.CAPI_LOG_PATH = join(__filename, 'impossible', 'capi.log');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { logCapiAttempt } = await import('./capi-logger');

    expect(() =>
      logCapiAttempt({
        datasetId: 'ds-1',
        url: 'https://example.com',
        body: {},
        outcome: 'success',
        httpStatus: 200,
      })
    ).not.toThrow();

    consoleError.mockRestore();
  });
});
