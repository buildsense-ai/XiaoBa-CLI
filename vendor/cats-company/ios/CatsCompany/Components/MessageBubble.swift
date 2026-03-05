import SwiftUI
import QuickLook
import WebKit

struct MessageBubble: View {
    let message: Message
    let isMe: Bool
    var onReply: (() -> Void)?

    @ObservedObject private var identities = IdentityStore.shared
    @State private var showImagePreview = false
    @State private var previewImageUrl: String?
    @State private var expandedMessage: ExpandedMarkdownMessage?

    private var senderName: String {
        identities.displayName(forRawID: message.fromUid, fallback: message.fromUid)
    }

    private var senderAvatarURL: String? {
        identities.avatarURL(forRawID: message.fromUid)
    }

    private var senderIsBot: Bool {
        identities.isBot(forRawID: message.fromUid)
    }

    private var readableText: String? {
        switch message.content {
        case .text(let text):
            return text
        case .rich(let rich):
            guard rich.type != "image", rich.type != "file" else { return nil }
            return rich.text ?? rich.title
        }
    }

    private var shouldOfferExpandedView: Bool {
        guard let readableText else { return false }
        return senderIsBot && MarkdownHeuristics.prefersExpandedReading(for: readableText)
    }

    private var usesWideBubbleLayout: Bool {
        guard let readableText else { return false }
        return senderIsBot && MarkdownHeuristics.prefersWideLayout(for: readableText)
    }

    private var bubbleWidthRatio: CGFloat {
        if usesWideBubbleLayout { return 0.84 }
        if senderIsBot { return 0.78 }
        return 0.72
    }

    private var bubbleMaxWidth: CGFloat {
        min(UIScreen.main.bounds.width * bubbleWidthRatio, 560)
    }

