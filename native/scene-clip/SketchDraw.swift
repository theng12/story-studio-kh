// Sketch Draw: local skeleton ink + feathered colour reveal. No upstream assets or runtime.
//
// Frames: closing hold = min(2.5 s, 50% of the clip) in frames (at least 1), or the job's exact
// hold_frames; the rest is split ink:colour 2:1 (each at least 1 frame). A clip of fewer than
// 3 frames cannot hold both phases, so it shows only the completed image: never an overrun. Regions are connected ink areas clustered by centre
// (at most six), ordered top-to-bottom then left-to-right; brush sweeps are serpentine.
// Pen tip is anchored at the newest stroke sample and hidden during the hold.
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
}

/// The closing hold the app and the helper agree on; lib/native-scene-clip.ts mirrors it.
func sketchDefaultHold(frames: Int, fps: Int) -> Int {
    if frames < 3 { return frames }
    return min(frames - 2, max(1, Int(min(2.5 * Double(fps), Double(frames) / 2).rounded())))
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

private struct SketchStroke {
    var points: [CGPoint]
    var length: Double
}

private struct SketchRegion {
    var centre: CGPoint
    var strokes: [SketchStroke] = []
    var brush: [CGPoint] = []
    var pixels = 0
}

private func sketchImage(_ path: String) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
          image.width > 0, image.height > 0, image.width <= 16384, image.height <= 16384 else {
        fail(3, "cannot decode sketch image \(path)")
    }
    return image
}

private func sketchInk(_ bitmap: SketchBitmap) -> [UInt8] {
    let w = bitmap.width, h = bitmap.height
    var gray = [Float](repeating: 0, count: w * h)
    for i in 0..<gray.count {
        gray[i] = Float(bitmap.bytes[i * 4]) * 0.299 + Float(bitmap.bytes[i * 4 + 1]) * 0.587 + Float(bitmap.bytes[i * 4 + 2]) * 0.114
    }
    // A separable 15x15 Gaussian adaptive threshold, C=10, with replicated borders.
    let kernel = (-7...7).map { exp(-Float($0 * $0) / (2 * 2.6 * 2.6)) }
    let sum = kernel.reduce(0, +)
    var horizontal = gray, ink = [UInt8](repeating: 0, count: gray.count)
    for y in 0..<h { for x in 0..<w {
        var value: Float = 0
        for k in -7...7 { value += gray[y * w + min(w - 1, max(0, x + k))] * kernel[k + 7] }
        horizontal[y * w + x] = value / sum
    } }
    for y in 1..<(h - 1) { for x in 1..<(w - 1) {
        var value: Float = 0
        for k in -7...7 { value += horizontal[min(h - 1, max(0, y + k)) * w + x] * kernel[k + 7] }
        ink[y * w + x] = gray[y * w + x] < value / sum - 10 ? 1 : 0
    } }
    return ink
}

private func sketchSkeleton(_ ink: [UInt8], _ w: Int, _ h: Int) -> [UInt8] {
    var skeleton = ink
    let offsets = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]
    var active = (0..<ink.count).filter { ink[$0] != 0 }
    for _ in 0..<160 {
        var changed = false
        for pass in 0...1 {
            var removed: [Int] = []
            for i in active where skeleton[i] != 0 {
                let p = offsets.map { Int(skeleton[i + $0]) }
                let neighbours = p.reduce(0, +)
                if neighbours < 2 || neighbours > 6 { continue }
                var transitions = 0
                for k in 0..<8 where p[k] == 0 && p[(k + 1) % 8] == 1 { transitions += 1 }
                if transitions != 1 { continue }
                if pass == 0 {
                    if p[0] * p[2] * p[4] != 0 || p[2] * p[4] * p[6] != 0 { continue }
                } else if p[0] * p[2] * p[6] != 0 || p[0] * p[4] * p[6] != 0 { continue }
                removed.append(i)
            }
            for i in removed { skeleton[i] = 0 }
            changed = changed || !removed.isEmpty
        }
        if !changed { break }
        active.removeAll { skeleton[$0] == 0 }
    }
    return skeleton
}

