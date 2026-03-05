import SwiftUI

struct ContactsView: View {
    var onOpenChat: ((String) -> Void)?

    @ObservedObject var auth = AuthManager.shared
    @ObservedObject private var identities = IdentityStore.shared
    @State private var friends: [User] = []
    @State private var groups: [Group] = []
    @State private var pendingRequests: [FriendRequest] = []
    @State private var showAddFriend = false
    @State private var showCreateGroup = false
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            List {
                // Pending requests
                if !pendingRequests.isEmpty {
                    Section {
                        ForEach(pendingRequests) { req in
                            FriendRequestRow(request: req) {
                                await acceptFriend(req)
                            } onReject: {
                                await rejectFriend(req)
                            }
                        }
                    } header: {
                        Text("好友请求")
                            .font(.caption)
                            .foregroundStyle(CatColor.textSecondary)
                            .textCase(nil)
                    }
                }

                // Groups
                if !groups.isEmpty {
                    Section {
                        ForEach(groups) { group in
                            Button {
                                onOpenChat?(group.topicId)
                            } label: {
                                HStack(spacing: 12) {
                                    AvatarView(name: group.name, avatarURL: group.avatarUrl, isBot: false, isGroup: true, size: 40)
                                    Text(group.name)
                                        .foregroundStyle(CatColor.textPrimary)
                                }
                            }
                        }
                    } header: {
                        Text("群聊")
                            .font(.caption)
                            .foregroundStyle(CatColor.textSecondary)
                            .textCase(nil)
                    }
                }

                // Friends
                Section {
                    if friends.isEmpty && !isLoading {
                        Text("还没有好友")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(friends) { friend in
                        let topicId = makeP2PTopicId(friend.id)
                        Button {
                            onOpenChat?(topicId)
                        } label: {
                            HStack(spacing: 12) {
                                AvatarView(name: friend.label, avatarURL: friend.avatarUrl, isBot: friend.isBot, isGroup: false, size: 40)
                                VStack(alignment: .leading) {
                                    HStack {
                                        Text(friend.label)
                                            .foregroundStyle(CatColor.textPrimary)
                                        if friend.isBot {
                                            Image(systemName: "cpu")
                                                .font(.caption)
                                                .foregroundStyle(CatColor.primary)
                                        }
                                    }
                                    Text("@\(friend.username)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } header: {
                    Text("好友")
                        .font(.caption)
                        .foregroundStyle(CatColor.textSecondary)
                        .textCase(nil)
                }
            }
            .navigationTitle("通讯录")
            .navigationDestination(for: String.self) { topicId in
                let name = nameForTopic(topicId)
                ChatDetailView(topicId: topicId, title: name)
            }
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showAddFriend = true } label: {
                        Image(systemName: "person.badge.plus")
                    }
                    Button { showCreateGroup = true } label: {
                        Image(systemName: "person.3.fill")
                    }
                }
            }
            .sheet(isPresented: $showAddFriend) {
                AddFriendView()
            }
            .sheet(isPresented: $showCreateGroup) {
                CreateGroupView(friends: friends) {
                    Task { await loadData() }
                }
            }
            .refreshable { await loadData() }
            .task { await loadData() }
            .onReceive(NotificationCenter.default.publisher(for: .botDeleted)) { _ in
                Task { await loadData() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .contactsDataChanged)) { _ in
                Task { await loadData() }
            }
        }
    }

    private func loadData() async {
        do {
            async let f = APIClient.shared.getFriends()
            async let g = APIClient.shared.getGroups()
            async let p = APIClient.shared.getPendingRequests()
            friends = try await f
            groups = try await g
            pendingRequests = try await p
            identities.upsertCurrentUser(auth.currentUser)
            identities.upsertUsers(friends)
            identities.upsertGroups(groups)
            isLoading = false
        } catch {
            print("Load contacts error: \(error)")
            isLoading = false
        }
    }

    private func acceptFriend(_ req: FriendRequest) async {
        _ = try? await APIClient.shared.acceptFriend(userId: req.fromUserId)
        pendingRequests.removeAll { $0.id == req.id }
        await loadData()
    }

    private func rejectFriend(_ req: FriendRequest) async {
        _ = try? await APIClient.shared.rejectFriend(userId: req.fromUserId)
        pendingRequests.removeAll { $0.id == req.id }
    }

    private func makeP2PTopicId(_ friendId: Int64) -> String {
        guard let myId = auth.currentUser?.id else { return "" }
        let ids = [myId, friendId].sorted()
        return "p2p_\(ids[0])_\(ids[1])"
    }

    private func nameForTopic(_ topicId: String) -> String {
        if topicId.hasPrefix("grp_") {
            return groups.first { $0.topicId == topicId }?.name ?? "群聊"
        }
        let parts = topicId.replacingOccurrences(of: "p2p_", with: "").split(separator: "_")
        let myId = auth.currentUser?.id ?? 0
        for part in parts {
            if let uid = Int64(part), uid != myId {
                return friends.first { $0.id == uid }?.label ?? "用户 \(uid)"
            }
        }
        return "聊天"
    }
}

struct FriendRequestRow: View {
    let request: FriendRequest
    let onAccept: () async -> Void
    let onReject: () async -> Void

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(name: request.displayName ?? request.fromUsername, isBot: false, isGroup: false, size: 40)
            VStack(alignment: .leading) {
                Text(request.displayName ?? request.fromUsername)
                    .font(.body.weight(.medium))
                if let msg = request.message, !msg.isEmpty {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("接受") { Task { await onAccept() } }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            Button("拒绝") { Task { await onReject() } }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }
}
