// Optional local-only OCR helper. Compile with swiftc; no network or model calls.
import Foundation
import Vision
import PDFKit
import AppKit
import ImageIO

struct Input: Decodable { let pdf: String; let pages: [Int]; let images: [String:String]? }
struct Page: Encodable { let number: Int; let text: String; let confidence: Float }
let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
guard let document = PDFDocument(data: try Data(contentsOf: URL(fileURLWithPath: input.pdf))) else { exit(2) }
var output: [Page] = []
for number in input.pages {
    let cgImage: CGImage
    if let imagePath = input.images?[String(number)] {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }
        cgImage = image
    } else {
        guard let page = document.page(at: number - 1) else { exit(2) }
        let size = page.bounds(for: .mediaBox).size
        let image = page.thumbnail(of: NSSize(width: size.width * 2, height: size.height * 2), for: .mediaBox)
        var rect = CGRect(origin: .zero, size: image.size)
        guard let rendered = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { exit(2) }
        cgImage = rendered
    }
    let request = VNRecognizeTextRequest()
    request.revision = VNRecognizeTextRequestRevision2
    request.usesCPUOnly = true
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-CA"]
    request.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: cgImage).perform([request]) }
    catch {
        request.recognitionLevel = .fast
        do { try VNImageRequestHandler(cgImage: cgImage).perform([request]) }
        catch { output.append(Page(number: number, text: "", confidence: 0)); continue }
    }
    let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
    output.append(Page(number: number, text: candidates.map(\.string).joined(separator: "\n"), confidence: candidates.isEmpty ? 0 : candidates.map(\.confidence).reduce(0,+) / Float(candidates.count)))
}
FileHandle.standardOutput.write(try JSONEncoder().encode(output))
