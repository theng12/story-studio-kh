// Sketch Draw v2: multi-scale level-set ink on paper, drawn subject-first, with five reveal styles.
// No upstream assets and no runtime: every field is computed here, the depth proxy is model-free,
// and every random stream is seeded, so a re-render of the same scene is the same clip.
//
// The contract it keeps, unchanged from the v1 helper:
//   * the loop is `for f in 0..<frames`: the frame count is structural, never a side effect;
//   * the closing hold renders the FINISHED drawing and holds it, frozen;
//   * the pen tip is the newest stroke's last point, hidden in the hold and whenever any part of
//     the stamp would clip the frame;
//   * the fit, the paper ground, the NV12 conversion and the encode settings are the ones the app
//     and `lib/native-scene-clip.ts` already agree on.
//
// What is new (the approved prototype is the evidence: RESULTS.md in sketch-draw-v2-20261025):
//   1. multi-scale level sets — four bands contour the picture against their own local mean, so a
//      hazy 4 px column edge is as findable as a 400 px cliff, and a gradient gate keeps flat fills
//      free of dirt;
//   2. two-tone ink — a dark tone for the lit ground and a pale tone for the dark ground, split by
//      the picture's own tonal range, so a dark picture is drawable at all; the pale half is
//      composited only where the picture's colour has already arrived;
//   3. subject-first order — strokes are bucketed into depth zones from a model-free saliency proxy
//      and the nearest zone is finished before the next begins;
//   4. five reveal timelines over one renderer, each a table of timings plus a scalar field T that
//      drives the picture's alpha; the job's `reveal` names the one this scene resolved to.
//
// Cost is bounded by doing each frame as ONE parallel pass over row bands with byte maths: the
// fields never move, only the frame's scalar does.
import Foundation
import AVFoundation
import CoreVideo
import CoreGraphics
import CoreText
import ImageIO

struct SketchPen: Decodable {
    var mode: String
    var text: String?
    var logo: String?
}

struct SketchJob: Decodable {
    var kind: String
    var input: String
    var output: String
    var width: Int
    var height: Int
    var fps: Int
    var frames: Int
    var hold_frames: Int?      // exact closing hold; 1...frames-2, or frames when frames < 3. Default: sketchDefaultHold
    var paper: String
    var pen: SketchPen
    var quality: Double?
    var reveal: String?        // line | buildup | swipes | patches | bloom | colour. Default: line.
    var line_weight: String?   // thin | normal | bold. Default: normal — the engine's own weight.
    // Optional 8-bit depth map for THIS scene (the episode's own Scene Analysis depth), used only by
    // `colour` to paint the subject first. Absent, unreadable or flat: no subject phase, never an
    // invented one — the reveal never guesses where the subject is.
    var mask: String?
}

/// The closing hold the app and the helper agree on; lib/native-scene-clip.ts mirrors it.
func sketchDefaultHold(frames: Int, fps: Int) -> Int {
    if frames < 3 { return frames }
    return min(frames - 2, max(1, Int(min(2.5 * Double(fps), Double(frames) / 2).rounded())))
}

/// The reveal styles this engine draws. `mix` is resolved per scene by the app, never here.
enum SketchReveal: String {
    case line, buildup, swipes, patches, bloom, colour
    static let names = ["line", "buildup", "swipes", "patches", "bloom", "colour"]
}

/// The ink weights this engine draws. `normal` is the engine's own weight — the band widths the
/// renderer has always used — so a clip that asks for nothing is drawn exactly as before.
enum SketchLineWeight: String {
    case thin, normal, bold
    static let names = ["thin", "normal", "bold"]
    /// The multiplier applied to every stroke's width. Measured against rendered samples, not guessed.
    var scale: Float {
        switch self {
        case .thin: return 0.62
        case .normal: return 1.0
        case .bold: return 1.45
        }
    }
}

private final class SketchBitmap {
    let width: Int, height: Int
    let bytes: UnsafeMutablePointer<UInt8>
    let context: CGContext
    init(_ w: Int, _ h: Int) {
        width = w; height = h
        bytes = .allocate(capacity: w * h * 4)
        bytes.initialize(repeating: 255, count: w * h * 4)
        guard let c = CGContext(data: bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            fail(4, "sketch bitmap")
        }
        context = c
    }
    deinit { bytes.deinitialize(count: width * height * 4); bytes.deallocate() }
}

private func sketchImage(_ path: String) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
          image.width > 0, image.height > 0, image.width <= 16384, image.height <= 16384 else {
        fail(3, "cannot decode sketch image \(path)")
    }
    return image
}

// ── Parallel row bands ───────────────────────────────────────────────────────
// Every full-picture pass is pointwise, so it runs over row bands on all cores. A frame is one
// call, not one per layer: the thread hand-off would cost more than the arithmetic.

private func forRows(_ h: Int, _ body: (Int, Int) -> Void) {
    let bands = max(1, min(ProcessInfo.processInfo.activeProcessorCount, h))
    if bands == 1 { body(0, h); return }
    DispatchQueue.concurrentPerform(iterations: bands) { b in
        let y0 = h * b / bands, y1 = h * (b + 1) / bands
        if y1 > y0 { body(y0, y1) }
    }
}

// ── Planar primitives ────────────────────────────────────────────────────────

@inline(__always) private func v2Len(_ v: SIMD2<Float>) -> Float { (v.x * v.x + v.y * v.y).squareRoot() }

private func v2Unit(_ v: inout [Float]) {
    var lo = Float.greatestFiniteMagnitude, hi = -Float.greatestFiniteMagnitude
    for x in v { if x < lo { lo = x }; if x > hi { hi = x } }
    guard hi - lo > 1e-6 else { for i in v.indices { v[i] = 0 }; return }
    let scale = 1 / (hi - lo)
    for i in v.indices { v[i] = (v[i] - lo) * scale }
}

private func v2Bilinear(_ src: UnsafePointer<Float>, _ sw: Int, _ sh: Int, _ w: Int, _ h: Int, _ dst: UnsafeMutablePointer<Float>) {
    let scale = Double(sw) / Double(w)
    for y in 0..<h {
        let fy = (Double(y) + 0.5) * scale - 0.5
        let y0 = max(0, min(sh - 1, Int(floor(fy))))
        let y1 = min(sh - 1, y0 + 1)
        let wy = Float(max(0, min(1, fy - Double(y0))))
        let r0 = y0 * sw, r1 = y1 * sw
        for x in 0..<w {
            let fx = (Double(x) + 0.5) * scale - 0.5
            let x0 = max(0, min(sw - 1, Int(floor(fx))))
            let x1 = min(sw - 1, x0 + 1)
            let wx = Float(max(0, min(1, fx - Double(x0))))
            let top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * wx
            let bot = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * wx
            dst[y * w + x] = top + (bot - top) * wy
        }
    }
}

private func v2Kernel(_ sigma: Float) -> [Float] {
    let r = max(1, Int((sigma * 3).rounded()))
    var k = [Float](repeating: 0, count: 2 * r + 1)
    var sum: Float = 0
    for i in -r...r { let v = exp(-Float(i * i) / (2 * sigma * sigma)); k[i + r] = v; sum += v }
    for i in k.indices { k[i] /= sum }
    return k
}

private let v2LevelKernel: [Float] = [0.25, 0.5, 0.25]

private func v2BlurInPlace(_ buf: UnsafeMutablePointer<Float>, _ w: Int, _ h: Int, _ kernel: [Float]) {
    let r = kernel.count / 2
    let tmp = UnsafeMutablePointer<Float>.allocate(capacity: w * h)
    kernel.withUnsafeBufferPointer { kp in
        let kb = kp.baseAddress!
        forRows(h) { y0, y1 in
            for y in y0..<y1 {
                let row = y * w
                for x in 0..<w {
                    var acc: Float = 0
                    if x >= r && x + r < w {
                        for t in -r...r { acc += buf[row + x + t] * kb[t + r] }
                    } else {
                        for t in -r...r { acc += buf[row + min(w - 1, max(0, x + t))] * kb[t + r] }
                    }
                    tmp[row + x] = acc
                }
            }
        }
        forRows(h) { y0, y1 in
            for y in y0..<y1 {
                let row = y * w
                for x in 0..<w {
                    var acc: Float = 0
                    if y >= r && y + r < h {
                        for t in -r...r { acc += tmp[(y + t) * w + x] * kb[t + r] }
                    } else {
                        for t in -r...r { acc += tmp[min(h - 1, max(0, y + t)) * w + x] * kb[t + r] }
                    }
                    buf[row + x] = acc
                }
            }
        }
    }
    tmp.deallocate()
}

/// A gaussian blur of a Float plane. Sigmas above 3 px are done on a pyramid: for the fields this
/// feeds, a 46 px blur and a 6 px blur of the same picture are the same answer, and the pyramid is
/// two orders of magnitude cheaper. Each level gets a small smoothing pass on the way up, so the
/// bilinear upsample never leaves facets.
private func v2Blur(_ src: UnsafePointer<Float>, _ w: Int, _ h: Int, _ sigma: Float) -> [Float] {
    var out = [Float](repeating: 0, count: w * h)
    if sigma < 0.35 {
        out.withUnsafeMutableBufferPointer { $0.baseAddress!.update(from: src, count: w * h) }
        return out
    }
    let levels = max(0, Int(log2(max(1, sigma / 3))))
    if levels == 0 {
        out.withUnsafeMutableBufferPointer { $0.baseAddress!.update(from: src, count: w * h) }
        out.withUnsafeMutableBufferPointer { v2BlurInPlace($0.baseAddress!, w, h, v2Kernel(sigma)) }
        return out
    }
    // Down the pyramid, keeping every level so it can be reused on the way up.
    var chain: [[Float]] = []
    var dims: [(Int, Int)] = []
    var current = out
    current.withUnsafeMutableBufferPointer { $0.baseAddress!.update(from: src, count: w * h) }
    chain.append(current)
    dims.append((w, h))
    for _ in 0..<levels {
        let (pw, ph) = dims[dims.count - 1]
        let nw = max(4, pw / 2), nh = max(4, ph / 2)
        var next = [Float](repeating: 0, count: nw * nh)
        chain[chain.count - 1].withUnsafeBufferPointer { sp in
            next.withUnsafeMutableBufferPointer { np in
                for y in 0..<nh {
                    let r0 = min(ph - 1, y * 2), r1 = min(ph - 1, y * 2 + 1)
                    let a0 = r0 * pw, a1 = r1 * pw
                    for x in 0..<nw {
                        let c0 = min(pw - 1, x * 2), c1 = min(pw - 1, x * 2 + 1)
                        np[y * nw + x] = (sp[a0 + c0] + sp[a0 + c1] + sp[a1 + c0] + sp[a1 + c1]) * 0.25
                    }
                }
            }
        }
        chain.append(next); dims.append((nw, nh))
    }
    let (cw, ch) = dims[dims.count - 1]
    chain[chain.count - 1].withUnsafeMutableBufferPointer { v2BlurInPlace($0.baseAddress!, cw, ch, v2Kernel(sigma / Float(1 << levels))) }
    for i in stride(from: chain.count - 2, through: 0, by: -1) {
        let (sw, sh) = dims[i + 1]
        let (tw, th) = dims[i]
        var up = [Float](repeating: 0, count: tw * th)
        chain[i + 1].withUnsafeBufferPointer { sp in
            up.withUnsafeMutableBufferPointer { v2Bilinear(sp.baseAddress!, sw, sh, tw, th, $0.baseAddress!) }
        }
        up.withUnsafeMutableBufferPointer { v2BlurInPlace($0.baseAddress!, tw, th, v2LevelKernel) }
        chain[i] = up
    }
    return chain[0]
}

/// A percentile of a plane, by histogram: an exact order statistic is not worth a sort here.
private func v2Percentile(_ v: UnsafePointer<Float>, _ n: Int, _ pct: Float) -> Float {
    var lo = Float.greatestFiniteMagnitude, hi = -Float.greatestFiniteMagnitude
    for i in 0..<n { let x = v[i]; if x < lo { lo = x }; if x > hi { hi = x } }
    if !(hi > lo) { return lo }
    let bins = 4096
    var hist = [Int32](repeating: 0, count: bins)
    let scale = Float(bins - 1) / (hi - lo)
    for i in 0..<n { hist[min(bins - 1, max(0, Int((v[i] - lo) * scale)))] += 1 }
    let want = Int(Float(n) * pct / 100)
    var seen = 0
    for b in 0..<bins {
        seen += Int(hist[b])
        if seen > want { return lo + (Float(b) + 0.5) / scale }
    }
    return hi
}

/// Spectral-residual saliency plus a lower-in-frame bias: the model-free stand-in for depth. It
/// answers the two questions the reveal types actually ask — where the subject is and what is near.
/// The app bundles no depth model, so this is the whole answer, not a fallback.
private func v2Salience(_ lum: UnsafePointer<Float>, _ w: Int, _ h: Int) -> [Float] {
    let sh = 54, sw = max(8, Int((54.0 * Double(w) / Double(max(1, h))).rounded()))
    var small = [Float](repeating: 0, count: sw * sh)
    v2BilinearDown(lum, w, h, sw, sh, &small)
    // Separable naive DFT: 54x96 is 5k points, where a direct sum beats an FFT setup for its cost.
    let n = sw * sh
    var cosT = [Float](repeating: 0, count: sw * sw), sinT = [Float](repeating: 0, count: sw * sw)
    for u in 0..<sw { for x in 0..<sw {
        let a = -2.0 * Float.pi * Float(u * x) / Float(sw)
        cosT[u * sw + x] = cos(a); sinT[u * sw + x] = sin(a)
    } }
    var cosR = [Float](repeating: 0, count: sh * sh), sinR = [Float](repeating: 0, count: sh * sh)
    for v in 0..<sh { for y in 0..<sh {
        let a = -2.0 * Float.pi * Float(v * y) / Float(sh)
        cosR[v * sh + y] = cos(a); sinR[v * sh + y] = sin(a)
    } }
    var re = [Float](repeating: 0, count: n), im = [Float](repeating: 0, count: n)
    var tre = [Float](repeating: 0, count: n), tim = [Float](repeating: 0, count: n)
    for y in 0..<sh { for u in 0..<sw {
        var sr: Float = 0, si: Float = 0
        for x in 0..<sw { let v = small[y * sw + x]; sr += v * cosT[u * sw + x]; si += v * sinT[u * sw + x] }
        tre[y * sw + u] = sr; tim[y * sw + u] = si
    } }
    for u in 0..<sw { for v in 0..<sh {
        var sr: Float = 0, si: Float = 0
        for y in 0..<sh {
            let a = tre[y * sw + u], b = tim[y * sw + u]
            sr += a * cosR[v * sh + y] - b * sinR[v * sh + y]
            si += a * sinR[v * sh + y] + b * cosR[v * sh + y]
        }
        re[v * sw + u] = sr; im[v * sw + u] = si
    } }
    var logAmp = [Float](repeating: 0, count: n)
    for i in 0..<n { logAmp[i] = log(max(1e-9, (re[i] * re[i] + im[i] * im[i]).squareRoot())) }
    let smoothed = v2Blur(logAmp, sw, sh, 2.5)
    var cre = [Float](repeating: 0, count: n), cim = [Float](repeating: 0, count: n)
    for i in 0..<n {
        let mag = (re[i] * re[i] + im[i] * im[i]).squareRoot()
        guard mag > 1e-9 else { continue }
        // exp(residual) carries the spectral residual's magnitude; the unit-magnitude phase is spec/|spec|.
        let amp = exp(logAmp[i] - smoothed[i]) / mag
        cre[i] = re[i] * amp; cim[i] = im[i] * amp
    }
    for y in 0..<sh { for u in 0..<sw {
        var sr: Float = 0, si: Float = 0
        for x in 0..<sw {
            let a = cre[y * sw + x], b = cim[y * sw + x]
            sr += a * cosT[u * sw + x] - b * sinT[u * sw + x]
            si += a * sinT[u * sw + x] + b * cosT[u * sw + x]
        }
        tre[y * sw + u] = sr; tim[y * sw + u] = si
    } }
    for u in 0..<sw { for v in 0..<sh {
        var sr: Float = 0, si: Float = 0
        for y in 0..<sh {
            let a = tre[y * sw + u], b = tim[y * sw + u]
            sr += a * cosR[v * sh + y] - b * sinR[v * sh + y]
            si += a * sinR[v * sh + y] + b * cosR[v * sh + y]
        }
        re[v * sw + u] = sr / Float(sh); im[v * sw + u] = si / Float(sh)
    } }
    var sal = [Float](repeating: 0, count: n)
    for i in 0..<n { sal[i] = re[i] * re[i] + im[i] * im[i] }
    sal.withUnsafeMutableBufferPointer { v2BlurInPlace($0.baseAddress!, sw, sh, v2Kernel(2.0)) }
    v2Unit(&sal)
    var near = [Float](repeating: 0, count: n)
    for y in 0..<sh {
        let bias = 0.30 + 0.70 * (sh > 1 ? Float(y) / Float(sh - 1) : 0)
        for x in 0..<sw { near[y * sw + x] = 0.62 * sal[y * sw + x] + 0.38 * bias }
    }
    near.withUnsafeMutableBufferPointer { v2BlurInPlace($0.baseAddress!, sw, sh, v2Kernel(3.0)) }
    var full = [Float](repeating: 0, count: w * h)
    near.withUnsafeBufferPointer { sp in full.withUnsafeMutableBufferPointer { v2Bilinear(sp.baseAddress!, sw, sh, w, h, $0.baseAddress!) } }
    var lo = Float.greatestFiniteMagnitude, hi = -Float.greatestFiniteMagnitude
    for x in full { if x < lo { lo = x }; if x > hi { hi = x } }
    let p1 = v2Percentile(full, full.count, 1), p99 = v2Percentile(full, full.count, 99)
    let span = p99 - p1
    if span < 1e-6 { for i in full.indices { full[i] = 0.5 } }
    else { for i in full.indices { full[i] = max(0, min(1, (full[i] - p1) / span)) } }
    return full
}