private func sketchResample(_ points: [CGPoint], _ spacing: Double) -> [CGPoint] {
    guard let first = points.first else { return [] }
    var result = [first], remainder = spacing
    for i in 1..<points.count {
        var a = points[i - 1]
        let b = points[i]
        var length = hypot(b.x - a.x, b.y - a.y)
        while length >= remainder && length > 0 {
            let ratio = remainder / length
            a = CGPoint(x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio)
            result.append(a); length -= remainder; remainder = spacing
        }
        remainder -= length
    }
    if result.last != points.last { result.append(points.last!) }
    return result
}

private func sketchTrace(_ skeleton: [UInt8], _ w: Int, _ h: Int) -> [SketchStroke] {
    let offsets = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]
    let pixels = (0..<skeleton.count).filter { skeleton[$0] != 0 }
    var degree = [UInt8](repeating: 0, count: skeleton.count)
    for i in pixels { degree[i] = UInt8(offsets.filter { skeleton[i + $0] != 0 }.count) }
    var used = [UInt8](repeating: 0, count: skeleton.count), strokes: [SketchStroke] = []
    // Endpoints/junctions first; the second traversal includes closed loops.
    let starts = pixels.filter { degree[$0] != 2 } + pixels.filter { degree[$0] == 2 }
    for start in starts {
        for direction in 0..<8 where skeleton[start + offsets[direction]] != 0 && used[start] & (1 << direction) == 0 {
            var points = [CGPoint(x: start % w, y: start / w)]
            var current = start, nextDirection = direction
            while true {
                used[current] |= 1 << nextDirection
                let next = current + offsets[nextDirection]
                used[next] |= 1 << ((nextDirection + 4) % 8)
                points.append(CGPoint(x: next % w, y: next / w))
                let previous = current
                current = next
                if degree[current] != 2 || current == start { break }
                guard let d = (0..<8).first(where: { current + offsets[$0] != previous && skeleton[current + offsets[$0]] != 0 && used[current] & (1 << $0) == 0 }) else { break }
                nextDirection = d
            }
            if points.count < 4 { continue }
            let sampled = sketchResample(points, 2.5)
            var smooth = [sampled[0]]
            for j in 1..<sampled.count {
                let a = sampled[j - 1], b = sampled[j]
                smooth.append(CGPoint(x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25))
                smooth.append(CGPoint(x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75))
            }
            smooth.append(sampled.last!)
            let final = sketchResample(smooth, 2.5)
            let length = zip(final, final.dropFirst()).reduce(0.0) { $0 + hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y) }
            if length > 2 { strokes.append(SketchStroke(points: final, length: length)) }
        }
    }
    return strokes.sorted {
        let a = $0.points[0], b = $1.points[0]
        if Int(a.y / 12) != Int(b.y / 12) { return a.y < b.y }
        if a.x != b.x { return a.x < b.x }
        return $0.length > $1.length
    }
}

