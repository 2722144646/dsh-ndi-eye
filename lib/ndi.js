// NDI 6 frame capture, driven directly through the NDI runtime DLL with koffi.
//
// Verified against NDI SDK WIN64 6.3.2.0 on this machine:
//   · `NDIlib_find_create_v2` + `find_wait` + `find_get_current_sources` lists
//     sources (e.g. "BLOODPEACH (Live2D Camera NDI5)").
//   · `NDIlib_recv_create_v3` with the source embedded in the settings struct
//     connects; an explicit `recv_connect` afterwards returns false and is not
//     needed.
//   · `NDIlib_recv_capture_v2` delivers video frames with FourCC BGRA.
//
// The frame struct is the part that goes wrong quietly, so the exact NDI 6
// layout (validated by byte-dumping a real frame, see README) is:
//
//   int32 xres, int32 yres, int32 FourCC,
//   int32 frame_rate_N, int32 frame_rate_D, float picture_aspect_ratio,
//   int32 frame_format_type, int64 timecode,
//   uint8* data, int32 line_stride,
//   const char* metadata, int64 timestamp
//
// Omitting frame_rate_N/D/aspect/format the way older bindings do shifts every
// later field, which reads back as FourCC "ARGB" plus a nonsense stride — it
// looks like a decoded frame and is garbage.

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Known install locations for the NDI runtime, newest first. */
const LIBRARY_CANDIDATES = [
  'C:\\Program Files\\NDI\\NDI 6 Runtime\\v6',
  'C:\\Program Files\\NDI\\NDI 6 Tools\\Runtime',
  'C:\\Program Files\\NDI\\NDI 5 Runtime\\v5',
  'C:\\Program Files\\NDI\\NDI 5 Tools\\Runtime',
  'C:\\Program Files\\NewTek\\NDI 5 Tools\\Runtime',
  'C:\\Program Files\\NDI\\NDI 4 Runtime\\v4',
]

/** DLL file name inside a runtime directory. */
const LIBRARY_FILE = 'Processing.NDI.Lib.x64.dll'

/**
 * Locate `Processing.NDI.Lib.x64.dll`.
 *
 * `NDI_RUNTIME_DIR_V6` (and friends) are set by the NDI installer, so honour
 * them first; then the conventional Program Files layout. The VTube Studio
 * bundled copy is deliberately excluded: it is NDI 4.x and cannot receive
 * modern sources, so offering it only produces confusing "connection failed".
 *
 * @param {string} [configured] explicit directory or .dll path from panel config
 * @returns {{ path: string, origin: string } | null}
 */
export function locateLibrary(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    const trimmed = configured.trim()
    const path = /\.dll$/i.test(trimmed) ? trimmed : join(trimmed, LIBRARY_FILE)
    if (existsSync(path)) return { path, origin: 'configured' }
  }
  for (const key of ['NDI_RUNTIME_DIR_V6', 'NDI_RUNTIME_DIR_V5', 'NDI_RUNTIME_DIR_V4']) {
    const dir = process.env[key]
    if (typeof dir === 'string' && dir !== '') {
      const path = join(dir, LIBRARY_FILE)
      if (existsSync(path)) return { path, origin: `env:${key}` }
    }
  }
  for (const dir of LIBRARY_CANDIDATES) {
    const path = join(dir, LIBRARY_FILE)
    if (existsSync(path)) return { path, origin: 'program-files' }
  }
  return null
}

/** Load koffi from wherever this plugin can find it. */
export function loadKoffi() {
  const require = createRequire(import.meta.url)

  // 1. The plugin's own dependency (what install_bundle provisions).
  try {
    const mod = require('koffi')
    return mod.default ?? mod
  } catch {
    /* fall through */
  }

  // 2. A linked plugin directory owns no node_modules, so borrow an installed
  //    copy. dsh-orb ships koffi for its own Win32 hooks; reusing it avoids a
  //    second native addon for the same job.
  const profileDir = process.env.DSH_PROFILE_DIR
  const candidates = []
  if (typeof profileDir === 'string' && profileDir !== '') {
    candidates.push(join(profileDir, 'node_modules', 'koffi'))
    candidates.push(join(profileDir, 'node_modules', 'dsh-orb', 'node_modules', 'koffi'))
  }
  candidates.push(join(process.cwd(), 'node_modules', 'koffi'))
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'index.cjs'))) continue
    try {
      const mod = createRequire(join(dir, 'index.cjs'))('koffi')
      return mod.default ?? mod
    } catch {
      /* try the next candidate */
    }
  }

  throw new Error(
    'koffi (the FFI binding used to call the NDI runtime) is not installed. ' +
    'Install it with `npm i koffi` in the plugin directory, or reinstall the bundle.',
  )
}

