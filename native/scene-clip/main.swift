// scene-clip — Story Studio's native still-image clip renderer.
//
// Node (electron/server/lib/native-scene-clip.ts) compiles a scene's motion document into a
// per-frame plan (lib/scene-motion-plan.ts); this helper only renders that plan. Metal compute
// does the camera move (a bicubic resample of the still through the frame's affine), the focus
// blur, the fade and the RGB->YCbCr conversion; VideoToolbox (hardware H.264, through
// AVAssetWriter) does the encode. It knows nothing about move names.
//
//   scene-clip --job job.json     render the clip the job describes
//   scene-clip --version          print "scene-clip <n>" (availability probe)
//
// Exit codes: 0 ok, 2 bad job / usage, 3 unsupported input (caller falls back to FFmpeg),
// 4 render or encode failure.
//
// Colour: FFmpeg moves the PNG's raw RGB code values into the encoder, ignoring any embedded
// profile. So does this: the still is decoded in its OWN colour space (no conversion) and the
// conversion to YCbCr is done by the kernel below, with a selectable matrix.
import Foundation
import AVFoundation
import CoreVideo
import CoreGraphics
import ImageIO
import Metal

let HELPER_VERSION = 1

struct PlanFrame: Decodable {
    var z: Double          // magnification of the canvas (1 = fitted picture fills the frame)
    var cx: Double         // canvas point (output px, top-left origin) landing in the frame centre
    var cy: Double
    var rot: Double        // clockwise rotation of the canvas about that point, radians
    var blur: [Double]     // gaussian sigmas (output px), applied in order
    var gain: Double       // 0...1 brightness multiplier
}

struct Job: Decodable {
    var input: String
    var output: String
    var width: Int
    var height: Int
    var fps: Int
    var frames: [PlanFrame]
    var prepWidth: Int?        // the size the FFmpeg chain prepares the still at (scale+pad), when it is larger than the frame
    var prepHeight: Int?
    var quality: Double?       // VideoToolbox quality 0...1
    var matrix: String?        // "bt601" | "bt709": the RGB->YCbCr matrix used for the pixel data
    var resample: String?      // how a frame is cut out of the prepared picture: "lanczos" (zoompan moves) | "bilinear" (rotation, static)
    var debugFrame: Int?       // write this frame as a raw yuv420p-less PNG instead of encoding
}

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data(("scene-clip: " + message + "\n").utf8))
    exit(code)
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--version" {
    print("scene-clip \(HELPER_VERSION)")
    exit(0)
}
guard args.count >= 3, args[1] == "--job" else { fail(2, "usage: scene-clip --job job.json | --version") }
guard let jobData = FileManager.default.contents(atPath: args[2]),
      let job = try? JSONDecoder().decode(Job.self, from: jobData) else { fail(2, "cannot read job \(args[2])") }
guard job.width > 0, job.height > 0, job.width % 2 == 0, job.height % 2 == 0, job.fps > 0, !job.frames.isEmpty else {
    fail(2, "bad geometry or empty plan")
}
let W = job.width, H = job.height

