// dsh-ndi-eye — NDI as an eye.
//
// What this gives the agent: a live frame from any NDI source on the network,
// committed through the harness attachment service and returned as an image
// block, exactly like a screenshot — but of a video feed instead of a screen.
//
// Why NDI and not screen capture: an NDI source is the *signal*, not the
// window. A Live2D/VTube Studio camera, an OBS program out, a capture card, or
// a machine across the LAN can be seen even when no window is visible, when the
// app is minimised, or when the thing you want to watch lives on another PC.
//
// Architecture (each piece exists because of a measured constraint):
//   · The receiver runs in a worker thread. `NDIlib_recv_capture_v2` blocks for
//     its full slice, so running it on the host thread would freeze the harness.
//   · koffi drives the DLL directly. Verified against NDI 6.3.2.0: find + recv
//     + BGRA frames all work; the frame struct needs frame_rate_N/D and
//     picture_aspect_ratio in place or every later field shifts.
//   · The worker keeps only the newest frame, so a caller always gets current
//     pixels rather than a stale queue entry.
//
// @module dsh-ndi-eye

import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { createNdiBinding, encodePng, isPng, libraryHint, locateLibrary, rankSource } from './ndi.js'

/** Cordis plugin name. */
export const name = 'ndi-eye'

/** Services this plugin needs; `attachments` is optional so the row still mounts without it. */
export const inject = ['tools', 'attachments', 'systemPrompt']

/** Prefix every tool with `ndi_` — the profile already mounts `screen_*` and `vtuber_*`. */
const TOOL_PREFIX = 'ndi'

/** How long a single-shot capture waits for video before giving up. */
const DEFAULT_WAIT_MS = 6000

/** Cap on frames returned by one burst call. */
const MAX_BURST_FRAMES = 8

/** Prompt guidance: what the eye sees and, critically, when to prefer it. */
const GUIDANCE = [
  '你有 NDI 眼睛：能看到任何 NDI 源（VTube Studio 的相机输出、OBS 节目画面、采集卡、局域网里另一台机器上的源）。',
  '· `ndi_sources`：列出当前所有 NDI 源，标出会自动选中的那个；先调它确认要看的源叫什么。',
  '· `ndi_see`：抓一帧 NDI 画面并送进视觉通道。不传 source 就用上次的源，再没有就自动挑最像 Live2D/相机的那个。',
  '· `ndi_watch`：在若干秒内采样多帧，只保留有变化的帧，用来判断「刚才发生了什么变化」（动画、动作、场景切换）。',
  '· `ndi_status`：报连接状态、帧数、实际帧率、最后的错误。抓不到帧时先用它诊断，别盲重试。',
  '',
  '**什么时候用 NDI 而不是 `screen_view`：**',
  '要看的画面本身是一个「源」时，优先用 NDI —— 皮套/Live2D 的相机画面、OBS 的节目输出、采集卡、另一台机器上的画面。',
  '因为这些画面常常没有独立的窗口，或者被别的窗口挡住、被最小化，截屏会拿到桌面或者一片黑；NDI 拿的是信号本身，不受这些影响。',
  '反过来，要读的是**你桌面上真实的界面**（某个软件的按钮在哪、报错弹窗写了什么），就用 `screen_view`。',
  '拿不准时先 `ndi_sources`：有源就看源，没源再退回去截屏。',
  '',
  '· 铁律：先看再判断。抓不到帧就说明一句（源没开/名字变了/网络没通），不要反复重试。',
].join('\n')

/** Render an image-bearing tool value as model-facing content blocks. */
function renderImageValue(value) {
  const scaled = value.originalWidth && value.originalWidth !== value.width
    ? ` (downscaled from ${value.originalWidth}×${value.originalHeight})`
    : ''
  const rate = value.fps ? `, ~${value.fps} fps` : ''
  return [
    {
      type: 'text',
      text:
        `<source>ndi://${value.source}</source>\n` +
        `<type>image</type>\n` +
        `<content>\n${value.mediaType} image, ${value.width}×${value.height} px, ${value.bytes} bytes${scaled}${rate}\n</content>`,
    },
    { type: 'image', attachment: value.attachment },
  ]
}

