import SwiftUI

struct ProfileView: View {
    @ObservedObject var auth = AuthManager.shared
    @ObservedObject var ws = WebSocketManager.shared
    @State private var showEditProfile = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    // User info card
                    HStack(spacing: 16) {
                        AvatarView(
                            name: auth.currentUser?.label ?? "?",
                            avatarURL: auth.currentUser?.avatarUrl,
                            isBot: false,
                            isGroup: false,
                            size: 64
                        )
                        VStack(alignment: .leading, spacing: 4) {
                            Text(auth.currentUser?.label ?? "未知用户")
                                .font(.title3.bold())
                            Text("@\(auth.currentUser?.username ?? "")")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            HStack(spacing: 4) {
                                Circle()
                                    .fill(ws.isConnected ? CatColor.primary : CatColor.textSecondary)
                                    .frame(width: 8, height: 8)
                                Text(ws.isConnected ? "在线" : "离线")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }
                    .padding(16)
                    .background(CatColor.cardBg)
                    .clipShape(RoundedRectangle(cornerRadius: CatLayout.radius))

                    Button {
                        showEditProfile = true
                    } label: {
                        HStack {
                            Image(systemName: "pencil")
                                .foregroundStyle(CatColor.primary)
                            Text("编辑个人资料")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(CatColor.textSecondary)
                        }
                        .foregroundStyle(CatColor.textPrimary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                    }
                    .background(CatColor.cardBg)
                    .clipShape(RoundedRectangle(cornerRadius: CatLayout.radius))

                    // Server config card
                    VStack(spacing: 0) {
                        HStack {
                            Text("服务器地址")
                            Spacer()
                            Text(APIClient.shared.baseURL)
                                .foregroundStyle(.secondary)
                                .font(.caption)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)

                        Divider().padding(.leading, 16)

                        HStack {
                            Text("WebSocket")
                            Spacer()
                            Text(ws.isConnected ? "已连接" : "未连接")
                                .foregroundStyle(ws.isConnected ? CatColor.primary : CatColor.danger)
                                .font(.caption)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    }
                    .background(CatColor.cardBg)
                    .clipShape(RoundedRectangle(cornerRadius: CatLayout.radius))

                    // Bot management
                    NavigationLink {
                        BotManagementView()
                    } label: {
                        HStack {
                            Image(systemName: "cpu")
                                .foregroundStyle(CatColor.primary)
                            Text("我的机器人")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(CatColor.textSecondary)
                        }
                        .foregroundStyle(CatColor.textPrimary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                    }
                    .background(CatColor.cardBg)
                    .clipShape(RoundedRectangle(cornerRadius: CatLayout.radius))

                    // Clear cache button
                    Button {
                        MessageStore.shared.clearAllMessages()
                        NotificationCenter.default.post(name: .conversationListChanged, object: nil)
                    } label: {
                        HStack {
                            Image(systemName: "arrow.triangle.2.circlepath")
                            Text("清除聊天缓存")
                        }
                        .foregroundStyle(CatColor.textPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                    }
                    .background(CatColor.cardBg)
                    .clipShape(RoundedRectangle(cornerRadius: CatLayout.radius))

                    // Logout button
                    Button {
                        ws.disconnect()
                        auth.logout()
                    } label: {
                        Text("退出登录")
                            .foregroundStyle(CatColor.danger)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .background(CatColor.cardBg)
                    .clipShape(RoundedRectangle(cornerRadius: CatLayout.radius))

                    // Version
                    Text("CatsCompany v1.0.0")
                        .font(.caption)
                        .foregroundStyle(CatColor.textSecondary)
                        .padding(.top, 16)
                }
                .padding(16)
            }
            .background(CatColor.background)
            .navigationTitle("我")
            .task { await refreshProfile() }
            .sheet(isPresented: $showEditProfile) {
                ProfileEditorView {
                    await refreshProfile()
                }
            }
        }
    }

    private func refreshProfile() async {
        do {
            let me = try await APIClient.shared.getMe()
            auth.updateCurrentUser(me)
        } catch {
            print("Refresh profile error: \(error)")
        }
    }
}