private func sketchRegions(_ ink: [UInt8], _ w: Int, _ h: Int, _ strokes: [SketchStroke], _ maxRegions: Int) -> ([SketchRegion], [UInt8]) {
    var visited = [UInt8](repeating: 0, count: ink.count), components: [(CGPoint, Int)] = []
    let offsets = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]
    for i in 0..<ink.count where ink[i] != 0 && visited[i] == 0 {
        var queue = [i], cursor = 0, sx = 0, sy = 0
        visited[i] = 1
        while cursor < queue.count {
            let p = queue[cursor]; cursor += 1; sx += p % w; sy += p / w
            for d in offsets {
                let n = p + d
                if ink[n] != 0 && visited[n] == 0 { visited[n] = 1; queue.append(n) }
            }
        }
        if queue.count >= 4 { components.append((CGPoint(x: Double(sx) / Double(queue.count), y: Double(sy) / Double(queue.count)), queue.count)) }
    }
    // Connected ink areas are clustered into at most six geometric regions (not semantic objects).
    components.sort { $0.1 > $1.1 }
    var centres: [CGPoint] = []
    for (point, _) in components where centres.count < maxRegions {
        if centres.allSatisfy({ hypot(($0.x - point.x) / Double(w), ($0.y - point.y) / Double(h)) > 0.25 }) { centres.append(point) }
    }
    if centres.isEmpty { centres = [CGPoint(x: w / 2, y: h / 2)] }
    for _ in 0..<3 {
        var sx = [Double](repeating: 0, count: centres.count), sy = sx, weight = sx
        for (point, size) in components {
            let r = centres.indices.min(by: { hypot(centres[$0].x - point.x, centres[$0].y - point.y) < hypot(centres[$1].x - point.x, centres[$1].y - point.y) })!
            sx[r] += point.x * Double(size); sy[r] += point.y * Double(size); weight[r] += Double(size)
        }
        for r in centres.indices where weight[r] > 0 { centres[r] = CGPoint(x: sx[r] / weight[r], y: sy[r] / weight[r]) }
    }
    centres.sort { abs($0.y - $1.y) > 12 ? $0.y < $1.y : $0.x < $1.x }
    var regions = centres.map { SketchRegion(centre: $0) }, owners = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h { for x in 0..<w {
        let r = centres.indices.min(by: { hypot(centres[$0].x - Double(x), centres[$0].y - Double(y)) < hypot(centres[$1].x - Double(x), centres[$1].y - Double(y)) })!
        owners[y * w + x] = UInt8(r); regions[r].pixels += 1
    } }
    for stroke in strokes {
        let p = stroke.points[stroke.points.count / 2]
        regions[Int(owners[Int(p.y) * w + Int(p.x)])].strokes.append(stroke)
    }
    return (regions, owners)
}

