// 生成 App 图标：蓝色圆角方块 + 🌀
import AppKit
let size = CGFloat(1024)
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
let colors = [NSColor(calibratedRed: 0.13, green: 0.44, blue: 0.95, alpha: 1).cgColor,
              NSColor(calibratedRed: 0.05, green: 0.28, blue: 0.75, alpha: 1).cgColor]
let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
let rect = CGRect(x: 80, y: 80, width: 864, height: 864)
let path = CGPath(roundedRect: rect, cornerWidth: 190, cornerHeight: 190, transform: nil)
ctx.addPath(path); ctx.saveGState(); ctx.clip()
ctx.drawLinearGradient(grad, start: CGPoint(x: 512, y: 900), end: CGPoint(x: 512, y: 120), options: [])
ctx.restoreGState()
let para = NSMutableParagraphStyle(); para.alignment = .center
let emoji = NSAttributedString(string: "🌀", attributes: [
    .font: NSFont.systemFont(ofSize: 560),
    .paragraphStyle: para,
])
emoji.draw(in: CGRect(x: 80, y: 212, width: 864, height: 600))
img.unlockFocus()
if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
    try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
    print("icon written")
}
