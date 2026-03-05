import SwiftUI

/// Animated three-dot typing indicator.
struct TypingDotsView: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(CatColor.textSecondary)
                    .frame(width: 4, height: 4)
                    .opacity(phase == i ? 1.0 : 0.3)
            }
        }
        .onAppear {
            Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
                withAnimation(.easeInOut(duration: 0.2)) {
                    phase = (phase + 1) % 3
                }
            }
        }
    }
}