private func v2BilinearDown(_ src: UnsafePointer<Float>, _ w: Int, _ h: Int, _ sw: Int, _ sh: Int, _ dst: inout [Float]) {
    for y in 0..<sh {
        let fy = (Double(y) + 0.5) * Double(h) / Double(sh) - 0.5
        let y0 = max(0, min(h - 1, Int(floor(fy)))), y1 = min(h - 1, y0 + 1)
        let wy = Float(max(0, min(1, fy - Double(y0))))
        for x in 0..<sw {
            let fx = (Double(x) + 0.5) * Double(w) / Double(sw) - 0.5
            let x0 = max(0, min(w - 1, Int(floor(fx)))), x1 = min(w - 1, x0 + 1)
            let wx = Float(max(0, min(1, fx - Double(x0))))
            let top = src[y0 * w + x0] + (src[y0 * w + x1] - src[y0 * w + x0]) * wx
            let bot = src[y1 * w + x0] + (src[y1 * w + x1] - src[y1 * w + x0]) * wx
            dst[y * sw + x] = top + (bot - top) * wy
        }
    }
}

/// Deterministic value stream for the fields' jitter. numpy's PCG64 is not reproducible here, and
/// does not need to be: what the contract needs is that the SAME picture renders the SAME clip.
private struct SketchRng {
    private var state: UInt64
    init(_ seed: UInt64) { state = seed &+ 0x9E3779B97F4A7C15 }
    mutating func next() -> UInt64 {
        state = state &+ 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func unit() -> Float { Float(next() >> 40) / Float(1 << 24) }
}

private func v2UnitNoise(_ w: Int, _ h: Int, _ seed: UInt64, _ sigma: Float) -> [Float] {
    var rng = SketchRng(seed)
    var field = [Float](repeating: 0, count: w * h)
    for i in field.indices { field[i] = rng.unit() }
    field.withUnsafeMutableBufferPointer { v2BlurInPlace($0.baseAddress!, w, h, v2Kernel(sigma)) }
    v2Unit(&field)
    return field
}

// ── Marching squares ─────────────────────────────────────────────────────────
// The level set of a blurred luminance field is one curve wherever it crosses the level, so an
// ordered polyline falls out of the grid walk — no skeleton, no junction bookkeeping, and every
// point of it is already stroke geometry. Cells whose four corners sit on one side are rejected by
// two compares, which is what keeps a 2 MP sweep cheap.

private func v2LevelContours(
    _ f: UnsafePointer<Float>, _ w: Int, _ h: Int, _ level: Float,
    _ edgeA: UnsafeMutablePointer<Int32>, _ edgeB: UnsafeMutablePointer<Int32>,
    _ touched: inout [Int32], _ chains: inout [[SIMD2<Float>]], _ closed: inout [Bool]
) {
    let plane = w * h
    var segEA: [Int32] = [], segEB: [Int32] = []
    var segPA: [SIMD2<Float>] = [], segPB: [SIMD2<Float>] = []
    segEA.reserveCapacity(4096); segEB.reserveCapacity(4096)
    segPA.reserveCapacity(4096); segPB.reserveCapacity(4096)
    let base = plane
    func horizontal(_ x: Int, _ y: Int) -> SIMD2<Float> {
        let a = f[y * w + x], b = f[y * w + x + 1]
        let t = abs(b - a) > 1e-12 ? (level - a) / (b - a) : 0.5
        return SIMD2<Float>(Float(x) + t, Float(y))
    }
    func vertical(_ x: Int, _ y: Int) -> SIMD2<Float> {
        let a = f[y * w + x], b = f[(y + 1) * w + x]
        let t = abs(b - a) > 1e-12 ? (level - a) / (b - a) : 0.5
        return SIMD2<Float>(Float(x), Float(y) + t)
    }
    var edges = [Int32](repeating: 0, count: 4)
    var points = [SIMD2<Float>](repeating: SIMD2<Float>(0, 0), count: 4)
    for y in 0..<(h - 1) {
        let r0 = y * w, r1 = (y + 1) * w
        for x in 0..<(w - 1) {
            let a = f[r0 + x], b = f[r0 + x + 1], cc = f[r1 + x + 1], d = f[r1 + x]
            let lo = min(min(a, b), min(cc, d)), hi = max(max(a, b), max(cc, d))
            if lo > level || hi < level { continue }
            let s0 = a > level, s1 = b > level, s2 = cc > level, s3 = d > level
            var count = 0
            // Edges in T, R, B, L order for the unambiguous two-crossing cases.
            if s0 != s1 { edges[count] = Int32(r0 + x); points[count] = horizontal(x, y); count += 1 }
            if s1 != s2 { edges[count] = Int32(base + r0 + x + 1); points[count] = vertical(x + 1, y); count += 1 }
            if s2 != s3 { edges[count] = Int32(r1 + x); points[count] = horizontal(x, y + 1); count += 1 }
            if s3 != s0 { edges[count] = Int32(base + r0 + x); points[count] = vertical(x, y); count += 1 }
            if count == 2 {
                segEA.append(edges[0]); segEB.append(edges[1]); segPA.append(points[0]); segPB.append(points[1])
            } else if count == 4 {
                // Saddle: the cell's own mean decides which diagonals are joined, so two cells
                // sharing an edge always agree about it.
                let mean = (a + b + cc + d) * 0.25
                if mean > level {
                    segEA.append(edges[0]); segEB.append(edges[3]); segPA.append(points[0]); segPB.append(points[3])
                    segEA.append(edges[1]); segEB.append(edges[2]); segPA.append(points[1]); segPB.append(points[2])
                } else {
                    segEA.append(edges[0]); segEB.append(edges[1]); segPA.append(points[0]); segPB.append(points[1])
                    segEA.append(edges[2]); segEB.append(edges[3]); segPA.append(points[2]); segPB.append(points[3])
                }
            }
        }
    }
    let segments = segEA.count
    guard segments > 0 else { return }
    for i in 0..<segments {
        let e0 = segEA[i], e1 = segEB[i]
        if edgeA[Int(e0)] < 0 { edgeA[Int(e0)] = Int32(2 * i); touched.append(e0) } else { edgeB[Int(e0)] = Int32(2 * i) }
        if edgeA[Int(e1)] < 0 { edgeA[Int(e1)] = Int32(2 * i + 1); touched.append(e1) } else { edgeB[Int(e1)] = Int32(2 * i + 1) }
    }
    func point(_ seg: Int, _ end: Int) -> SIMD2<Float> { end == 0 ? segPA[seg] : segPB[seg] }
    func edgeOf(_ seg: Int, _ end: Int) -> Int32 { end == 0 ? segEA[seg] : segEB[seg] }
    func partner(_ edge: Int32, _ notSeg: Int) -> (Int, Int)? {
        let a = edgeA[Int(edge)], b = edgeB[Int(edge)]
        if a >= 0 && Int(a) / 2 != notSeg { return (Int(a) / 2, Int(a) % 2) }
        if b >= 0 && Int(b) / 2 != notSeg { return (Int(b) / 2, Int(b) % 2) }
        return nil
    }
    var used = [Bool](repeating: false, count: segments)
    func trace(_ start: Int, _ startEnd: Int) -> ([SIMD2<Float>], Bool) {
        var path: [SIMD2<Float>] = [point(start, startEnd)]
        var seg = start, end = startEnd
        while true {
            used[seg] = true
            let exitEnd = 1 - end
            path.append(point(seg, exitEnd))
            guard let next = partner(edgeOf(seg, exitEnd), seg) else { return (path, false) }
            if next.0 == start && next.1 == startEnd { return (path, true) }
            if used[next.0] { return (path, false) }
            seg = next.0; end = next.1
            if path.count > 8_000_000 { return (path, false) }
        }
    }
    // Open chains first, from an endpoint nothing else links to; then anything left is a closed loop.
    for i in 0..<segments where !used[i] {
        for startEnd in 0...1 {
            let edge = edgeOf(i, startEnd)
            if edgeA[Int(edge)] >= 0 && edgeB[Int(edge)] >= 0 { continue }
            let (path, isClosed) = trace(i, startEnd)
            chains.append(path); closed.append(isClosed)
            break
        }
    }
    for i in 0..<segments where !used[i] {
        let (path, isClosed) = trace(i, 0)
        chains.append(path); closed.append(isClosed)
    }
    for e in touched { edgeA[Int(e)] = -1; edgeB[Int(e)] = -1 }
    touched.removeAll(keepingCapacity: true)
}

// ── Strokes ──────────────────────────────────────────────────────────────────

private struct V2Stroke {
    var points: [SIMD2<Float>]
    var length: Float
    var width: Float
    var alpha: Float
    var phase: Int
    var zone: Int
    var meanRow: Float
    var meanCol: Float
    var spatial: Float
    var bloomT: Float
    var jitter: Float
    var rank: Float
}

/// One band per detail level. Each band contours the picture against its own local mean, so a hazy
/// 4 px column edge is as findable as a 400 px cliff. Fields: local window sigma, contrast gain,
/// gradient gate percentile, absolute gate floor, min run length px, contour levels, stroke width px,
/// stroke alpha, phase. A run must also clear the gate by STRENGTH_MARGIN, or marginal blips on flat
/// fills make the drawing look dirty.
private struct V2Band {
    let big: Float, gain: Float, gatePct: Float, floor: Float, minLen: Float
    let levels: [Float], baseW: Float, baseA: Float, phase: Int
}
private let v2Bands: [V2Band] = [
    V2Band(big: 46.0, gain: 3.2, gatePct: 75, floor: 0.005, minLen: 30, levels: [0.42, 0.50, 0.58], baseW: 3.6, baseA: 1.00, phase: 0),
    V2Band(big: 18.0, gain: 4.2, gatePct: 78, floor: 0.009, minLen: 22, levels: [0.46, 0.54], baseW: 2.6, baseA: 0.94, phase: 1),
    V2Band(big: 7.0, gain: 6.0, gatePct: 80, floor: 0.016, minLen: 18, levels: [0.50], baseW: 1.8, baseA: 0.74, phase: 2),
    V2Band(big: 2.4, gain: 10.0, gatePct: 85, floor: 0.030, minLen: 16, levels: [0.50], baseW: 1.1, baseA: 0.46, phase: 3),
]
private let v2StrengthMargin: Float = 1.8

/// Where the closing dissolve starts, as a share of the reveal. Every reveal's ink and tone ease
/// out from here to the end, so the last drawing frame and the whole hold are the scene image.
/// The colour reveal paints its picture to this same point and fades from there, so all six
/// reveals dissolve over the same last 12% of the reveal. Before the dissolve starts, the frame
/// is byte-identical to the approved look.
private let sketchFadeStart: Float = 0.88

// ── The engine ───────────────────────────────────────────────────────────────

private final class SketchV2 {
    let w: Int, h: Int, n: Int
    let reveal: SketchReveal
    /// The ink weight this drawing is drawn with. `normal` scales every stroke by 1, so the
    /// drawing is byte-identical to the one the engine drew before the weight existed.
    let lineWeight: SketchLineWeight
    let paper: [UInt8]
    let zoom: Float

    let picture: UnsafeMutablePointer<UInt8>     // 3n, the fitted canvas RGB
    let inkAcc: UnsafeMutablePointer<UInt8>      // n
    let choose: UnsafeMutablePointer<UInt8>      // n, 255 = dark ink
    let inkDark: UnsafeMutablePointer<UInt8>     // 3n
    let inkPale: UnsafeMutablePointer<UInt8>     // 3n
    let toneRGB: UnsafeMutablePointer<UInt8>     // n
    let toneMap: UnsafeMutablePointer<UInt8>     // n
    let alpha: UnsafeMutablePointer<UInt8>       // n, scratch
    let swipeBase: UnsafeMutablePointer<UInt8>   // 4n, RGBA like the canvas
    let poster: UnsafeMutablePointer<UInt8>      // 3n, rebuilt when the swipe pass changes

    private let fSweep: [Float]
    private let fBloom: [Float]
    private let fPatches: [Float]
    private let swipeProj: [Float]
    private let swipeProjInv: [Float]
    private let pictureF: [[Float]]               // 3 planes kept separately for the poster passes

    private var strokes: [V2Stroke] = []
    private var orders: [String: (idx: [Int32], cum: [Float])] = [:]
    private var drawn: [String: Int] = [:]
    private var posterFor = -1
    private(set) var inked = false
    private(set) var tip: SIMD2<Float>?
    /// The colour reveal's contact timeline; nil for every other style.
    private(set) var colour: ColourPlan?

    init(_ source: SketchBitmap, _ paper: [UInt8], _ reveal: SketchReveal,
         lineWeight: SketchLineWeight = .normal,
         mask: (path: String, rect: (x: Int, y: Int, w: Int, h: Int))? = nil) {
        w = source.width; h = source.height; n = w * h
        self.reveal = reveal
        self.lineWeight = lineWeight
        self.paper = paper
        zoom = max(0.5, Float(w) / 1920.0)
        picture = .allocate(capacity: n * 3)
        inkAcc = .allocate(capacity: n)
        choose = .allocate(capacity: n)
        inkDark = .allocate(capacity: n * 3)
        inkPale = .allocate(capacity: n * 3)
        toneRGB = .allocate(capacity: n)
        toneMap = .allocate(capacity: n)
        alpha = .allocate(capacity: n)
        swipeBase = .allocate(capacity: n * 4)
        poster = .allocate(capacity: n * 3)
        inkAcc.initialize(repeating: 0, count: n)
        alpha.initialize(repeating: 0, count: n)
        for i in 0..<n { let d = i * 4, s = i * 3; picture[s] = source.bytes[d]; picture[s + 1] = source.bytes[d + 1]; picture[s + 2] = source.bytes[d + 2] }
        var lum = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let s = i * 3
            lum[i] = (0.2126 * Float(picture[s]) + 0.7152 * Float(picture[s + 1]) + 0.0722 * Float(picture[s + 2])) / 255.0
        }
        var planes = [[Float](repeating: 0, count: n), [Float](repeating: 0, count: n), [Float](repeating: 0, count: n)]
        for c in 0..<3 { for i in 0..<n { planes[c][i] = Float(picture[i * 3 + c]) } }
        pictureF = planes

