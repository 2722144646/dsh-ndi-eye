// Minimal NDI sender used by the self-test: a synthetic test pattern source.
// Exercises the real send path so the plugin can be verified without needing
// VTube Studio, OBS, or any other app running.
import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PROFILE = process.env.DSH_PROFILE_DIR ?? 'C:\\Users\\27221\\.dsh\\profiles\\desktop'
let koffi
try {
  koffi = require('koffi')
} catch {
  koffi = createRequire(`${PROFILE}\\node_modules\\dsh-orb\\node_modules\\koffi\\index.cjs`)('koffi')
}

const lib = koffi.load(workerData.libraryPath)

koffi.struct('ST_src', { p_ndi_name: 'const char *', p_url_address: 'const char *' })
koffi.struct('ST_send_create', {
  p_ndi_name: 'const char *',
  p_groups: 'const char *',
  clock_video: 'bool',
  clock_audio: 'bool',
})
koffi.struct('ST_send_frame_v2', {
  xres: 'int32',
  yres: 'int32',
  FourCC: 'int32',
  frame_rate_N: 'int32',
  frame_rate_D: 'int32',
  picture_aspect_ratio: 'float',
  frame_format_type: 'int32',
  timecode: 'int64',
  p_data: 'uint8_t *',
  line_stride_in_bytes: 'int32',
  p_metadata: 'const char *',
  timestamp: 'int64',
})

const initialize = lib.func('bool NDIlib_initialize(void)')
const destroy = lib.func('void NDIlib_destroy(void)')
const sendCreate = lib.func('void *NDIlib_send_create(const ST_send_create *p_create_settings)')
const sendVideo = lib.func('void NDIlib_send_send_video_v2(void *p_instance, const ST_send_frame_v2 *p_video_data)')
const sendDestroy = lib.func('void NDIlib_send_destroy(void *p_instance)')

initialize()
const name = workerData.sourceName ?? 'DSH NDI Test Pattern'
const sender = sendCreate({
  p_ndi_name: name,
  p_groups: null,
  clock_video: true,
  clock_audio: false,
})
if (!sender) {
  parentPort.postMessage({ type: 'failed', error: 'send_create returned null' })
  process.exit(1)
}

const width = workerData.width ?? 640
const height = workerData.height ?? 360
const fps = workerData.fps ?? 30
const stride = width * 4
const frame = Buffer.alloc(stride * height)

/** Draw a moving marker so consecutive frames genuinely differ. */
function paint(phase) {
  for (let y = 0; y < height; y++) {
    let offset = y * stride
    for (let x = 0; x < width; x++, offset += 4) {
      // BGRA: a vertical gradient background with a moving bright bar.
      frame[offset] = (x * 255 / width) | 0
      frame[offset + 1] = (y * 255 / height) | 0
      frame[offset + 2] = 40
      frame[offset + 3] = 255
      const barX = Math.floor((Math.sin(phase) * 0.5 + 0.5) * (width - 60))
      if (x >= barX && x < barX + 60) {
        frame[offset] = 240
        frame[offset + 1] = 240
        frame[offset + 2] = 240
      }
    }
  }
}

const frameStruct = koffi.alloc('ST_send_frame_v2', 1)
let phase = 0
const intervalMs = 1000 / fps
// NDI FourCC values are little-endian ints whose bytes spell the tag:
// BGRA is declared as 'ABGR' → 0x41424752? No: the bytes must read B,G,R,A,
// so the int is 0x41524742. Verified against a real source, which reported
// 1095911234 (0x41524742) and decoded as "BGRA".
const FOURCC_BGRA = 0x41524742
const timer = setInterval(() => {
  paint(phase)
  phase += 0.15
  koffi.encode(frameStruct, 'ST_send_frame_v2', {
    xres: width,
    yres: height,
    FourCC: FOURCC_BGRA,
    frame_rate_N: fps,
    frame_rate_D: 1,
    picture_aspect_ratio: width / height,
    // 1 = progressive; 0 would declare interlaced fields we never send.
    frame_format_type: 1,
    timecode: 0n,
    p_data: frame,
    line_stride_in_bytes: stride,
    p_metadata: null,
    timestamp: 0n,
  })
  sendVideo(sender, frameStruct)
}, intervalMs)

parentPort.postMessage({ type: 'sending', name, width, height, fps })

parentPort.on('message', (m) => {
  if (m?.type === 'stop') {
    clearInterval(timer)
    sendDestroy(sender)
    try { destroy() } catch { /* ignore */ }
    parentPort.postMessage({ type: 'stopped' })
    setTimeout(() => process.exit(0), 100)
  }
})
