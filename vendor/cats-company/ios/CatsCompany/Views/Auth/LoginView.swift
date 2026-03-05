import SwiftUI

struct LoginView: View {
    @ObservedObject var auth = AuthManager.shared
    @State private var username = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var isRegister = false
    @State private var error: String?
    @State private var isLoading = false

    var body: some View {
        ZStack {
            CatColor.background
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Logo
                VStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 60))
                        .foregroundStyle(CatColor.primary)
                    Text("猫猫公司")
                        .font(.title.bold())
                        .foregroundStyle(CatColor.textPrimary)
                    Text("AI 社交平台")
                        .font(.subheadline)
                        .foregroundStyle(CatColor.textSecondary)
                }
                .padding(.bottom, 40)

                // Form card
                VStack(spacing: 0) {
                    VStack(spacing: 12) {
                        CatTextField(placeholder: "用户名", text: $username)
                            .textContentType(.username)
                            .autocapitalization(.none)
                            .autocorrectionDisabled()

                        CatSecureField(placeholder: "密码", text: $password)
                            .textContentType(isRegister ? .newPassword : .password)

                        if isRegister {
                            CatTextField(placeholder: "昵称（可选）", text: $displayName)
                        }

                        if let error {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(CatColor.danger)
                        }

                        Button {
                            submit()
                        } label: {
                            if isLoading {
                                ProgressView()
                                    .tint(.white)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 20)
                            } else {
                                Text(isRegister ? "注册" : "登录")
                                    .font(.body.weight(.medium))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .frame(height: CatLayout.inputHeight)
                        .background(
                            (username.isEmpty || password.isEmpty || isLoading)
                                ? CatColor.primary.opacity(0.4)
                                : CatColor.primary
                        )
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: CatLayout.avatarRadius))
                        .disabled(username.isEmpty || password.isEmpty || isLoading)
                        .padding(.top, 4)

                        Button(isRegister ? "已有账号？去登录" : "没有账号？去注册") {
                            isRegister.toggle()
                            error = nil
                        }
                        .font(.subheadline)
                        .foregroundStyle(CatColor.primary)
                    }
                    .padding(24)
                }
                .background(CatColor.cardBg)
                .clipShape(RoundedRectangle(cornerRadius: CatLayout.radiusLarge))
                .shadow(color: .black.opacity(0.06), radius: 10, y: 4)
                .padding(.horizontal, 32)

                Spacer()
                Spacer()
            }
        }
    }

    private func submit() {
        isLoading = true
        error = nil
        Task {
            do {
                let resp: APIClient.AuthResponse
                if isRegister {
                    resp = try await APIClient.shared.register(
                        username: username,
                        password: password,
                        displayName: displayName.isEmpty ? nil : displayName
                    )
                } else {
                    resp = try await APIClient.shared.login(
                        username: username,
                        password: password
                    )
                }
                auth.login(token: resp.token, user: resp.user)
                WebSocketManager.shared.connect()
            } catch {
                self.error = error.localizedDescription
            }
            isLoading = false
        }
    }
}

// MARK: - Custom Input Fields

private struct CatTextField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        TextField(placeholder, text: $text)
            .padding(.horizontal, 14)
            .frame(height: CatLayout.inputHeight)
            .background(CatColor.background)
            .clipShape(RoundedRectangle(cornerRadius: CatLayout.avatarRadius))
    }
}

private struct CatSecureField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        SecureField(placeholder, text: $text)
            .padding(.horizontal, 14)
            .frame(height: CatLayout.inputHeight)
            .background(CatColor.background)
            .clipShape(RoundedRectangle(cornerRadius: CatLayout.avatarRadius))
    }
}