// ── Source ───────────────────────────────────────────────────────────────────
guard let imgSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: job.input) as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(imgSource, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else {
    fail(3, "cannot decode \(job.input)")
}
// FFmpeg drops alpha without compositing, so an image with transparency has no single right answer here.
// An alpha channel that is fully opaque (common: RGBA PNGs from image models) is just colour and is fine;
// it is checked on the pixels below.
let hasAlphaChannel: Bool = { switch cgImage.alphaInfo { case .none, .noneSkipFirst, .noneSkipLast: return false; default: return true } }()
guard let srcSpace = cgImage.colorSpace, srcSpace.model == .rgb else { fail(3, "source is not an RGB image") }
let srcW = cgImage.width, srcH = cgImage.height
guard srcW >= 2, srcH >= 2, srcW <= 16384, srcH <= 16384 else { fail(3, "source size \(srcW)x\(srcH) not supported") }

// Raw RGBA8 in the image's OWN space: drawing into a context of the same space converts nothing.
var rgba = [UInt8](repeating: 255, count: srcW * srcH * 4)
rgba.withUnsafeMutableBytes { buf in
    let info = hasAlphaChannel ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
    guard let c = CGContext(data: buf.baseAddress, width: srcW, height: srcH, bitsPerComponent: 8, bytesPerRow: srcW * 4,
                            space: srcSpace, bitmapInfo: info) else { fail(3, "cannot read pixels") }
    c.interpolationQuality = .none
    c.setBlendMode(.copy)          // write the source's own alpha, do not composite it onto the buffer
    c.draw(cgImage, in: CGRect(x: 0, y: 0, width: srcW, height: srcH))
}
if hasAlphaChannel {
    var i = 3
    while i < rgba.count { if rgba[i] != 255 { fail(3, "source has an alpha channel") }; i += 4 }
}

// "Fit": FFmpeg's scale(force_original_aspect_ratio=decrease) + pad, reproduced including its rounding, in the
// size the chain prepares the still at (the 1x frame, the 2x supersample, the 1.1x rotation canvas). Two details
// move the picture by up to a pixel: the fitted size is rounded to nearest, and `pad` snaps its offset DOWN to an
// even number because the chain is in yuv420p by then. Everything is then expressed in OUTPUT pixels.
let prepW = Double(job.prepWidth ?? W), prepH = Double(job.prepHeight ?? H)
func rescale(_ a: Double, _ b: Double, _ c: Double) -> Double { (a * b / c).rounded(.toNearestOrAwayFromZero) }
let fitWp = min(rescale(prepH, Double(srcW), Double(srcH)), prepW)
let fitHp = min(rescale(prepW, Double(srcH), Double(srcW)), prepH)
func evenDown(_ v: Double) -> Double { (v / 2).rounded(.down) * 2 }
let padXp = evenDown(((prepW - fitWp) / 2).rounded(.towardZero))
let padYp = evenDown(((prepH - fitHp) / 2).rounded(.towardZero))

// ── Metal ────────────────────────────────────────────────────────────────────
guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { fail(4, "no Metal device") }

let shaderSource = """
#include <metal_stdlib>
using namespace metal;

struct Params {
    float outW, outH, srcW, srcH;
    float prepW, prepH, padX, padY;
    float fitWp, fitHp;
    float cx, cy, z, rot;
    float gain;
    int   kernelType;       // 0 bicubic(B=0,C=0.6, swscale default) 1 catmull-rom 2 lanczos3 3 bilinear
    float matrixKr, matrixKb;
};

float weight(float x, int kind) {
    x = fabs(x);
    if (kind == 3) return max(0.0, 1.0 - x);
    if (kind == 2) {
        if (x >= 3.0) return 0.0;
        if (x < 1e-6) return 1.0;
        float px = M_PI_F * x;
        return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
    }
    float B = 0.0, C = (kind == 0) ? 0.6 : 0.5;
    if (x < 1.0) return ((12.0 - 9.0 * B - 6.0 * C) * x * x * x + (-18.0 + 12.0 * B + 6.0 * C) * x * x + (6.0 - 2.0 * B)) / 6.0;
    if (x < 2.0) return ((-B - 6.0 * C) * x * x * x + (6.0 * B + 30.0 * C) * x * x + (-12.0 * B - 48.0 * C) * x + (8.0 * B + 24.0 * C)) / 6.0;
    return 0.0;
}

// Pass 1 (once per clip): the prepared picture — the still, fitted into the prepared canvas the way FFmpeg's
// scale+pad does it, resampled bicubic (swscale's default), black outside the picture.
kernel void prepare_picture(texture2d<float, access::read> src [[texture(0)]],
                            texture2d<float, access::write> dst [[texture(1)]],
                            constant Params &p [[buffer(0)]],
                            uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= (uint)p.prepW || gid.y >= (uint)p.prepH) return;
    float2 pos = float2(gid) + 0.5 - float2(p.padX, p.padY);
    if (pos.x < 0.0 || pos.y < 0.0 || pos.x >= p.fitWp || pos.y >= p.fitHp) { dst.write(float4(0, 0, 0, 1), gid); return; }
    float2 sp = pos * float2(p.srcW / p.fitWp, p.srcH / p.fitHp);
    float2 ratio = max(float2(p.srcW / p.fitWp, p.srcH / p.fitHp), float2(1.0));
    int2 lo = int2(floor(sp - 2.0 * ratio)), hi = int2(ceil(sp + 2.0 * ratio));
    int2 lim = int2(p.srcW, p.srcH) - 1;
    float3 acc = 0.0; float wsum = 0.0;
    for (int j = lo.y; j <= hi.y; j++) {
        float wy = weight((float(j) + 0.5 - sp.y) / ratio.y, 0);
        if (wy == 0.0) continue;
        for (int i = lo.x; i <= hi.x; i++) {
            float w = wy * weight((float(i) + 0.5 - sp.x) / ratio.x, 0);
            if (w == 0.0) continue;
            acc += w * src.read(uint2(clamp(int2(i, j), int2(0), lim))).rgb;
            wsum += w;
        }
    }
    dst.write(float4(clamp(acc / wsum, 0.0, 1.0), 1.0), gid);
}

// Pass 2 (per frame): cut the frame out of the prepared picture through the frame's affine.
kernel void render_rgb(texture2d<float, access::read> pic [[texture(0)]],
                       texture2d<float, access::write> dst [[texture(1)]],
                       constant Params &p [[buffer(0)]],
                       uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= (uint)p.outW || gid.y >= (uint)p.outH) return;
    float2 d = float2(gid) + 0.5 - float2(p.outW, p.outH) * 0.5;
    // canvas = c + R(-rot) d / z   (y down: +rot is clockwise on screen); the prepared picture is the canvas x prepScale
    float cr = cos(p.rot), sr = sin(p.rot);
    float2 rd = float2(d.x * cr + d.y * sr, -d.x * sr + d.y * cr) / p.z;
    float2 prep = (float2(p.cx, p.cy) + rd) * float2(p.prepW / p.outW, p.prepH / p.outH);
    float2 ratio = max(float2(p.prepW / p.outW, p.prepH / p.outH) / p.z, float2(1.0));
    int kind = p.kernelType;
    int taps = (kind == 2) ? 3 : 1;
    float2 rad = float2(taps) * ratio;
    int2 lo = int2(floor(prep - rad)), hi = int2(ceil(prep + rad));
    int2 lim = int2(p.prepW, p.prepH) - 1;
    float3 acc = 0.0; float wsum = 0.0;
    for (int j = lo.y; j <= hi.y; j++) {
        float wy = weight((float(j) + 0.5 - prep.y) / ratio.y, kind);
        if (wy == 0.0) continue;
        for (int i = lo.x; i <= hi.x; i++) {
            float w = wy * weight((float(i) + 0.5 - prep.x) / ratio.x, kind);
            if (w == 0.0) continue;
            // outside the prepared canvas is black (what `rotate` shows past the edge)
            float3 c = (i < 0 || j < 0 || i > lim.x || j > lim.y) ? float3(0.0) : pic.read(uint2(i, j)).rgb;
            acc += w * c;
            wsum += w;
        }
    }
    dst.write(float4(clamp(acc / wsum, 0.0, 1.0), 1.0), gid);
}

kernel void blur_pass(texture2d<float, access::read> src [[texture(0)]],
                      texture2d<float, access::write> dst [[texture(1)]],
                      constant float2 &axisSigma [[buffer(0)]],      // x = 1 horizontal / 0 vertical, y = sigma
                      uint2 gid [[thread_position_in_grid]]) {
    int2 size = int2(src.get_width(), src.get_height());
    if (int(gid.x) >= size.x || int(gid.y) >= size.y) return;
    float sigma = axisSigma.y;
    int r = max(1, int(ceil(sigma * 3.0)));
    int2 step = axisSigma.x > 0.5 ? int2(1, 0) : int2(0, 1);
    float3 acc = 0.0; float wsum = 0.0;
    for (int k = -r; k <= r; k++) {
        float w = exp(-0.5 * float(k * k) / (sigma * sigma));
        acc += w * src.read(uint2(clamp(int2(gid) + step * k, int2(0), size - 1))).rgb;
        wsum += w;
    }
    dst.write(float4(acc / wsum, 1.0), gid);
}

// RGB (0..1, gamma-coded code values) -> limited-range YCbCr 4:2:0 (NV12).
kernel void to_nv12(texture2d<float, access::read> src [[texture(0)]],
                    texture2d<float, access::write> yOut [[texture(1)]],
                    texture2d<float, access::write> cOut [[texture(2)]],
                    constant Params &p [[buffer(0)]],
                    uint2 gid [[thread_position_in_grid]]) {
    // one thread per 2x2 block
    uint2 base = gid * 2;
    if (base.x >= (uint)p.outW || base.y >= (uint)p.outH) return;
    float Kr = p.matrixKr, Kb = p.matrixKb, Kg = 1.0 - Kr - Kb;
    float cbSum = 0.0, crSum = 0.0;
    for (uint dy = 0; dy < 2; dy++) {
        for (uint dx = 0; dx < 2; dx++) {
            uint2 q = base + uint2(dx, dy);
            float3 c = src.read(q).rgb * p.gain;
            float y = Kr * c.r + Kg * c.g + Kb * c.b;
            yOut.write(float4((16.0 + 219.0 * y) / 255.0, 0, 0, 1), q);
            cbSum += (c.b - y) / (2.0 * (1.0 - Kb));
            crSum += (c.r - y) / (2.0 * (1.0 - Kr));
        }
    }
    float cb = (128.0 + 224.0 * (cbSum * 0.25)) / 255.0;
    float cr = (128.0 + 224.0 * (crSum * 0.25)) / 255.0;
    cOut.write(float4(cb, cr, 0, 1), gid);
}
"""

let library: MTLLibrary
do { library = try device.makeLibrary(source: shaderSource, options: nil) } catch { fail(4, "shader compile: \(error)") }
func pipeline(_ name: String) -> MTLComputePipelineState {
    guard let fn = library.makeFunction(name: name), let ps = try? device.makeComputePipelineState(function: fn) else { fail(4, "pipeline \(name)") }
    return ps
}
let psPrepare = pipeline("prepare_picture"), psRender = pipeline("render_rgb"), psBlur = pipeline("blur_pass"), psNV12 = pipeline("to_nv12")

let srcDesc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: srcW, height: srcH, mipmapped: false)
srcDesc.usage = .shaderRead
guard let srcTex = device.makeTexture(descriptor: srcDesc) else { fail(4, "source texture") }
rgba.withUnsafeBytes { srcTex.replace(region: MTLRegionMake2D(0, 0, srcW, srcH), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: srcW * 4) }
func workTexture() -> MTLTexture {
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: W, height: H, mipmapped: false)
    d.usage = [.shaderRead, .shaderWrite]
    d.storageMode = .private
    guard let t = device.makeTexture(descriptor: d) else { fail(4, "work texture") }
    return t
}
let texA = workTexture(), texB = workTexture()
let pDesc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: Int(prepW), height: Int(prepH), mipmapped: false)
pDesc.usage = [.shaderRead, .shaderWrite]
pDesc.storageMode = .private
guard let picTex = device.makeTexture(descriptor: pDesc) else { fail(4, "prepared texture") }