        let depth = v2Salience(lum, w, h)
        // Ink tones: one tone cannot draw a dark picture. `choose` splits them on the picture's own
        // tonal range, so a sunset at 0.6 mean and a night portrait at 0.06 both cross over inside
        // their own lights.
        var soft = v2Blur(lum, w, h, max(2.0, Float(w) / 340.0))
        let loQ = v2Percentile(soft, n, 15), hiQ = v2Percentile(soft, n, 85)
        if hiQ - loQ < 0.06 {
            choose.update(repeating: 255, count: n)
        } else {
            let lo = loQ + 0.30 * (hiQ - loQ), span = max(1e-4, 0.40 * (hiQ - loQ))
            for i in 0..<n {
                var t = (soft[i] - lo) / span
                t = t < 0 ? 0 : (t > 1 ? 1 : t)
                choose[i] = UInt8(t * t * (3 - 2 * t) * 255 + 0.5)
            }
        }
        for i in 0..<n {
            for c in 0..<3 {
                inkDark[i * 3 + c] = UInt8(max(0, min(255, Float(picture[i * 3 + c]) * 0.20 + 12.0)))
                inkPale[i * 3 + c] = UInt8(max(0, min(255, Float(picture[i * 3 + c]) * 0.55 + 104.0)))
            }
        }
        // Tone: hatch density where the picture is dark, phase-shifted by low-frequency noise so it
        // reads as drawn rather than as a screen.
        let tone = SketchV2.buildTone(lum, depth, w, h)
        for i in 0..<n {
            toneMap[i] = UInt8(max(0, min(1, tone[i])) * 255 + 0.5)
            let g = (0.299 * Float(picture[i * 3]) + 0.587 * Float(picture[i * 3 + 1]) + 0.114 * Float(picture[i * 3 + 2])) / 255.0
            toneRGB[i] = UInt8(max(0, min(255, (0.58 * g + 0.14) * 255.0)))
        }
        fSweep = reveal == .line ? SketchV2.fieldSweep(depth, w, h) : []
        fBloom = (reveal == .buildup || reveal == .bloom) ? SketchV2.fieldBloom(lum, depth, w, h) : []
        fPatches = reveal == .patches ? SketchV2.fieldPatches(picture, depth, w, h) : []
        var proj = [Float](repeating: 0, count: n)
        for y in 0..<h { for x in 0..<w { proj[y * w + x] = Float(x) / Float(w) * 0.94 + Float(y) / Float(h) * 0.34 } }
        v2Unit(&proj)
        swipeProj = proj
        swipeProjInv = proj.map { 1 - $0 }
        // Paper under the picture, always: the reveal is of the subject, not of a rectangle.
        for i in 0..<n {
            swipeBase[i * 4] = paper[0]; swipeBase[i * 4 + 1] = paper[1]; swipeBase[i * 4 + 2] = paper[2]; swipeBase[i * 4 + 3] = 255
        }
        buildStrokes(lum, depth)
        if strokes.isEmpty {
            FileHandle.standardError.write(Data("scene-clip sketch: no strokes found for this picture; its reveal will be colour only\n".utf8))
        }
        if reveal == .colour {
            // The subject phase needs a real mask. A missing, unreadable or flat depth map is not a
            // reason to guess one: the picture is coloured in one phase instead, and says which.
            var subject: [Bool]? = nil
            if let mask = mask {
                if let plane = colourDepthPlane(mask.path, w, h, mask.rect) {
                    subject = colourSubjectMask(plane, mask.rect, w, h)
                    if subject == nil {
                        FileHandle.standardError.write(Data("scene-clip sketch: this scene's depth map is too flat to separate a subject; colouring without a subject phase\n".utf8))
                    }
                } else {
                    FileHandle.standardError.write(Data("scene-clip sketch: this scene's depth map could not be decoded; colouring without a subject phase\n".utf8))
                }
            }
            let plan = colourPlan(picture: picture, w: w, h: h, strokes: strokes, subject: subject)
            colour = plan
            FileHandle.standardError.write(Data(String(format: "scene-clip sketch colour: %d colour groups, %d brush strokes, %.1f px brush, subject phase %@, plan %.3fs, travel %.0f px\n",
                plan.groups, plan.strokes, plan.brush, plan.subject ? "on" : "off", plan.seconds, plan.travel).utf8))
        }
    }

    deinit {
        picture.deallocate(); inkAcc.deallocate(); choose.deallocate(); inkDark.deallocate(); inkPale.deallocate()
        toneRGB.deallocate(); toneMap.deallocate(); alpha.deallocate(); swipeBase.deallocate(); poster.deallocate()
    }

    // ── Fields ───────────────────────────────────────────────────────────────

    private static func buildTone(_ lum: [Float], _ depth: [Float], _ w: Int, _ h: Int) -> [Float] {
        let blurred = v2Blur(lum, w, h, max(3.0, Float(w) / 480.0))
        var dark = [Float](repeating: 0, count: w * h)
        for i in dark.indices { dark[i] = max(0, min(1, (0.80 - blurred[i]) / 0.62)) }
        let warp = v2UnitNoise(w, h, 7, max(6.0, Float(w) / 90.0))
        var tone = [Float](repeating: 0, count: w * h)
        let a = Float(34.0 * Double.pi / 180.0), a2 = Float((34.0 + 65.9) * Double.pi / 180.0)
        let s1 = max(3.0, Float(w) / 320.0), s2 = max(4.0, Float(w) / 210.0)
        let ca = cos(a), sa = sin(a), ca2 = cos(a2), sa2 = sin(a2)
        for y in 0..<h {
            let fy = Float(y)
            for x in 0..<w {
                let fx = Float(x)
                let proj = (fx * ca + fy * sa) / s1 + warp[y * w + x] * 1.5
                let l1 = 0.5 + 0.5 * cos(2 * Float.pi * proj)
                let proj2 = (fx * ca2 + fy * sa2) / s2 - warp[y * w + x] * 1.5
                let l2 = 0.5 + 0.5 * cos(2 * Float.pi * proj2)
                let d = dark[y * w + x]
                let t = d * (0.62 * l1 * l1 + 0.55 * max(0, min(1, (d - 0.45) / 0.55)) * l2 * l2)
                tone[y * w + x] = max(0, min(1, t)) * (0.72 + 0.28 * depth[y * w + x])
            }
        }
        return v2Blur(tone, w, h, 0.6)
    }

    private static func fieldSweep(_ depth: [Float], _ w: Int, _ h: Int) -> [Float] {
        let noise = v2UnitNoise(w, h, 5, max(4.0, Float(w) / 200.0))
        let a = Float(-18.0 * Double.pi / 180.0)
        let ca = cos(a), sa = sin(a)
        var field = [Float](repeating: 0, count: w * h)
        for y in 0..<h {
            let fy = Float(y) / Float(h)
            for x in 0..<w {
                let proj = Float(x) / Float(w) * ca + fy * sa
                field[y * w + x] = 0.82 * proj + 0.18 * (1 - depth[y * w + x]) * 0.4 + 0.10 * noise[y * w + x]
            }
        }
        v2Unit(&field)
        return field
    }

    /// Where the picture's near subject sits: the centroid of what is both near and detailed. Depth
    /// has to dominate, or a bright distant sun outvotes the thing the scene is about.
    private static func subjectPoint(_ depth: [Float], _ lum: [Float], _ w: Int, _ h: Int) -> (Float, Float) {
        let smooth = v2Blur(lum, w, h, max(1.5, Float(w) / 960.0))
        let energy = v2BlurRawEdges(smooth, w, h)
        var total: Float = 0, sy: Float = 0, sx: Float = 0
        for y in 0..<h {
            for x in 0..<w {
                let near = max(0, depth[y * w + x] - 0.45)
                let weight = near * near * (0.15 + energy[y * w + x])
                total += weight; sy += weight * Float(y); sx += weight * Float(x)
            }
        }
        guard total > 0 else { return (Float(h) * 0.5, Float(w) * 0.5) }
        return (sy / total, sx / total)
    }

