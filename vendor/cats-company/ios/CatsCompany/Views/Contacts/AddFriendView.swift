import SwiftUI

struct AddFriendView: View {
    @Environment(\.dismiss) var dismiss
    @State private var query = ""
    @State private var results: [User] = []
    @State private var sentIds: Set<Int64> = []
    @State private var isSearching = false

    var body: some View {
        NavigationStack {
            VStack {
                HStack {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(CatColor.textSecondary)
                        TextField("搜索用户名...", text: $query)
                            .autocapitalization(.none)
                            .autocorrectionDisabled()
                            .onSubmit { search() }
                    }
                    .padding(.horizontal, 12)
                    .frame(height: CatLayout.inputHeight)
                    .background(CatColor.background)
                    .clipShape(RoundedRectangle(cornerRadius: CatLayout.avatarRadius))

                    Button("搜索") { search() }
                        .foregroundStyle(CatColor.primary)
                        .disabled(query.count < 2)
                }
                .padding()

                if isSearching {
                    ProgressView()
                } else {
                    List(results) { user in
                        HStack(spacing: 12) {
                            AvatarView(name: user.label, avatarURL: user.avatarUrl, isBot: user.isBot, isGroup: false, size: 40)
                            VStack(alignment: .leading) {
                                Text(user.label)
                                Text("@\(user.username)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if sentIds.contains(user.id) {
                                HStack(spacing: 4) {
                                    Image(systemName: "checkmark")
                                        .font(.caption2)
                                    Text("已发送")
                                        .font(.caption)
                                }
                                .foregroundStyle(CatColor.primary)
                            } else {
                                Button("添加") {
                                    sendRequest(user)
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                            }
                        }
                    }
                    .listStyle(.plain)
                }

                Spacer()
            }
            .navigationTitle("添加好友")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    private func search() {
        guard query.count >= 2 else { return }
        isSearching = true
        Task {
            do {
                results = try await APIClient.shared.searchUsers(query: query)
            } catch {
                print("Search error: \(error)")
            }
            isSearching = false
        }
    }

    private func sendRequest(_ user: User) {
        Task {
            do {
                _ = try await APIClient.shared.sendFriendRequest(userId: user.id)
                sentIds.insert(user.id)
            } catch {
                print("Send request error: \(error)")
            }
        }
    }
}
