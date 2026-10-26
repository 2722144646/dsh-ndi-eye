// Self-contained end-to-end test: start a synthetic NDI sender, then drive the
// plugin's four tools against it. Does not depend on VTube Studio being open.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { locateLibrary } from '../lib/ndi.js'

const located = locateLibrary('')
if (!located) { console.error('no NDI runtime'); process.exit(1) }
console.log('runtime:', located.path)

const SOURCE = 'DSH NDI Test Pattern'

// ---- 1. sender ------------------------------------------------------------
const sender = new Worker(new URL('./test-sender.mjs', import.meta.url), {
  workerData: { libraryPath: located.path, sourceName: SOURCE, width: 640, height: 360, fps: 30 },
})
const senderReady = new Promise((resolve, reject) => {
  sender.on('message', (m) => {
    if (m?.type === 'sending') resolve(m)
    if (m?.type === 'failed') reject(new Error(m.error))
  })
  sender.on('error', reject)
})
console.log('sender:', await senderReady)

// ---- 2. plugin ------------------------------------------------------------
const registry = new Map()
const savedImages = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (d) => { registry.set(d.name, d); return () => registry.delete(d.name) } },
  attachments: {
    async saveImage(input) {
      const bytes = Buffer.from(input.data)
      if (!(bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) throw new Error('not a PNG')
      savedImages.push(bytes)
      return {
        attachmentId: `att_${savedImages.length}`,
        mediaType: input.mediaType,
        bytes: bytes.length,
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        name: input.name,
      }
    },
  },
  systemPrompt: { section: () => () => {} },
  on: () => () => {},
}
const mod = await import('../lib/index.js')
const disposePlugin = mod.apply(ctx, { libraryPath: '', maxWidth: 1280 })
const run = (name, args = {}) => registry.get(name).execute(args, {})

// NDI prefixes the announcing machine: the sender registers as
// "DSH NDI Test Pattern" but is discovered as "HOST (DSH NDI Test Pattern)".
await new Promise((resolve) => setTimeout(resolve, 3000))

let failures = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures++
}

// ---- 3. ndi_sources -------------------------------------------------------
const sources = await run('ndi_sources', { wait_ms: 4000 })
const announced = sources.sources.find((s) => s.name.includes(SOURCE))
check('ndi_sources finds the synthetic source', announced !== undefined,
  `count=${sources.count} name=${announced?.name ?? 'none'}`)

const SOURCE_ID = announced?.name ?? SOURCE

// ---- 4. ndi_see -----------------------------------------------------------
const t0 = Date.now()
const shot = await run('ndi_see', { source: SOURCE_ID, wait_ms: 12000 })
const seeMs = Date.now() - t0
check('ndi_see returns a frame', shot.width > 0 && shot.height > 0,
  `${shot.width}x${shot.height} in ${seeMs}ms`)
check('ndi_see committed a PNG attachment', savedImages.length === 1 && shot.attachment.bytes > 0,
  `${shot.attachment.bytes} bytes`)
const blocks = registry.get('ndi_see').output.render({}, shot)
check('ndi_see render yields a real image block',
  blocks.some((b) => b.type === 'image' && b.attachment.attachmentId))

const t1 = Date.now()
const again = await run('ndi_see', { source: SOURCE_ID })
const reuseMs = Date.now() - t1
check('second ndi_see reuses the connection', reuseMs < 500 && again.connect_ms === 0,
  `${reuseMs}ms, connect_ms=${again.connect_ms}`)

// ---- 5. ndi_watch ---------------------------------------------------------
const burst = await run('ndi_watch', { source: SOURCE_ID, duration_ms: 2200, interval_ms: 250, max_frames: 5, max_width: 480 })
check('ndi_watch sampled multiple frames', burst.sampled >= 4, `sampled=${burst.sampled}`)
check('ndi_watch kept frames', burst.frame_count >= 2, `kept=${burst.frame_count}`)
const changes = burst.frames.map((f) => f.change)
check('ndi_watch reports real movement (moving bar changes pixels)',
  changes.slice(1).some((c) => c > 0.002), `changes=${changes.join(',')}`)
const watchBlocks = registry.get('ndi_watch').output.render({}, burst)
check('ndi_watch render emits one image per kept frame',
  watchBlocks.filter((b) => b.type === 'image').length === burst.frame_count)

// ---- 6. ndi_status --------------------------------------------------------
const status = await run('ndi_status', {})
check('ndi_status reports connected', status.connected === true, `frames=${status.frames}`)
check('ndi_status reports a plausible frame rate',
  status.fps === null || (status.fps > 5 && status.fps < 120), `fps=${status.fps}`)

// ---- 7. error handling ----------------------------------------------------
try {
  await run('ndi_see', { source: 'source-that-does-not-exist', wait_ms: 2000 })
  check('missing source is refused', false, 'call unexpectedly succeeded')
} catch (error) {
  check('missing source is refused', /no frame|idle|paused|gone/i.test(error.message),
    error.message.slice(0, 80))
}

// Save one image so the pixels can be inspected by eye.
if (savedImages.length > 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ndi-eye-'))
  writeFileSync(join(tmpdir(), 'ndi-eye-synthetic.png'), savedImages[0])
  console.log('wrote ndi-eye-synthetic.png')
}

// ---- 8. teardown ----------------------------------------------------------
disposePlugin()
await new Promise((resolve) => setTimeout(resolve, 800))
sender.postMessage({ type: 'stop' })
await new Promise((resolve) => setTimeout(resolve, 600))
await sender.terminate()

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