    private static func v2BlurRawEdges(_ f: [Float], _ w: Int, _ h: Int) -> [Float] {
        var out = [Float](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let xm = max(0, x - 1), xp = min(w - 1, x + 1)
                let ym = max(0, y - 1), yp = min(h - 1, y + 1)
                let gx = (f[y * w + xp] - f[y * w + xm]) * 0.5
                let gy = (f[yp * w + x] - f[ym * w + x]) * 0.5
                out[y * w + x] = (gx * gx + gy * gy).squareRoot()
            }
        }
        return v2Blur(out, w, h, max(4.0, Float(w) / 240.0))
    }

    private static func fieldBloom(_ lum: [Float], _ depth: [Float], _ w: Int, _ h: Int) -> [Float] {
        let (cy, cx) = subjectPoint(depth, lum, w, h)
        let noise = v2UnitNoise(w, h, 11, max(5.0, Float(w) / 160.0))
        let norm = max(1.0, (Float(h * h + w * w)).squareRoot() * 0.5)
        var field = [Float](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let dy = Float(y) - cy, dx = Float(x) - cx
                let dist = (dy * dy + dx * dx).squareRoot() / norm
                field[y * w + x] = dist * (1.25 - 0.45 * depth[y * w + x]) + 0.28 * noise[y * w + x]
            }
        }
        v2Unit(&field)
        return field
    }

    /// Superpixel order over colour + depth, near-first. SLIC on a small grid, then the rank of each
    /// segment's (depth, height) blurred at roughly a patch width: a big flat superpixel would
    /// otherwise flip whole and leave a hard-edged hole that reads as an error, not a brush.
    private static func fieldPatches(_ picture: UnsafeMutablePointer<UInt8>, _ depth: [Float], _ w: Int, _ h: Int) -> [Float] {
        let sw = max(24, w / 12), sh = max(16, h / 12)
        let count = sw * sh
        var feat = [Float](repeating: 0, count: count * 4)
        for y in 0..<sh {
            let fy = (Double(y) + 0.5) * Double(h) / Double(sh) - 0.5
            let y0 = max(0, min(h - 1, Int(floor(fy)))), y1 = min(h - 1, y0 + 1)
            let wy = Float(max(0, min(1, fy - Double(y0))))
            for x in 0..<sw {
                let fx = (Double(x) + 0.5) * Double(w) / Double(sw) - 0.5
                let x0 = max(0, min(w - 1, Int(floor(fx)))), x1 = min(w - 1, x0 + 1)
                let wx = Float(max(0, min(1, fx - Double(x0))))
                let i = y * sw + x
                for c in 0..<3 {
                    let top = Float(picture[(y0 * w + x0) * 3 + c]) + (Float(picture[(y0 * w + x1) * 3 + c]) - Float(picture[(y0 * w + x0) * 3 + c])) * wx
                    let bot = Float(picture[(y1 * w + x0) * 3 + c]) + (Float(picture[(y1 * w + x1) * 3 + c]) - Float(picture[(y1 * w + x0) * 3 + c])) * wx
                    feat[i * 4 + c] = (top + (bot - top) * wy) / 255.0
                }
                let top = depth[y0 * w + x0] + (depth[y0 * w + x1] - depth[y0 * w + x0]) * wx
                let bot = depth[y1 * w + x0] + (depth[y1 * w + x1] - depth[y1 * w + x0]) * wx
                feat[i * 4 + 3] = (top + (bot - top) * wy) * 1.7
            }
        }
        let segments = 190
        var labels = SketchV2.slic(feat, sw, sh, segments, compactness: 0.10)
        if labels.isEmpty { labels = [Int32](repeating: 0, count: count) }
        let k = (labels.max() ?? 0) + 1
        var dsum = [Double](repeating: 0, count: Int(k)), ysum = [Double](repeating: 0, count: Int(k)), members = [Double](repeating: 0, count: Int(k))
        for y in 0..<sh { for x in 0..<sw {
            let l = Int(labels[y * sw + x])
            dsum[l] += Double(feat[(y * sw + x) * 4 + 3]); ysum[l] += Double(y); members[l] += 1
        } }
        var dmean = [Float](repeating: 0, count: Int(k)), ymean = [Float](repeating: 0, count: Int(k))
        for l in 0..<Int(k) where members[l] > 0 {
            dmean[l] = Float(dsum[l] / members[l]); ymean[l] = Float(ysum[l] / members[l]) / Float(max(1, sh - 1))
        }
        var order = Array(0..<Int(k))
        order.sort { a, b in
            if dmean[a] != dmean[b] { return dmean[a] > dmean[b] }
            return ymean[a] < ymean[b]
        }
        var rank = [Float](repeating: 0, count: Int(k))
        for (i, s) in order.enumerated() { rank[s] = Int(k) > 1 ? Float(i) / Float(Int(k) - 1) : 0 }
        var small = [Float](repeating: 0, count: count)
        for i in 0..<count { small[i] = rank[Int(labels[i])] }
        var full = [Float](repeating: 0, count: w * h)
        small.withUnsafeBufferPointer { sp in
            let nearest = UnsafeMutablePointer<Float>.allocate(capacity: count)
            nearest.update(from: sp.baseAddress!, count: count)
            SketchV2.upsampleNearest(nearest, sw, sh, w, h, &full)
            nearest.deallocate()
        }
        var field = v2Blur(full, w, h, max(6.0, Float(w) / 40.0))
        let noise = v2UnitNoise(w, h, 3, max(4.0, Float(w) / 120.0))
        for i in field.indices { field[i] += 0.22 * noise[i] }
        v2Unit(&field)
        return field
    }

    private static func upsampleNearest(_ src: UnsafeMutablePointer<Float>, _ sw: Int, _ sh: Int, _ w: Int, _ h: Int, _ dst: inout [Float]) {
        for y in 0..<h {
            let sy = min(sh - 1, y * sh / h)
            for x in 0..<w { dst[y * w + x] = src[sy * sw + min(sw - 1, x * sw / w)] }
        }
    }

    /// SLIC: k-means over [r, g, b, depth*1.7] on a coarse grid with a compactness term. Small grid,
    /// few iterations — it only has to group what belongs together, not be a segmentation.
    private static func slic(_ feat: [Float], _ w: Int, _ h: Int, _ segments: Int, compactness: Float) -> [Int32] {
        let count = w * h
        let step = max(1, Int((Double(count) / Double(max(1, segments))).squareRoot().rounded()))
        var cy: [Float] = [], cx: [Float] = [], cc: [[Float]] = [[], [], [], []]
        var y = step / 2
        while y < h {
            var x = step / 2
            while x < w {
                let i = y * w + x
                cy.append(Float(y)); cx.append(Float(x))
                for c in 0..<4 { cc[c].append(feat[i * 4 + c]) }
                x += step
            }
            y += step
        }
        guard !cy.isEmpty else { return [] }
        let k = cy.count
        var labels = [Int32](repeating: 0, count: count)
        var dist = [Float](repeating: .greatestFiniteMagnitude, count: count)
        let compact = compactness / Float(step)
        for _ in 0..<8 {
            for i in 0..<count { dist[i] = .greatestFiniteMagnitude }
            for c in 0..<k {
                let y0 = max(0, Int(cy[c]) - step), y1 = min(h - 1, Int(cy[c]) + step)
                let x0 = max(0, Int(cx[c]) - step), x1 = min(w - 1, Int(cx[c]) + step)
                for yy in y0...y1 {
                    for xx in x0...x1 {
                        let i = yy * w + xx
                        var dc: Float = 0
                        for ch in 0..<4 { let d = feat[i * 4 + ch] - cc[ch][c]; dc += d * d }
                        let dy = Float(yy) - cy[c], dx = Float(xx) - cx[c]
                        let d = dc + compact * compact * (dy * dy + dx * dx)
                        if d < dist[i] { dist[i] = d; labels[i] = Int32(c) }
                    }
                }
            }
            var sy = [Float](repeating: 0, count: k), sx = [Float](repeating: 0, count: k)
            var sc = [[Float]](repeating: [Float](repeating: 0, count: k), count: 4)
            var cn = [Float](repeating: 0, count: k)
            for yy in 0..<h { for xx in 0..<w {
                let i = yy * w + xx, c = Int(labels[i])
                sy[c] += Float(yy); sx[c] += Float(xx); cn[c] += 1
                for ch in 0..<4 { sc[ch][c] += feat[i * 4 + ch] }
            } }
            for c in 0..<k where cn[c] > 0 {
                cy[c] = sy[c] / cn[c]; cx[c] = sx[c] / cn[c]
                for ch in 0..<4 { cc[ch][c] = sc[ch][c] / cn[c] }
            }
        }
        return labels
    }

    // ── Strokes and their draw orders ────────────────────────────────────────

    private func buildStrokes(_ lum: [Float], _ depth: [Float]) {
        var raw: [(points: [SIMD2<Float>], width: Float, alpha: Float, phase: Int, strength: Float)] = []
        let edgeA = UnsafeMutablePointer<Int32>.allocate(capacity: 2 * n)
        let edgeB = UnsafeMutablePointer<Int32>.allocate(capacity: 2 * n)
        edgeA.initialize(repeating: -1, count: 2 * n)
        edgeB.initialize(repeating: -1, count: 2 * n)
        defer { edgeA.deallocate(); edgeB.deallocate() }
        var touched: [Int32] = []
        var chains: [[SIMD2<Float>]] = [], closedChain: [Bool] = []
        lum.withUnsafeBufferPointer { lb in
            let lp = lb.baseAddress!
            for band in v2Bands {
                let blob = v2Blur(lp, w, h, band.big * zoom)
                var eq = [Float](repeating: 0, count: n)
                for i in 0..<n { eq[i] = 0.5 + (lp[i] - blob[i]) * band.gain }
                eq.withUnsafeMutableBufferPointer { v2BlurInPlace($0.baseAddress!, w, h, v2Kernel(0.9 * zoom)) }
                var g = [Float](repeating: 0, count: n)
                eq.withUnsafeBufferPointer { eb in
                    let ep = eb.baseAddress!
                    forRows(h) { y0, y1 in
                        for y in y0..<y1 {
                            let ym = max(0, y - 1), yp = min(h - 1, y + 1)
                            for x in 0..<w {
                                let xm = max(0, x - 1), xp = min(w - 1, x + 1)
                                let gx = (ep[y * w + xp] - ep[y * w + xm]) * 0.5
                                let gy = (ep[yp * w + x] - ep[ym * w + x]) * 0.5
                                g[y * w + x] = (gx * gx + gy * gy).squareRoot()
                            }
                        }
                    }
                }
                var gate: Float = 0
                g.withUnsafeBufferPointer { gate = max(v2Percentile($0.baseAddress!, n, band.gatePct), band.floor) }
                let need = gate * v2StrengthMargin
                let minLen = Int(band.minLen * zoom)
                for level in band.levels {
                    chains.removeAll(keepingCapacity: true); closedChain.removeAll(keepingCapacity: true)
                    eq.withUnsafeBufferPointer { eb in
                        v2LevelContours(eb.baseAddress!, w, h, level, edgeA, edgeB, &touched, &chains, &closedChain)
                    }
                    g.withUnsafeBufferPointer { gb in
                        let gp = gb.baseAddress!
                        for (ci, chain) in chains.enumerated() {
                            if chain.count < max(4, minLen) { continue }
                            let isClosed = closedChain[ci]
                            var keep = [Bool](repeating: false, count: chain.count)
                            for i in 0..<chain.count { keep[i] = sample(gp, chain[i], w, h) > gate }
                            // binary_closing of the gate mask along the run: blips of one sample are bridged.
                            var closedMask = keep
                            for i in 0..<keep.count {
                                let a = keep[max(0, i - 1)], b = keep[i], c = keep[min(keep.count - 1, i + 1)]
                                closedMask[i] = a || b || c
                            }
                            var dilated = closedMask
                            for i in 0..<closedMask.count {
                                let a = closedMask[max(0, i - 1)], b = closedMask[i], c = closedMask[min(closedMask.count - 1, i + 1)]
                                dilated[i] = a && b && c
                            }
                            for run in SketchV2.runs(dilated, isClosed) {
                                let from = run.0, to = run.1
                                if to - from < minLen { continue }
                                var strength: Float = 0
                                for i in from..<to { strength += sample(gp, chain[i % chain.count], w, h) }
                                strength /= Float(to - from)
                                if strength < need { continue }
                                var seg: [SIMD2<Float>] = []
                                seg.reserveCapacity(to - from + 1)
                                for i in from...to { seg.append(chain[i % chain.count]) }
                                let step = max(1, Int((zoom * 1.5).rounded()))
                                var simplified: [SIMD2<Float>] = []
                                if step > 1 && seg.count > 2 * step {
                                    var i = 0
                                    while i < seg.count { simplified.append(seg[i]); i += step }
                                    simplified.append(seg[seg.count - 1])
                                } else { simplified = seg }
                                if simplified.count < 2 { continue }
                                // The ink weight scales every stroke's width. `normal` is exactly 1, so a normal drawing is
                                // byte-identical to the one the engine drew before the weight existed.
                                let width = band.baseW * zoom * (0.6 + 0.8 * min(1, strength / (need * 1.6))) * lineWeight.scale
                                let f = min(1, (strength - need) / (need * 1.2))
                                let alpha = band.baseA * (0.62 + 0.38 * max(0, f))
                                raw.append((simplified, width, alpha, band.phase, strength))
                            }
                        }
                    }
                }
            }
        }
        guard !raw.isEmpty else { return }
        // Per-stroke statistics and the draw order keys.
        var rng = SketchRng(1)
        var strokesOut: [V2Stroke] = []
        strokesOut.reserveCapacity(raw.count)
        for s in raw {
            var length: Float = 0
            var sumR: Float = 0, sumC: Float = 0, sumD: Float = 0
            var minR = Int.max, minC = Int.max
            for i in 0..<s.points.count {
                let p = s.points[i]
                sumR += p.y; sumC += p.x
                if i > 0 { let q = s.points[i - 1]; length += v2Len(p - q) }
                let r = max(0, min(h - 1, Int(p.y))), c = max(0, min(w - 1, Int(p.x)))
                if r < minR { minR = r }
                if c < minC { minC = c }
                sumD += depth[r * w + c]
            }
            let count = Float(s.points.count)
            let md = sumD / count
            let anchor = minR * w + minC
            strokesOut.append(V2Stroke(points: s.points, length: max(0, length), width: s.width, alpha: s.alpha,
                phase: s.phase, zone: max(0, min(5, Int((1 - md) * 6))), meanRow: sumR / count, meanCol: sumC / count,
                spatial: swipeProj[anchor], bloomT: fBloom.isEmpty ? 0 : fBloom[anchor], jitter: rng.unit(), rank: 0))
        }
        strokes = strokesOut
        var order = Array(0..<strokes.count)
        order.sort { a, b in
            let x = strokes[a], y = strokes[b]
            if x.zone != y.zone { return x.zone < y.zone }
            if x.phase != y.phase { return x.phase < y.phase }
            if x.length != y.length { return x.length > y.length }
            if x.meanRow != y.meanRow { return x.meanRow < y.meanRow }
            if x.meanCol != y.meanCol { return x.meanCol < y.meanCol }
            return x.jitter < y.jitter
        }
        let total = strokes.count
        for (i, idx) in order.enumerated() { strokes[idx].rank = total > 1 ? Float(i) / Float(total - 1) : 0 }

        func make(_ key: (V2Stroke, V2Stroke) -> Bool, _ subset: [Int]?, _ limit: Int? = nil) -> (idx: [Int32], cum: [Float]) {
            var ids = subset ?? Array(0..<total)
            ids.sort { key(strokes[$0], strokes[$1]) }
            if let limit = limit, ids.count > limit { ids = Array(ids.prefix(limit)) }
            var cum = [Float](repeating: 0, count: ids.count + 1)
            for (i, s) in ids.enumerated() { cum[i + 1] = cum[i] + strokes[s].length }
            return (ids.map { Int32($0) }, cum)
        }
        let bold: (V2Stroke, V2Stroke) -> Bool = { a, b in
            if a.zone != b.zone { return a.zone < b.zone }
            if a.phase != b.phase { return a.phase < b.phase }
            if a.length != b.length { return a.length > b.length }
            return a.rank < b.rank
        }
        orders["line"] = make(bold, nil)
        orders["buildup"] = make(bold, nil)
        orders["patches"] = make(bold, nil)
        orders["rough"] = make({ a, b in
            if a.length != b.length { return a.length > b.length }
            if a.phase != b.phase { return a.phase < b.phase }
            return a.rank < b.rank
        }, nil, max(1, total / 3))
        orders["bloom"] = make({ a, b in
            if a.phase != b.phase { return a.phase < b.phase }
            if a.bloomT != b.bloomT { return a.bloomT < b.bloomT }
            return a.rank < b.rank
        }, nil)
        for p in 0...3 {
            let members = (0..<total).filter { strokes[$0].phase == p }
            orders["swipe\(p)"] = make({ a, b in
                if a.length != b.length { return a.length > b.length }
                if a.rank != b.rank { return a.rank < b.rank }
                return a.spatial < b.spatial
            }, members)
            orders["swipe\(p)_r"] = make({ a, b in
                if a.length != b.length { return a.length > b.length }
                if a.rank != b.rank { return a.rank < b.rank }
                return a.spatial > b.spatial
            }, members)
        }
    }

    var strokeCount: Int { strokes.count }

    /// Index ranges [a, b] where the mask is true; a closed contour wraps.
    private static func runs(_ keep: [Bool], _ closed: Bool) -> [(Int, Int)] {
        let n = keep.count
        if !keep.contains(true) { return [] }
        if closed {
            var all = true
            for v in keep where !v { all = false; break }
            if all { return [(0, n)] }
            // rotate so index 0 is outside, then read the linear runs
            var start = 0
            while keep[start % n] { start += 1 }
            var out: [(Int, Int)] = []
            var i = 0
            while i < n {
                let idx = (start + i) % n
                if keep[idx] {
                    var j = i
                    while j < n && keep[(start + j) % n] { j += 1 }
                    out.append((start + i, start + j - 1))
                    i = j
                } else { i += 1 }
            }
            return out
        }
        var out: [(Int, Int)] = []
        var i = 0
        while i < n {
            if keep[i] {
                var j = i
                while j < n && keep[j] { j += 1 }
                out.append((i, j - 1))
                i = j
            } else { i += 1 }
        }
        return out
    }

    private func sample(_ field: UnsafePointer<Float>, _ p: SIMD2<Float>, _ w: Int, _ h: Int) -> Float {
        let r = max(0, min(Float(h) - 1.001, max(0, min(Float(h) - 1, p.y))))
        let c = max(0, min(Float(w) - 1, max(0, min(Float(w) - 1, p.x))))
        let r0 = Int(r), c0 = Int(c)
        let r1 = min(r0 + 1, h - 1), c1 = min(c0 + 1, w - 1)
        let fr = r - Float(r0), fc = c - Float(c0)
        let top = field[r0 * w + c0] * (1 - fc) + field[r0 * w + c1] * fc
        let bot = field[r1 * w + c0] * (1 - fc) + field[r1 * w + c1] * fc
        return top * (1 - fr) + bot * fr
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    /// Append the strokes a channel has newly completed to the ink mask. `frac` only ever grows, so
    /// the strokes already drawn are exactly the first `drawn[channel]` entries: each is rasterised
    /// once, and the hold is exactly the finished drawing.
    private func drawInk(_ channel: String, _ frac: Float, alphaScale: Float = 1, widthScale: Float = 1) {
        guard frac > 0, let seq = orders[channel], let total = seq.cum.last, total > 0 else { return }
        let target = frac * total
        var count = 0
        while count < seq.idx.count && seq.cum[count + 1] <= target { count += 1 }
        let start = drawn[channel] ?? 0
        var last: SIMD2<Float>?
        if start < count {
            for i in start..<count {
                let s = strokes[Int(seq.idx[i])]
                if let l = rasterize(s.points, s.width * widthScale, UInt8(max(0, min(255, (255 * s.alpha * alphaScale).rounded())))) { last = l }
            }
            inked = true
        }
        if count < seq.idx.count {
            let s = strokes[Int(seq.idx[count])]
            let span = seq.cum[count + 1] - seq.cum[count]
            let part = span > 1e-6 ? min(1, max(0, (target - seq.cum[count]) / span)) : 0
            if part > 0 {
                let head = strokeHead(s.points, part)
                if head.count >= 2, let l = rasterize(head, s.width * widthScale, UInt8(max(0, min(255, (255 * s.alpha * alphaScale).rounded())))) {
                    last = l; inked = true
                }
            }
        }
        drawn[channel] = count
        if let l = last { tip = l }
    }

    private func strokeHead(_ pts: [SIMD2<Float>], _ frac: Float) -> [SIMD2<Float>] {
        if pts.count < 2 || frac >= 1 { return pts }
        var cum = [Float](repeating: 0, count: pts.count)
        for i in 1..<pts.count { let d = pts[i] - pts[i - 1]; cum[i] = cum[i - 1] + v2Len(d) }
        let target = frac * cum[pts.count - 1]
        var k = 1
        while k < pts.count && cum[k] < target { k += 1 }
        if k >= pts.count { return pts }
        var head = Array(pts[0..<k])
        let span = cum[k] - cum[k - 1]
        let t = span > 1e-6 ? (target - cum[k - 1]) / span : 0
        head.append(pts[k - 1] + (pts[k] - pts[k - 1]) * t)
        return head
    }

    /// A stroke is one tapered polygon: width follows sin(pi t)^0.5, so every line has a pen-like
    /// entry and exit, and the ink mask takes the maximum, so overlapping passes never double up.
    @discardableResult
    private func rasterize(_ pts: [SIMD2<Float>], _ width: Float, _ value: UInt8) -> SIMD2<Float>? {
        guard pts.count >= 2, value > 0 else { return nil }
        var poly: [SIMD2<Float>] = []
        poly.reserveCapacity(pts.count * 2)
        let wide = pts.count >= 4
        for i in 0..<pts.count {
            let t = i == 0 ? pts[1] - pts[0] : (i == pts.count - 1 ? pts[i] - pts[i - 1] : pts[i + 1] - pts[i - 1])
            var nrm = SIMD2<Float>(-t.y, t.x)
            let len = v2Len(nrm)
            nrm = len > 1e-6 ? nrm / len : SIMD2<Float>(0, 0)
            let s = pts.count > 1 ? Float(i) / Float(pts.count - 1) : 0
            let half = wide ? width * (0.30 + 0.70 * max(0, sin(Float.pi * s)).squareRoot()) * 0.5 : width * 0.5
            poly.append(pts[i] + nrm * half)
        }
        for i in stride(from: pts.count - 1, through: 0, by: -1) {
            let t = i == 0 ? pts[1] - pts[0] : (i == pts.count - 1 ? pts[i] - pts[i - 1] : pts[i + 1] - pts[i - 1])
            var nrm = SIMD2<Float>(-t.y, t.x)
            let len = v2Len(nrm)
            nrm = len > 1e-6 ? nrm / len : SIMD2<Float>(0, 0)
            let s = pts.count > 1 ? Float(i) / Float(pts.count - 1) : 0
            let half = wide ? width * (0.30 + 0.70 * max(0, sin(Float.pi * s)).squareRoot()) * 0.5 : width * 0.5
            poly.append(pts[i] - nrm * half)
        }
        fillPolygon(poly, value)
        return pts[pts.count - 1]
    }

    private func fillPolygon(_ poly: [SIMD2<Float>], _ value: UInt8) {
        SketchV2.fillPolygon(poly, value, w, h, inkAcc)
    }

    /// Scan-fill one polygon, taking the maximum of what is already there. Static so the colour
    /// barrier can fill its own buffer with the same arithmetic the ink mask uses.
    fileprivate static func fillPolygon(_ poly: [SIMD2<Float>], _ value: UInt8, _ w: Int, _ h: Int, _ target: UnsafeMutablePointer<UInt8>) {
        var ymin = Float.greatestFiniteMagnitude, ymax = -Float.greatestFiniteMagnitude
        for p in poly { if p.y < ymin { ymin = p.y }; if p.y > ymax { ymax = p.y } }
        let y0 = max(0, Int(ymin.rounded(.down))), y1 = min(h - 1, Int(ymax.rounded(.up)))
        guard y0 <= y1 else { return }
        var xs: [Float] = []
        xs.reserveCapacity(32)
        poly.withUnsafeBufferPointer { pb in
            for y in y0...y1 {
                let yc = Float(y) + 0.5
                xs.removeAll(keepingCapacity: true)
                var prev = pb[pb.count - 1]
                for cur in pb {
                    if (prev.y <= yc && cur.y > yc) || (cur.y <= yc && prev.y > yc) {
                        xs.append(prev.x + (yc - prev.y) * (cur.x - prev.x) / (cur.y - prev.y))
                    }
                    prev = cur
                }
                guard xs.count >= 2 else { continue }
                xs.sort()
                var i = 0
                let row = y * w
                while i + 1 < xs.count {
                    var xa = Int((xs[i] - 0.5).rounded(.up)), xb = Int((xs[i + 1] - 0.5).rounded(.down))
                    if xa < 0 { xa = 0 }
                    if xb > w - 1 { xb = w - 1 }
                    if xa <= xb { for x in xa...xb where target[row + x] < value { target[row + x] = value } }
                    i += 2
                }
            }
        }
    }

    // ── Per-frame composite ──────────────────────────────────────────────────

    private func fillPaper(_ dst: UnsafeMutablePointer<UInt8>) {
        let c0 = paper[0], c1 = paper[1], c2 = paper[2]
        forRows(h) { y0, y1 in
            for y in y0..<y1 {
                var i = y * w * 4
                for _ in 0..<self.w { dst[i] = c0; dst[i + 1] = c1; dst[i + 2] = c2; dst[i + 3] = 255; i += 4 }
            }
        }
    }

    /// alpha = smoothstep(clamp((p - T)/soft)). `p` is passed already nudged so the LAST drawing
    /// frame clears the field's maximum: the hold is the finished drawing, never a picture with its
    /// last band still arriving. The nudge is cubic, so the mid-reveal timing is unchanged.
    private func front(_ field: [Float], _ p: Float, _ soft: Float) {
        let pEff = p * (1 + soft * p * p)
        let inv = 1 / soft
        field.withUnsafeBufferPointer { fb in
            let fp = fb.baseAddress!
            let al = alpha
            forRows(h) { y0, y1 in
                for i in (y0 * self.w)..<(y1 * self.w) {
                    var d = (pEff - fp[i]) * inv
                    d = d < 0 ? 0 : (d > 1 ? 1 : d)
                    al[i] = UInt8(d * d * (3 - 2 * d) * 255 + 0.5)
                }
            }
        }
    }

    /// The colour reveal's hard contact: a pixel is painted exactly when the brush has passed it,
    /// with no fade. One shared timeline, so the brush and the picture can never drift apart.
    private func contact(_ timing: [Float], _ p: Float) {
        let al = alpha
        timing.withUnsafeBufferPointer { tb in
            let tp = tb.baseAddress!
            forRows(h) { y0, y1 in
                for i in (y0 * self.w)..<(y1 * self.w) { al[i] = tp[i] <= p ? 255 : 0 }
            }
        }
    }

    private func overPicture(_ dst: UnsafeMutablePointer<UInt8>) {        let pic = picture, al = alpha
        forRows(h) { y0, y1 in
            for p in (y0 * self.w)..<(y1 * self.w) {
                let a = Int32(al[p])
                if a == 0 { continue }
                let d = p * 4, s = p * 3
                for c in 0..<3 {
                    let dv = Int32(dst[d + c]), sv = Int32(pic[s + c])
                    let v = dv * 255 + (sv - dv) * a
                    dst[d + c] = UInt8((v + 1 + (v >> 8)) >> 8)
                }
            }
        }
    }

    /// The wet edge: behind the front the picture is flattened toward its own pale wash, which is
    /// what makes a bloom read as pigment rather than as a fade.
    private func overPictureWet(_ dst: UnsafeMutablePointer<UInt8>, _ field: [Float], _ p: Float) {
        let pic = picture, al = alpha
        let inv: Float = 1 / 0.045
        field.withUnsafeBufferPointer { fb in
            let fp = fb.baseAddress!
            forRows(h) { y0, y1 in
                for i in (y0 * self.w)..<(y1 * self.w) {
                    let a = Int32(al[i])
                    if a == 0 { continue }
                    var d = abs(p - fp[i]) * inv
                    d = d > 1 ? 1 : d
                    let wet = (1 - d) * 0.32
                    let d4 = i * 4, s = i * 3
                    for c in 0..<3 {
                        let src = Float(pic[s + c]) * (1 - wet)
                        let dv = Int32(dst[d4 + c])
                        let v = dv * 255 + (Int32(src) - dv) * a
                        dst[d4 + c] = UInt8((v + 1 + (v >> 8)) >> 8)
                    }
                }
            }
        }
    }

    private func overTone(_ dst: UnsafeMutablePointer<UInt8>, _ amount: Float) {
        guard amount > 0 else { return }
        let tm = toneMap, tr = toneRGB
        forRows(h) { y0, y1 in
            for p in (y0 * self.w)..<(y1 * self.w) {
                let a = Int32(Float(tm[p]) * amount)
                if a == 0 { continue }
                let colour = Int32(tr[p])
                let d = p * 4
                for c in 0..<3 {
                    let dv = Int32(dst[d + c])
                    let v = dv * 255 + (colour - dv) * a
                    dst[d + c] = UInt8((v + 1 + (v >> 8)) >> 8)
                }
            }
        }
    }

    /// Dark ink always; pale ink only where the picture's own colour has already arrived, because
    /// pale ink on bare paper is invisible — an artist's light-ground lines appear when the dark
    /// ground is laid in.
    private func overInk(_ dst: UnsafeMutablePointer<UInt8>, _ ground: UnsafePointer<UInt8>?, fade: Float = 1) {
        guard inked else { return }
        let acc = inkAcc, ch = choose, dark = inkDark, pale = inkPale
        // 255 leaves the arithmetic untouched, so every reveal that never fades is byte-identical.
        let fadeFactor = fade >= 1 ? 255 : Int32(max(0, min(1, fade)) * 255 + 0.5)
        forRows(h) { y0, y1 in
            for p in (y0 * self.w)..<(y1 * self.w) {
                var a = Int32(acc[p])
                if a == 0 { continue }
                if fadeFactor != 255 { a = a * fadeFactor / 255 }
                let c = Int32(ch[p])
                let d = p * 4, s = p * 3
                let darkA = a * c / 255
                if darkA > 0 {
                    for k in 0..<3 {
                        let dv = Int32(dst[d + k]), sv = Int32(dark[s + k])
                        let v = dv * 255 + (sv - dv) * darkA
                        dst[d + k] = UInt8((v + 1 + (v >> 8)) >> 8)
                    }
                }
                var paleA = a * (255 - c) / 255
                if let g = ground { paleA = paleA * Int32(g[p]) / 255 }
                paleA = paleA * 72 / 100
                if paleA > 0 {
                    for k in 0..<3 {
                        let dv = Int32(dst[d + k]), sv = Int32(pale[s + k])
                        let v = dv * 255 + (sv - dv) * paleA
                        dst[d + k] = UInt8((v + 1 + (v >> 8)) >> 8)
                    }
                }
            }
        }
    }

    private func ensurePoster(_ pass: Int) {
        guard posterFor != pass else { return }
        posterFor = pass
        let settings: [(Int, Float, Float)] = [(6, 6.0, 0.72), (8, 3.0, 0.42), (14, 1.4, 0.16), (28, 2.2, 0.0), (64, 1.1, 0.0), (256, 0.0, 0.0)]
        let (levels, sigma, mute) = settings[max(0, min(5, pass))]
        var planes = pictureF
        if sigma > 0 { for c in 0..<3 { planes[c] = v2Blur(planes[c], w, h, sigma) } }
        let step = levels < 256 ? Float(levels - 1) : 0
        for i in 0..<n {
            let r = planes[0][i], g = planes[1][i], b = planes[2][i]
            var pr = r, pg = g, pb = b
            if step > 0 {
                pr = (pr / 255 * step).rounded() / step * 255
                pg = (pg / 255 * step).rounded() / step * 255
                pb = (pb / 255 * step).rounded() / step * 255
            }
            if mute > 0 {
                let gray = 0.299 * pr + 0.587 * pg + 0.114 * pb
                let paleC = 168.0 + 0.36 * gray
                pr = pr * (1 - mute) + paleC * mute
                pg = pg * (1 - mute) + paleC * mute
                pb = pb * (1 - mute) + paleC * mute
            }
            poster[i * 3] = UInt8(max(0, min(255, pr)))
            poster[i * 3 + 1] = UInt8(max(0, min(255, pg)))
            poster[i * 3 + 2] = UInt8(max(0, min(255, pb)))
        }
    }

    private func overPosterIntoBase(_ dst: UnsafeMutablePointer<UInt8>) {
        let al = alpha, pos = poster
        forRows(h) { y0, y1 in
            for p in (y0 * self.w)..<(y1 * self.w) {
                let a = Int32(al[p])
                if a == 0 { continue }
                let d = p * 4, s = p * 3
                for c in 0..<3 {
                    let dv = Int32(dst[d + c]), sv = Int32(pos[s + c])
                    let v = dv * 255 + (sv - dv) * a
                    dst[d + c] = UInt8((v + 1 + (v >> 8)) >> 8)
                }
            }
        }
    }

    private func applyRim(_ dst: UnsafeMutablePointer<UInt8>, _ field: [Float], _ local: Float, fade: Float = 1) {
        let inv: Float = 1 / 0.013
        let c0 = Int32(paper[0]), c1 = Int32(paper[1]), c2 = Int32(paper[2])
        let fadeFactor = fade >= 1 ? 255 : Int32(max(0, min(1, fade)) * 255 + 0.5)
        field.withUnsafeBufferPointer { fb in
            let fp = fb.baseAddress!
            forRows(h) { y0, y1 in
                for i in (y0 * self.w)..<(y1 * self.w) {
                    var d = abs(fp[i] - local) * inv
                    d = d > 1 ? 1 : d
                    let a = Int32((1 - d) * 0.34 * 255)
                    if a <= 0 { continue }
                    let ar = a * fadeFactor / 255
                    if ar <= 0 { continue }
                    let q = i * 4
                    let dv0 = Int32(dst[q]), dv1 = Int32(dst[q + 1]), dv2 = Int32(dst[q + 2])
                    let v0 = dv0 * 255 + (c0 - dv0) * ar
                    let v1 = dv1 * 255 + (c1 - dv1) * ar
                    let v2 = dv2 * 255 + (c2 - dv2) * ar
                    dst[q] = UInt8((v0 + 1 + (v0 >> 8)) >> 8)
                    dst[q + 1] = UInt8((v1 + 1 + (v1 >> 8)) >> 8)
                    dst[q + 2] = UInt8((v2 + 1 + (v2 >> 8)) >> 8)
                }
            }
        }
    }

    private func ramp(_ u: Float, _ a: Float, _ b: Float) -> Float {
        if u <= a { return 0 }
        if u >= b { return 1 }
        return (u - a) / (b - a)
    }

    func render(_ u: Float, into canvas: SketchBitmap) {
        let dst = canvas.bytes
        // The closing dissolve every reveal shares: the drawing's ink and tone ease out over the
        // last slice of the reveal, so the clip ends on the scene image itself, not on a two-tone
        // drawing. Before the dissolve starts the frame is byte-identical to the approved look.
        let fade = 1 - sketchSmoothstep(ramp(u, sketchFadeStart, 1))
        switch reveal {
        case .line:
            drawInk("line", ramp(u, 0.00, 0.66))
            let p = ramp(u, 0.60, 1.00)
            fillPaper(dst)
            if p > 0 {
                front(fSweep, p, 0.10)
                overPicture(dst)
            }
            overTone(dst, 0.40 * ramp(u, 0.56, 0.80) * fade)
            overInk(dst, p > 0 ? alpha : nil, fade: fade)
        case .buildup:
            drawInk("rough", ramp(u, 0.00, 0.24), alphaScale: 0.32, widthScale: 1.9)
            drawInk("buildup", ramp(u, 0.18, 0.58))
            let p = ramp(u, 0.70, 1.00)
            fillPaper(dst)
            if p > 0 {
                front(fBloom, p, 0.10)
                overPicture(dst)
            }
            overTone(dst, 0.85 * ramp(u, 0.52, 0.74) * fade)
            overInk(dst, p > 0 ? alpha : nil, fade: fade)
        case .patches:
            drawInk("patches", ramp(u, 0.00, 0.72))
            let p = ramp(u, 0.14, 1.00)
            fillPaper(dst)
            if p > 0 {
                front(fPatches, p, 0.05)
                overPicture(dst)
            }
            overTone(dst, 0.45 * ramp(u, 0.56, 0.78) * fade)
            overInk(dst, p > 0 ? alpha : nil, fade: fade)
        case .bloom:
            drawInk("bloom", ramp(u, 0.00, 0.72))
            let p = ramp(u, 0.16, 1.00)
            fillPaper(dst)
            if p > 0 {
                front(fBloom, p, 0.085)
                overPictureWet(dst, fBloom, p)
            }
            overTone(dst, 0.35 * ramp(u, 0.60, 0.82) * fade)
            overInk(dst, p > 0 ? alpha : nil, fade: fade)
        case .swipes:
            let span = u * 6
            let pass = min(5, Int(span))
            let local = min(1, span - Float(pass))
            let forward = pass % 2 == 0
            let field = forward ? swipeProj : swipeProjInv
            ensurePoster(pass)
            front(field, local, 0.055)
            overPosterIntoBase(swipeBase)
            if pass < 4 {
                drawInk(pass % 2 == 0 ? "swipe\(pass)" : "swipe\(pass)_r", ramp(local, 0.0, 0.92))
            }
            dst.update(from: swipeBase, count: n * 4)
            if pass == 4 {
                let tone = 0.62 * ramp(local, 0.0, 0.85)
                if tone > 0 { overTone(dst, tone * fade) }
            }
            overInk(dst, alpha, fade: fade)
            applyRim(dst, field, local, fade: fade)
        case .colour:
            guard let plan = colour else { fillPaper(dst); break }
            drawInk("line", ramp(u, 0.00, colourInkShare))
            let p = ramp(u, colourInkShare, colourPaintEnd)
            fillPaper(dst)
            contact(plan.timing, p)
            overPicture(dst)
            // The closing hold is the source picture: the bold ink eases out over the last part of
            // the reveal, so the clip ends on the scene image itself, not on a two-tone drawing.
            overInk(dst, plan.first <= p ? alpha : nil, fade: fade)
        }
    }
}

