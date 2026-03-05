import SwiftUI

struct CreateBotSheet: View {
    private enum CreateMode: String, CaseIterable, Identifiable {
        case selfHosted
        case managed

        var id: String { rawValue }

        var title: String {
            switch self {
            case .selfHosted:
                return "仅创建"
            case .managed:
                return "创建并部署"
            }
        }

        var description: String {
            switch self {
            case .selfHosted:
                return "获取 API Key 和 WebSocket 地址，适合第三方 SDK / 自己部署"
            case .managed:
                return "创建 Bot 后立即接入 Gauz Platform 云端运行时"
            }
        }
    }

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var auth = AuthManager.shared
    @State private var displayName = ""
    @State private var createMode: CreateMode = .selfHosted
    @State private var isCreating = false
    @State private var errorMessage: String?
    @State private var createdBot: APIClient.CreateBotResponse?
    @State private var createdApiKey: String?
    @State private var friendStatus: String?
    @State private var friendSuccess = false
    @State private var copiedField: String?
    let onCreated: () async -> Void

    private var wsUrl: String {
        let base = APIClient.shared.baseURL
            .replacingOccurrences(of: "http://", with: "ws://")
            .replacingOccurrences(of: "https://", with: "wss://")
        return "\(base)/v0/channels"
    }

    var body: some View {
        NavigationStack {
            Form {
                if let bot = createdBot {
                    successSection(bot)
                } else {
                    createSection
                }
            }
            .navigationTitle(createdBot != nil ? "创建成功" : "创建机器人")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if createdBot != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("完成") {
                            Task {
                                await onCreated()
                                dismiss()
                            }
                        }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("创建") {
                            Task { await createBot() }
                        }
                        .disabled(displayName.trimmingCharacters(in: .whitespaces).isEmpty || isCreating)
                    }
                }
            }
        }
    }

    // MARK: - Create Form

    @ViewBuilder
    private var createSection: some View {
        Section {
            Picker("创建方式", selection: $createMode) {
                ForEach(CreateMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)

            TextField("机器人名称", text: $displayName)
                .textInputAutocapitalization(.never)
        } header: {
            Text("基本信息")
        } footer: {
            Text(createMode.description)
        }

        if let err = errorMessage {
            Section {
                Text(err)
                    .foregroundStyle(CatColor.danger)
                    .font(.caption)
            }
        }
    }

    // MARK: - Success View

    @ViewBuilder
    private func successSection(_ bot: APIClient.CreateBotResponse) -> some View {
        Section {
            LabeledContent("名称", value: bot.displayName ?? bot.username)
            LabeledContent("用户名", value: "@\(bot.username)")
            LabeledContent("UID", value: "\(bot.uid)")
            LabeledContent("创建方式", value: createMode.title)
            if let tenant = bot.tenantName, !tenant.isEmpty {
                LabeledContent("租户", value: tenant)
            }
        } header: {
            Text("机器人信息")
        }

        if let key = createdApiKey {
            Section {
                copiableRow(label: "API Key", value: key, field: "apiKey")
                copiableRow(label: "WebSocket", value: wsUrl, field: "wsUrl")
            } header: {
                Text("连接凭证")
            } footer: {
                Text(createMode == .managed
                     ? "即使选择云端部署，API Key 和 WebSocket 仍可用于后续接入或迁移。"
                     : "API Key 仅在创建时显示一次，请妥善保存。")
                    .foregroundStyle(CatColor.danger)
            }
        }

        if createMode == .managed {
            Section {
                Label("已请求云端部署", systemImage: "cloud.fill")
                    .foregroundStyle(CatColor.primary)
            } header: {
                Text("云端运行")
            } footer: {
                Text("Gauz Platform 将使用同一个 Bot 凭证启动托管运行时。")
            }
        }

        if let status = friendStatus {
            Section {
                HStack {
                    Image(systemName: friendSuccess ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(friendSuccess ? .green : .orange)
                    Text(status)
                        .font(.caption)
                }
            } header: {
                Text("好友状态")
            }
        }
    }

    private func copiableRow(label: String, value: String, field: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Text(value)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button {
                    UIPasteboard.general.string = value
                    copiedField = field
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        if copiedField == field { copiedField = nil }
                    }
                } label: {
                    Image(systemName: copiedField == field ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                        .foregroundStyle(copiedField == field ? .green : CatColor.primary)
                }
                .buttonStyle(.borderless)
            }
        }
    }

    // MARK: - Actions

    private func createBot() async {
        let name = displayName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }

        isCreating = true
        errorMessage = nil

        let slug = name.lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let username = "bot-\(slug.prefix(16))-\(Int.random(in: 1000...9999))"

        do {
            let resp = try await APIClient.shared.createBot(
                username: username,
                displayName: name,
                deployToCloud: createMode == .managed
            )
            createdBot = resp
            createdApiKey = resp.apiKey

            // Auto-add bot as friend
            await autoAddFriend(botUid: resp.uid, apiKey: resp.apiKey)
        } catch {
            errorMessage = error.localizedDescription
            isCreating = false
        }
    }

    private func autoAddFriend(botUid: Int64, apiKey: String?) async {
        guard let myUid = auth.currentUser?.id else {
            friendStatus = "无法获取当前用户，请手动添加好友"
            return
        }
        do {
            // Step 1: Owner sends friend request to bot
            _ = try await APIClient.shared.sendFriendRequest(userId: botUid)

            // Step 2: Bot accepts using its ApiKey
            if let key = apiKey {
                try await APIClient.shared.acceptFriendAsBot(apiKey: key, userId: myUid)
                friendSuccess = true
                friendStatus = "已自动添加为好友"
            } else {
                friendStatus = "已发送好友请求，需手动接受"
            }
        } catch {
            friendStatus = "自动添加好友失败: \(error.localizedDescription)"
        }
    }
}
