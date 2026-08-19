/**
 * Persistent NDJSON log of every Meta CAPI fire attempt — the exact
 * request body sent to Meta plus the outcome. This exists because the
 * capi_events audit table stores only components (event_name, value,
 * currency…), not the payload itself; when Meta-side matching breaks,
 * this file is the ground truth of what we actually sent.
 *
 * Destination: CAPI_LOG_PATH env var, default ./logs/capi.log. In the
 * Docker deploy ./logs is a bind mount so the file survives rebuilds.
 * Writes are synchronous — fires are human-triggered and rare, so
 * durability beats throughput here.
 *
 * The access token travels in the Authorization header, never in the
 * body, so entries are token-free by construction. Logging must never
 * break a fire: any logger failure degrades to console.error.
 */

import pino from 'pino'

export interface CapiLogEntry {
  datasetId: string
  url: string
  /** Exact JSON body sent to Meta. */
  body: Record<string, unknown>
  outcome: 'success' | 'failed'
  /** Absent when the request itself failed (network error). */
  httpStatus?: number
  /** Meta or network error message when outcome is 'failed'. */
  error?: string
}

let logger: pino.Logger | null | undefined
let destination: ReturnType<typeof pino.destination> | undefined

function getLogger(): pino.Logger | null {
  if (logger !== undefined) return logger
  try {
    const dest = process.env.CAPI_LOG_PATH ?? './logs/capi.log'
    destination = pino.destination({ dest, mkdir: true, sync: true })
    logger = pino({ base: undefined }, destination)
  } catch (err) {
    console.error('[capi] payload logger init failed:', err)
    logger = null
  }
  return logger
}

export function logCapiAttempt(entry: CapiLogEntry): void {
  try {
    getLogger()?.info(entry)
  } catch (err) {
    console.error('[capi] payload log write failed:', err)
  }
}

/** Flush and release the file handle (tests, graceful shutdown). */
export async function closeCapiLogger(): Promise<void> {
  const dest = destination
  destination = undefined
  logger = undefined
  if (!dest) return
  try {
    dest.flushSync()
    await new Promise<void>((resolve) => {
      dest.on('close', resolve)
      dest.end()
    })
  } catch {
    // nothing to release
  }
}