    private var sideInset: CGFloat {
        usesWideBubbleLayout ? 8 : 28
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if !isMe {
                AvatarView(name: senderName, avatarURL: senderAvatarURL, isBot: senderIsBot, size: 36)
            } else {
                Spacer(minLength: sideInset)
            }

            VStack(alignment: isMe ? .trailing : .leading, spacing: 4) {
                if !isMe {
                    Text(senderName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                // Reply quote
                if message.replyTo != nil {
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(CatColor.primary.opacity(0.6))
                            .frame(width: 2.5)
                        Text("回复消息 #\(message.replyTo!)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                }

                // Content
                contentView
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(isMe ? CatColor.bubbleSelf : CatColor.bubbleOther)
                    .foregroundStyle(isMe ? CatColor.bubbleSelfText : CatColor.textPrimary)
                    .clipShape(RoundedRectangle(cornerRadius: CatLayout.radius))
                    .frame(maxWidth: bubbleMaxWidth, alignment: isMe ? .trailing : .leading)
                if shouldOfferExpandedView {
                    Button {
                        presentExpandedMessage()
                    } label: {
                        Label("全屏查看", systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.caption2)
                            .foregroundStyle(CatColor.textSecondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .contextMenu {
                Button { onReply?() } label: {
                    Label("回复", systemImage: "arrowshape.turn.up.left")
                }
                Button {
                    UIPasteboard.general.string = message.content.displayText
                } label: {
                    Label("复制", systemImage: "doc.on.doc")
                }
                if shouldOfferExpandedView {
                    Button {
                        presentExpandedMessage()
                    } label: {
                        Label("全屏查看", systemImage: "arrow.up.left.and.arrow.down.right")
                    }
                }
            }

            if isMe {
                AvatarView(name: senderName, avatarURL: senderAvatarURL, isBot: senderIsBot, size: 36)
            } else {
                Spacer(minLength: sideInset)
            }
        }
        .fullScreenCover(isPresented: $showImagePreview) {
            ImagePreviewView(urlString: previewImageUrl) {
                showImagePreview = false
            }
        }
        .sheet(item: $expandedMessage) { expandedMessage in
            MarkdownMessageDetailView(message: expandedMessage)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var contentView: some View {
        switch message.content {
        case .text(let text):
            MarkdownMessageText(
                text: text,
                renderMarkdown: senderIsBot
            )

        case .rich(let rich):
            VStack(alignment: .leading, spacing: 6) {
                if rich.type == "image", let urlStr = rich.url ?? rich.imageUrl {
                    let fullUrl = urlStr.hasPrefix("http") ? urlStr : APIClient.shared.baseURL + urlStr
                    AsyncImage(url: URL(string: fullUrl)) { image in
                        image
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 200, maxHeight: 200)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .onTapGesture {
                                previewImageUrl = fullUrl
                                showImagePreview = true
                            }
                    } placeholder: {
                        ProgressView()
                            .frame(width: 100, height: 100)
                    }
                } else if rich.type == "file" {
                    FileContentView(rich: rich)
                } else if rich.type == "link" || rich.type == "card" || rich.type == "link_preview" {
                    VStack(alignment: .leading, spacing: 4) {
                        if let title = rich.title {
                            Text(title).font(.subheadline.bold())
                        }
                        if let desc = rich.description {
                            Text(desc).font(.caption).lineLimit(2)
                        }
                        if let imgUrl = rich.imageUrl {
                            let fullUrl = imgUrl.hasPrefix("http") ? imgUrl : APIClient.shared.baseURL + imgUrl
                            if let url = URL(string: fullUrl) {
                            AsyncImage(url: url) { image in
                                image.resizable().scaledToFit()
                                    .frame(maxHeight: 120)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                            } placeholder: { EmptyView() }
                            }
                        }
                    }
                } else {
                    MarkdownMessageText(
                        text: rich.text ?? rich.title ?? "",
                        renderMarkdown: senderIsBot
                    )
                }
            }
        }
    }
}

extension MessageBubble {
    private func presentExpandedMessage() {
        guard let readableText else { return }
        expandedMessage = ExpandedMarkdownMessage(
            senderName: senderName,
            text: readableText
        )
    }
}

private struct MarkdownMessageText: View {
    let text: String
    let renderMarkdown: Bool

    private var blocks: [MarkdownDisplayBlock] {
        MarkdownBlockParser.parse(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .markdown(let content):
                    markdownTextView(content)
                case .code(let language, let code):
                    CodeBlockCardView(language: language, code: code)
                }
            }
        }
    }

    @ViewBuilder
    private func markdownTextView(_ content: String) -> some View {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            if let markdownContent = attributedString(for: trimmed) {
                Text(markdownContent)
                    .tint(CatColor.primary)
            } else {
                Text(trimmed)
                    .font(.body)
            }
        }
    }

    private func attributedString(for content: String) -> AttributedString? {
        guard renderMarkdown, MarkdownHeuristics.looksLikeMarkdown(content) else { return nil }

        do {
            return try AttributedString(
                markdown: content,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            )
        } catch {
            return nil
        }
    }
}

private struct CodeBlockCardView: View {
    let language: String?
    let code: String

    @State private var justCopied = false

    private var languageLabel: String {
        let trimmed = language?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "CODE" : trimmed.uppercased()
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(languageLabel)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.white.opacity(0.72))

                Spacer()

                Button {
                    UIPasteboard.general.string = code
                    justCopied = true

                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(1.2))
                        justCopied = false
                    }
                } label: {
                    Label(justCopied ? "已复制" : "复制", systemImage: justCopied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                        .foregroundStyle(Color.white.opacity(0.9))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.black.opacity(0.18))

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Color.white.opacity(0.92))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
        }
        .background(Color.black.opacity(0.28))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.vertical, 6)
    }
}

private enum MarkdownDisplayBlock {
    case markdown(String)
    case code(language: String?, code: String)
}

private enum MarkdownBlockParser {
    static func parse(_ text: String) -> [MarkdownDisplayBlock] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.components(separatedBy: "\n")

        var blocks: [MarkdownDisplayBlock] = []
        var currentLines: [String] = []
        var codeLines: [String] = []
        var inCodeBlock = false
        var language: String?

        func flushMarkdown() {
            let content = currentLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !content.isEmpty {
                blocks.append(.markdown(content))
            }
            currentLines.removeAll()
        }

        func flushCode() {
            let content = codeLines.joined(separator: "\n")
            blocks.append(.code(language: language, code: content))
            codeLines.removeAll()
            language = nil
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCodeBlock {
                    flushCode()
                    inCodeBlock = false
                } else {
                    flushMarkdown()
                    let rawLanguage = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
                    language = rawLanguage.isEmpty ? nil : rawLanguage
                    inCodeBlock = true
                }
                continue
            }

            if inCodeBlock {
                codeLines.append(line)
            } else {
                currentLines.append(line)
            }
        }

        if inCodeBlock {
            flushCode()
        } else {
            flushMarkdown()
        }

        if blocks.isEmpty {
            return [.markdown(text)]
        }
        return blocks
    }
}