/** Shared schema fragment for the image value a see/watch call returns. */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['source', 'attachment'],
  properties: {
    source: { type: 'string' },
    mediaType: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    originalWidth: { type: 'integer' },
    originalHeight: { type: 'integer' },
    fps: { type: 'number' },
    fourcc: { type: 'string' },
    age_ms: { type: 'integer' },
    connect_ms: { type: 'integer' },
    attachment: {
      type: 'object',
      additionalProperties: true,
      required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
    },
  },
}

/**
 * Message queue over one NDI worker.
 *
 * One worker serves the whole plugin: discovery is cheap and stateless, and a
 * single receiver keeps the NDI connection count (and the SDK's thread budget)
 * predictable.
 */
 class NdiWorker {
  /**
   * @param {object} options
   * @param {string} options.libraryPath
   * @param {URL} options.workerUrl
   */
  constructor(options) {
    this.libraryPath = options.libraryPath
    this.workerUrl = options.workerUrl
    /** @type {Worker | null} */
    this.worker = null
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
    this.pending = new Map()
    this.counter = 0
    this.ready = null
    this.version = null
    this.bootError = null
    this.reportedError = null
  }

  /** Start the worker and wait until NDI initialises. */
  async start() {
    if (this.worker !== null) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const worker = new Worker(this.workerUrl, {
        workerData: { libraryPath: this.libraryPath },
      })
      this.worker = worker
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve({ version: this.version })
      }
      worker.on('message', (message) => {
        if (message?.type === 'ready') {
          this.version = message.version
          finish(null)
          return
        }
        if (message?.type === 'boot-failed') {
          this.bootError = message.error
          finish(new Error(`NDI worker could not initialise: ${message.error}`))
          return
        }
        if (message?.type === 'error') {
          this.reportedError = message.message
          return
        }
        if (typeof message?.id === 'string') this.#settle(message)
      })
      worker.on('error', (error) => {
        this.bootError = error instanceof Error ? error.message : String(error)
        finish(error)
        this.#failAll(this.bootError)
      })
      worker.on('exit', () => {
        this.worker = null
        this.#failAll('the NDI worker exited')
      })
    })
    return this.ready
  }

  /** Resolve or reject one queued request. */
  #settle(message) {
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok === true) entry.resolve(message.value)
    else entry.reject(new Error(message.error ?? 'NDI worker returned an error'))
  }

  /** Reject everything in flight (worker died). */
  #failAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
  }

  /**
   * Send one command and await its result.
   *
   * @param {string} command
   * @param {object} payload
   * @param {number} timeoutMs
   */
  request(command, payload, timeoutMs) {
    const worker = this.worker
    if (worker === null) return Promise.reject(new Error('the NDI worker is not running'))
    const id = `req-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`NDI worker did not answer "${command}" within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, command, ...payload })
    })
  }

  /**
   * Stop the worker and its NDI runtime.
   *
   * Order matters and is the difference between a clean exit and an access
   * violation: the worker must be told to release its receiver and call
   * NDIlib_destroy() *while it is still running*. Terminating a thread that is
   * inside NDIlib_recv_capture crashes the process (0xC0000005), so `quit` is
   * sent first and `terminate()` is only a fallback for a wedged worker.
   */
  async stop() {
    const worker = this.worker
    if (worker === null) {
      this.#failAll('the NDI worker was stopped')
      return
    }

    // Ask the worker to shut its own receiver down. Send the command directly
    // rather than through request(): request() refuses once `this.worker` is
    // cleared, which silently skipped the teardown and forced terminate().
    const id = `req-${++this.counter}`
    const quit = new Promise((resolve) => {
      const done = () => resolve()
      const timer = setTimeout(done, 3000)
      this.pending.set(id, {
        resolve: () => { clearTimeout(timer); done() },
        reject: () => { clearTimeout(timer); done() },
        timer: undefined,
      })
      worker.postMessage({ id, command: 'quit' })
    })

    await quit
    this.worker = null
    this.#failAll('the NDI worker was stopped')

    // The worker exits itself after `quit`; give it a moment, then make sure.
    const exited = await Promise.race([
      new Promise((resolve) => worker.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ])
    if (!exited) await worker.terminate().catch(() => undefined)
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                      */
/* -------------------------------------------------------------------------- */

export function apply(ctx, config = {}) {
  /** Panel-less defaults; the row's `config` may override them. */
  const settings = {
    libraryPath: typeof config.libraryPath === 'string' ? config.libraryPath : '',
    preferredSource: typeof config.preferredSource === 'string' ? config.preferredSource : '',
    maxWidth: Number.isFinite(config.maxWidth) ? config.maxWidth : 1280,
    announce: config.announce !== false,
  }

  const attachments = ctx.attachments
  const workerUrl = new URL('./worker.js', import.meta.url)

  /** The one shared worker; created on first use so an idle plugin costs nothing. */
  let shared = null
  /** Remembered source so consecutive calls do not have to repeat the name. */
  let currentSource = settings.preferredSource !== '' ? settings.preferredSource : null

  /** Locate the runtime once, with a clear error when it is missing. */
  function requireLibrary() {
    const located = locateLibrary(settings.libraryPath)
    if (located === null) {
      const hint = libraryHint()
      throw new Error(
        'NDI runtime not found. Install the NDI 6 Runtime/Tools, or set `libraryPath` to ' +
        `Processing.NDI.Lib.x64.dll.${hint ? ` (C:\\Program Files\\NDI contains: ${hint})` : ''}`,
      )
    }
    return located
  }

  /** Get (or lazily create) the worker serving this plugin instance. */
  async function ensureWorker() {
    if (shared !== null) {
      try {
        await shared.start()
        return shared
      } catch {
        shared = null
      }
    }
    const located = requireLibrary()
    const worker = new NdiWorker({ libraryPath: located.path, workerUrl })
    await worker.start()
    shared = worker
    ctx.logger?.info?.(`dsh-ndi-eye: NDI ${worker.version ?? 'unknown'} loaded from ${located.path}`)
    return worker
  }

  /**
   * List sources through the worker.
   *
   * Discovery runs on the worker thread on purpose: the NDI runtime is
   * process-wide and `NDIlib_destroy()` tears down every receiver in the
   * process. A second binding on the host thread that initialises and then
   * destroys the runtime would kill the feed the worker is receiving on
   * (observed as a 0xC0000005 crash). One thread owns NDI, always.
   */
  async function listSources(timeoutMs) {
    const located = requireLibrary()
    const worker = await ensureWorker()
    const result = await worker.request('discover', { timeoutMs }, timeoutMs + 12000)
    return {
      libraryPath: located.path,
      libraryOrigin: located.origin,
      version: result.version ?? worker.version,
      sources: result.sources,
    }
  }

  /** Pick the source to use: explicit > remembered > best-ranked. */
  function chooseSource(requested, sources) {
    const explicit = typeof requested === 'string' ? requested.trim() : ''
    if (explicit !== '') return explicit
    if (currentSource !== null && sources.some((item) => item.name === currentSource)) {
      return currentSource
    }
    if (sources.length === 0) return null
    const ranked = [...sources].sort(
      (a, b) => rankSource(b.name, settings.preferredSource) - rankSource(a.name, settings.preferredSource),
    )
    return ranked[0].name
  }

  /**
   * Connect the shared worker to `source`.
   *
   * NDI does not deliver frames the instant a receiver exists: measured on
   * 6.3.2, the first frame lands 2–4 s later. The worker therefore only reports
   * success once real pixels are in hand, so a caller's first capture is fast
   * instead of paying that stall itself.
   *
   * @param {string} source
   * @param {number} warmupMs how long the connection may take to start delivering
   */
  async function connect(source, warmupMs = 12000) {
    const worker = await ensureWorker()
    const info = await worker.request('connect', { source, warmupMs }, warmupMs + 15000)
    currentSource = source
    return { worker, info }
  }

  /** Turn one worker snapshot into an attachment + model-facing value. */
  async function commitSnapshot(shot, displaySource) {
    const png = Buffer.isBuffer(shot.png) ? shot.png : Buffer.from(shot.png)
    if (!isPng(png)) throw new Error('NDI capture did not produce a PNG')
    const ref = await attachments.saveImage({
      data: new Uint8Array(png),
      mediaType: 'image/png',
      name: 'ndi-frame.png',
    })
    const value = {
      source: displaySource,
      mediaType: ref.mediaType,
      width: ref.width,
      height: ref.height,
      bytes: ref.bytes,
      originalWidth: shot.originalWidth,
      originalHeight: shot.originalHeight,
      fourcc: shot.fourcc,
      age_ms: shot.ageMs ?? 0,
      attachment: ref,
    }
    // Only include a rate once one has actually been established: the harness
    // validator rejects `type` arrays, so this stays an optional key.
    if (typeof shot.fps === 'number') value.fps = shot.fps
    return value
  }

  /* ---------------------------------------------------------------------- */
  /* Tools                                                                   */
  /* ---------------------------------------------------------------------- */

  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'ndi_sources',
    description:
      'List every NDI source currently visible on the network (including this machine). ' +
      'Each entry carries the exact source name to pass to ndi_see / ndi_watch, plus a hint. ' +
      'Call this first when you do not know what is available, or when a previous capture ' +
      'failed because the source was not running.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        wait_ms: {
          type: 'integer',
          description: 'How long to wait for sources to announce themselves (default 2500, max 15000).',
        },
        include_offline_hint: {
          type: 'boolean',
          description: 'Also report which runtime was used and why no sources might be missing.',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['sources'],
        properties: {
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['name'],
              properties: {
                name: { type: 'string' },
                address: { type: 'string' },
                preferred: { type: 'boolean' },
              },
            },
          },
          count: { type: 'integer' },
          version: { type: 'string' },
          libraryPath: { type: 'string' },
          libraryOrigin: { type: 'string' },
          current: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.sources.length === 0) {
          return [{
            type: 'text',
            text:
              `No NDI sources found via ${value.version} (${value.libraryPath}).\n` +
              'The runtime is present and listening; nothing is announcing. Start the sender ' +
              '(VTube Studio NDI output, OBS NDI output, or a machine on the LAN) and retry.',
          }]
        }
        const lines = value.sources.map((item, index) => {
          const mark = item.preferred ? '  ← would be picked automatically' : ''
          return `${index + 1}. ${item.name}${item.address ? `  [${item.address}]` : ''}${mark}`
        })
        return [{
          type: 'text',
          text:
            `<sources count="${value.sources.length}">\n${lines.join('\n')}\n</sources>\n` +
            `runtime: ${value.version}\ncurrent: ${value.current ?? '(not connected)'}`,
        }]
      },
    },
    async execute(args) {
      const waitMs = Number.isFinite(args.wait_ms)
        ? Math.max(200, Math.min(15000, Math.trunc(args.wait_ms)))
        : 2500
      const result = await listSources(waitMs)
      const ranked = [...result.sources].sort(
        (a, b) => rankSource(b.name, settings.preferredSource) - rankSource(a.name, settings.preferredSource),
      )
      const best = ranked.length > 0 ? ranked[0].name : null
      const value = {
        count: result.sources.length,
        version: result.version,
        libraryPath: result.libraryPath,
        libraryOrigin: result.libraryOrigin,
        sources: result.sources.map((item) => {
          const entry = { name: item.name, preferred: item.name === best }
          // The harness schema validator rejects `type` arrays, so a nullable
          // field is expressed as an optional key instead of `['string','null']`.
          if (typeof item.address === 'string' && item.address !== '') entry.address = item.address
          return entry
        }),
      }
      if (currentSource !== null) value.current = currentSource
      return value
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'ndi_see',
    description:
      'Capture one frame from an NDI source and attach it so you can actually see it. ' +
      'This is a video signal, not a screenshot: it works when the app is minimised or ' +
      'hidden, and it can be a source on another machine. Omit `source` to reuse the last ' +
      'one, or to auto-pick the most camera-like source. Use it to look at a Live2D/VTube ' +
      'Studio feed, an OBS program output, or any NDI sender. ' +
      'Prefer this over screen capture whenever the thing you want to see is a video source ' +
      '(avatar/camera feed, program output, capture card, another machine): those often have ' +
      'no window of their own, so a screenshot returns the desktop or black instead. ' +
      'Use screen_view instead when you need the actual desktop UI (buttons, dialogs, error text).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: {
          type: 'string',
          description: 'Exact NDI source name from ndi_sources. Omit to reuse the last source or auto-pick.',
        },
        wait_ms: {
          type: 'integer',
          description: 'How long to wait for the first frame (default 6000, max 30000).',
        },
        max_width: {
          type: 'integer',
          description: 'Downscale the frame to at most this width before attaching (default 1280).',
        },
      },
      required: [],
    },
    output: { schema: IMAGE_VALUE_SCHEMA, render: (_args, value) => renderImageValue(value) },
    async execute(args) {
      if (attachments === undefined) {
        throw new Error('the harness attachment service is not available in this deployment')
      }
      const waitMs = Number.isFinite(args.wait_ms)
        ? Math.max(500, Math.min(30000, Math.trunc(args.wait_ms)))
        : DEFAULT_WAIT_MS
      const maxWidth = Number.isFinite(args.max_width)
        ? Math.max(160, Math.min(3840, Math.trunc(args.max_width)))
        : settings.maxWidth

      let source = typeof args.source === 'string' ? args.source.trim() : ''
      if (source === '') {
        const listed = await listSources(1200)
        source = chooseSource('', listed.sources) ?? ''
        if (source === '') {
          throw new Error(
            'No NDI source is available. Start a sender (VTube Studio NDI output or OBS) and retry, ' +
            'or call ndi_sources to see what is announcing.',
          )
        }
      }

      const { worker, info } = await connect(source, Math.max(waitMs, 3000))
      const shot = await worker.request('snapshot', { maxWidth, waitMs }, waitMs + 15000)
      const value = await commitSnapshot(shot, shot.source ?? source)
      // Surface the connect delay: it explains a slow first capture and is
      // useful when deciding whether the feed is healthy.
      if (typeof info?.waitedMs === 'number') value.connect_ms = info.waitedMs
      return value
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'ndi_watch',
    description:
      'Sample an NDI source repeatedly over a short window and return several frames in one ' +
      'result, so you can see what CHANGED rather than a single still. Frames with no movement ' +
      'are dropped; each kept frame reports its elapsed time and change ratio. Use it to judge ' +
      'an animation, a gesture, a scene switch, or whether something actually moved. ' +
      'This is sampling, not a live feed: you see the burst after it finishes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Exact NDI source name. Omit to reuse the current source.' },
        duration_ms: { type: 'integer', description: 'How long to sample (default 2500, max 10000).' },
        interval_ms: { type: 'integer', description: 'Gap between samples (default 400, min 100).' },
        max_frames: { type: 'integer', description: 'Cap on returned frames (default 6, max 8).' },
        min_change: { type: 'number', description: 'Drop frames whose change ratio is below this (default 0.01).' },
        max_width: { type: 'integer', description: 'Downscale each frame to at most this width (default 960).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['frames'],
        properties: {
          source: { type: 'string' },
          frame_count: { type: 'integer' },
          sampled: { type: 'integer' },
          duration_ms: { type: 'integer' },
          frames: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['index', 'attachment'],
              properties: {
                index: { type: 'integer' },
                elapsed_ms: { type: 'integer' },
                change: { type: 'number' },
                attachment: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const blocks = [{
          type: 'text',
          text:
            `<source>ndi://${value.source}</source>\n` +
            `<frames kept="${value.frame_count}" sampled="${value.sampled}" window_ms="${value.duration_ms}">` +
            'Frames in capture order; `change` is the fraction of pixels that moved since the previous sample.' +
            '</frames>',
        }]
        for (const frame of value.frames) {
          blocks.push({
            type: 'text',
            text: `<frame index="${frame.index}" elapsed="${frame.elapsed_ms}ms" change="${frame.change}"></frame>`,
          })
          blocks.push({ type: 'image', attachment: frame.attachment })
        }
        return blocks
      },
    },
    async execute(args) {
      if (attachments === undefined) {
        throw new Error('the harness attachment service is not available in this deployment')
      }
      const durationMs = Number.isFinite(args.duration_ms)
        ? Math.max(300, Math.min(10000, Math.trunc(args.duration_ms)))
        : 2500
      const intervalMs = Number.isFinite(args.interval_ms)
        ? Math.max(100, Math.min(5000, Math.trunc(args.interval_ms)))
        : 400
      const maxFrames = Number.isFinite(args.max_frames)
        ? Math.max(1, Math.min(MAX_BURST_FRAMES, Math.trunc(args.max_frames)))
        : 6
      const minChange = Number.isFinite(args.min_change)
        ? Math.max(0, Math.min(1, args.min_change))
        : 0.01
      const maxWidth = Number.isFinite(args.max_width)
        ? Math.max(160, Math.min(1920, Math.trunc(args.max_width)))
        : 960

      let source = typeof args.source === 'string' ? args.source.trim() : ''
      if (source === '') {
        const listed = await listSources(1200)
        source = chooseSource('', listed.sources) ?? ''
        if (source === '') throw new Error('No NDI source is available to watch.')
      }

      const { worker } = await connect(source, 12000)
      const started = Date.now()
      const samples = []
      const deadline = started + durationMs
      while (Date.now() <= deadline) {
        // The worker reports the change ratio against the previous snapshot it
        // produced, so the compare happens on the pixels it already holds and
        // no RGB buffers cross the thread boundary.
        const shot = await worker.request('snapshot', { maxWidth, waitMs: 3000 }, 15000)
        samples.push({ shot, elapsed: Date.now() - started })
        if (samples.length >= MAX_BURST_FRAMES * 4) break
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        const gap = Math.min(intervalMs, remaining)
        if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
      }
      if (samples.length === 0) throw new Error('the NDI source produced no frames to watch')

      const kept = samples.filter((sample, index) =>
        index === 0 || (sample.shot.change ?? 1) >= minChange,
      ).slice(0, maxFrames)

      const frames = []
      for (const [position, sample] of kept.entries()) {
        const value = await commitSnapshot(sample.shot, sample.shot.source ?? source)
        frames.push({
          index: position,
          elapsed_ms: Math.round(sample.elapsed),
          change: Math.round((sample.shot.change ?? 0) * 1000) / 1000,
          attachment: value.attachment,
        })
      }
      return {
        source,
        frame_count: frames.length,
        sampled: samples.length,
        duration_ms: durationMs,
        frames,
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'ndi_status',
    description:
      'Report the NDI eye connection state without capturing anything: which source is connected, ' +
      'how many frames arrived, the current frame rate, and the last error. Cheap; use it to ' +
      'diagnose "why did my capture fail" instead of retrying blindly.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['connected'],
        properties: {
          connected: { type: 'boolean' },
          source: { type: 'string' },
          frames: { type: 'integer' },
          fps: { type: 'number' },
          lastError: { type: 'string' },
          runtime: { type: 'string' },
          libraryPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `NDI ${value.runtime}\n` +
          `library: ${value.libraryPath}\n` +
          `connected: ${value.connected ? `yes → ${value.source}` : 'no'}\n` +
          `frames received: ${value.frames}${value.fps === undefined ? '' : ` (~${value.fps} fps)`}\n` +
          `last error: ${value.lastError ?? 'none'}`,
      }],
    },
    async execute() {
      const located = requireLibrary()
      if (shared === null) {
        return {
          connected: false,
          frames: 0,
          runtime: 'not initialised for capture yet',
          libraryPath: located.path,
        }
      }
      await shared.start().catch(() => undefined)
      const status = await shared.request('status', {}, 5000).catch((error) => ({
        connected: false,
        source: currentSource,
        frames: 0,
        latest: null,
        lastError: error instanceof Error ? error.message : String(error),
      }))
      const value = {
        connected: status.connected === true,
        frames: status.frames ?? 0,
        runtime: shared.version ?? 'unknown',
        libraryPath: located.path,
      }
      // Optional keys, never null: the harness schema validator rejects both
      // `type` arrays and values that do not match the declared type.
      const source = status.source ?? currentSource
      if (typeof source === 'string' && source !== '') value.source = source
      const fps = status.latest?.fps
      if (typeof fps === 'number') value.fps = fps
      const lastError = status.lastError ?? shared.reportedError
      if (typeof lastError === 'string' && lastError !== '') value.lastError = lastError
      return value
    },
  }))

  /* ---------------------------------------------------------------------- */
  /* Announce + cleanup                                                      */
  /* ---------------------------------------------------------------------- */

  if (settings.announce) {
    try {
      disposers.push(ctx.systemPrompt.section({
        name: 'plugin:dsh-ndi-eye',
        order: 155,
        text: NAVIGATION_NOTE,
      }))
    } catch {
      /* systemPrompt not mounted — stay silent */
    }
  }

  // Release the NDI runtime when the plugin unloads or the profile restarts,
  // otherwise the worker keeps holding the receiver.
  ctx.on('dispose', () => {
    const worker = shared
    shared = null
    void worker?.stop()
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
    const worker = shared
    shared = null
    void worker?.stop()
  }
}

/** Prompt guidance shown to the agent. */
const NAVIGATION_NOTE = GUIDANCE
