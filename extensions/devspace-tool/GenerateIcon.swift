import AppKit
import Foundation

let outputPath = CommandLine.arguments.dropFirst().first ?? "DevSpaceToolIcon.png"
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)

image.lockFocus()
NSGraphicsContext.current?.imageInterpolation = .high

let canvas = NSRect(origin: .zero, size: size)
let background = NSBezierPath(roundedRect: canvas.insetBy(dx: 28, dy: 28), xRadius: 220, yRadius: 220)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.04, green: 0.10, blue: 0.22, alpha: 1),
    NSColor(calibratedRed: 0.20, green: 0.05, blue: 0.34, alpha: 1),
    NSColor(calibratedRed: 0.00, green: 0.62, blue: 0.74, alpha: 1)
])!
gradient.draw(in: background, angle: -42)

let panelRect = canvas.insetBy(dx: 150, dy: 150)
let panel = NSBezierPath(roundedRect: panelRect, xRadius: 150, yRadius: 150)
NSColor(calibratedWhite: 0.02, alpha: 0.55).setFill()
panel.fill()
NSColor.white.withAlphaComponent(0.18).setStroke()
panel.lineWidth = 8
panel.stroke()

func strokedPath(_ points: [NSPoint]) {
    guard let first = points.first else { return }
    let path = NSBezierPath()
    path.move(to: first)
    for point in points.dropFirst() { path.line(to: point) }
    path.lineWidth = 62
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    NSColor.white.setStroke()
    path.stroke()
}

strokedPath([
    NSPoint(x: 402, y: 342),
    NSPoint(x: 270, y: 512),
    NSPoint(x: 402, y: 682)
])
strokedPath([
    NSPoint(x: 622, y: 342),
    NSPoint(x: 754, y: 512),
    NSPoint(x: 622, y: 682)
])
strokedPath([
    NSPoint(x: 574, y: 300),
    NSPoint(x: 450, y: 724)
])

for center in [NSPoint(x: 332, y: 250), NSPoint(x: 512, y: 226), NSPoint(x: 692, y: 250)] {
    let dot = NSBezierPath(ovalIn: NSRect(x: center.x - 18, y: center.y - 18, width: 36, height: 36))
    NSColor(calibratedRed: 0.36, green: 0.96, blue: 1.0, alpha: 0.95).setFill()
    dot.fill()
}

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Could not render DevSpace Tool icon.\n", stderr)
    exit(1)
}

try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
