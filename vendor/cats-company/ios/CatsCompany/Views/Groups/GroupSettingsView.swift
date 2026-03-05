import PhotosUI
import SwiftUI

struct GroupSettingsView: View {
    let groupId: Int64
    let topicId: String
    var onSaved: (() async -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var auth = AuthManager.shared

    @State private var group: Group?
    @State private var members: [GroupMember] = []
    @State private var friends: [User] = []
    @State private var groupName = ""
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var avatarURL: String?
    @State private var selectedInvitees: Set<Int64> = []
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var currentRole: String? {
        guard let myID = auth.currentUser?.id else { return nil }
        return members.first(where: { $0.userId == myID })?.role
    }

    private var canManage: Bool {
        currentRole == "owner" || currentRole == "admin"
    }

    private var availableFriends: [User] {
        let memberIDs = Set(members.map(\.userId))
        return friends.filter { !memberIDs.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        VStack(spacing: 12) {
                            AvatarView(
                                name: groupName.isEmpty ? (group?.name ?? "群聊") : groupName,
                                avatarURL: avatarURL,
                                isGroup: true,
                                size: 88
                            )
                            if canManage {
                                PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                                    Text("选择群头像")
                                        .font(.subheadline)
                                }
                            }
                        }
                        Spacer()
                    }
                    .padding(.vertical, 8)
                }

                Section("群资料") {
                    TextField("群名称", text: $groupName)
                        .disabled(!canManage)
                    if !canManage {
                        Text("只有群主或管理员可以修改群资料")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("成员 (\(members.count))") {
                    ForEach(members) { member in
                        HStack(spacing: 12) {
                            AvatarView(
                                name: member.displayName ?? member.username,
                                avatarURL: member.avatarUrl,
                                isBot: member.isBot == true,
                                size: 32
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.displayName ?? member.username)
                                Text("@\(member.username)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let role = member.role {
                                Text(roleLabel(role))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if canManage {
                    Section("添加成员") {
                        if availableFriends.isEmpty {
                            Text("没有可添加的好友")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(availableFriends) { friend in
                                Button {
                                    toggleInvitee(friend.id)
                                } label: {
                                    HStack {
                                        AvatarView(
                                            name: friend.label,
                                            avatarURL: friend.avatarUrl,
                                            isBot: friend.isBot,
                                            size: 32
                                        )
                                        Text(friend.label)
                                            .foregroundStyle(.primary)
                                        Spacer()
                                        Image(systemName: selectedInvitees.contains(friend.id) ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(selectedInvitees.contains(friend.id) ? CatColor.primary : .secondary)
                                    }
                                }
                            }
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("群设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(isSaving ? "保存中" : "保存") {
                        Task { await saveChanges() }
                    }
                    .disabled(!canManage || isSaving || groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .task { await loadData() }
            .onChange(of: selectedPhotoItem) {
                guard let selectedPhotoItem else { return }
                Task { await uploadAvatar(selectedPhotoItem) }
            }
        }
    }

    private func loadData() async {
        do {
            async let groupInfoTask = APIClient.shared.getGroupInfo(groupId: groupId)
            async let friendsTask = APIClient.shared.getFriends()
            let groupInfo = try await groupInfoTask
            friends = try await friendsTask
            group = groupInfo.group
            members = groupInfo.members
            groupName = groupInfo.group.name
            avatarURL = groupInfo.group.avatarUrl

            IdentityStore.shared.upsertGroups([groupInfo.group])
            IdentityStore.shared.upsertUsers(friends)
            IdentityStore.shared.upsertGroupMembers(groupInfo.members)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func uploadAvatar(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                errorMessage = "无法读取所选图片"
                return
            }
            let fileName = "group_avatar_\(groupId)_\(Int(Date().timeIntervalSince1970)).jpg"
            let upload = try await APIClient.shared.uploadImage(data: data, filename: fileName)
            avatarURL = upload.url
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveChanges() async {
        let trimmedName = groupName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }

        isSaving = true
        defer { isSaving = false }

        do {
            if let current = group,
               current.name != trimmedName || (current.avatarUrl ?? "") != (avatarURL ?? "") {
                let updatedGroup = try await APIClient.shared.updateGroup(
                    groupId: groupId,
                    name: trimmedName,
                    avatarUrl: avatarURL
                )
                group = updatedGroup
                IdentityStore.shared.upsertGroups([updatedGroup])
            }

            if !selectedInvitees.isEmpty {
                try await APIClient.shared.inviteToGroup(groupId: groupId, userIds: Array(selectedInvitees))
                selectedInvitees.removeAll()
            }

            let refreshed = try await APIClient.shared.getGroupInfo(groupId: groupId)
            group = refreshed.group
            members = refreshed.members
            groupName = refreshed.group.name
            avatarURL = refreshed.group.avatarUrl
            IdentityStore.shared.upsertGroups([refreshed.group])
            IdentityStore.shared.upsertGroupMembers(refreshed.members)

            NotificationCenter.default.post(name: .contactsDataChanged, object: nil)
            NotificationCenter.default.post(name: .conversationListChanged, object: topicId)
            if let onSaved {
                await onSaved()
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggleInvitee(_ id: Int64) {
        if selectedInvitees.contains(id) {
            selectedInvitees.remove(id)
        } else {
            selectedInvitees.insert(id)
        }
    }

    private func roleLabel(_ role: String) -> String {
        switch role {
        case "owner":
            return "群主"
        case "admin":
            return "管理员"
        default:
            return "成员"
        }
    }
}