private final class SketchCanvas {
    let source: SketchBitmap, canvas: SketchBitmap
    let ink: [UInt8], owners: [UInt8]
    let aw: Int, ah: Int
    let scale: Double
    let radius: Double
    private var painted: [UInt8]
    var inkTotal: Int
    init(_ source: SketchBitmap, _ ink: [UInt8], _ owners: [UInt8], _ aw: Int, _ ah: Int, _ paper: [UInt8], _ fit: CGRect) {
        self.source = source; self.ink = ink; self.owners = owners; self.aw = aw; self.ah = ah
        painted = [UInt8](repeating: 0, count: aw * ah); inkTotal = ink.reduce(0) { $0 + Int($1) }
        scale = Double(source.width) / Double(aw); radius = max(8, 32 * scale)
        canvas = SketchBitmap(source.width, source.height)
        let x0 = max(0, Int(fit.minX)), x1 = min(source.width - 1, Int(fit.maxX) - 1)
        let y0 = max(0, Int(fit.minY)), y1 = min(source.height - 1, Int(fit.maxY) - 1)
        let corners = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
        let background = (0..<3).map { c -> UInt8 in
            let values = corners.map { Int(source.bytes[($0.1 * source.width + $0.0) * 4 + c]) }.sorted()
            return UInt8((values[1] + values[2]) / 2)
        }
        // Keep an illustration's own paper stationary; reveal its subject, not polygonal background patches.
        for y in 0..<source.height { for x in 0..<source.width {
            let colour = x >= x0 && x <= x1 && y >= y0 && y <= y1 ? background : paper
            for c in 0..<3 { canvas.bytes[(y * source.width + x) * 4 + c] = colour[c] }
        } }
    }
    func inkSegment(_ a: CGPoint, _ b: CGPoint) {
        let ax = a.x * scale, ay = a.y * scale, bx = b.x * scale, by = b.y * scale
        let r = max(1.5, 4.5 * scale), w = canvas.width, h = canvas.height
        let x0 = max(0, Int(min(ax, bx) - r - 1)), x1 = min(w - 1, Int(max(ax, bx) + r + 1))
        let y0 = max(0, Int(min(ay, by) - r - 1)), y1 = min(h - 1, Int(max(ay, by) + r + 1))
        if x0 > x1 || y0 > y1 { return }
        let dx = bx - ax, dy = by - ay, length2 = max(0.0001, dx * dx + dy * dy)
        for y in y0...y1 { for x in x0...x1 {
            let p = min(ah - 1, Int(Double(y) / scale)) * aw + min(aw - 1, Int(Double(x) / scale))
            if ink[p] == 0 { continue }
            let t = max(0, min(1, ((Double(x) - ax) * dx + (Double(y) - ay) * dy) / length2))
            let alpha = min(1, max(0, r + 0.5 - hypot(Double(x) - ax - t * dx, Double(y) - ay - t * dy)))
            let i = (y * w + x) * 4
            for c in 0..<3 { canvas.bytes[i + c] = UInt8(Double(canvas.bytes[i + c]) * (1 - alpha) + 24 * alpha) }
            if alpha > 0.35 { painted[p] = 1 }
        } }
    }
    /// Skeleton tracing can miss short arcs and thick joins. Complete those ink pixels
    /// across the region's own ink frames so no missing ink appears all at once in the hold.
    func paintResidualInk(_ region: Int, _ from: Double, _ to: Double) -> CGPoint? {
        let y0 = min(ah, max(0, Int(Double(ah) * from))), y1 = min(ah, max(y0 + 1, Int(Double(ah) * to)))
        var last: CGPoint?
        for y in y0..<y1 { for x in 0..<aw {
            let p = y * aw + x
            if ink[p] == 0 || owners[p] != UInt8(region) || painted[p] != 0 { continue }
            let ox0 = Int(Double(x) * scale), ox1 = min(canvas.width, Int(Double(x + 1) * scale) + 1)
            let oy0 = Int(Double(y) * scale), oy1 = min(canvas.height, Int(Double(y + 1) * scale) + 1)
            // Use the pixel's own grayscale, not flat black: dense hatching must keep its texture.
            let sx = min(source.width - 1, (ox0 + ox1) / 2), sy = min(source.height - 1, (oy0 + oy1) / 2)
            let si = (sy * source.width + sx) * 4
            let gray = UInt8(0.299 * Double(source.bytes[si]) + 0.587 * Double(source.bytes[si + 1]) + 0.114 * Double(source.bytes[si + 2]))
            for oy in oy0..<oy1 { for ox in ox0..<ox1 {
                let i = (oy * canvas.width + ox) * 4
                for c in 0..<3 { canvas.bytes[i + c] = gray }
            } }
            painted[p] = 1; last = CGPoint(x: x, y: y)
        } }
        return last
    }
    func undrawnInk() -> Int {
        var count = 0
        for p in 0..<ink.count where ink[p] != 0 && painted[p] == 0 { count += 1 }
        return count
    }
    func brush(_ point: CGPoint) {
        let cx = point.x * scale, cy = point.y * scale, w = canvas.width, h = canvas.height, r = radius
        let x0 = max(0, Int(cx - r)), x1 = min(w - 1, Int(cx + r)), y0 = max(0, Int(cy - r)), y1 = min(h - 1, Int(cy + r))
        if x0 > x1 || y0 > y1 { return }
        for y in y0...y1 { for x in x0...x1 {
            // Neighbouring regions may feather over the boundary; a hard ownership clip makes visible wedges.
            let alpha = min(1, max(0, (r - hypot(Double(x) - cx, Double(y) - cy)) / (r * 0.32)))
            if alpha <= 0 { continue }
            let i = (y * w + x) * 4
            for c in 0..<3 { canvas.bytes[i + c] = UInt8(Double(canvas.bytes[i + c]) * (1 - alpha) + Double(source.bytes[i + c]) * alpha) }
        } }
    }
    func complete() { canvas.bytes.update(from: source.bytes, count: canvas.width * canvas.height * 4) }
}

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
    let ys = CVPixelBufferGetBytesPerRowOfPlane(pb, 0), cs = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
    let yp = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
    let cp = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
    for y in stride(from: 0, to: canvas.height, by: 2) { for x in stride(from: 0, to: canvas.width, by: 2) {
        var cb = 0.0, cr = 0.0
        for dy in 0...1 { for dx in 0...1 {
            let i = ((y + dy) * canvas.width + x + dx) * 4
            let r = Double(canvas.bytes[i]) / 255, g = Double(canvas.bytes[i + 1]) / 255, b = Double(canvas.bytes[i + 2]) / 255
            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
            yp[(y + dy) * ys + x + dx] = UInt8(max(16, min(235, (16 + 219 * luma).rounded())))
            cb += (b - luma) / 1.8556; cr += (r - luma) / 1.5748
        } }
        cp[y / 2 * cs + x] = UInt8(max(16, min(240, (128 + 56 * cb).rounded())))
        cp[y / 2 * cs + x + 1] = UInt8(max(16, min(240, (128 + 56 * cr).rounded())))
    } }
}