private enum MarkdownHeuristics {
    static func looksLikeMarkdown(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        if trimmed.contains("```") || trimmed.contains("**") || trimmed.contains("~~") {
            return true
        }
        if trimmed.contains("](") || trimmed.contains("https://") || trimmed.contains("http://") {
            return true
        }
        if trimmed.contains("\n#") || trimmed.hasPrefix("#") {
            return true
        }
        if trimmed.contains("\n- ") || trimmed.hasPrefix("- ") || trimmed.contains("\n* ") || trimmed.hasPrefix("* ") {
            return true
        }
        if trimmed.contains("\n> ") || trimmed.hasPrefix("> ") {
            return true
        }
        if trimmed.contains("|") && trimmed.contains("\n") {
            return true
        }

        return false
    }

    static func prefersWideLayout(for text: String) -> Bool {
        text.count > 180 || text.contains("\n\n")
    }

    static func prefersExpandedReading(for text: String) -> Bool {
        text.count > 260 || text.contains("```") || text.contains("|") || text.contains("\n\n")
    }
}

// MARK: - File Content View

struct FileContentView: View {
    let rich: RichContent
    @State private var isDownloading = false
    @State private var previewURL: URL?
    @State private var textPreview: TextPreviewFile?
    @State private var sharedFile: SharedPreviewFile?
    @State private var errorMessage: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: fileIcon)
                .font(.title)
                .foregroundStyle(iconColor)

            VStack(alignment: .leading, spacing: 2) {
                Text(rich.fileName ?? "文件")
                    .font(.subheadline.bold())
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if let size = rich.fileSize {
                        Text(formatFileSize(size))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if isPreviewable {
                        Text("· 可预览")
                            .font(.caption)
                            .foregroundStyle(CatColor.primary)
                    }
                }
            }

            Spacer()

            if isDownloading {
                ProgressView()
                    .frame(width: 28, height: 28)
            } else {
                HStack(spacing: 8) {
                    if isPreviewable {
                        Button {
                            openFile()
                        } label: {
                            Image(systemName: "eye.circle.fill")
                                .font(.title2)
                                .foregroundStyle(CatColor.primary)
                        }
                    }

                    Button {
                        shareFile()
                    } label: {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.title2)
                            .foregroundStyle(CatColor.primary)
                    }
                }
            }
        }
        .frame(minWidth: 180, maxWidth: 240)
        .onTapGesture {
            if isPreviewable && !isDownloading {
                openFile()
            }
        }
        .contextMenu {
            if isPreviewable {
                Button {
                    openFile()
                } label: {
                    Label("预览", systemImage: "eye")
                }
            }

            Button {
                shareFile()
            } label: {
                Label("下载/分享", systemImage: "square.and.arrow.down")
            }
        }
        .quickLookPreview($previewURL)
        .sheet(item: $textPreview) { file in
            TextFilePreviewSheet(file: file) {
                sharedFile = SharedPreviewFile(url: file.url)
            }
        }
        .sheet(item: $sharedFile) { item in
            ShareSheet(items: [item.url])
        }
        .alert("文件打开失败", isPresented: Binding(
            get: { errorMessage != nil },
            set: { newValue in
                if !newValue {
                    errorMessage = nil
                }
            }
        )) {
            Button("知道了", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "请稍后重试")
        }
    }

    private var isPreviewable: Bool {
        isTextPreviewable || isQuickLookPreviewable
    }

    private var fileExtension: String {
        let name = rich.fileName ?? rich.url ?? ""
        return URL(fileURLWithPath: name).pathExtension.lowercased()
    }

    private var isMarkdown: Bool {
        ["md", "markdown"].contains(fileExtension)
    }

    private var isTextPreviewable: Bool {
        ["md", "markdown", "txt", "json", "csv", "xml", "log", "yml", "yaml"].contains(fileExtension)
    }

    private var isQuickLookPreviewable: Bool {
        ["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt",
         "rtf", "png", "jpg", "jpeg", "gif", "heic", "webp"].contains(fileExtension)
    }

    private var fileIcon: String {
        guard let name = rich.fileName?.lowercased() else { return "doc.fill" }
        if name.hasSuffix(".pdf") { return "doc.text.fill" }
        if name.hasSuffix(".docx") || name.hasSuffix(".doc") { return "doc.richtext.fill" }
        if name.hasSuffix(".xlsx") || name.hasSuffix(".xls") || name.hasSuffix(".csv") { return "tablecells.fill" }
        if name.hasSuffix(".pptx") || name.hasSuffix(".ppt") { return "rectangle.fill.on.rectangle.fill" }
        if name.hasSuffix(".zip") || name.hasSuffix(".rar") { return "doc.zipper" }
        if name.hasSuffix(".mp3") || name.hasSuffix(".wav") { return "music.note" }
        if name.hasSuffix(".mp4") || name.hasSuffix(".mov") { return "video.fill" }
        if name.hasSuffix(".txt") || name.hasSuffix(".rtf") || name.hasSuffix(".md") || name.hasSuffix(".json") {
            return "doc.plaintext.fill"
        }
        return "doc.fill"
    }

    private var iconColor: Color {
        guard let name = rich.fileName?.lowercased() else { return CatColor.primary }
        if name.hasSuffix(".pdf") { return .red }
        if name.hasSuffix(".docx") || name.hasSuffix(".doc") { return .blue }
        if name.hasSuffix(".xlsx") || name.hasSuffix(".xls") || name.hasSuffix(".csv") { return .green }
        if name.hasSuffix(".pptx") || name.hasSuffix(".ppt") { return .orange }
        return CatColor.primary
    }

    private func formatFileSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(bytes / 1024) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1024.0 / 1024.0)
    }

    private func resolveFullURL() -> URL? {
        guard let urlStr = rich.url else { return nil }
        let full = urlStr.hasPrefix("http") ? urlStr : APIClient.shared.baseURL + urlStr
        return URL(string: full)
    }

    private func openFile() {
        Task {
            await withDownloadTask {
                let localURL = try await ensureLocalFile()
                if isTextPreviewable {
                    textPreview = try buildTextPreview(from: localURL)
                } else {
                    previewURL = localURL
                }
            }
        }
    }

    private func shareFile() {
        Task {
            await withDownloadTask {
                let localURL = try await ensureLocalFile()
                sharedFile = SharedPreviewFile(url: localURL)
            }
        }
    }

    @MainActor
    private func withDownloadTask(_ operation: @escaping () async throws -> Void) async {
        guard !isDownloading else { return }
        guard resolveFullURL() != nil else {
            errorMessage = "文件地址缺失，当前消息还不能下载。"
            return
        }

        isDownloading = true
        defer { isDownloading = false }

        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
            print("File open/share error: \(error)")
        }
    }

    private func ensureLocalFile() async throws -> URL {
        guard let remoteURL = resolveFullURL() else {
            throw FilePreviewError.missingURL
        }

        let destinationURL = cachedFileURL(for: remoteURL)
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: destinationURL.path) {
            return destinationURL
        }

        let directory = destinationURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)

        let (tempURL, _) = try await URLSession.shared.download(from: remoteURL)
        if fileManager.fileExists(atPath: destinationURL.path) {
            try fileManager.removeItem(at: destinationURL)
        }
        try fileManager.moveItem(at: tempURL, to: destinationURL)
        return destinationURL
    }

    private func cachedFileURL(for remoteURL: URL) -> URL {
        let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let downloadsDir = cachesDir.appendingPathComponent("ChatDownloads", isDirectory: true)

        let displayName = rich.fileName?.replacingOccurrences(of: "/", with: "_") ?? remoteURL.lastPathComponent
        let displayURL = URL(fileURLWithPath: displayName)
        let basename = displayURL.deletingPathExtension().lastPathComponent
        let ext = displayURL.pathExtension
        let uniquePrefix = remoteURL.deletingPathExtension().lastPathComponent
        let finalName = ext.isEmpty ? "\(uniquePrefix)_\(basename)" : "\(uniquePrefix)_\(basename).\(ext)"

        return downloadsDir.appendingPathComponent(finalName)
    }

    private func buildTextPreview(from localURL: URL) throws -> TextPreviewFile {
        let data = try Data(contentsOf: localURL)
        guard !data.isEmpty else {
            throw FilePreviewError.emptyFile
        }

        let text = String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
        return TextPreviewFile(
            title: rich.fileName ?? localURL.lastPathComponent,
            text: text,
            isMarkdown: isMarkdown,
            url: localURL
        )
    }
}