// ── Colour it in ─────────────────────────────────────────────────────────────
// The sixth reveal, ported from the approved 2026-10-29 prototype (`proto/colour_in.py`, CC0).
//
// Our own v2 ink is laid down first, in the `line` order. Then the picture is coloured in: Lab
// colour groups, each split into ink-bounded regions so a group finishes one region at a time;
// the subject first when this scene has a real depth map; colours ordered by the first substantial
// occurrence near the top of their phase; brush-lane strokes with short-span merging and a routed
// contact timeline; and one eased timeline that both the brush and the pixels follow, so a pixel
// appears exactly when the brush passes over it.
//
// The closing hold is the SOURCE PICTURE, not a drawing: the bold two-tone ink eases out over the
// last part of the reveal, so the clip ends on the scene image itself. Ink is how the picture
// arrives, not a look it keeps.
//
// Not ported: their Grid path, their hand, and `grid_stream.py` (MIT), and the "Quick" left-to-right
// background tail, which at a 12° brush angle tears skies into white strips.

private let colourPaletteColors = 16
private let colourGroupCount = 8
private let colourMinRegionArea = 80
private let colourBrushRatio: Float = 0.12
private let colourBrushMin: Float = 24
private let colourBrushMax: Float = 92
private let colourStrokeAngle: Float = 12
private let colourTravelSpeed: Float = 1.5
/// Ink runs from 0 to this share of the drawing; colour then runs to `colourPaintEnd`.
private let colourInkShare: Float = 0.45
private let colourPaintEnd: Float = sketchFadeStart
private let colourMaskFloor: Float = 0.55
private let colourMaskMinArea = 4000

/// One colour group's brush-stroke plan for one phase.
private struct ColourSpan {
    var pixels: [Int32]        // indices into the colour's own pixel list
    var begin: SIMD2<Float>
    var end: SIMD2<Float>
    var v0: Float
    var v1: Float
}

private struct ColourStroke {
    var pixels: [Int32]        // global pixel indices
    var progress: [Float]
    var travel: Float
    var length: Float
    var phase: Int
}

private struct ColourPlan {
    var timing: [Float]        // per pixel: contact time in [0, 1] over the colour phase
    var first: Float           // the earliest contact, so "is anything painted" costs nothing
    var brush: Float
    var groups: Int
    var strokes: Int
    var travel: Float
    var paint: Float
    var subject: Bool
    var seconds: Double
}

