import SwiftUI

extension Notification.Name {
    static let conversationListChanged = Notification.Name("conversationListChanged")
    static let contactsDataChanged = Notification.Name("contactsDataChanged")
}

/// A single conversation item for the chat list.
struct Conversation: Identifiable {
    let id: String // topic_id
    let name: String
    let isGroup: Bool
    let isBot: Bool
    var lastMessage: String?
    var lastTime: Date?
    var isOnline: Bool
    var avatarUrl: String?
    var peerUid: Int64? // for P2P chats
    var latestSeq: Int?
}

struct ChatListView: View {
    @Binding var pendingTopicId: String?

    @ObservedObject var ws = WebSocketManager.shared
    @State private var conversations: [Conversation] = []
    @State private var selectedTopic: Conversation?
    @State private var isLoading = true
    @State private var dataListenerID: WebSocketManager.ListenerID?
    @State private var presenceListenerID: WebSocketManager.ListenerID?

    var body: some View {
        NavigationStack {
            SwiftUI.Group {
                if isLoading {
                    ProgressView("加载中...")
                } else if conversations.isEmpty {
                    ContentUnavailableView(
                        "暂无会话",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("添加好友或创建群聊开始聊天")
                    )
                } else {
                    List(conversations) { conv in
                        NavigationLink(value: conv.id) {
                            ConversationRow(conversation: conv)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                deleteConversation(conv)
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await loadConversations() }
                }
            }
            .navigationTitle("消息")
            .navigationDestination(for: String.self) { topicId in
                if let conv = conversations.first(where: { $0.id == topicId }) {
                    ChatDetailView(topicId: conv.id, title: conv.name)
                }
            }
            .task { await loadConversations() }
            .onAppear { setupWSHandlers() }
            .onDisappear { clearWSHandlers() }
            .onChange(of: pendingTopicId) {
                if let topicId = pendingTopicId {
                    // Find or create conversation for this topic
                    if let conv = conversations.first(where: { $0.id == topicId }) {
                        selectedTopic = conv
                    } else {
                        // Create a temporary conversation
                        selectedTopic = Conversation(id: topicId, name: topicId, isGroup: topicId.hasPrefix("grp_"))
                    }
                    pendingTopicId = nil
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .botDeleted)) { _ in
                Task { await loadConversations() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .conversationListChanged)) { _ in
                Task { await loadConversations() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .contactsDataChanged)) { _ in
                Task { await loadConversations() }
            }
        }
    }

    private func setupWSHandlers() {
        guard dataListenerID == nil, presenceListenerID == nil else { return }

        dataListenerID = ws.addDataListener { [self] data in
            MessageStore.shared.unhideConversation(topic: data.topic)
            if let idx = conversations.firstIndex(where: { $0.id == data.topic }) {
                conversations[idx].lastMessage = data.content.displayText
                conversations[idx].lastTime = Date()
                conversations[idx].latestSeq = data.seq
                let conv = conversations.remove(at: idx)
                conversations.insert(conv, at: 0)
            } else {
                Task { await loadConversations() }
            }
        }

        presenceListenerID = ws.addPresenceListener { pres in
            if pres.what == "on", let src = pres.src {
                if let idx = conversations.firstIndex(where: { $0.id.contains(src) }) {
                    conversations[idx].isOnline = true
                }
            } else if pres.what == "off", let src = pres.src {
                if let idx = conversations.firstIndex(where: { $0.id.contains(src) }) {
                    conversations[idx].isOnline = false
                }
            }
        }
    }

    private func clearWSHandlers() {
        ws.removeDataListener(dataListenerID)
        ws.removePresenceListener(presenceListenerID)
        dataListenerID = nil
        presenceListenerID = nil
    }

    private func loadConversations() async {
        do {
            let summaries = try await APIClient.shared.getConversations()
            var visibleConversations: [Conversation] = []
            var hiddenConversations: [APIClient.ConversationSummary] = []

            for summary in summaries {
                if MessageStore.shared.isConversationHidden(topic: summary.id) {
                    hiddenConversations.append(summary)
                    continue
                }
                visibleConversations.append(makeConversation(from: summary))
            }

            if visibleConversations.isEmpty && !hiddenConversations.isEmpty {
                for summary in hiddenConversations {
                    MessageStore.shared.unhideConversation(topic: summary.id)
                    visibleConversations.append(makeConversation(from: summary))
                }
            }

            conversations = visibleConversations
            isLoading = false
        } catch {
            print("Load conversations error: \(error)")
            isLoading = false
        }
    }

    private func deleteConversation(_ conversation: Conversation) {
        MessageStore.shared.clearMessages(for: conversation.id, upToSeq: conversation.latestSeq)
        MessageStore.shared.hideConversation(topic: conversation.id)
        conversations.removeAll { $0.id == conversation.id }
    }

    private func makeConversation(from summary: APIClient.ConversationSummary) -> Conversation {
        Conversation(
            id: summary.id,
            name: summary.name,
            isGroup: summary.isGroup,
            isBot: summary.isBot,
            lastMessage: summary.preview,
            lastTime: summary.lastTime,
            isOnline: summary.isOnline,
            avatarUrl: summary.avatarUrl,
            peerUid: summary.friendId,
            latestSeq: summary.latestSeq
        )
    }
}

struct ConversationRow: View {
    let conversation: Conversation

    private var timeText: String? {
        guard let date = conversation.lastTime else { return nil }
        let formatter = DateFormatter()
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            formatter.dateFormat = "HH:mm"
        } else if calendar.isDateInYesterday(date) {
            return "昨天"
        } else {
            formatter.dateFormat = "M/d"
        }
        return formatter.string(from: date)
    }

    var body: some View {
        HStack(spacing: 12) {
            // Avatar with online indicator
            ZStack(alignment: .bottomTrailing) {
                AvatarView(
                    name: conversation.name,
                    avatarURL: conversation.avatarUrl,
                    isBot: conversation.isBot,
                    isGroup: conversation.isGroup,
                    size: 48
                )
                if !conversation.isGroup && conversation.isOnline {
                    Circle()
                        .fill(CatColor.primary)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(conversation.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    if conversation.isBot {
                        Image(systemName: "cpu")
                            .font(.caption)
                            .foregroundStyle(CatColor.primary)
                    }
                    Spacer()
                    if let time = timeText {
                        Text(time)
                            .font(.caption)
                            .foregroundStyle(CatColor.textSecondary)
                    }
                }
                if let last = conversation.lastMessage {
                    Text(last)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 4)
        .alignmentGuide(.listRowSeparatorLeading) { _ in 72 }
    }
}