func renderSketch(_ job: SketchJob) {
    guard job.kind == "sketch", job.width >= 2, job.height >= 2, job.width <= 4096, job.height <= 4096,
          job.width % 2 == 0, job.height % 2 == 0, job.fps >= 1, job.fps <= 120,
          job.frames >= 1, job.frames <= 1_000_000,
          job.hold_frames == nil || (job.frames < 3 ? job.hold_frames! == job.frames : (1...(job.frames - 2)).contains(job.hold_frames!)),
          job.quality == nil || (job.quality!.isFinite && (0...1).contains(job.quality!)),
          job.paper.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
          ["none", "plain", "name", "logo"].contains(job.pen.mode),
          job.pen.mode != "name" || (!(job.pen.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (job.pen.text?.count ?? 0) <= 256),
          job.pen.mode != "logo" || !(job.pen.logo ?? "").isEmpty,
          job.input.hasPrefix("/"), job.output.hasPrefix("/"), job.input != job.output else { fail(2, "bad sketch geometry, frame budget, paper or pen") }
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
    let aw = max(4, min(960, job.width)), ah = max(4, Int((Double(job.height) * Double(aw) / Double(job.width)).rounded()))
    let analysis = SketchBitmap(aw, ah)
    analysis.context.interpolationQuality = .high
    analysis.context.draw(source.context.makeImage()!, in: CGRect(x: 0, y: 0, width: aw, height: ah))
    let ink = sketchInk(analysis), skeleton = sketchSkeleton(ink, aw, ah), strokes = sketchTrace(skeleton, aw, ah)
    let hold = job.hold_frames ?? sketchDefaultHold(frames: job.frames, fps: job.fps)
    let drawing = job.frames - hold
    var (regions, owners) = sketchRegions(ink, aw, ah, strokes, max(1, min(6, drawing / 3)))
    let canvas = SketchCanvas(source, ink, owners, aw, ah, paper, CGRect(x: px, y: py, width: fw, height: fh))
    let step = max(4, canvas.radius / canvas.scale * 0.7)
    for r in regions.indices {
        // Follow ink first, then serpentine brush sweeps cover colour away from the skeleton too.
        regions[r].brush = regions[r].strokes.flatMap { sketchResample($0.points, step * 0.6) }
        var row = 0
        for y in stride(from: step * 0.25, through: Double(ah - 1) + step * 0.25, by: step) {
            let yy = min(ah - 1, Int(y))
            let xs = Array(stride(from: step * 0.25, through: Double(aw - 1) + step * 0.25, by: step))
            for x in row % 2 == 0 ? xs : xs.reversed() {
                let xx = min(aw - 1, Int(x))
                if owners[yy * aw + xx] == r { regions[r].brush.append(CGPoint(x: xx, y: yy)) }
            }
            row += 1
        }
    }
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
    func emit(_ point: CGPoint?, _ reuse: CVPixelBuffer? = nil) -> CVPixelBuffer {
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed { fail(4, "sketch encoder: \(writer.error?.localizedDescription ?? "?")") }
            usleep(300)
        }
        let pb: CVPixelBuffer
        if let reuse = reuse { pb = reuse } else {
            var value: CVPixelBuffer?
            guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &value) == kCVReturnSuccess, let value = value else { fail(4, "sketch pixel buffer") }
            pb = value
            let saved = point.flatMap { tool?.stamp(CGPoint(x: $0.x * canvas.scale, y: $0.y * canvas.scale), canvas.canvas) }
            if ProcessInfo.processInfo.environment["SCENE_CLIP_PROFILE"] != nil, let p = point {
                FileHandle.standardError.write(Data(String(format: "sketch tip frame %d: %.3f %.3f\n", index, p.x * canvas.scale, p.y * canvas.scale).utf8))
            }
            sketchNV12(canvas.canvas, pb)
            if let saved = saved { tool?.restore(saved, canvas.canvas) }
            CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        }
        guard adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(index) * 512, timescale: timescale)) else { fail(4, "sketch append \(index): \(writer.error?.localizedDescription ?? "?")") }
        index += 1
        return pb
    }
    if drawing > 0 {
        let inkBudget = canvas.inkTotal > 0 ? max(regions.count, Int((Double(drawing) * 2 / 3).rounded())) : 0
        let colourBudget = drawing - inkBudget
        func budgets(_ total: Int, _ weights: [Int]) -> [Int] {
            let available = total - weights.count, sum = max(1, weights.reduce(0, +))
            var assigned = 0
            return weights.enumerated().map { i, weight in
                let next = i == weights.count - 1 ? available : Int((Double(available) * Double(weights.prefix(i + 1).reduce(0, +)) / Double(sum)).rounded())
                let count = 1 + next - assigned; assigned = next; return count
            }
        }
        let ib = inkBudget == 0 ? [Int](repeating: 0, count: regions.count) : budgets(inkBudget, regions.map { max(1, Int($0.strokes.reduce(0) { $0 + $1.length })) })
        let cb = budgets(colourBudget, regions.map { $0.pixels })
        for r in regions.indices {
            let segments = regions[r].strokes.flatMap { stroke in zip(stroke.points, stroke.points.dropFirst()).map { ($0, $1) } }
            var cursor = 0
            if ib[r] > 0 { for f in 0..<ib[r] {
                let end = (f + 1) * segments.count / ib[r]
                while cursor < end { canvas.inkSegment(segments[cursor].0, segments[cursor].1); cursor += 1 }
                let residual = canvas.paintResidualInk(r, Double(f) / Double(ib[r]), Double(f + 1) / Double(ib[r]))
                _ = emit(cursor > 0 ? segments[cursor - 1].1 : residual)
            } }
            cursor = 0
            for f in 0..<cb[r] {
                let end = (f + 1) * regions[r].brush.count / cb[r]
                while cursor < end { canvas.brush(regions[r].brush[cursor]); cursor += 1 }
                // The pen marks ink work only; a colour-only frame has no active stroke point.
                _ = emit(nil)
            }
        }
    }
    let residual = canvas.undrawnInk()
    let residualPct = canvas.inkTotal > 0 ? 100 * Double(residual) / Double(canvas.inkTotal) : 0
    FileHandle.standardError.write(Data(String(format: "scene-clip sketch ink hold-start: %d/%d undrawn (%.3f%%)\n", residual, canvas.inkTotal, residualPct).utf8))
    canvas.complete()
    let complete = emit(nil)
    while index < job.frames { _ = emit(nil, complete) }
    guard index == job.frames else { fail(4, "sketch frame budget \(index) != \(job.frames)") }
    input.markAsFinished()
    writer.endSession(atSourceTime: CMTime(value: CMTimeValue(job.frames) * 512, timescale: timescale))
    let sem = DispatchSemaphore(value: 0)
    writer.finishWriting { sem.signal() }; sem.wait()
    guard writer.status == .completed else { fail(4, "sketch finish: \(writer.error?.localizedDescription ?? "?")") }
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - began) / 1e9
    FileHandle.standardError.write(Data(String(format: "scene-clip sketch: %d regions, %d strokes, %d drawing + %d hold = %d frames, %.3fs\n", regions.count, strokes.count, drawing, hold, job.frames, elapsed).utf8))
}
