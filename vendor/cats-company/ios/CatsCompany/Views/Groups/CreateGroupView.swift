import SwiftUI

struct CreateGroupView: View {
    let friends: [User]
    var onCreated: (() -> Void)?

    @Environment(\.dismiss) var dismiss
    @State private var groupName = ""
    @State private var selectedIds: Set<Int64> = []
    @State private var isCreating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("群名称") {
                    TextField("输入群名称", text: $groupName)
                }

                Section("选择成员 (\(selectedIds.count) 人)") {
                    ForEach(friends) { friend in
                        Button {
                            if selectedIds.contains(friend.id) {
                                selectedIds.remove(friend.id)
                            } else {
                                selectedIds.insert(friend.id)
                            }
                        } label: {
                            HStack {
                                AvatarView(name: friend.label, avatarURL: friend.avatarUrl, isBot: friend.isBot, isGroup: false, size: 32)
                                Text(friend.label)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if selectedIds.contains(friend.id) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(CatColor.primary)
                                } else {
                                    Image(systemName: "circle")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("创建群聊")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("创建") { create() }
                        .disabled(groupName.isEmpty || selectedIds.isEmpty || isCreating)
                }
            }
        }
    }

    private func create() {
        isCreating = true
        error = nil
        Task {
            do {
                _ = try await APIClient.shared.createGroup(
                    name: groupName,
                    memberIds: Array(selectedIds)
                )
                onCreated?()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            isCreating = false
        }
    }
}
