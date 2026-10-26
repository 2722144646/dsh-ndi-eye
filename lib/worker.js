// NDI receive worker.
//
// The NDI receiver lives on this thread because `recv_capture` blocks until a
// frame arrives (or its slice expires); doing that on the host thread would
// stall the whole harness.
//
// Two rules shape this file:
//   · NEVER block the worker's message queue. The receive loop pumps one short
//     capture slice and then yields, so a `snapshot` command sent while a feed
//     is running is serviced within about one slice.
//   · Keep the newest frame only. A camera feed is a live view, not a queue;
//     a slow caller should get a fresher frame, not an older one.

import { parentPort, workerData } from 'node:worker_threads'
import { deflateSync } from 'node:zlib'
import { createNdiBinding, encodePng, toRgb } from './ndi.js'

/** Longest a single capture slice may block before the loop yields. */
const CAPTURE_SLICE_MS = 250

/** Rolling window used to estimate the delivered frame rate (≥1s at 60fps). */
const FPS_WINDOW = 90

const state = {
  /** @type {ReturnType<typeof createNdiBinding> | null} */
  binding: null,
  /** @type {unknown} */
  receiver: null,
  source: null,
  /** @type {{rgb: Buffer, width: number, height: number, rate: number|null, fourcc: string, at: number} | null} */
  latest: null,
  frames: 0,
  lastError: null,
  connectionError: null,
  connectedAt: null,
  running: false,
  recent: /** @type {number[]} */ ([]),
  /** Previous emitted RGB buffer, for the "what changed" ratio. @type {Buffer | null} */
  previous: null,
  /** @type {Map<string, {deadline: number, maxWidth: number}>} */
  pending: new Map(),
}

function post(message) {
  parentPort?.postMessage(message)
}

/** Decode the frame currently in the binding's frame buffer into `state.latest`. */
function storeFrame(frame) {
  try {
    const pixels = state.binding.readPixels(frame)
    const { rgb, width, height, converted } = toRgb(pixels, frame)
    const now = Date.now()
    state.recent.push(now)
    if (state.recent.length > FPS_WINDOW) state.recent.shift()
    // Only claim a rate once the window spans real time: two frames 2ms apart
    // would otherwise report a meaningless 500 fps.
    const span = (state.recent[state.recent.length - 1] - state.recent[0]) / 1000
    // Span at least a second: a shorter window still contains the connection's
    // ramp-up and reads low (21.5 fps for a 30 fps source).
    const enough = state.recent.length >= 8 && span >= 1.0
    state.latest = {
      rgb,
      width,
      height,
      // Require a real window before claiming a rate. Two frames 2ms apart
      // would otherwise read as 500 fps, and a reading taken while the
      // connection is still ramping up understates the source (measured: a
      // 30 fps source read 21.5 fps in the first second, 30.0 fps after).
      rate: enough ? Math.round(((state.recent.length - 1) / span) * 10) / 10 : null,
      declaredRate: frame.fpsNumerator > 0 && frame.fpsDenominator > 0
        ? Math.round((frame.fpsNumerator / frame.fpsDenominator) * 100) / 100
        : null,
      fourcc: converted,
      at: now,
    }
    state.frames += 1
    state.lastError = null
    return true
  } catch (error) {
    // A conversion failure means the pixel format changed under us. Drop the
    // frame rather than surface half-converted pixels.
    state.lastError = error instanceof Error ? error.message : String(error)
    return false
  }
}

/** Nearest-neighbour downscale; the harness downscales again anyway. */
function downscale(rgb, width, height, maxWidth) {
  if (!(maxWidth > 0) || width <= maxWidth) return { rgb, width, height }
  const scale = maxWidth / width
  const outWidth = Math.max(1, Math.round(width * scale))
  const outHeight = Math.max(1, Math.round(height * scale))
  const out = Buffer.alloc(outWidth * outHeight * 3)
  for (let y = 0; y < outHeight; y++) {
    const srcY = Math.min(height - 1, Math.floor((y / outHeight) * height))
    let dst = y * outWidth * 3
    let src = srcY * width * 3
    for (let x = 0; x < outWidth; x++) {
      const srcX = Math.min(width - 1, Math.floor((x / outWidth) * width))
      const offset = src + srcX * 3
      out[dst] = rgb[offset]
      out[dst + 1] = rgb[offset + 1]
      out[dst + 2] = rgb[offset + 2]
      dst += 3
    }
  }
  return { rgb: out, width: outWidth, height: outHeight }
}