struct Params {
    var outW: Float, outH: Float, srcW: Float, srcH: Float
    var prepW: Float, prepH: Float, padX: Float, padY: Float
    var fitWp: Float, fitHp: Float
    var cx: Float, cy: Float, z: Float, rot: Float
    var gain: Float
    var kernelType: Int32
    var matrixKr: Float, matrixKb: Float
}
let kernelType: Int32 = (job.resample ?? "lanczos") == "bilinear" ? 3 : 2
let useBT709 = (job.matrix ?? "bt601") == "bt709"
let (Kr, Kb): (Float, Float) = useBT709 ? (0.2126, 0.0722) : (0.299, 0.114)

func grid(_ enc: MTLComputeCommandEncoder, _ ps: MTLComputePipelineState, _ w: Int, _ h: Int) {
    let tw = ps.threadExecutionWidth, th = max(1, ps.maxTotalThreadsPerThreadgroup / tw)
    enc.dispatchThreads(MTLSize(width: w, height: h, depth: 1), threadsPerThreadgroup: MTLSize(width: tw, height: th, depth: 1))
}

/// Encode one frame's work into `cb`; the finished RGB lives in the returned texture.
func baseParams(_ f: PlanFrame, gain: Float) -> Params {
    Params(outW: Float(W), outH: Float(H), srcW: Float(srcW), srcH: Float(srcH),
           prepW: Float(prepW), prepH: Float(prepH), padX: Float(padXp), padY: Float(padYp),
           fitWp: Float(fitWp), fitHp: Float(fitHp),
           cx: Float(f.cx), cy: Float(f.cy), z: Float(f.z), rot: Float(f.rot), gain: gain,
           kernelType: kernelType, matrixKr: Kr, matrixKb: Kb)
}

