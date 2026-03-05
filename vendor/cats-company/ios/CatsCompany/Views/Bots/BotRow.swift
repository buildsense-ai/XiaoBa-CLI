import SwiftUI

struct BotRow: View {
    let bot: Bot
    let onToggleVisibility: () async -> Void
    let onDelete: () async -> Void
    @State private var showDeleteConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                AvatarView(name: bot.label, isBot: true, isGroup: false, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(bot.label)
                            .font(.body.weight(.medium))
                        Image(systemName: "cpu")
                            .font(.caption)
                            .foregroundStyle(CatColor.primary)
                    }
                    Text("@\(bot.username)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if bot.isManaged {
                        Text("云端托管")
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(CatColor.primary.opacity(0.12))
                            .foregroundStyle(CatColor.primary)
                            .clipShape(Capsule())
                    }
                }
                Spacer()
                Text(bot.isPublic ? "公开" : "私有")
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(bot.isPublic ? CatColor.primary.opacity(0.15) : CatColor.textSecondary.opacity(0.15))
                    .foregroundStyle(bot.isPublic ? CatColor.primary : CatColor.textSecondary)
                    .clipShape(Capsule())
            }

            HStack(spacing: 12) {
                Button {
                    Task { await onToggleVisibility() }
                } label: {
                    Label(bot.isPublic ? "设为私有" : "设为公开",
                          systemImage: bot.isPublic ? "eye.slash" : "eye")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Spacer()

                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    Label("删除", systemImage: "trash")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
        .confirmationDialog("确定删除机器人「\(bot.label)」？", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                Task { await onDelete() }
            }
        }
    }
}