// MARK: - Image Preview View

struct ImagePreviewView: View {
    let urlString: String?
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let urlStr = urlString, let url = URL(string: urlStr) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFit()
                        .gesture(
                            TapGesture(count: 1)
                                .onEnded { onDismiss() }
                        )
                } placeholder: {
                    ProgressView()
                        .tint(.white)
                }
            }

            VStack {
                HStack {
                    Spacer()
                    Button {
                        onDismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title)
                            .foregroundStyle(.white)
                            .padding()
                    }
                }
                Spacer()
            }
        }
    }
}

private struct TextPreviewFile: Identifiable {
    let id = UUID()
    let title: String
    let text: String
    let isMarkdown: Bool
    let url: URL
}

private struct SharedPreviewFile: Identifiable {
    let id = UUID()
    let url: URL
}

private enum FilePreviewError: LocalizedError {
    case missingURL
    case emptyFile

    var errorDescription: String? {
        switch self {
        case .missingURL:
            return "文件链接还没解析出来，请重新进入会话后再试。"
        case .emptyFile:
            return "文件内容为空。"
        }
    }
}

private struct TextFilePreviewSheet: View {
    let file: TextPreviewFile
    let onShare: () -> Void

    private var markdownContent: AttributedString? {
        guard file.isMarkdown else { return nil }
        return try? AttributedString(markdown: file.text)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let markdownContent {
                        Text(markdownContent)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Text(file.text)
                            .font(.system(.body, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .textSelection(.enabled)
                .padding(16)
            }
            .background(CatColor.chatBg)
            .navigationTitle(file.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        onShare()
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
            }
        }
    }
}

private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private struct ExpandedMarkdownMessage: Identifiable {
    let id = UUID()
    let senderName: String
    let text: String
}

private struct MarkdownMessageDetailView: View {
    let message: ExpandedMarkdownMessage

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text(message.senderName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(CatColor.textSecondary)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(CatColor.secondaryBg)

                MarkdownDetailWebView(
                    html: MarkdownHTMLRenderer.document(
                        for: message.text,
                        colorScheme: colorScheme
                    )
                )
                .background(CatColor.chatBg)
            }
            .background(CatColor.chatBg)
            .navigationTitle("消息详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        UIPasteboard.general.string = message.text
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                }
            }
        }
    }
}

