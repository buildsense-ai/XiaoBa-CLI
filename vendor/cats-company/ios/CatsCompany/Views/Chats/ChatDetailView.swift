import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import UIKit

struct ChatDetailView: View {
    let topicId: String
    let title: String

    @Environment(\.dismiss) private var dismiss
    @ObservedObject var ws = WebSocketManager.shared
    @ObservedObject var auth = AuthManager.shared
    @ObservedObject private var identities = IdentityStore.shared
    @State private var messages: [Message] = []
    @State private var inputText = ""
    @State private var replyTo: Message?
    @State private var isTyping = false
    @State private var typingUser: String?
    @State private var isLoading = true
    @State private var pendingMsgIds: [String: Int] = [:] // wsId -> index in messages
    @State private var tempSeqCounter = -1
    @State private var dataListenerID: WebSocketManager.ListenerID?
    @State private var ctrlListenerID: WebSocketManager.ListenerID?
    @State private var infoListenerID: WebSocketManager.ListenerID?

    // Attachment
    @State private var showAttachmentMenu = false
    @State private var showPhotoPicker = false
    @State private var showDocumentPicker = false
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var isUploading = false
    @State private var attachmentErrorMessage: String?
    @State private var showGroupSettings = false
    @State private var historyOffset = 0
    @State private var lastSeenSeq = 0
    @State private var hasMoreHistory = false
    @State private var isLoadingOlder = false
    @State private var messageListRefreshID = 0
    @FocusState private var isComposerFocused: Bool

    private let pageSize = 50
    private let bottomAnchorID = "chat-bottom-anchor"

    private var resolvedTitle: String {
        if topicId.hasPrefix("grp_") {
            return identities.groupName(forTopic: topicId, fallback: title)
        }
        return title
    }

