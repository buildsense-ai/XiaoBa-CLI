import SwiftUI

// Notification sent when a bot is deleted
extension Notification.Name {
    static let botDeleted = Notification.Name("botDeleted")
}

struct BotManagementView: View {
    @State private var bots: [Bot] = []
    @State private var isLoading = true
    @State private var showCreateSheet = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if bots.isEmpty && !isLoading {
                Section {
                    VStack(spacing: 12) {
                        Image(systemName: "cpu")
                            .font(.system(size: 40))
                            .foregroundStyle(CatColor.textSecondary)
                        Text("还没有机器人")
                            .foregroundStyle(CatColor.textSecondary)
                        Text("点击右上角 + 创建你的第一个机器人")
                            .font(.caption)
                            .foregroundStyle(CatColor.textSecondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                }
            }

            ForEach(bots) { bot in
                BotRow(bot: bot, onToggleVisibility: {
                    await toggleVisibility(bot)
                }, onDelete: {
                    await deleteBot(bot)
                })
            }
        }
        .navigationTitle("我的机器人")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showCreateSheet = true } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showCreateSheet) {
            CreateBotSheet { await loadBots() }
        }
        .refreshable { await loadBots() }
        .task { await loadBots() }
        .alert("错误", isPresented: .init(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("确定") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func loadBots() async {
        do {
            bots = try await APIClient.shared.getMyBots()
            isLoading = false
        } catch {
            isLoading = false
            print("Load bots error: \(error)")
        }
    }

    private func toggleVisibility(_ bot: Bot) async {
        let newVis = bot.isPublic ? "private" : "public"
        do {
            _ = try await APIClient.shared.setBotVisibility(uid: bot.id, visibility: newVis)
            await loadBots()
        } catch {
            errorMessage = "切换可见性失败: \(error.localizedDescription)"
        }
    }

    private func deleteBot(_ bot: Bot) async {
        do {
            _ = try await APIClient.shared.deleteBot(uid: bot.id)
            bots.removeAll { $0.id == bot.id }
            // Notify other views to refresh (friends list, chats list)
            NotificationCenter.default.post(name: .botDeleted, object: bot.id)
        } catch {
            errorMessage = "删除失败: \(error.localizedDescription)"
        }
    }
}