private struct MarkdownDetailWebView: UIViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: 24, right: 0)
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.loadHTMLString(html, baseURL: nil)
        context.coordinator.lastHTML = html
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastHTML != html else { return }
        webView.loadHTMLString(html, baseURL: nil)
        context.coordinator.lastHTML = html
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastHTML = ""

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .linkActivated,
               let url = navigationAction.request.url {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }

            decisionHandler(.allow)
        }
    }
}

private enum MarkdownHTMLRenderer {
    static func document(for markdown: String, colorScheme: ColorScheme) -> String {
        let palette = colorScheme == .dark ? darkPalette : lightPalette

        return """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <style>
            :root {
              color-scheme: \(colorScheme == .dark ? "dark" : "light");
              --bg: \(palette.background);
              --surface: \(palette.surface);
              --surface-strong: \(palette.surfaceStrong);
              --text: \(palette.text);
              --muted: \(palette.muted);
              --line: \(palette.line);
              --accent: \(palette.accent);
              --code-bg: \(palette.codeBackground);
              --quote-bg: \(palette.quoteBackground);
            }

            * { box-sizing: border-box; }

            body {
              margin: 0;
              padding: 20px 16px 28px;
              background: var(--bg);
              color: var(--text);
              font: 17px/1.65 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
              word-break: break-word;
            }

            h1, h2, h3, h4, h5, h6 {
              margin: 1.2em 0 0.5em;
              line-height: 1.28;
            }

            h1 { font-size: 1.55rem; }
            h2 { font-size: 1.35rem; }
            h3 { font-size: 1.15rem; }
            h4, h5, h6 { font-size: 1rem; }

            p, ul, ol, pre, blockquote, table {
              margin: 0 0 1em;
            }

            ul, ol {
              padding-left: 1.4em;
            }

            li + li {
              margin-top: 0.35em;
            }

            .task-list {
              list-style: none;
              padding-left: 0;
            }

            .task-item {
              display: flex;
              align-items: flex-start;
              gap: 0.6em;
            }

            .task-item input {
              margin-top: 0.35em;
              accent-color: var(--accent);
            }

            code {
              font: 0.92em/1.55 "SF Mono", ui-monospace, Menlo, monospace;
              background: var(--surface);
              border: 1px solid var(--line);
              border-radius: 6px;
              padding: 0.12em 0.35em;
            }

            pre {
              overflow-x: auto;
              padding: 14px;
              border-radius: 14px;
              background: var(--code-bg);
              border: 1px solid var(--line);
            }

            pre code {
              padding: 0;
              border: 0;
              background: transparent;
              font-size: 0.9rem;
              white-space: pre;
            }

            blockquote {
              margin-left: 0;
              padding: 12px 14px;
              border-left: 4px solid var(--accent);
              background: var(--quote-bg);
              border-radius: 12px;
              color: var(--muted);
            }

            .table-wrap {
              overflow-x: auto;
              margin: 0 0 1em;
              border: 1px solid var(--line);
              border-radius: 14px;
              background: var(--surface);
            }

            table {
              width: 100%;
              border-collapse: collapse;
              min-width: 100%;
              margin: 0;
            }

            th, td {
              padding: 10px 12px;
              border-bottom: 1px solid var(--line);
              text-align: left;
              vertical-align: top;
            }

            thead th {
              background: var(--surface-strong);
              font-weight: 700;
            }

            tbody tr:last-child td {
              border-bottom: 0;
            }

            a {
              color: var(--accent);
            }

            hr {
              border: 0;
              border-top: 1px solid var(--line);
              margin: 1.2em 0;
            }
          </style>
        </head>
        <body>
        \(renderBlocks(markdown))
        </body>
        </html>
        """
    }