@inline(__always) private func sketchSmoothstep(_ t: Float) -> Float {
    let x = min(1, max(0, t))
    return x * x * (3 - 2 * x)
}

@inline(__always) private func colourSq(_ a: SIMD3<Float>, _ b: SIMD3<Float>) -> Float {
    let d = a - b
    return d.x * d.x + d.y * d.y + d.z * d.z
}

/// sRGB (0…255) to CIE Lab (D65). vImage has no RGB→Lab conversion, so the transform is here; it is
/// the same space the prototype clusters in.
@inline(__always) private func colourLab(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> SIMD3<Float> {
    @inline(__always) func linear(_ v: Float) -> Float { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    let lr = linear(Float(r) / 255), lg = linear(Float(g) / 255), lb = linear(Float(b) / 255)
    let x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
    let y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb
    let z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / 1.08883
    @inline(__always) func curve(_ t: Float) -> Float { t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0 }
    let fx = curve(x), fy = curve(y), fz = curve(z)
    return SIMD3<Float>(116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))
}

/// Weighted k-means++ over a handful of samples. Deterministic: the first centre is the heaviest
/// sample and every later pick comes from the fixed-seed stream.
private func colourKMeans(_ samples: [SIMD3<Float>], _ weights: [Float], _ k: Int,
                          seed: UInt64, iterations: Int, tolerance: Float) -> (centres: [SIMD3<Float>], labels: [Int32]) {
    let n = samples.count
    guard n > 0, k > 0 else { return ([], []) }
    if k == 1 { return ([samples[0]], [Int32](repeating: 0, count: n)) }
    var rng = SketchRng(seed)
    var centres: [SIMD3<Float>] = []
    var chosen = [Bool](repeating: false, count: n)
    var first = 0
    for i in 1..<n where weights[i] > weights[first] { first = i }
    centres.append(samples[first]); chosen[first] = true
    var nearest = [Float](repeating: 0, count: n)
    for i in 0..<n { nearest[i] = colourSq(samples[i], centres[0]) }
    while centres.count < k {
        var total: Float = 0
        for i in 0..<n where !chosen[i] { total += weights[i] * nearest[i] }
        var pick = -1
        if total > 1e-12 {
            let target = rng.unit() * total
            var acc: Float = 0
            for i in 0..<n where !chosen[i] {
                acc += weights[i] * nearest[i]
                if acc >= target { pick = i; break }
            }
        }
        if pick < 0 { for i in 0..<n where !chosen[i] { if pick < 0 || weights[i] > weights[pick] { pick = i } } }
        guard pick >= 0 else { break }
        chosen[pick] = true
        centres.append(samples[pick])
        for i in 0..<n where !chosen[i] {
            let d = colourSq(samples[i], samples[pick])
            if d < nearest[i] { nearest[i] = d }
        }
    }
    var labels = [Int32](repeating: 0, count: n)
    for _ in 0..<iterations {
        for i in 0..<n {
            var best = 0, bestD = colourSq(samples[i], centres[0])
            for c in 1..<centres.count {
                let d = colourSq(samples[i], centres[c])
                if d < bestD { bestD = d; best = c }
            }
            labels[i] = Int32(best)
        }
        var sum = [SIMD3<Float>](repeating: .zero, count: centres.count)
        var mass = [Float](repeating: 0, count: centres.count)
        for i in 0..<n { let c = Int(labels[i]); sum[c] += samples[i] * weights[i]; mass[c] += weights[i] }
        var shift: Float = 0
        for c in 0..<centres.count where mass[c] > 0 {
            let next = sum[c] / mass[c]
            let d = colourSq(next, centres[c])
            if d > shift { shift = d }
            centres[c] = next
        }
        if shift < tolerance { break }
    }
    for i in 0..<n {
        var best = 0, bestD = colourSq(samples[i], centres[0])
        for c in 1..<centres.count {
            let d = colourSq(samples[i], centres[c])
            if d < bestD { bestD = d; best = c }
        }
        labels[i] = Int32(best)
    }
    return (centres, labels)
}

@inline(__always) private func colourBin(_ lab: SIMD3<Float>) -> Int {
    let l = min(31, max(0, Int(lab.x * (32.0 / 100.0))))
    let a = min(31, max(0, Int((lab.y + 128) * (32.0 / 255.0))))
    let b = min(31, max(0, Int((lab.z + 128) * (32.0 / 255.0))))
    return (l << 10) | (a << 5) | b
}

/// A subject mask from the scene's own depth map: near, large and closed up. Depth does not know
/// what a character is, so the mask is a near-field blob, and a picture whose floor is near takes
/// the floor too — exactly what the approved prototype's depth mask does.
private func colourSubjectMask(_ depth: [Float], _ rect: (x: Int, y: Int, w: Int, h: Int), _ w: Int, _ h: Int) -> [Bool]? {
    let x0 = max(0, rect.x), y0 = max(0, rect.y)
    let x1 = min(w, rect.x + rect.w), y1 = min(h, rect.y + rect.h)
    guard x1 > x0, y1 > y0 else { return nil }
    // Normalise to the fitted picture's own 1st…99th percentile, so the paper border is not "far".
    var lo = Float.greatestFiniteMagnitude, hi = -Float.greatestFiniteMagnitude
    for y in y0..<y1 { for x in x0..<x1 { let v = depth[y * w + x]; if v < lo { lo = v }; if v > hi { hi = v } } }
    if !(hi > lo) { return nil }
    let scale = 1 / (hi - lo)
    var hist = [Int](repeating: 0, count: 128)
    var values = [Float](repeating: 0, count: (x1 - x0) * (y1 - y0))
    var at = 0
    for y in y0..<y1 { for x in x0..<x1 {
        let v = max(0, min(1, (depth[y * w + x] - lo) * scale))
        values[at] = v; at += 1
        hist[min(127, Int(v * 127.999))] += 1
    } }
    // Otsu's threshold, floored: a near-field mask must not swallow the whole picture.
    let total = values.count
    var sumAll: Float = 0
    for i in 0..<128 { sumAll += Float(i) * Float(hist[i]) }
    var wB: Float = 0, sumB: Float = 0, best: Float = -1
    var otsu: Float = 0.5
    for i in 0..<128 {
        wB += Float(hist[i])
        if wB == 0 { continue }
        let wF = Float(total) - wB
        if wF <= 0 { break }
        sumB += Float(i) * Float(hist[i])
        let mB = sumB / wB, mF = (sumAll - sumB) / wF
        let between = wB * wF * (mB - mF) * (mB - mF)
        if between > best { best = between; otsu = Float(i) / 127 }
    }
    let threshold = max(otsu, colourMaskFloor)
    var mask = [Bool](repeating: false, count: w * h)
    at = 0
    for y in y0..<y1 { for x in x0..<x1 { if values[at] >= threshold { mask[y * w + x] = true }; at += 1 } }
    // Close 9×9, drop small islands, fill holes — the prototype's `_clean`.
    colourBox(&mask, w, h, radius: 4, wantAll: false)
    colourBox(&mask, w, h, radius: 4, wantAll: true)
    colourDropSmall(&mask, w, h, minArea: colourMaskMinArea)
    colourFillHoles(&mask, w, h)
    return mask
}

/// One separable half of a 9×9 binary morphology pass: a pixel survives a dilation if any true,
/// an erosion if every one is true, within `radius`.
private func colourBox(_ mask: inout [Bool], _ w: Int, _ h: Int, radius: Int, wantAll: Bool) {
    var tmp = [Bool](repeating: false, count: w * h)
    for y in 0..<h {
        let row = y * w
        for x in 0..<w {
            var acc = wantAll
            var k = max(0, x - radius)
            while k <= min(w - 1, x + radius) {
                if wantAll ? !mask[row + k] : mask[row + k] { acc = !wantAll; break }
                k += 1
            }
            tmp[row + x] = acc
        }
    }
    for y in 0..<h {
        let row = y * w
        for x in 0..<w {
            var acc = wantAll
            var k = max(0, y - radius)
            while k <= min(h - 1, y + radius) {
                if wantAll ? !tmp[k * w + x] : tmp[k * w + x] { acc = !wantAll; break }
                k += 1
            }
            mask[row + x] = acc
        }
    }
}

private func colourDropSmall(_ mask: inout [Bool], _ w: Int, _ h: Int, minArea: Int) {
    var seen = [Bool](repeating: false, count: w * h)
    var stack: [Int32] = [], members: [Int32] = []
    for i in 0..<(w * h) where mask[i] && !seen[i] {
        members.removeAll(keepingCapacity: true); stack.removeAll(keepingCapacity: true)
        stack.append(Int32(i)); seen[i] = true
        while let p = stack.popLast() {
            let pi = Int(p)
            members.append(p)
            let y = pi / w, x = pi % w
            if x > 0 && mask[pi - 1] && !seen[pi - 1] { seen[pi - 1] = true; stack.append(Int32(pi - 1)) }
            if x + 1 < w && mask[pi + 1] && !seen[pi + 1] { seen[pi + 1] = true; stack.append(Int32(pi + 1)) }
            if y > 0 && mask[pi - w] && !seen[pi - w] { seen[pi - w] = true; stack.append(Int32(pi - w)) }
            if y + 1 < h && mask[pi + w] && !seen[pi + w] { seen[pi + w] = true; stack.append(Int32(pi + w)) }
        }
        if members.count < minArea { for p in members { mask[Int(p)] = false } }
    }
}

/// A hole is background the border cannot reach.
private func colourFillHoles(_ mask: inout [Bool], _ w: Int, _ h: Int) {
    var reach = [Bool](repeating: false, count: w * h)
    var queue: [Int32] = []
    func seed(_ i: Int) { if !mask[i] && !reach[i] { reach[i] = true; queue.append(Int32(i)) } }
    for x in 0..<w { seed(x); seed((h - 1) * w + x) }
    for y in 0..<h { seed(y * w); seed(y * w + w - 1) }
    var head = 0
    while head < queue.count {
        let p = Int(queue[head]); head += 1
        let y = p / w, x = p % w
        if x > 0 && !mask[p - 1] && !reach[p - 1] { reach[p - 1] = true; queue.append(Int32(p - 1)) }
        if x + 1 < w && !mask[p + 1] && !reach[p + 1] { reach[p + 1] = true; queue.append(Int32(p + 1)) }
        if y > 0 && !mask[p - w] && !reach[p - w] { reach[p - w] = true; queue.append(Int32(p - w)) }
        if y + 1 < h && !mask[p + w] && !reach[p + w] { reach[p + w] = true; queue.append(Int32(p + w)) }
    }
    for i in 0..<(w * h) where !mask[i] && !reach[i] { mask[i] = true }
}

private func colourGreedyRoute(_ spans: [ColourSpan], _ tip: SIMD2<Float>) -> [(Int, Bool)] {
    var remaining = [Bool](repeating: true, count: spans.count)
    var route: [(Int, Bool)] = []
    route.reserveCapacity(spans.count)
    var at = tip
    for _ in 0..<spans.count {
        var bestScore = Float.greatestFiniteMagnitude, bestIndex = -1, bestReverse = false
        for i in spans.indices where remaining[i] {
            for reverse in 0...1 {
                let p = reverse == 0 ? spans[i].begin : spans[i].end
                let score = v2Len(p - at) + 0.08 * max(at.y - p.y, 0)
                if score < bestScore { bestScore = score; bestIndex = i; bestReverse = reverse == 1 }
            }
        }
        guard bestIndex >= 0 else { break }
        remaining[bestIndex] = false
        route.append((bestIndex, bestReverse))
        at = bestReverse ? spans[bestIndex].begin : spans[bestIndex].end
    }
    return route
}

/// Bounded block reversal inside one colour group: shortens travel without reordering colours.
private func colourRefine(_ spans: [ColourSpan], _ route: [(Int, Bool)], _ tip: SIMD2<Float>,
                          window: Int = 25, passes: Int = 2) -> [(Int, Bool)] {
    var r = route
    for _ in 0..<passes {
        var best: Float = 0
        var change: (Int, Int)?
        for left in 0..<r.count {
            let (first, firstReverse) = r[left]
            let before = left == 0 ? tip : (r[left - 1].1 ? spans[r[left - 1].0].begin : spans[r[left - 1].0].end)
            let firstEntry = firstReverse ? spans[first].end : spans[first].begin
            let firstExit = firstReverse ? spans[first].begin : spans[first].end
            var right = left + 1
            while right < min(r.count, left + window) {
                let (last, lastReverse) = r[right]
                let lastEntry = lastReverse ? spans[last].begin : spans[last].end
                var old = v2Len(before - firstEntry)
                var new = v2Len(before - lastEntry)
                if right + 1 < r.count {
                    let (after, afterReverse) = r[right + 1]
                    let afterEntry = afterReverse ? spans[after].end : spans[after].begin
                    let lastExit = lastReverse ? spans[last].begin : spans[last].end
                    old += v2Len(afterEntry - lastExit)
                    new += v2Len(afterEntry - firstExit)
                }
                if old - new > best + 1e-9 { best = old - new; change = (left, right) }
                right += 1
            }
        }
        guard let (left, right) = change else { break }
        var slice = Array(r[left...right])
        slice.reverse()
        for k in 0..<slice.count { r[left + k] = (slice[k].0, !slice[k].1) }
    }
    return r
}

/// Join short neighbouring spans that fit inside one brush corridor (their `_merge_short`).
private func colourMergeShort(_ spans: [ColourSpan], _ u: [Float], _ brush: Float, _ cosA: Float, _ sinA: Float) -> [ColourSpan] {
    var active = spans
    var alive = [Bool](repeating: true, count: active.count)
    guard active.count > 1 else { return active }
    for i in 0..<active.count {
        if !alive[i] { continue }
        if active[i].v1 - active[i].v0 > brush * 0.65 { continue }
        for j in (i + 1)..<active.count {
            if !alive[j] || active[j].v1 - active[j].v0 > brush * 0.65 { continue }
            let low = min(active[i].v0, active[j].v0), high = max(active[i].v1, active[j].v1)
            let gap = max(max(active[i].v0 - active[j].v1, active[j].v0 - active[i].v1), 0)
            let endpointGap = min(min(v2Len(active[i].begin - active[j].begin), v2Len(active[i].begin - active[j].end)),
                                  min(v2Len(active[i].end - active[j].begin), v2Len(active[i].end - active[j].end)))
            if gap > brush * 0.75 || high - low > brush * 1.5 || endpointGap > brush { continue }
            let combined = active[i].pixels + active[j].pixels
            var uLo = Float.greatestFiniteMagnitude, uHi = -Float.greatestFiniteMagnitude
            for m in combined { let v = u[Int(m)]; if v < uLo { uLo = v }; if v > uHi { uHi = v } }
            if uHi - uLo > brush { continue }
            let laneU = (uLo + uHi) * 0.5
            active[i] = ColourSpan(pixels: combined,
                                   begin: SIMD2<Float>(laneU * cosA - low * sinA, laneU * sinA + low * cosA),
                                   end: SIMD2<Float>(laneU * cosA - high * sinA, laneU * sinA + high * cosA),
                                   v0: low, v1: high)
            alive[j] = false
            if high - low > brush * 0.65 { break }
        }
    }
    return zip(active, alive).filter { $0.1 }.map { $0.0 }
}

/// The whole colouring plan: ink barrier, colour regions, subject phase, lanes and contact times.
private func colourPlan(picture: UnsafeMutablePointer<UInt8>, w: Int, h: Int,
                        strokes: [V2Stroke], subject: [Bool]?) -> ColourPlan {
    let began = DispatchTime.now().uptimeNanoseconds
    let n = w * h
    let brush = max(colourBrushMin, min(colourBrushMax, Float(min(w, h)) * colourBrushRatio))
    let angle = colourStrokeAngle * Float.pi / 180
    let cosA = cos(angle), sinA = sin(angle)

    // 1. The ink barrier: the union of the strokes we are about to draw, at their full width.
    var barrier = [UInt8](repeating: 0, count: n)
    barrier.withUnsafeMutableBufferPointer { bp in
        let target = bp.baseAddress!
        for s in strokes where s.points.count >= 2 {
            let half = max(0.75, s.width * 0.5)
            var poly: [SIMD2<Float>] = []
            poly.reserveCapacity(s.points.count * 2)
            for i in 0..<s.points.count {
                let t = i == 0 ? s.points[1] - s.points[0]
                    : (i == s.points.count - 1 ? s.points[i] - s.points[i - 1] : s.points[i + 1] - s.points[i - 1])
                var normal = SIMD2<Float>(-t.y, t.x)
                let len = v2Len(normal)
                normal = len > 1e-6 ? normal / len : SIMD2<Float>(0, 0)
                poly.append(s.points[i] + normal * half)
            }
            for i in stride(from: s.points.count - 1, through: 0, by: -1) {
                let t = i == 0 ? s.points[1] - s.points[0]
                    : (i == s.points.count - 1 ? s.points[i] - s.points[i - 1] : s.points[i + 1] - s.points[i - 1])
                var normal = SIMD2<Float>(-t.y, t.x)
                let len = v2Len(normal)
                normal = len > 1e-6 ? normal / len : SIMD2<Float>(0, 0)
                poly.append(s.points[i] - normal * half)
            }
            SketchV2.fillPolygon(poly, 255, w, h, target)
        }
    }
    // 2. Ink, grown by one pixel, is what splits a colour group into regions.
    var grown = [UInt8](repeating: 0, count: n)
    for y in 0..<h {
        let row = y * w
        for x in 0..<w {
            var v = barrier[row + x]
            if v == 0 && x > 0 && barrier[row + x - 1] != 0 { v = 1 }
            if v == 0 && x + 1 < w && barrier[row + x + 1] != 0 { v = 1 }
            grown[row + x] = v
        }
    }
    // The vertical half reads a copy: growing in place would cascade down the column.
    let horizontal = grown
    for y in 0..<h {
        let row = y * w
        for x in 0..<w {
            if horizontal[row + x] == 0 {
                if y > 0 && horizontal[row - w + x] != 0 { grown[row + x] = 1 }
                else if y + 1 < h && horizontal[row + w + x] != 0 { grown[row + x] = 1 }
            }
        }
    }
    var visible = [Bool](repeating: false, count: n)
    for i in 0..<n { visible[i] = barrier[i] == 0 }

    // 3. Lab colour groups, from a 32³ histogram so k-means sees bins, not pixels.
    var labL = [Float](repeating: 0, count: n)
    var labA = [Float](repeating: 0, count: n)
    var labB = [Float](repeating: 0, count: n)
    let bins = 32 * 32 * 32
    var counts = [Int32](repeating: 0, count: bins)
    var sums = [Float](repeating: 0, count: bins * 3)
    for i in 0..<n where visible[i] {
        let s = i * 3
        let lab = colourLab(picture[s], picture[s + 1], picture[s + 2])
        labL[i] = lab.x; labA[i] = lab.y; labB[i] = lab.z
        let bin = colourBin(lab)
        counts[bin] += 1
        sums[bin * 3] += lab.x; sums[bin * 3 + 1] += lab.y; sums[bin * 3 + 2] += lab.z
    }
    var samples: [SIMD3<Float>] = [], weights: [Float] = []
    samples.reserveCapacity(bins); weights.reserveCapacity(bins)
    for bin in 0..<bins where counts[bin] > 0 {
        let c = Float(counts[bin])
        samples.append(SIMD3<Float>(sums[bin * 3] / c, sums[bin * 3 + 1] / c, sums[bin * 3 + 2] / c))
        weights.append(c)
    }
    let fineCount = min(colourPaletteColors, samples.count)
    let fine = colourKMeans(samples, weights, max(1, fineCount), seed: 42, iterations: 10, tolerance: 1.0)
    var fineLabel = [UInt8](repeating: 255, count: n)
    for i in 0..<n where visible[i] {
        var best = 0, bestD = colourSq(SIMD3<Float>(labL[i], labA[i], labB[i]), fine.centres[0])
        for c in 1..<fine.centres.count {
            let d = colourSq(SIMD3<Float>(labL[i], labA[i], labB[i]), fine.centres[c])
            if d < bestD { bestD = d; best = c }
        }
        fineLabel[i] = UInt8(best)
    }

    // 4. Ink-bounded connected regions per colour group; every pixel then belongs to the nearest one.
    var regions = [Int32](repeating: 0, count: n)
    var nextRegion: Int32 = 1
    var stack: [Int32] = [], members: [Int32] = []
    for colour in 0..<max(1, fineCount) {
        let label = UInt8(colour)
        for i in 0..<n where fineLabel[i] == label && grown[i] == 0 && regions[i] == 0 {
            members.removeAll(keepingCapacity: true); stack.removeAll(keepingCapacity: true)
            stack.append(Int32(i)); regions[i] = -1
            while let p = stack.popLast() {
                let pi = Int(p)
                members.append(p)
                let y = pi / w, x = pi % w
                if x > 0 && fineLabel[pi - 1] == label && grown[pi - 1] == 0 && regions[pi - 1] == 0 { regions[pi - 1] = -1; stack.append(Int32(pi - 1)) }
                if x + 1 < w && fineLabel[pi + 1] == label && grown[pi + 1] == 0 && regions[pi + 1] == 0 { regions[pi + 1] = -1; stack.append(Int32(pi + 1)) }
                if y > 0 && fineLabel[pi - w] == label && grown[pi - w] == 0 && regions[pi - w] == 0 { regions[pi - w] = -1; stack.append(Int32(pi - w)) }
                if y + 1 < h && fineLabel[pi + w] == label && grown[pi + w] == 0 && regions[pi + w] == 0 { regions[pi + w] = -1; stack.append(Int32(pi + w)) }
            }
            if members.count >= colourMinRegionArea {
                for p in members { regions[Int(p)] = nextRegion }
                nextRegion += 1
            } else {
                for p in members { regions[Int(p)] = 0 }
            }
        }
    }
    // Nearest-region fill under the ink, so nothing is left unpainted under the lines.
    var queue: [Int32] = []
    queue.reserveCapacity(n)
    for i in 0..<n where regions[i] > 0 { queue.append(Int32(i)) }
    var head = 0
    while head < queue.count {
        let p = Int(queue[head]); head += 1
        let y = p / w, x = p % w
        if x > 0 && regions[p - 1] == 0 { regions[p - 1] = regions[p]; queue.append(Int32(p - 1)) }
        if x + 1 < w && regions[p + 1] == 0 { regions[p + 1] = regions[p]; queue.append(Int32(p + 1)) }
        if y > 0 && regions[p - w] == 0 { regions[p - w] = regions[p]; queue.append(Int32(p - w)) }
        if y + 1 < h && regions[p + w] == 0 { regions[p + w] = regions[p]; queue.append(Int32(p + w)) }
    }
    let regionCount = Int(nextRegion)

    // 5. Coarse colour groups from the region means, weighted by area: brush groups, not 16 greys.
    if regionCount > 1 {
        var area = [Float](repeating: 0, count: regionCount)
        var sumL = [Float](repeating: 0, count: regionCount)
        var sumA = [Float](repeating: 0, count: regionCount)
        var sumB = [Float](repeating: 0, count: regionCount)
        for i in 0..<n {
            let r = Int(regions[i])
            if r <= 0 { continue }
            area[r] += 1; sumL[r] += labL[i]; sumA[r] += labA[i]; sumB[r] += labB[i]
        }
        var means: [SIMD3<Float>] = [], mass: [Float] = []
        var seen = Set<UInt32>()
        for r in 1..<regionCount where area[r] > 0 {
            let m = SIMD3<Float>(sumL[r] / area[r], sumA[r] / area[r], sumB[r] / area[r])
            let key = UInt32(bitPattern: Int32(m.x.rounded())) &* 73856093
                ^ UInt32(bitPattern: Int32(m.y.rounded())) &* 19349663
                ^ UInt32(bitPattern: Int32(m.z.rounded()))
            if seen.contains(key) { continue }
            seen.insert(key)
            means.append(m); mass.append(area[r])
        }
        let groupCount = max(1, min(colourGroupCount, means.count))
        var assignment = [Int32](repeating: 0, count: regionCount)
        if means.isEmpty {
            // No regions at all: one group.
        } else {
            let grouped = colourKMeans(means, mass, groupCount, seed: 42, iterations: 20, tolerance: 0.5)
            // Clusters are not one-per-region; map each region to its nearest group mean.
            for r in 1..<regionCount where area[r] > 0 {
                let m = SIMD3<Float>(sumL[r] / area[r], sumA[r] / area[r], sumB[r] / area[r])
                var best = 0, bestD = colourSq(m, grouped.centres[0])
                for c in 1..<grouped.centres.count {
                    let d = colourSq(m, grouped.centres[c])
                    if d < bestD { bestD = d; best = c }
                }
                assignment[r] = Int32(best + 1)
            }
        }
        var palette = [UInt8](repeating: 1, count: n)
        for i in 0..<n { let r = Int(regions[i]); if r > 0 && assignment[r] > 0 { palette[i] = UInt8(assignment[r]) } }
        return colourStrokes(palette: palette, visible: visible, subject: subject, w: w, h: h, brush: brush,
                             cosA: cosA, sinA: sinA, began: began)
    }
    // One region or none: the whole picture is one colour group.
    return colourStrokes(palette: [UInt8](repeating: 1, count: n), visible: visible, subject: subject,
                         w: w, h: h, brush: brush, cosA: cosA, sinA: sinA, began: began)
}

/// Phases, colour order, lanes, routing and the one contact timeline.
private func colourStrokes(palette: [UInt8], visible: [Bool], subject: [Bool]?, w: Int, h: Int,
                           brush: Float, cosA: Float, sinA: Float, began: UInt64) -> ColourPlan {
    let n = w * h
    var phases: [[Int32]] = []
    if let subjectMask = subject {
        var front: [Int32] = [], back: [Int32] = []
        for i in 0..<n where visible[i] {
            if subjectMask[i] { front.append(Int32(i)) } else { back.append(Int32(i)) }
        }
        phases.append(front); phases.append(back)
    } else {
        var all: [Int32] = []
        for i in 0..<n where visible[i] { all.append(Int32(i)) }
        phases.append(all)
    }

    var out: [ColourStroke] = []
    var tip = SIMD2<Float>(0, 0)
    var groupTotal = 0
    for (phaseIndex, phase) in phases.enumerated() {
        if phase.isEmpty { continue }
        var byColour = [[Int32]](repeating: [], count: colourGroupCount)
        for p in phase {
            let g = Int(palette[Int(p)]) - 1
            if g >= 0 && g < colourGroupCount { byColour[g].append(p) }
        }
        var rowHist = [[Int32]](repeating: [Int32](repeating: 0, count: h), count: colourGroupCount)
        for g in 0..<colourGroupCount {
            for p in byColour[g] { rowHist[g][Int(p) / w] += 1 }
        }
        // Their rule: the first substantial occurrence of each colour near the top of the phase.
        var order: [(row: Int, group: Int)] = []
        for g in 0..<colourGroupCount where !byColour[g].isEmpty {
            let want = Int(Float(byColour[g].count) * 0.05)
            var row = 0, seen = 0
            while row < h {
                seen += Int(rowHist[g][row])
                if seen > want { break }
                row += 1
            }
            order.append((min(row, h - 1), g))
        }
        order.sort { $0.row != $1.row ? $0.row < $1.row : $0.group < $1.group }
        groupTotal += order.count

        for entry in order {
            let px = byColour[entry.group]
            if px.isEmpty { continue }
            var u = [Float](repeating: 0, count: px.count)
            var v = [Float](repeating: 0, count: px.count)
            var uLo = Float.greatestFiniteMagnitude, uHi = -Float.greatestFiniteMagnitude
            for k in 0..<px.count {
                let p = Int(px[k])
                let x = Float(p % w), y = Float(p / w)
                u[k] = x * cosA + y * sinA
                v[k] = -x * sinA + y * cosA
                if u[k] < uLo { uLo = u[k] }
                if u[k] > uHi { uHi = u[k] }
            }
            let lanes = max(1, Int(((uHi - uLo) / brush).rounded(.down)) + 1)
            var beams = [[Int32]](repeating: [], count: lanes)
            for k in 0..<px.count {
                let lane = min(lanes - 1, max(0, Int(((u[k] - uLo) / brush).rounded(.down))))
                beams[lane].append(Int32(k))
            }
            var spans: [ColourSpan] = []
            for lane in beams.indices {
                var idx = beams[lane]
                if idx.isEmpty { continue }
                idx.sort { a, b in
                    let va = v[Int(a)], vb = v[Int(b)]
                    return va != vb ? va < vb : a < b
                }
                var start = 0
                func emit(_ a: Int, _ b: Int) {
                    let slice = Array(idx[a...b])
                    var lo = Float.greatestFiniteMagnitude, hi = -Float.greatestFiniteMagnitude
                    var lLo = Float.greatestFiniteMagnitude, lHi = -Float.greatestFiniteMagnitude
                    for m in slice {
                        let vv = v[Int(m)], uu = u[Int(m)]
                        if vv < lo { lo = vv }
                        if vv > hi { hi = vv }
                        if uu < lLo { lLo = uu }
                        if uu > lHi { lHi = uu }
                    }
                    let laneU = (lLo + lHi) * 0.5
                    spans.append(ColourSpan(pixels: slice,
                                            begin: SIMD2<Float>(laneU * cosA - lo * sinA, laneU * sinA + lo * cosA),
                                            end: SIMD2<Float>(laneU * cosA - hi * sinA, laneU * sinA + hi * cosA),
                                            v0: lo, v1: hi))
                }
                if idx.count == 1 { emit(0, 0); continue }
                for k in 1..<idx.count where v[Int(idx[k])] - v[Int(idx[k - 1])] > brush * 0.75 {
                    emit(start, k - 1); start = k
                }
                emit(start, idx.count - 1)
            }
            spans = colourMergeShort(spans, u, brush, cosA, sinA)
            if spans.isEmpty { continue }
            let route = colourRefine(spans, colourGreedyRoute(spans, tip), tip)
            for (index, reverse) in route {
                var span = spans[index]
                if reverse {
                    swap(&span.begin, &span.end)
                    swap(&span.v0, &span.v1)
                }
                let travel = v2Len(span.begin - tip)
                let length = max(abs(span.v1 - span.v0), brush * 0.35)
                let spanV = span.v1 - span.v0
                var progress = [Float](repeating: 0.5, count: span.pixels.count)
                if abs(spanV) > 1e-6 {
                    for k in 0..<span.pixels.count { progress[k] = (v[Int(span.pixels[k])] - span.v0) / spanV }
                }
                // `span.pixels` are indices into this colour's own pixel list; the timeline is
                // indexed by global pixel, so the mapping happens exactly once, here.
                out.append(ColourStroke(pixels: span.pixels.map { px[Int($0)] }, progress: progress,
                                        travel: travel, length: length, phase: phaseIndex))
                tip = span.end
            }
        }
    }

    // One eased timeline for brush contact and pixels: a pixel appears exactly when the nib reaches it.
    var timing = [Float](repeating: .greatestFiniteMagnitude, count: n)
    var travelSum: Float = 0, paintSum: Float = 0
    var weightTotal: Float = 0
    var weights: [Float] = []
    weights.reserveCapacity(out.count * 2)
    for s in out {
        let travelWeight = max(s.travel / colourTravelSpeed, brush * 0.04)
        weights.append(travelWeight); weights.append(s.length)
        travelSum += s.travel; paintSum += s.length
        weightTotal += travelWeight + s.length
    }
    if weightTotal > 0 {
        var current: Float = 0
        for (i, s) in out.enumerated() {
            let travelDuration = weights[i * 2] / weightTotal
            let paintDuration = weights[i * 2 + 1] / weightTotal
            let paintStart = current + travelDuration
            for k in 0..<s.pixels.count {
                let contact = acos(1 - 2 * min(1, max(0, s.progress[k]))) / Float.pi
                timing[Int(s.pixels[k])] = paintStart + contact * paintDuration
            }
            current = paintStart + paintDuration
        }
    }
    // Every other pixel — the ink itself — takes its nearest painted neighbour's time, so the
    // picture is painted under the lines instead of leaving white paper showing through them.
    var queue: [Int32] = []
    for i in 0..<n where timing[i].isFinite {
        if timing[i] > 1 { timing[i] = 1 }
        queue.append(Int32(i))
    }
    var head = 0
    while head < queue.count {
        let p = Int(queue[head]); head += 1
        let y = p / w, x = p % w
        if x > 0 && !timing[p - 1].isFinite { timing[p - 1] = timing[p]; queue.append(Int32(p - 1)) }
        if x + 1 < w && !timing[p + 1].isFinite { timing[p + 1] = timing[p]; queue.append(Int32(p + 1)) }
        if y > 0 && !timing[p - w].isFinite { timing[p - w] = timing[p]; queue.append(Int32(p - w)) }
        if y + 1 < h && !timing[p + w].isFinite { timing[p + w] = timing[p]; queue.append(Int32(p + w)) }
    }
    for i in 0..<n where !timing[i].isFinite { timing[i] = 1 }
    var first = Float.greatestFiniteMagnitude
    for i in 0..<n where timing[i] < first { first = timing[i] }
    return ColourPlan(timing: timing, first: first == .greatestFiniteMagnitude ? 0 : first,
                      brush: brush, groups: groupTotal, strokes: out.count,
                      travel: travelSum, paint: paintSum, subject: subject != nil,
                      seconds: Double(DispatchTime.now().uptimeNanoseconds - began) / 1e9)
}

/// Decode a scene's depth map into a canvas-sized plane, drawn into the same fitted rect as the
/// picture so the two line up. Nil when the file is not a decodable image.
private func colourDepthPlane(_ path: String, _ w: Int, _ h: Int, _ rect: (x: Int, y: Int, w: Int, h: Int)) -> [Float]? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    let bytes = UnsafeMutablePointer<UInt8>.allocate(capacity: w * h)
    bytes.initialize(repeating: 0, count: w * h)
    defer { bytes.deinitialize(count: w * h); bytes.deallocate() }
    guard let context = CGContext(data: bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: w, height: h))
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h))
    var plane = [Float](repeating: 0, count: w * h)
    for i in 0..<(w * h) { plane[i] = Float(bytes[i]) }
    return plane
}