/// Pass 1, once per clip.
do {
    guard let cb = queue.makeCommandBuffer(), let enc = cb.makeComputeCommandEncoder() else { fail(4, "prepare encoder") }
    var p = baseParams(job.frames[0], gain: 1)
    enc.setComputePipelineState(psPrepare)
    enc.setTexture(srcTex, index: 0); enc.setTexture(picTex, index: 1)
    enc.setBytes(&p, length: MemoryLayout<Params>.size, index: 0)
    grid(enc, psPrepare, Int(prepW), Int(prepH))
    enc.endEncoding()
    cb.commit(); cb.waitUntilCompleted()
    if cb.status != .completed { fail(4, "prepare pass: \(cb.error?.localizedDescription ?? "?")") }
}

/// Encode one frame's work into `cb`; the finished RGB lives in the returned texture.
func encodeRGB(_ f: PlanFrame, _ cb: MTLCommandBuffer) -> MTLTexture {
    var p = baseParams(f, gain: 1)
    guard let enc = cb.makeComputeCommandEncoder() else { fail(4, "encoder") }
    enc.setComputePipelineState(psRender)
    enc.setTexture(picTex, index: 0); enc.setTexture(texA, index: 1)
    enc.setBytes(&p, length: MemoryLayout<Params>.size, index: 0)
    grid(enc, psRender, W, H)
    var cur = texA, other = texB
    for sigma in f.blur where sigma > 0 {
        for axis in [Float(1), Float(0)] {
            var a = SIMD2<Float>(axis, Float(sigma))
            enc.setComputePipelineState(psBlur)
            enc.setTexture(cur, index: 0); enc.setTexture(other, index: 1)
            enc.setBytes(&a, length: MemoryLayout<SIMD2<Float>>.size, index: 0)
            grid(enc, psBlur, W, H)
            swap(&cur, &other)
        }
    }
    enc.endEncoding()
    return cur
}