    private static func renderBlocks(_ markdown: String) -> String {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.components(separatedBy: "\n")

        var html: [String] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)

            if trimmed.isEmpty {
                index += 1
                continue
            }

            if trimmed.hasPrefix("```") {
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
                index += 1
                var codeLines: [String] = []
                while index < lines.count && !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[index])
                    index += 1
                }
                if index < lines.count {
                    index += 1
                }

                let code = escapeHTML(codeLines.joined(separator: "\n"))
                let className = language.isEmpty ? "" : " class=\"language-\(escapeHTML(language))\""
                html.append("<pre><code\(className)>\(code)</code></pre>")
                continue
            }

            if let heading = headingLevel(for: trimmed) {
                let content = trimmed.dropFirst(heading).trimmingCharacters(in: .whitespaces)
                html.append("<h\(heading)>\(inlineHTML(String(content)))</h\(heading)>")
                index += 1
                continue
            }

            if isTable(at: index, lines: lines) {
                let rendered = renderTable(startingAt: index, lines: lines)
                html.append(rendered.html)
                index = rendered.nextIndex
                continue
            }

            if isListStarter(trimmed) {
                let rendered = renderList(startingAt: index, lines: lines)
                html.append(rendered.html)
                index = rendered.nextIndex
                continue
            }

            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while index < lines.count {
                    let quoteLine = lines[index].trimmingCharacters(in: .whitespaces)
                    guard quoteLine.hasPrefix(">") else { break }
                    quoteLines.append(String(quoteLine.dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                html.append("<blockquote>\(renderBlocks(quoteLines.joined(separator: "\n")))</blockquote>")
                continue
            }

            var paragraphLines: [String] = []
            while index < lines.count {
                let current = lines[index]
                let currentTrimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if currentTrimmed.isEmpty || startsNewBlock(at: index, lines: lines) {
                    break
                }
                paragraphLines.append(currentTrimmed)
                index += 1
            }

            let paragraph = inlineHTML(paragraphLines.joined(separator: "\n"))
                .replacingOccurrences(of: "\n", with: "<br/>")
            html.append("<p>\(paragraph)</p>")
        }

        return html.joined(separator: "\n")
    }

    private static func renderList(startingAt startIndex: Int, lines: [String]) -> (html: String, nextIndex: Int) {
        let trimmed = lines[startIndex].trimmingCharacters(in: .whitespaces)
        let ordered = orderedListItemText(from: trimmed) != nil

        var items: [String] = []
        var index = startIndex
        var containsTaskItems = false

        while index < lines.count {
            let line = lines[index]
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)

            if trimmedLine.isEmpty {
                break
            }

            if let task = taskListItem(from: trimmedLine) {
                containsTaskItems = true
                let checkbox = "<input type=\"checkbox\" disabled \(task.checked ? "checked" : "") />"
                items.append("<li class=\"task-item\">\(checkbox)<span>\(inlineHTML(task.text))</span></li>")
                index += 1
                continue
            }

            let itemText = ordered ? orderedListItemText(from: trimmedLine) : unorderedListItemText(from: trimmedLine)
            if let itemText {
                items.append("<li>\(inlineHTML(itemText))</li>")
                index += 1
                continue
            }

            if let lastIndex = items.indices.last,
               line.hasPrefix("  ") || line.hasPrefix("\t") {
                let insertionPoint = items[lastIndex].index(items[lastIndex].endIndex, offsetBy: -5)
                items[lastIndex].insert(contentsOf: "<br/>\(inlineHTML(trimmedLine))", at: insertionPoint)
                index += 1
                continue
            }

            break
        }

        let tag = ordered && !containsTaskItems ? "ol" : "ul"
        let className = containsTaskItems ? " class=\"task-list\"" : ""
        return ("<\(tag)\(className)>\(items.joined())</\(tag)>", index)
    }

    private static func renderTable(startingAt startIndex: Int, lines: [String]) -> (html: String, nextIndex: Int) {
        let headers = splitTableCells(lines[startIndex])
        let alignments = splitTableCells(lines[startIndex + 1]).map(tableAlignment(for:))

        var rows: [[String]] = []
        var index = startIndex + 2

        while index < lines.count {
            let trimmed = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || !trimmed.contains("|") || startsNewBlock(at: index, lines: lines) {
                break
            }
            rows.append(splitTableCells(lines[index]))
            index += 1
        }

        let headHTML = headers.enumerated().map { offset, cell in
            let alignment = alignments.indices.contains(offset) ? alignments[offset] : nil
            return "<th\(alignment.map { " style=\"text-align:\($0)\"" } ?? "")>\(inlineHTML(cell))</th>"
        }.joined()

        let bodyHTML = rows.map { row in
            let cells = row.enumerated().map { offset, cell in
                let alignment = alignments.indices.contains(offset) ? alignments[offset] : nil
                return "<td\(alignment.map { " style=\"text-align:\($0)\"" } ?? "")>\(inlineHTML(cell))</td>"
            }.joined()
            return "<tr>\(cells)</tr>"
        }.joined()

        let html = """
        <div class="table-wrap">
          <table>
            <thead><tr>\(headHTML)</tr></thead>
            <tbody>\(bodyHTML)</tbody>
          </table>
        </div>
        """

        return (html, index)
    }

    private static func startsNewBlock(at index: Int, lines: [String]) -> Bool {
        let trimmed = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        if trimmed.hasPrefix("```") || trimmed.hasPrefix(">") { return true }
        if headingLevel(for: trimmed) != nil || isListStarter(trimmed) { return true }
        return isTable(at: index, lines: lines)
    }

    private static func headingLevel(for line: String) -> Int? {
        var count = 0
        for character in line {
            if character == "#" {
                count += 1
            } else {
                break
            }
        }

        guard (1...6).contains(count) else { return nil }
        return line.dropFirst(count).first == " " ? count : nil
    }

    private static func isTable(at index: Int, lines: [String]) -> Bool {
        guard index + 1 < lines.count else { return false }
        let header = lines[index].trimmingCharacters(in: .whitespaces)
        let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)

        guard header.contains("|"), separator.contains("|") else { return false }

        let separatorCells = splitTableCells(separator)
        guard !separatorCells.isEmpty else { return false }
        return separatorCells.allSatisfy { cell in
            let trimmed = cell.replacingOccurrences(of: ":", with: "").replacingOccurrences(of: "-", with: "")
            return trimmed.isEmpty
        }
    }

    private static func isListStarter(_ line: String) -> Bool {
        taskListItem(from: line) != nil ||
        unorderedListItemText(from: line) != nil ||
        orderedListItemText(from: line) != nil
    }

    private static func taskListItem(from line: String) -> (checked: Bool, text: String)? {
        let pattern = #"^\s*[-*+]\s+\[([ xX])\]\s+(.+)$"#
        return firstMatch(in: line, pattern: pattern).flatMap { captures in
            guard captures.count == 3 else { return nil }
            return (captures[1].lowercased() == "x", captures[2])
        }
    }

    private static func unorderedListItemText(from line: String) -> String? {
        let pattern = #"^\s*[-*+]\s+(.+)$"#
        return firstMatch(in: line, pattern: pattern).flatMap { captures in
            captures.count == 2 ? captures[1] : nil
        }
    }

    private static func orderedListItemText(from line: String) -> String? {
        let pattern = #"^\s*\d+\.\s+(.+)$"#
        return firstMatch(in: line, pattern: pattern).flatMap { captures in
            captures.count == 2 ? captures[1] : nil
        }
    }

    private static func tableAlignment(for cell: String) -> String? {
        let trimmed = cell.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }

        let left = trimmed.hasPrefix(":")
        let right = trimmed.hasSuffix(":")

        switch (left, right) {
        case (true, true):
            return "center"
        case (false, true):
            return "right"
        default:
            return "left"
        }
    }

    private static func splitTableCells(_ line: String) -> [String] {
        line
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "|"))
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func inlineHTML(_ text: String) -> String {
        var working = escapeHTML(text)
        var placeholders: [String: String] = [:]

        working = replace(pattern: #"`([^`]+)`"#, in: working) { captures in
            let token = "__INLINE_CODE_\(placeholders.count)__"
            let content = captures.count > 1 ? captures[1] : ""
            placeholders[token] = "<code>\(content)</code>"
            return token
        }

        working = replace(pattern: #"\[([^\]]+)\]\((https?://[^\s)]+)\)"#, in: working) { captures in
            let token = "__INLINE_LINK_\(placeholders.count)__"
            let label = captures.count > 1 ? captures[1] : ""
            let url = captures.count > 2 ? captures[2] : ""
            placeholders[token] = "<a href=\"\(url)\">\(label)</a>"
            return token
        }

        working = replace(pattern: #"(https?://[^\s<]+)"#, in: working) { captures in
            let token = "__AUTO_LINK_\(placeholders.count)__"
            let url = captures.count > 1 ? captures[1] : ""
            placeholders[token] = "<a href=\"\(url)\">\(url)</a>"
            return token
        }

        working = replace(pattern: #"\*\*\*([^*]+)\*\*\*"#, in: working) { captures in
            "<strong><em>\(captures[1])</em></strong>"
        }
        working = replace(pattern: #"\*\*([^*]+)\*\*"#, in: working) { captures in
            "<strong>\(captures[1])</strong>"
        }
        working = replace(pattern: #"__([^_]+)__"#, in: working) { captures in
            "<strong>\(captures[1])</strong>"
        }
        working = replace(pattern: #"(?<!\*)\*([^*]+)\*(?!\*)"#, in: working) { captures in
            "<em>\(captures[1])</em>"
        }
        working = replace(pattern: #"(?<!_)_([^_]+)_(?!_)"#, in: working) { captures in
            "<em>\(captures[1])</em>"
        }
        working = replace(pattern: #"~~([^~]+)~~"#, in: working) { captures in
            "<del>\(captures[1])</del>"
        }

        for token in placeholders.keys.sorted(by: { $0.count > $1.count }) {
            if let value = placeholders[token] {
                working = working.replacingOccurrences(of: token, with: value)
            }
        }

        return working
    }

    private static func escapeHTML(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    private static func firstMatch(in text: String, pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return nil
        }

        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else {
            return nil
        }

        return (0..<match.numberOfRanges).compactMap { index in
            guard let range = Range(match.range(at: index), in: text) else { return nil }
            return String(text[range])
        }
    }

    private static func replace(
        pattern: String,
        in text: String,
        transform: ([String]) -> String
    ) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return text
        }

        let matches = regex.matches(in: text, options: [], range: NSRange(text.startIndex..., in: text))
        guard !matches.isEmpty else { return text }

        var result = ""
        var currentIndex = text.startIndex

        for match in matches {
            guard let matchRange = Range(match.range, in: text) else { continue }
            result += text[currentIndex..<matchRange.lowerBound]

            let captures = (0..<match.numberOfRanges).compactMap { index -> String? in
                guard let captureRange = Range(match.range(at: index), in: text) else { return nil }
                return String(text[captureRange])
            }

            result += transform(captures)
            currentIndex = matchRange.upperBound
        }

        result += text[currentIndex...]
        return result
    }

    private static let lightPalette = Palette(
        background: "#F4F4F4",
        surface: "#FFFFFF",
        surfaceStrong: "#F7F7F7",
        text: "#111111",
        muted: "#666666",
        line: "#E3E3E3",
        accent: "#07C160",
        codeBackground: "#111318",
        quoteBackground: "#F7FBF8"
    )

    private static let darkPalette = Palette(
        background: "#1C1C1E",
        surface: "#2C2C2E",
        surfaceStrong: "#343438",
        text: "#F3F3F3",
        muted: "#B0B0B5",
        line: "#434347",
        accent: "#32D17C",
        codeBackground: "#101114",
        quoteBackground: "#202B24"
    )

    private struct Palette {
        let background: String
        let surface: String
        let surfaceStrong: String
        let text: String
        let muted: String
        let line: String
        let accent: String
        let codeBackground: String
        let quoteBackground: String
    }
}