// ── Pen, NV12 and the render loop ────────────────────────────────────────────

private final class SketchTool {
    let bitmap: SketchBitmap
    let anchor: CGPoint
    init(_ pen: SketchPen, _ scale: Double) {
        let s = max(0.8, scale) * (pen.mode == "name" ? 1.25 : 1), w = Int(190 * s), h = Int(96 * s)
        bitmap = SketchBitmap(w, h); anchor = CGPoint(x: 16 * s, y: 79 * s)
        bitmap.bytes.update(repeating: 0, count: w * h * 4)
        let c = bitmap.context
        c.scaleBy(x: s, y: s)
        c.translateBy(x: 12, y: 12); c.rotate(by: 0.32)
        c.setFillColor(CGColor(gray: 0.14, alpha: 1))
        c.move(to: .zero); c.addLine(to: CGPoint(x: 24, y: 9)); c.addLine(to: CGPoint(x: 24, y: -9)); c.closePath(); c.fillPath()
        c.setFillColor(CGColor(red: 0.91, green: 0.92, blue: 0.94, alpha: 1))
        c.fill(CGRect(x: 24, y: -9, width: 138, height: 18))
        c.setFillColor(CGColor(red: 0.14, green: 0.26, blue: 0.34, alpha: 1))
        c.fill(CGRect(x: 154, y: -9, width: 12, height: 18))
        if pen.mode == "name", let text = pen.text {
            c.saveGState(); c.translateBy(x: 30, y: 4)
            let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 12, nil)
            let attributes = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: CGColor(gray: 0.1, alpha: 1)] as [CFString: Any]
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes as? [NSAttributedString.Key: Any]))
            let length = CTLineGetTypographicBounds(line, nil, nil, nil)
            c.scaleBy(x: min(1, 114 / max(1, length)), y: 1); CTLineDraw(line, c); c.restoreGState()
        } else if pen.mode == "logo", let path = pen.logo {
            let logo = sketchImage(path), ratio = min(108 / Double(logo.width), 15 / Double(logo.height))
            let lw = Double(logo.width) * ratio, lh = Double(logo.height) * ratio
            // CGImage draws top-down in this y-up bitmap; flip just the logo rect.
            c.draw(logo, in: CGRect(x: 32 + (108 - lw) / 2, y: -lh / 2, width: lw, height: lh))
        }
    }
    func stamp(_ point: CGPoint, _ canvas: SketchBitmap) -> (Int, Int, Int, Int, [UInt8]) {
        let ox = point.x - anchor.x, oy = point.y - anchor.y
        // Hide the pen whenever any part would clip: a stray cap or nib sliver is worse than no pen.
        if ox < 0 || oy < 0 || ox + Double(bitmap.width) > Double(canvas.width) || oy + Double(bitmap.height) > Double(canvas.height) {
            return (0, 0, 0, 0, [])
        }
        let x0 = Int(floor(ox)), y0 = Int(floor(oy))
        let x1 = min(canvas.width, Int(ceil(ox)) + bitmap.width), y1 = min(canvas.height, Int(ceil(oy)) + bitmap.height)
        if x1 <= x0 || y1 <= y0 { return (0, 0, 0, 0, []) }
        var saved: [UInt8] = []; saved.reserveCapacity((x1 - x0) * (y1 - y0) * 4)
        for y in y0..<y1 { for x in x0..<x1 {
            let i = (y * canvas.width + x) * 4
            let tx = Double(x) - ox, ty = Double(y) - oy, sx = Int(floor(tx)), sy = Int(floor(ty))
            let fx = tx - Double(sx), fy = ty - Double(sy)
            var sample = SIMD4<Double>(repeating: 0)
            for dy in 0...1 { for dx in 0...1 {
                let xx = sx + dx, yy = sy + dy
                if xx < 0 || yy < 0 || xx >= bitmap.width || yy >= bitmap.height { continue }
                let weight = (dx == 0 ? 1 - fx : fx) * (dy == 0 ? 1 - fy : fy), j = (yy * bitmap.width + xx) * 4
                for k in 0..<4 { sample[k] += Double(bitmap.bytes[j + k]) * weight }
            } }
            let a = sample[3] / 255
            for k in 0..<4 { saved.append(canvas.bytes[i + k]) }
            for k in 0..<3 { canvas.bytes[i + k] = UInt8(min(255, Double(canvas.bytes[i + k]) * (1 - a) + sample[k])) }
        } }
        return (x0, y0, x1, y1, saved)
    }
    func restore(_ saved: (Int, Int, Int, Int, [UInt8]), _ canvas: SketchBitmap) {
        var j = 0
        for y in saved.1..<saved.3 { for x in saved.0..<saved.2 {
            let i = (y * canvas.width + x) * 4
            for k in 0..<4 { canvas.bytes[i + k] = saved.4[j]; j += 1 }
        } }
    }
}