/** Encode the newest frame as a PNG. */
function snapshotNow(maxWidth) {
  const latest = state.latest
  if (latest === null) return null
  const scaled = downscale(latest.rgb, latest.width, latest.height, maxWidth)
  // Compare against the previously emitted snapshot, not the previous frame:
  // a burst asks "what changed since the last picture you were given".
  const change = state.previous === null ? 1 : changeRatio(state.previous, scaled.rgb)
  state.previous = scaled.rgb
  return {
    png: encodePng(scaled.width, scaled.height, scaled.rgb, { deflateSync }),
    width: scaled.width,
    height: scaled.height,
    originalWidth: latest.width,
    originalHeight: latest.height,
    source: state.source,
    fourcc: latest.fourcc,
    fps: latest.rate,
    ageMs: Date.now() - latest.at,
    change,
  }
}

/**
 * Fraction of sampled pixels that differ between two RGB buffers.
 *
 * Sampled rather than exhaustive: this only decides "did anything move", and a
 * sparse stride is enough while staying cheap on 720p buffers.
 */
function changeRatio(a, b) {
  if (a === null || b === null || a.length !== b.length || a.length === 0) return 1
  const stride = Math.max(3, Math.floor(a.length / 20000 / 3) * 3 || 3)
  let checked = 0
  let changed = 0
  for (let offset = 0; offset + 2 < a.length; offset += stride) {
    checked += 1
    if (
      Math.abs(a[offset] - b[offset]) > 12 ||
      Math.abs(a[offset + 1] - b[offset + 1]) > 12 ||
      Math.abs(a[offset + 2] - b[offset + 2]) > 12
    ) {
      changed += 1
    }
  }
  return checked === 0 ? 0 : Math.round((changed / checked) * 10000) / 10000
}

/** Serve every queued snapshot request that can now be answered. */
function servicePending() {
  for (const [id, request] of state.pending) {
    const shot = snapshotNow(request.maxWidth)
    if (shot !== null) {
      state.pending.delete(id)
      post({ id, type: 'result', ok: true, value: shot })
    } else if (Date.now() > request.deadline || !state.running) {
      state.pending.delete(id)
      post({
        id,
        type: 'result',
        ok: false,
        error: state.connectionError !== null
          ? state.connectionError
          : `no video frame received within the timeout (frames so far: ${state.frames})`,
      })
    }
  }
}

/** One capture slice, then yield so messages can be handled. */
function pump() {
  if (!state.running || state.receiver === null) return
  if (state.pending.size > 0) servicePending()
  let frame = null
  try {
    frame = state.binding.waitFrame(state.receiver, CAPTURE_SLICE_MS)
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
    post({ type: 'error', message: state.lastError })
    stopReceiving()
    servicePending()
    return
  }
  if (frame !== null) {
    storeFrame(frame)
    try { state.binding.freeFrame(state.receiver) } catch { /* ignore */ }
  }
  servicePending()
  if (state.running) setImmediate(pump)
}

/** Tear down the receiver but keep the runtime (and the worker) alive. */
function stopReceiving() {
  state.running = false
  if (state.receiver !== null) {
    try { state.binding.close(state.receiver) } catch { /* ignore */ }
    state.receiver = null
  }
  state.latest = null
  state.recent = []
  state.previous = null
}

/** Connect to `source` and begin receiving. */
function connect(source) {
  // Reuse a healthy connection to the same source. Without this, every capture
  // pays NDI's 2–4 s first-frame stall again even though nothing changed.
  if (state.receiver !== null && state.running && state.source === source && state.latest !== null) {
    return { reused: true }
  }
  stopReceiving()
  state.frames = 0
  state.lastError = null
  state.connectionError = null
  state.source = source
  try {
    state.receiver = state.binding.open(source)
  } catch (error) {
    state.connectionError = error instanceof Error ? error.message : String(error)
    return { reused: false, ok: false }
  }
  state.running = true
  state.connectedAt = Date.now()
  setImmediate(pump)
  return { reused: false, ok: true }
}

/**
 * Warm up the connection until the first frame actually arrives.
 *
 * Measured on NDI 6.3.2: a freshly created receiver delivers nothing for 2–4
 * seconds, then settles into the source's native rate. Reporting "connected"
 * before that makes every first capture wait out that stall and makes the
 * plugin look slow, so the connection is only considered ready once real
 * pixels have landed or the deadline passes.
 *
 * This yields between checks: the receive loop advances through setImmediate,
 * so a synchronous wait here would deadlock against the very frames it waits
 * for.
 *
 * @param {number} timeoutMs
 * @returns {Promise<{ ready: boolean, waitedMs: number, error: string | null }>}
 */