/** NDI frame FourCC values this module can convert. */
const FOURCC_BGRA = 'BGRA'
const FOURCC_BGRX = 'BGRX'
const FOURCC_RGBA = 'RGBA'
const FOURCC_UYVY = 'UYVY'
const FOURCC_UYVA = 'UYVA'

const KIND_VIDEO = 1

/**
 * Register the NDI wire structs exactly once per process.
 *
 * koffi keeps a global type registry and throws on a duplicate name, so a second
 * binding in the same process (panel probe + tool call) would otherwise fail.
 * One registration is enough: the byte layout is identical for every binding.
 *
 * @param {object} koffi
 */
function registerNdiTypes(koffi) {
  if (koffi.NdiEyeTypesRegistered === true) return
  koffi.struct('NDIlib_source_t', {
    p_ndi_name: 'const char *',
    p_url_address: 'const char *',
  })
  koffi.struct('NDIlib_find_create_t', {
    show_local_sources: 'bool',
    p_groups: 'const char *',
    p_extra_ips: 'const char *',
  })
  koffi.struct('NDIlib_recv_create_v3_t', {
    source_to_connect_to: 'NDIlib_source_t',
    color_format: 'int32',
    bandwidth: 'int32',
    allow_video_fields: 'bool',
    p_ndi_recv_name: 'const char *',
  })
  koffi.struct('NDIlib_video_frame_v2_t', {
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
  koffi.NdiEyeTypesRegistered = true
}

/**
 * Build the NDI binding for one library path.
 *
 * @param {string} libraryPath
 * @returns {object} callable NDI API surface
 */
export function createNdiBinding(libraryPath) {
  const koffi = loadKoffi()
  const lib = koffi.load(libraryPath)
  registerNdiTypes(koffi)

  const version = lib.func('const char *NDIlib_version(void)')
  const initialize = lib.func('bool NDIlib_initialize(void)')
  const destroy = lib.func('void NDIlib_destroy(void)')

  const findCreate = lib.func('void *NDIlib_find_create_v2(const NDIlib_find_create_t *p_create_settings)')
  const findWait = lib.func('bool NDIlib_find_wait_for_sources(void *p_instance, uint32_t timeout_in_milliseconds)')
  const findGet = lib.func('const NDIlib_source_t *NDIlib_find_get_current_sources(void *p_instance, _Out_ uint32_t *p_no_sources)')
  const findDestroy = lib.func('void NDIlib_find_destroy(void *p_instance)')

  const recvCreate = lib.func('void *NDIlib_recv_create_v3(const NDIlib_recv_create_v3_t *p_create_settings)')
  const recvCapture = lib.func('int32 NDIlib_recv_capture_v2(void *p_instance, _Out_ NDIlib_video_frame_v2_t *p_video, void *p_audio, void *p_metadata, uint32_t timeout_in_ms)')
  const recvFreeVideo = lib.func('void NDIlib_recv_free_video_v2(void *p_instance, NDIlib_video_frame_v2_t *p_video_data)')
  const recvDestroy = lib.func('void NDIlib_recv_destroy(void *p_instance)')

  let started = false
  const frameBuffer = koffi.alloc('NDIlib_video_frame_v2_t', 1)

  return {
    koffi,
    version: () => version(),

    /** Initialise the runtime once; later calls are no-ops. */
    start() {
      if (started) return true
      started = initialize() === true
      return started
    },

    /**
     * Discover every source currently on the network (including this machine).
     *
     * @param {number} timeoutMs how long to wait for sources to appear
     * @returns {Array<{ name: string, address: string | null }>}
     */
    discover(timeoutMs) {
      const finder = findCreate({ show_local_sources: true, p_groups: null, p_extra_ips: null })
      if (finder === null) throw new Error('NDI finder could not be created')
      try {
        findWait(finder, Math.max(200, Math.min(60000, timeoutMs)))
        const count = [0]
        const pointer = findGet(finder, count)
        if (pointer === null || count[0] === 0) return []
        const rows = koffi.decode(pointer, 'NDIlib_source_t', count[0])
        return rows.map((row) => ({
          name: String(row.p_ndi_name ?? ''),
          address: row.p_url_address === null ? null : String(row.p_url_address),
        }))
      } finally {
        findDestroy(finder)
      }
    },

    /**
     * Connect to one named NDI source.
     *
     * `color_format: 1` (UYVY input) is the fastest path measured on NDI 6.3.2:
     * it delivered BGRA at the source rate with the lowest first-frame latency
     * (2.0s, versus 2.0-4.1s for other formats). `bandwidth: 0` (highest) is
     * required — `lowest` never delivered a frame in testing.
     *
     * @param {string} sourceName the full NDI name, e.g. "PC (Camera NDI5)"
     */
    open(sourceName) {
      const recv = recvCreate({
        source_to_connect_to: { p_ndi_name: sourceName, p_url_address: null },
        color_format: 1,        // UYVY input requested; the SDK hands back BGRA
        bandwidth: 0,           // highest — `lowest` delivers nothing here
        allow_video_fields: true,
        p_ndi_recv_name: 'dsh-ndi-eye',
      })
      if (recv === null) throw new Error(`NDI receiver could not be created for "${sourceName}"`)
      return recv
    },

    /**
     * Wait for one video frame.
     *
     * @param {object} recv receiver from {@link open}
     * @param {number} timeoutMs per-attempt timeout
     * @returns {object|null} raw frame description, or null when nothing arrived
     */
    waitFrame(recv, timeoutMs) {
      const kind = recvCapture(recv, frameBuffer, null, null, Math.max(1, Math.min(60000, timeoutMs)))
      if (kind !== KIND_VIDEO) return null
      const frame = koffi.decode(frameBuffer, 'NDIlib_video_frame_v2_t')
      return {
        width: frame.xres,
        height: frame.yres,
        fourcc: fourCcName(frame.FourCC),
        fpsNumerator: frame.frame_rate_N,
        fpsDenominator: frame.frame_rate_D,
        aspectRatio: frame.picture_aspect_ratio,
        formatType: frame.frame_format_type,
        stride: Math.abs(frame.line_stride_in_bytes) || frame.xres * 4,
        pointer: frame.p_data,
        timestamp: frame.timestamp,
      }
    },

    /**
     * Read the pixels of the current frame and hand the raw buffer back.
     *
     * @param {object} frame result of {@link waitFrame}
     * @returns {Uint8Array} tightly described pixel bytes
     */
    readPixels(frame) {
      const bytes = Math.abs(frame.stride) * frame.height
      if (!(bytes > 0)) return new Uint8Array(0)
      return koffi.decode(frame.pointer, 'uint8', bytes)
    },

    /** Release the frame currently held by the receiver. */
    freeFrame(recv) {
      recvFreeVideo(recv, frameBuffer)
    },

    /** Close one receiver. */
    close(recv) {
      if (recv !== null && recv !== undefined) recvDestroy(recv)
    },

    /** Tear the runtime down; safe to call repeatedly. */
    stop() {
      if (!started) return
      try { destroy() } catch { /* already gone */ }
      started = false
    },
  }
}

/** Turn a FourCC int32 into its 4-character tag. */
function fourCcName(value) {
  return String.fromCharCode(
    value & 255,
    (value >> 8) & 255,
    (value >> 16) & 255,
    (value >>> 24) & 255,
  )
}

/* -------------------------------------------------------------------------- */
/* Pixel conversion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Convert one NDI frame to packed RGB8.
 *
 * @param {Uint8Array} pixels raw bytes from {@link createNdiBinding.readPixels}
 * @param {object} frame frame description
 * @returns {{ rgb: Buffer, width: number, height: number, converted: string }}
 */
export function toRgb(pixels, frame) {
  const { width, height, stride } = frame
  const fourcc = frame.fourcc
  const rgb = Buffer.alloc(width * height * 3)

  if (fourcc === FOURCC_BGRA || fourcc === FOURCC_BGRX) {
    for (let y = 0; y < height; y++) {
      let src = y * stride
      let dst = y * width * 3
      for (let x = 0; x < width; x++, src += 4, dst += 3) {
        rgb[dst] = pixels[src + 2]
        rgb[dst + 1] = pixels[src + 1]
        rgb[dst + 2] = pixels[src]
      }
    }
    return { rgb, width, height, converted: fourcc }
  }

  if (fourcc === FOURCC_RGBA) {
    for (let y = 0; y < height; y++) {
      let src = y * stride
      let dst = y * width * 3
      for (let x = 0; x < width; x++, src += 4, dst += 3) {
        rgb[dst] = pixels[src]
        rgb[dst + 1] = pixels[src + 1]
        rgb[dst + 2] = pixels[src + 2]
      }
    }
    return { rgb, width, height, converted: fourcc }
  }

  if (fourcc === FOURCC_UYVY || fourcc === FOURCC_UYVA) {
    const step = fourcc === FOURCC_UYVA ? 4 : 2
    for (let y = 0; y < height; y++) {
      let src = y * stride
      let dst = y * width * 3
      for (let x = 0; x < width; x += 2, src += step * 2) {
        const u = pixels[src]
        const y0 = pixels[src + 1]
        const v = pixels[src + 2]
        const y1 = pixels[src + 3]
        writeYuv(rgb, dst, y0, u, v)
        if (x + 1 < width) writeYuv(rgb, dst + 3, y1, u, v)
        dst += 6
      }
    }
    return { rgb, width, height, converted: `${fourcc}→RGB` }
  }

  throw new Error(`unsupported NDI frame format ${fourcc} (expected BGRA, BGRX, RGBA, UYVY or UYVA)`)
}

/** BT.709 limited-range YUV to RGB, clipped to a byte. */
function writeYuv(rgb, offset, y, u, v) {
  const c = Math.max(0, y - 16)
  const d = u - 128
  const e = v - 128
  rgb[offset] = clampByte((298 * c + 459 * e + 128) >> 8)
  rgb[offset + 1] = clampByte((298 * c - 55 * d - 136 * e + 128) >> 8)
  rgb[offset + 2] = clampByte((298 * c + 541 * d + 128) >> 8)
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/* -------------------------------------------------------------------------- */
/* Minimal PNG encoder                                                         */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * Encode packed RGB8 as a PNG.
 *
 * The harness re-encodes and downscales images itself, so this stays a plain
 * filter-0 encoder: correctness over ratio.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgb packed RGB8, width*height*3 bytes
 * @param {{ deflateSync: (data: Buffer) => Buffer }} zlib
 * @returns {Buffer} PNG bytes
 */
export function encodePng(width, height, rgb, zlib) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 2    // colour type: truecolour
  ihdr[10] = 0   // deflate
  ihdr[11] = 0   // adaptive filtering
  ihdr[12] = 0   // no interlace

  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Cheap PNG signature guard before handing bytes to the attachment store. */
export function isPng(buffer) {
  return buffer.length > 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
}

/* -------------------------------------------------------------------------- */
/* Source ranking                                                              */
/* -------------------------------------------------------------------------- */

/** Score a source name for "this is probably the thing you want to see". */
export function rankSource(name, hint) {
  let score = 0
  if (typeof hint === 'string' && hint !== '' && name.includes(hint)) score += 100
  if (/vtuber|vtuber studio|vts/i.test(name)) score += 40
  if (/live2d/i.test(name)) score += 35
  if (/camera|webcam/i.test(name)) score += 20
  if (/screen|desktop|display|monitor/i.test(name)) score += 15
  if (/obs/i.test(name)) score += 10
  return score
}

/** List host names hidden in a directory listing, for error messages. */
export function libraryHint() {
  const roots = ['C:\\Program Files\\NDI']
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      return readdirSync(root).join(', ')
    } catch {
      /* ignore */
    }
  }
  return ''
}