// ── Encode ───────────────────────────────────────────────────────────────────
let outURL = URL(fileURLWithPath: job.output)
try? FileManager.default.removeItem(at: outURL)
let timescale = Int32(job.fps * 512)   // FFmpeg's mp4 muxer lands on fps*512 (12288 at 24 fps); xfade needs the inputs' time bases to agree.

let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4) } catch { fail(4, "writer: \(error)") }
let compression: [String: Any] = [
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoExpectedSourceFrameRateKey: job.fps,
    AVVideoMaxKeyFrameIntervalKey: job.fps * 10,
    AVVideoAllowFrameReorderingKey: false,
    AVVideoQualityKey: job.quality ?? 0.7,
]
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: compression,
    AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.mediaTimeScale = timescale
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
    kCVPixelBufferMetalCompatibilityKey as String: true,
    kCVPixelBufferIOSurfacePropertiesKey as String: [:],
])
guard writer.canAdd(input) else { fail(4, "writer rejected the video input") }
writer.add(input)
guard writer.startWriting() else { fail(4, "startWriting: \(writer.error?.localizedDescription ?? "?")") }
writer.startSession(atSourceTime: .zero)

var textureCache: CVMetalTextureCache?
CVMetalTextureCacheCreate(nil, nil, device, nil, &textureCache)
guard let cache = textureCache else { fail(4, "texture cache") }

func planeTexture(_ pb: CVPixelBuffer, plane: Int, format: MTLPixelFormat) -> (MTLTexture, CVMetalTexture) {
    var ref: CVMetalTexture?
    let pw = CVPixelBufferGetWidthOfPlane(pb, plane), ph = CVPixelBufferGetHeightOfPlane(pb, plane)
    CVMetalTextureCacheCreateTextureFromImage(nil, cache, pb, nil, format, pw, ph, plane, &ref)
    guard let r = ref, let t = CVMetalTextureGetTexture(r) else { fail(4, "plane texture") }
    return (t, r)
}

for (i, f) in job.frames.enumerated() {
    while !input.isReadyForMoreMediaData { usleep(300) }
    guard let pool = adaptor.pixelBufferPool else { fail(4, "no pixel buffer pool") }
    var pbOpt: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOpt)
    guard let pb = pbOpt else { fail(4, "pixel buffer") }
    let (yTex, yRef) = planeTexture(pb, plane: 0, format: .r8Unorm)
    let (cTex, cRef) = planeTexture(pb, plane: 1, format: .rg8Unorm)
    guard let cb = queue.makeCommandBuffer() else { fail(4, "command buffer") }
    let rgb = encodeRGB(f, cb)
    // gain (fade) is applied inside the conversion pass's params below
    var p = baseParams(f, gain: Float(max(0, min(1, f.gain))))
    guard let enc = cb.makeComputeCommandEncoder() else { fail(4, "encoder") }
    enc.setComputePipelineState(psNV12)
    enc.setTexture(rgb, index: 0); enc.setTexture(yTex, index: 1); enc.setTexture(cTex, index: 2)
    enc.setBytes(&p, length: MemoryLayout<Params>.size, index: 0)
    grid(enc, psNV12, W / 2, H / 2)
    enc.endEncoding()
    cb.commit()
    cb.waitUntilCompleted()
    if cb.status != .completed { fail(4, "GPU frame \(i): \(cb.error?.localizedDescription ?? "?")") }
    withExtendedLifetime((yRef, cRef)) {}
    CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
    if !adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i) * 512, timescale: timescale)) {
        fail(4, "append frame \(i): \(writer.error?.localizedDescription ?? "?")")
    }
}
input.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.endSession(atSourceTime: CMTime(value: CMTimeValue(job.frames.count) * 512, timescale: timescale))
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status != .completed { fail(4, "finish: \(writer.error?.localizedDescription ?? "?")") }