async function warmup(timeoutMs) {
  const started = Date.now()
  const deadline = started + Math.max(0, Math.min(30000, timeoutMs))
  while (state.latest === null && Date.now() < deadline) {
    if (!state.running || state.receiver === null) {
      return {
        ready: false,
        waitedMs: Date.now() - started,
        error: state.connectionError ?? state.lastError ?? 'the receiver stopped before any frame arrived',
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  const waitedMs = Date.now() - started
  const ready = state.latest !== null
  return {
    ready,
    waitedMs,
    error: ready
      ? null
      : state.lastError ??
        `no frame arrived within ${waitedMs}ms of connecting (the source may be idle, paused or gone)`,
  }
}

/* -------------------------------------------------------------------------- */
/* Message handling                                                            */
/* -------------------------------------------------------------------------- */

parentPort?.on('message', async (message) => {
  const { id, command } = message ?? {}
  try {
    switch (command) {
      case 'connect': {
        const outcome = connect(message.source)
        if (outcome.ok === false) {
          post({ id, type: 'result', ok: false, error: state.connectionError })
          break
        }
        // Report ready only once pixels have actually arrived — see warmup().
        // A reused connection is already delivering, so this returns at once.
        const warmed = await warmup(message.warmupMs ?? 12000)
        post({
          id,
          type: 'result',
          ok: warmed.ready,
          error: warmed.error ?? undefined,
          value: warmed.ready
            ? {
                source: message.source,
                reused: outcome.reused,
                waitedMs: warmed.waitedMs,
                width: state.latest.width,
                height: state.latest.height,
                fps: state.latest.rate,
                declaredFps: state.latest.declaredRate,
              }
            : undefined,
        })
        break
      }
      case 'snapshot': {
        // Answer immediately when a frame is already held; otherwise queue the
        // request and let the pump satisfy it as soon as video arrives.
        const immediate = snapshotNow(message.maxWidth)
        if (immediate !== null) {
          post({ id, type: 'result', ok: true, value: immediate })
          break
        }
        if (state.receiver === null) {
          post({
            id,
            type: 'result',
            ok: false,
            error: state.connectionError ?? 'no NDI source is connected',
          })
          break
        }
        state.pending.set(id, {
          maxWidth: message.maxWidth,
          deadline: Date.now() + Math.max(1, Math.min(30000, message.waitMs ?? 4000)),
        })
        if (!state.running) {
          state.running = true
          setImmediate(pump)
        }
        break
      }
      case 'discover': {
        // Discovery must happen on THIS thread. NDI's runtime is process-wide,
        // so a second binding on the host thread that later calls
        // NDIlib_destroy() would tear down the runtime this worker is actively
        // receiving on — observed as an access violation at shutdown.
        const found = state.binding.discover(message.timeoutMs ?? 2500)
        post({
          id,
          type: 'result',
          ok: true,
          value: { sources: found, version: state.binding.version() },
        })
        break
      }
      case 'status': {
        post({
          id,
          type: 'result',
          ok: true,
          value: {
            connected: state.receiver !== null,
            source: state.source,
            frames: state.frames,
            latest: state.latest === null ? null : {
              width: state.latest.width,
              height: state.latest.height,
              fps: state.latest.rate,
              ageMs: Date.now() - state.latest.at,
              fourcc: state.latest.fourcc,
            },
            lastError: state.lastError,
            connectedForMs: state.connectedAt === null ? 0 : Date.now() - state.connectedAt,
          },
        })
        break
      }
      case 'disconnect': {
        stopReceiving()
        post({ id, type: 'result', ok: true })
        break
      }
      case 'quit': {
        stopReceiving()
        try { state.binding.stop() } catch { /* ignore */ }
        post({ id, type: 'result', ok: true })
        setImmediate(() => process.exit(0))
        break
      }
      default:
        throw new Error(`unknown command "${command}"`)
    }
  } catch (error) {
    post({ id, type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

try {
  state.binding = createNdiBinding(workerData.libraryPath)
  if (!state.binding.start()) throw new Error('NDIlib_initialize returned false')
  post({ type: 'ready', version: state.binding.version() })
} catch (error) {
  post({ type: 'boot-failed', error: error instanceof Error ? error.message : String(error) })
}
