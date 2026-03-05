import SwiftUI

@main
struct CatsCompanyApp: App {
    @StateObject private var auth = AuthManager.shared

    init() {
        print("🐱 [APP] init start")
        configureTabBarAppearance()
        print("🐱 [APP] init done")
    }

    var body: some Scene {
        WindowGroup {
            SwiftUI.Group {
                let _ = print("🐱 [APP] body eval — isLoggedIn=\(auth.isLoggedIn)")
                if auth.isLoggedIn {
                    MainTabView()
                        .onAppear {
                            print("🐱 [APP] MainTabView appeared")
                            WebSocketManager.shared.connect()
                        }
                } else {
                    LoginView()
                        .onAppear {
                            print("🐱 [APP] LoginView appeared")
                        }
                }
            }
            .tint(CatColor.primary)
        }
    }

    private func configureTabBarAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithDefaultBackground()
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }
}

struct MainTabView: View {
    @State private var selectedTab = 0
    @State private var pendingTopicId: String?

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatListView(pendingTopicId: $pendingTopicId)
                .tabItem {
                    Label("消息", systemImage: "bubble.left.and.bubble.right")
                }
                .tag(0)

            ContactsView(onOpenChat: { topicId in
                pendingTopicId = topicId
                selectedTab = 0
            })
                .tabItem {
                    Label("通讯录", systemImage: "person.2")
                }
                .tag(1)

            ProfileView()
                .tabItem {
                    Label("我", systemImage: "person.circle")
                }
                .tag(2)
        }
    }
}