private func sketchNV12(_ canvas: SketchBitmap, _ pb: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(pb, [])
    defer { CVPixelBufferUnlockBaseAddress(pb, []) }
    let width = canvas.width, height = canvas.height
    let ys = CVPixelBufferGetBytesPerRowOfPlane(pb, 0), cs = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
    let yp = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
    let cp = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
    let src = canvas.bytes
    forRows(height / 2) { r0, r1 in
        for half in r0..<r1 {
            let y = half * 2
            for x in stride(from: 0, to: width, by: 2) {
                var cb = 0.0, cr = 0.0
                for dy in 0...1 { for dx in 0...1 {
                    let i = ((y + dy) * width + x + dx) * 4
                    let r = Double(src[i]) / 255, g = Double(src[i + 1]) / 255, b = Double(src[i + 2]) / 255
                    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
                    yp[(y + dy) * ys + x + dx] = UInt8(max(16, min(235, (16 + 219 * luma).rounded())))
                    cb += (b - luma) / 1.8556; cr += (r - luma) / 1.5748
                } }
                cp[half * cs + x] = UInt8(max(16, min(240, (128 + 56 * cb).rounded())))
                cp[half * cs + x + 1] = UInt8(max(16, min(240, (128 + 56 * cr).rounded())))
            }
        }
    }
}

func renderSketch(_ job: SketchJob) {
    let revealName = job.reveal ?? "line"
    let weightName = job.line_weight ?? "normal"
    guard job.kind == "sketch", job.width >= 2, job.height >= 2, job.width <= 4096, job.height <= 4096,
          job.width % 2 == 0, job.height % 2 == 0, job.fps >= 1, job.fps <= 120,
          job.frames >= 1, job.frames <= 1_000_000,
          job.hold_frames == nil || (job.frames < 3 ? job.hold_frames! == job.frames : (1...(job.frames - 2)).contains(job.hold_frames!)),
          job.quality == nil || (job.quality!.isFinite && (0...1).contains(job.quality!)),
          job.paper.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
          SketchReveal.names.contains(revealName),
          SketchLineWeight.names.contains(weightName),
          ["none", "plain", "name", "logo"].contains(job.pen.mode),
          job.pen.mode != "name" || (!(job.pen.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (job.pen.text?.count ?? 0) <= 256),
          job.pen.mode != "logo" || !(job.pen.logo ?? "").isEmpty,
          job.input.hasPrefix("/"), job.output.hasPrefix("/"), job.input != job.output,
          job.mask == nil || job.mask!.hasPrefix("/") else { fail(2, "bad sketch geometry, frame budget, paper, reveal, line weight, mask or pen") }
    if FileManager.default.fileExists(atPath: job.output) { fail(2, "sketch output already exists; use a new temporary path") }
    let began = DispatchTime.now().uptimeNanoseconds
    let hex = String(job.paper.dropFirst()), paper = stride(from: 0, to: 6, by: 2).map { i -> UInt8 in
        let start = hex.index(hex.startIndex, offsetBy: i), end = hex.index(start, offsetBy: 2)
        return UInt8(hex[start..<end], radix: 16)!
    }
    let source = SketchBitmap(job.width, job.height), image = sketchImage(job.input)
    source.context.setFillColor(CGColor(red: Double(paper[0]) / 255, green: Double(paper[1]) / 255, blue: Double(paper[2]) / 255, alpha: 1))
    source.context.fill(CGRect(x: 0, y: 0, width: job.width, height: job.height))
    // Match the existing contain fit, including nearest rounding and even-down pad offsets.
    let fw = min((Double(job.height * image.width) / Double(image.height)).rounded(), Double(job.width))
    let fh = min((Double(job.width * image.height) / Double(image.width)).rounded(), Double(job.height))
    let px = floor(floor((Double(job.width) - fw) / 2) / 2) * 2, py = floor(floor((Double(job.height) - fh) / 2) / 2) * 2
    source.context.interpolationQuality = .high
    source.context.draw(image, in: CGRect(x: px, y: py, width: fw, height: fh))
    let analysisBegan = DispatchTime.now().uptimeNanoseconds
    // The depth map is the scene's own, and is drawn into the same fitted rect as the picture.
    let mask = job.mask.map { (path: $0, rect: (x: Int(px), y: Int(py), w: Int(fw), h: Int(fh))) }
    let engine = SketchV2(source, paper, SketchReveal(rawValue: revealName)!, lineWeight: SketchLineWeight(rawValue: weightName)!, mask: mask)
    let analysisSeconds = Double(DispatchTime.now().uptimeNanoseconds - analysisBegan) / 1e9
    let hold = job.hold_frames ?? sketchDefaultHold(frames: job.frames, fps: job.fps)
    let drawing = job.frames - hold
    let tool = job.pen.mode == "none" ? nil : SketchTool(job.pen, Double(job.width) / 960)
    let timescale = Int32(job.fps * 512), writer: AVAssetWriter
    do { writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: job.output), fileType: .mp4) } catch { fail(4, "sketch writer: \(error)") }
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: job.width, AVVideoHeightKey: job.height,
        AVVideoCompressionPropertiesKey: [AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoExpectedSourceFrameRateKey: job.fps, AVVideoMaxKeyFrameIntervalKey: job.fps * 10,
            AVVideoAllowFrameReorderingKey: false, AVVideoQualityKey: job.quality ?? 0.7],
        AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
    ])
    input.mediaTimeScale = timescale
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey as String: job.width, kCVPixelBufferHeightKey as String: job.height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ])
    guard writer.canAdd(input) else { fail(4, "sketch writer rejected input") }
    writer.add(input)
    guard writer.startWriting() else { fail(4, "sketch start: \(writer.error?.localizedDescription ?? "?")") }
    writer.startSession(atSourceTime: .zero)
    var index = 0
    var maxWaitNs: UInt64 = 0
    func emit(_ reuse: CVPixelBuffer? = nil, stampPen: Bool = true) -> CVPixelBuffer {
        let waitStart = DispatchTime.now().uptimeNanoseconds
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed || writer.status == .cancelled {
                fail(4, "sketch encoder \(writer.status == .cancelled ? "cancelled" : "failed"): \(writer.error?.localizedDescription ?? "unknown error") at frame \(index)")
            }
            let waited = Double(DispatchTime.now().uptimeNanoseconds - waitStart) / 1e9
            if waited > 300.0 { fail(4, "sketch encoder stall: waited \(Int(waited))s for isReadyForMoreMediaData at frame \(index); writer status=\(writer.status.rawValue)") }
            usleep(3000)
        }
        let waitNs = DispatchTime.now().uptimeNanoseconds - waitStart
        if waitNs > maxWaitNs { maxWaitNs = waitNs }
        let pb: CVPixelBuffer
        if let reuse = reuse { pb = reuse } else {
            var value: CVPixelBuffer?
            guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &value) == kCVReturnSuccess, let value = value else { fail(4, "sketch pixel buffer") }
            pb = value
            let saved = stampPen ? engine.tip.flatMap { tool?.stamp(CGPoint(x: Double($0.x), y: Double($0.y)), source) } : nil
            sketchNV12(source, pb)
            if let saved = saved { tool?.restore(saved, source) }
            CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        }
        guard adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(index) * 512, timescale: timescale)) else { fail(4, "sketch append \(index): \(writer.error?.localizedDescription ?? "?")") }
        index += 1
        return pb
    }
    if drawing > 0 {
        let drawingBegan = DispatchTime.now().uptimeNanoseconds
        for f in 0..<drawing {
            let u = drawing <= 1 ? 1.0 : min(1.0, Float(f) / Float(drawing - 1))
            engine.render(u, into: source)
            _ = emit()
        }
        let drawingSeconds = Double(DispatchTime.now().uptimeNanoseconds - drawingBegan) / 1e9
        FileHandle.standardError.write(Data(String(format: "scene-clip sketch draw: %.3fs for %d frames (%.1f ms/frame)\n", drawingSeconds, drawing, 1000 * drawingSeconds / Double(max(1, drawing))).utf8))
    }
    // The hold is the finished drawing. The last drawing frame already rendered at u = 1, so the
    // hold re-encodes exactly that frame — without the pen, which belongs to the drawing.
    if drawing == 0 { engine.render(1.0, into: source) }
    let complete = emit(nil, stampPen: false)
    while index < job.frames { _ = emit(complete) }
    guard index == job.frames else { fail(4, "sketch frame budget \(index) != \(job.frames)") }
    input.markAsFinished()
    writer.endSession(atSourceTime: CMTime(value: CMTimeValue(job.frames) * 512, timescale: timescale))
    let sem = DispatchSemaphore(value: 0)
    writer.finishWriting { sem.signal() }
    if sem.wait(timeout: .now() + 180) == .timedOut { fail(4, "sketch finish stall: finishWriting did not complete within 180s; writer status=\(writer.status.rawValue)") }
    guard writer.status == .completed else { fail(4, "sketch finish \(writer.status == .failed ? "failed" : writer.status == .cancelled ? "cancelled" : "incomplete"): \(writer.error?.localizedDescription ?? "unknown error")") }
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - began) / 1e9
    FileHandle.standardError.write(Data(String(format: "scene-clip sketch: %@, %d strokes, analysis %.3fs, %d drawing + %d hold = %d frames, %.3fs\n", revealName, engine.strokeCount, analysisSeconds, drawing, hold, job.frames, elapsed).utf8))
    if ProcessInfo.processInfo.environment["SCENE_CLIP_PROFILE"] != nil {
        FileHandle.standardError.write(Data(String(format: "scene-clip sketch profile: max isReadyForMoreMediaData wait %.3fs\n", Double(maxWaitNs) / 1e9).utf8))
    }
}