    private var groupID: Int64? {
        guard topicId.hasPrefix("grp_") else { return nil }
        return Int64(topicId.dropFirst(4))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if hasMoreHistory {
                        Button {
                            Task { await loadOlderMessages() }
                        } label: {
                            HStack(spacing: 6) {
                                if isLoadingOlder {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                }
                                Text(isLoadingOlder ? "加载中..." : "加载更早消息")
                                    .font(.caption)
                                    .foregroundStyle(CatColor.primary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        }
                        .disabled(isLoadingOlder)
                    }

                    ForEach(Array(messages.enumerated()), id: \.element.seq) { index, msg in
                        // Date separator
                        if let ts = msg.timestamp, shouldShowDate(at: index) {
                            DateSeparator(date: ts)
                        }

                        MessageBubble(
                            message: msg,
                            isMe: msg.fromUid == String(auth.currentUser?.id ?? 0),
                            onReply: { replyTo = msg }
                        )
                        .id(msg.seq)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(bottomAnchorID)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .id(messageListRefreshID)
            }
            .contentShape(Rectangle())
            .background(CatColor.chatBg)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composerArea
            }
            .onTapGesture {
                hideKeyboard()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle(resolvedTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if groupID != nil {
                            Button {
                                showGroupSettings = true
                            } label: {
                                Label("群设置", systemImage: "person.3")
                            }
                        }
                        Button(role: .destructive) {
                            clearLocalConversation()
                        } label: {
                            Label("清空本地记录", systemImage: "trash")
                        }
                        Button(role: .destructive) {
                            deleteConversation()
                        } label: {
                            Label("删除对话", systemImage: "trash.slash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .task {
                await loadMessages()
                await loadIdentityContext()
            }
            .onAppear { setupWSHandlers() }
            .onDisappear { clearWSHandlers() }
            .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhotoItem, matching: .images)
            .onChange(of: selectedPhotoItem) {
                guard let item = selectedPhotoItem else { return }
                selectedPhotoItem = nil
                Task { await handlePhotoPick(item) }
            }
            .onChange(of: messages.count) {
                guard !isLoadingOlder else { return }
                // Only scroll if there's a new message (higher seq)
                if let lastMsg = messages.last, lastMsg.seq > lastSeenSeq {
                    lastSeenSeq = lastMsg.seq
                    scrollToBottom(proxy)
                }
            }
            .onChange(of: isComposerFocused) {
                refreshMessageListLayout(proxy, keepBottomVisible: isComposerFocused)
            }
            .onChange(of: replyTo?.seq) {
                guard replyTo != nil else { return }
                scrollToBottom(proxy)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { _ in
                refreshMessageListLayout(proxy, keepBottomVisible: isComposerFocused)
            }
            .sheet(isPresented: $showDocumentPicker) {
                DocumentPickerView { urls in
                    guard let url = urls.first else { return }
                    Task { await handleFilePick(url) }
                }
            }
            .sheet(isPresented: $showGroupSettings) {
                if let groupID {
                    GroupSettingsView(groupId: groupID, topicId: topicId) {
                        await loadMessages()
                        await loadIdentityContext()
                    }
                }
            }
            .alert("附件发送失败", isPresented: Binding(
                get: { attachmentErrorMessage != nil },
                set: { newValue in
                    if !newValue {
                        attachmentErrorMessage = nil
                    }
                }
            )) {
                Button("知道了", role: .cancel) {}
            } message: {
                Text(attachmentErrorMessage ?? "请稍后重试")
            }
        }
    }

    private var composerArea: some View {
        VStack(spacing: 0) {
            // Typing indicator
            if typingUser != nil {
                HStack(spacing: 4) {
                    TypingDotsView()
                    Text("\(resolvedTitle) 正在输入...")
                        .font(.caption)
                        .foregroundStyle(CatColor.textSecondary)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
                .background(CatColor.chatBg)
                .transition(.opacity)
            }

            // Reply preview
            if let reply = replyTo {
                HStack {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(CatColor.primary)
                        .frame(width: 3)
                    VStack(alignment: .leading) {
                        Text("回复")
                            .font(.caption.bold())
                            .foregroundStyle(CatColor.primary)
                        Text(reply.content.displayText)
                            .font(.caption)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button { replyTo = nil } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(CatColor.secondaryBg)
            }

            VStack(spacing: 0) {
                CatColor.border
                    .frame(height: 0.5)

                // Upload progress
                if isUploading {
                    HStack(spacing: 6) {
                        ProgressView()
                            .scaleEffect(0.8)
                        Text("正在上传...")
                            .font(.caption)
                            .foregroundStyle(CatColor.textSecondary)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
                }

                HStack(spacing: 8) {
                    // Attachment button
                    Menu {
                        Button {
                            showPhotoPicker = true
                        } label: {
                            Label("相册", systemImage: "photo.on.rectangle")
                        }
                        Button {
                            showDocumentPicker = true
                        } label: {
                            Label("文件", systemImage: "doc")
                        }
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.title2)
                            .foregroundStyle(CatColor.primary)
                    }
                    .disabled(isUploading)

                    TextField("输入消息...", text: $inputText, axis: .vertical)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .lineLimit(1...5)
                        .background(CatColor.background)
                        .clipShape(RoundedRectangle(cornerRadius: CatLayout.avatarRadius))
                        .focused($isComposerFocused)
                        .onChange(of: inputText) {
                            ws.sendTyping(topic: topicId)
                        }

                    Button {
                        Task { await sendMessage() }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                            .foregroundStyle(
                                inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    ? Color.gray.opacity(0.4)
                                    : CatColor.primary
                            )
                    }
                    .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .background(CatColor.cardBg)
        }
    }

    private func shouldShowDate(at index: Int) -> Bool {
        guard let currentTs = messages[index].timestamp else { return false }
        if index == 0 { return true }
        guard let prevTs = messages[index - 1].timestamp else { return true }
        return currentTs.timeIntervalSince(prevTs) > 300 // 5 minutes
    }

    private func setupWSHandlers() {
        guard dataListenerID == nil, ctrlListenerID == nil, infoListenerID == nil else { return }

        dataListenerID = ws.addDataListener { data in
            guard data.topic == topicId else { return }
            let msg = Message(
                id: nil,
                topicId: data.topic,
                fromUid: data.from ?? "",
                content: data.content,
                seq: data.seq,
                replyTo: data.replyTo
            )
            if !messages.contains(where: { $0.seq == msg.seq }) {
                messages.append(msg)
                MessageStore.shared.appendMessage(msg, for: topicId)
            }
            ws.updateTopicSeq(topicId, seq: data.seq)
            ws.sendRead(topic: topicId, seq: data.seq)
            typingUser = nil
        }

        ctrlListenerID = ws.addCtrlListener { ctrl in
            guard ctrl.topic == topicId, ctrl.code == 200,
                  let ctrlId = ctrl.id,
                  let idx = pendingMsgIds[ctrlId] else { return }
            if let params = ctrl.params?.value as? [String: Any],
               let realSeq = params["seq"] as? Int,
               idx < messages.count, messages[idx].seq < 0 {
                let oldSeq = messages[idx].seq
                messages[idx].seq = realSeq
                ws.updateTopicSeq(topicId, seq: realSeq)
                MessageStore.shared.updateMessageSeq(in: topicId, oldSeq: oldSeq, newSeq: realSeq)
            }
            pendingMsgIds.removeValue(forKey: ctrlId)
        }

        infoListenerID = ws.addInfoListener { info in
            guard info.topic == topicId else { return }
            if info.what == "kp" {
                typingUser = info.from
                Task {
                    // 30s timeout — bot processing can take a while
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    if typingUser == info.from {
                        typingUser = nil
                    }
                }
            }
        }
    }

    private func clearWSHandlers() {
        ws.removeDataListener(dataListenerID)
        ws.removeInfoListener(infoListenerID)
        ws.removeCtrlListener(ctrlListenerID)
        dataListenerID = nil
        infoListenerID = nil
        ctrlListenerID = nil
    }

    private func loadMessages() async {
        // Load cached messages first for instant display (limit to pageSize)
        let cached = MessageStore.shared.loadMessages(for: topicId, limit: pageSize)
        if !cached.isEmpty {
            messages = mergeMessages(cached, [])
            isLoading = false
        }

        historyOffset = 0
        hasMoreHistory = false

        // Then fetch from server and merge
        do {
            let serverMsgs = try await APIClient.shared.getMessages(
                topicId: topicId,
                limit: pageSize,
                latest: true
            )
            let pending = messages.filter { $0.seq < 0 }
            let cachedPersisted = cached.filter { $0.seq > 0 }
            let visibleServerMsgs = MessageStore.shared.filterVisible(serverMsgs, for: topicId)
            let mergedPersisted = mergeMessages(cachedPersisted, visibleServerMsgs)
            messages = mergeMessages(mergedPersisted, pending)
            MessageStore.shared.saveMessages(mergedPersisted, for: topicId)
            historyOffset = mergedPersisted.count
            hasMoreHistory = visibleServerMsgs.count == pageSize || mergedPersisted.count > visibleServerMsgs.count
            if let last = mergedPersisted.last {
                ws.updateTopicSeq(topicId, seq: last.seq)
                ws.sendRead(topic: topicId, seq: last.seq)
            }
            isLoading = false
        } catch {
            print("Load messages error: \(error)")
            isLoading = false
        }
    }

    private func loadOlderMessages() async {
        guard !isLoadingOlder, hasMoreHistory else { return }

        isLoadingOlder = true
        defer { isLoadingOlder = false }

        do {
            let older = try await APIClient.shared.getMessages(
                topicId: topicId,
                limit: pageSize,
                offset: historyOffset,
                latest: true
            )
            let visibleOlder = MessageStore.shared.filterVisible(older, for: topicId)
            let persisted = mergeMessages(messages.filter { $0.seq > 0 }, visibleOlder)
            let pending = messages.filter { $0.seq < 0 }
            messages = mergeMessages(persisted, pending)
            MessageStore.shared.saveMessages(persisted, for: topicId)
            historyOffset += visibleOlder.count
            hasMoreHistory = visibleOlder.count == pageSize
        } catch {
            print("Load older messages error: \(error)")
        }
    }

    private func loadIdentityContext() async {
        IdentityStore.shared.upsertCurrentUser(auth.currentUser)

        do {
            if let groupID {
                let info = try await APIClient.shared.getGroupInfo(groupId: groupID)
                IdentityStore.shared.upsertGroup(info.group)
                IdentityStore.shared.upsertGroupMembers(info.members)
            } else {
                let friends = try await APIClient.shared.getFriends()
                IdentityStore.shared.upsertUsers(friends)
            }
        } catch {
            print("Load identity context error: \(error)")
        }
    }

    private func sendMessage() async {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        let currentReplyTo = replyTo?.seq
        let myUid = String(auth.currentUser?.id ?? 0)

        if !ws.isConnected {
            do {
                try await APIClient.shared.sendMessage(topicId: topicId, content: text)
                inputText = ""
                replyTo = nil
                await loadMessages()
            } catch {
                attachmentErrorMessage = "文本发送失败: \(error.localizedDescription)"
            }
            return
        }

        let tempSeq = tempSeqCounter
        tempSeqCounter -= 1

        let msg = Message(
            id: nil,
            topicId: topicId,
            fromUid: myUid,
            content: .text(text),
            seq: tempSeq,
            replyTo: currentReplyTo
        )
        messages.append(msg)

        let wsId = ws.sendMessage(topic: topicId, content: text, replyTo: currentReplyTo)
        pendingMsgIds[wsId] = messages.count - 1
        inputText = ""
        replyTo = nil
    }

    private func hideKeyboard() {
        isComposerFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        let action = {
            proxy.scrollTo(bottomAnchorID, anchor: .bottom)
        }
        if animated {
            withAnimation(.easeOut(duration: 0.22), action)
        } else {
            action()
        }
    }

    private func refreshMessageListLayout(_ proxy: ScrollViewProxy, keepBottomVisible: Bool) {
        messageListRefreshID += 1
        guard keepBottomVisible else { return }

        Task { @MainActor in
            await Task.yield()
            scrollToBottom(proxy, animated: false)
            scheduleScrollToBottom(proxy)
        }
    }

    private func scheduleScrollToBottom(_ proxy: ScrollViewProxy) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(120))
            scrollToBottom(proxy)
        }
    }

    private func clearLocalConversation() {
        let latestSeq = messages.map(\.seq).filter { $0 > 0 }.max()
        MessageStore.shared.clearMessages(for: topicId, upToSeq: latestSeq)
        messages = messages.filter { $0.seq < 0 }
        NotificationCenter.default.post(name: .conversationListChanged, object: topicId)
    }

    private func deleteConversation() {
        let latestSeq = messages.map(\.seq).filter { $0 > 0 }.max()
        MessageStore.shared.clearMessages(for: topicId, upToSeq: latestSeq)
        MessageStore.shared.hideConversation(topic: topicId)
        NotificationCenter.default.post(name: .conversationListChanged, object: topicId)
        dismiss()
    }

    // MARK: - Attachment Upload

    private func handlePhotoPick(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            attachmentErrorMessage = "无法读取所选图片"
            return
        }
        let filename = "photo_\(Int(Date().timeIntervalSince1970)).jpg"
        isUploading = true
        do {
            let resp = try await APIClient.shared.uploadImage(data: data, filename: filename)
            try await sendRichContent(
                type: "image",
                url: resp.url,
                name: resp.name ?? filename,
                size: resp.size,
                fileKey: resp.fileKey
            )
        } catch {
            attachmentErrorMessage = error.localizedDescription
        }
        isUploading = false
    }

    private func handleFilePick(_ url: URL) async {
        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }

        guard let data = try? Data(contentsOf: url) else {
            attachmentErrorMessage = "无法读取所选文件"
            return
        }
        let filename = url.lastPathComponent
        let mimeType = mimeTypeFor(filename)
        let isImage = ["image/jpeg", "image/png", "image/gif", "image/webp"].contains(mimeType)

        isUploading = true
        do {
            let resp = isImage
                ? try await APIClient.shared.uploadImage(data: data, filename: filename)
                : try await APIClient.shared.uploadFile(data: data, filename: filename, mimeType: mimeType)
            try await sendRichContent(
                type: isImage ? "image" : "file",
                url: resp.url,
                name: resp.name ?? filename,
                size: resp.size ?? data.count,
                fileKey: resp.fileKey,
                mimeType: isImage ? nil : mimeType
            )
        } catch {
            attachmentErrorMessage = error.localizedDescription
        }
        isUploading = false
    }

    private func sendRichContent(
        type: String,
        url: String,
        name: String,
        size: Int? = nil,
        fileKey: String? = nil,
        mimeType: String? = nil
    ) async throws {
        var payload: [String: Any] = ["url": url, "name": name]
        if let size { payload["size"] = size }
        if let fileKey { payload["file_key"] = fileKey }
        if let mimeType { payload["mime_type"] = mimeType }
        if type == "image" { payload["thumbnail"] = url }

        let content: [String: Any] = ["type": type, "payload": payload]

        if !ws.isConnected {
            try await APIClient.shared.sendRichMessage(topicId: topicId, content: content, msgType: type)
            await loadMessages()
            return
        }

        let myUid = String(auth.currentUser?.id ?? 0)
        let tempSeq = tempSeqCounter
        tempSeqCounter -= 1

        let rich = RichContent(
            type: type,
            url: url,
            imageUrl: type == "image" ? url : nil,
            fileName: name,
            fileSize: size,
            mimeType: mimeType
        )
        let msg = Message(
            id: nil, topicId: topicId, fromUid: myUid,
            content: .rich(rich), seq: tempSeq
        )
        messages.append(msg)

        let wsId = ws.sendRichMessage(topic: topicId, content: content)
        pendingMsgIds[wsId] = messages.count - 1
    }

    private func mimeTypeFor(_ filename: String) -> String {
        let ext = (filename as NSString).pathExtension.lowercased()
        let map: [String: String] = [
            "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "gif": "image/gif", "webp": "image/webp",
            "pdf": "application/pdf",
            "doc": "application/msword",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls": "application/vnd.ms-excel",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt": "application/vnd.ms-powerpoint",
            "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "zip": "application/zip", "txt": "text/plain", "md": "text/markdown",
            "json": "application/json", "csv": "text/csv",
            "mp3": "audio/mpeg", "mp4": "video/mp4", "wav": "audio/wav",
        ]
        return map[ext] ?? "application/octet-stream"
    }

    private func mergeMessages(_ primary: [Message], _ secondary: [Message]) -> [Message] {
        var bySeq: [Int: Message] = [:]
        for message in primary + secondary {
            bySeq[message.seq] = message
        }
        return bySeq.values.sorted { lhs, rhs in
            if lhs.seq == rhs.seq {
                return (lhs.timestamp ?? .distantPast) < (rhs.timestamp ?? .distantPast)
            }
            return lhs.seq < rhs.seq
        }
    }
}
