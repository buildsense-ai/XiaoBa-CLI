import PhotosUI
import SwiftUI

struct ProfileEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var auth = AuthManager.shared

    var onSaved: (() async -> Void)? = nil

    @State private var displayName = ""
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var avatarURL: String?
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        VStack(spacing: 12) {
                            AvatarView(
                                name: displayName.isEmpty ? (auth.currentUser?.label ?? "?") : displayName,
                                avatarURL: avatarURL,
                                size: 88
                            )
                            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                                Text("选择头像")
                                    .font(.subheadline)
                            }
                        }
                        Spacer()
                    }
                    .padding(.vertical, 8)
                }

                Section("昵称") {
                    TextField("输入昵称", text: $displayName)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("编辑资料")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(isSaving ? "保存中" : "保存") {
                        Task { await saveProfile() }
                    }
                    .disabled(isSaving || displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .task {
                displayName = auth.currentUser?.label ?? ""
                avatarURL = auth.currentUser?.avatarUrl
            }
            .onChange(of: selectedPhotoItem) {
                guard let selectedPhotoItem else { return }
                Task { await uploadAvatar(selectedPhotoItem) }
            }
        }
    }

    private func uploadAvatar(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                errorMessage = "无法读取所选图片"
                return
            }
            let fileName = "avatar_\(Int(Date().timeIntervalSince1970)).jpg"
            let upload = try await APIClient.shared.uploadImage(data: data, filename: fileName)
            avatarURL = upload.url
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveProfile() async {
        let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }

        isSaving = true
        defer { isSaving = false }

        do {
            let user = try await APIClient.shared.updateMe(displayName: trimmedName, avatarUrl: avatarURL)
            auth.updateCurrentUser(user)
            NotificationCenter.default.post(name: .contactsDataChanged, object: nil)
            NotificationCenter.default.post(name: .conversationListChanged, object: nil)
            if let onSaved {
                await onSaved()
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
