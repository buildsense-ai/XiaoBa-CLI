import Foundation
import SwiftUI

/// Manages authentication state, token persistence, and current user info.
@MainActor
class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @Published var isLoggedIn = false
    @Published var currentUser: User?
    @Published var token: String?

    private let tokenKey = "cc_token"
    private let userKey = "cc_user"

    private init() {
        // Restore session from Keychain/UserDefaults
        if let saved = UserDefaults.standard.string(forKey: tokenKey), !saved.isEmpty {
            self.token = saved
            self.isLoggedIn = true
            if let data = UserDefaults.standard.data(forKey: userKey),
               let user = try? JSONDecoder().decode(User.self, from: data) {
                self.currentUser = user
            }
        }
    }

    func login(token: String, user: User) {
        self.token = token
        self.currentUser = user
        self.isLoggedIn = true
        UserDefaults.standard.set(token, forKey: tokenKey)
        if let data = try? JSONEncoder().encode(user) {
            UserDefaults.standard.set(data, forKey: userKey)
        }
        IdentityStore.shared.upsertCurrentUser(user)
    }

    func updateCurrentUser(_ user: User) {
        self.currentUser = user
        if let data = try? JSONEncoder().encode(user) {
            UserDefaults.standard.set(data, forKey: userKey)
        }
        IdentityStore.shared.upsertCurrentUser(user)
    }

    func logout() {
        self.token = nil
        self.currentUser = nil
        self.isLoggedIn = false
        UserDefaults.standard.removeObject(forKey: tokenKey)
        UserDefaults.standard.removeObject(forKey: userKey)
        IdentityStore.shared.clear()
    }
}
