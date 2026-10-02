import Foundation
import Photos
import Tauri
import UIKit
import UniformTypeIdentifiers

// 메신저 첨부 저장·공유(iOS, 2026-10-02). 서명 URL을 직접 받아 임시 폴더에 원래 이름으로 둔 뒤:
//   share/open → UIActivityViewController(공유 시트 — '이미지 저장'·'파일에 저장'·다른 앱으로 열기가 여기 있다)
//   save       → 그림은 사진 보관함(PHPhotoLibrary, 추가 전용 권한 — Info.plist NSPhotoLibraryAddUsageDescription), 그 밖은 '파일에 저장'(문서 내보내기)
// 결과: { where: "photos"|"files" } 또는 { cancelled: true }. 실패는 reject(문구는 JS가 고른다).

struct MediaArgs: Decodable {
  let url: String
  let name: String?
  let mime: String?
}

struct MediaResult: Encodable {
  let place: String?
  let cancelled: Bool
  enum CodingKeys: String, CodingKey {
    case place = "where"
    case cancelled
  }
}

class MediaSharePlugin: Plugin, UIDocumentPickerDelegate {
  private let maxBytes: Int64 = 26_214_400 // 첨부 상한 25MB(앱·게이트웨이·저장소 정책과 같다)
  private var pickerInvoke: Invoke?

  @objc public func share(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MediaArgs.self)
    fetch(args, invoke) { file, _ in self.presentShare(file, invoke) }
  }

  // iOS에는 '다른 앱으로 열기' 단독 화면이 없다 — 공유 시트가 그 역할(파일에 저장·앱으로 보내기)을 한다.
  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MediaArgs.self)
    fetch(args, invoke) { file, _ in self.presentShare(file, invoke) }
  }

  @objc public func save(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MediaArgs.self)
    fetch(args, invoke) { file, mime in
      let isImage = mime.hasPrefix("image/") || (UTType(filenameExtension: file.pathExtension)?.conforms(to: .image) ?? false)
      if isImage { self.saveToPhotos(file, invoke) } else { self.exportToFiles(file, invoke) }
    }
  }

  private func fetch(_ args: MediaArgs, _ invoke: Invoke, then: @escaping (URL, String) -> Void) {
    guard let url = URL(string: args.url), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
      invoke.reject("invalid url")
      return
    }
    let task = URLSession.shared.downloadTask(with: url) { tmp, response, error in
      if let error = error { invoke.reject(error.localizedDescription); return }
      guard let tmp = tmp, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        invoke.reject("download failed")
        return
      }
      do {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("media-share", isDirectory: true)
        Self.prune(root)
        let dir = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(Self.safeName(args.name))
        try fm.moveItem(at: tmp, to: dest)
        let size = Int64((try? dest.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        if size > self.maxBytes {
          try? fm.removeItem(at: dir)
          invoke.reject("file too large")
          return
        }
        let given = args.mime ?? ""
        let mime = (!given.isEmpty && given != "application/octet-stream") ? given : (http.mimeType ?? "application/octet-stream")
        DispatchQueue.main.async { then(dest, mime) }
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
    task.resume()
  }

  private func presentShare(_ file: URL, _ invoke: Invoke) {
    guard let vc = manager.viewController else { invoke.reject("no view controller"); return }
    let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
    sheet.completionWithItemsHandler = { _, completed, _, error in
      if let error = error { invoke.reject(error.localizedDescription) } else { invoke.resolve(MediaResult(place: nil, cancelled: !completed)) }
    }
    if let pop = sheet.popoverPresentationController { // iPad — 팝오버 기준점이 없으면 앱이 종료된다
      pop.sourceView = vc.view
      pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 80, width: 1, height: 1)
      pop.permittedArrowDirections = []
    }
    vc.present(sheet, animated: true)
  }

  private func saveToPhotos(_ file: URL, _ invoke: Invoke) {
    PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
      guard status == .authorized || status == .limited else { invoke.reject("photos_denied"); return }
      PHPhotoLibrary.shared().performChanges({
        PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: file, options: nil)
      }) { ok, error in
        if ok { invoke.resolve(MediaResult(place: "photos", cancelled: false)) } else { invoke.reject(error?.localizedDescription ?? "save failed") }
      }
    }
  }

  private func exportToFiles(_ file: URL, _ invoke: Invoke) {
    guard let vc = manager.viewController else { invoke.reject("no view controller"); return }
    let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
    picker.delegate = self
    pickerInvoke = invoke
    vc.present(picker, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    pickerInvoke?.resolve(MediaResult(place: "files", cancelled: false))
    pickerInvoke = nil
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pickerInvoke?.resolve(MediaResult(place: nil, cancelled: true))
    pickerInvoke = nil
  }

  /// 파일 이름 — 경로 구분자·예약 문자·제어 문자를 '_'로, 앞뒤 점·공백 제거, 120자, 비면 "file"
  static func safeName(_ raw: String?) -> String {
    let base = (raw ?? "file").components(separatedBy: CharacterSet(charactersIn: "/\\")).last ?? "file"
    let bad = CharacterSet(charactersIn: "<>:\"|?*").union(.controlCharacters)
    let cleaned = String(base.unicodeScalars.map { bad.contains($0) ? "_" : Character($0) })
    let trimmed = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespaces))
    let limited = String(trimmed.prefix(120))
    return limited.isEmpty ? "file" : limited
  }

  /// 하루 지난 임시 사본 정리 — 공유 대상 앱이 파일을 다 읽을 시간을 두고 지운다.
  static func prune(_ root: URL) {
    let fm = FileManager.default
    guard let items = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
    let cutoff = Date().addingTimeInterval(-86_400)
    for item in items {
      let modified = (try? item.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
      if modified < cutoff { try? fm.removeItem(at: item) }
    }
  }
}

@_cdecl("init_plugin_media_share")
func initPlugin() -> Plugin {
  return MediaSharePlugin()
}
