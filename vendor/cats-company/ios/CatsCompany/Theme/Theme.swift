import SwiftUI
import UIKit

// MARK: - Brand Colors

enum CatColor {
    static let primary = Color(hex: 0x07C160)
    static let primaryDark = Color(hex: 0x06AD56)
    static let primaryLight = Color(hex: 0x95EC69)

    static let background = Color(light: Color(hex: 0xEDEDED), dark: Color(hex: 0x111111))
    static let secondaryBg = Color(light: Color(hex: 0xF7F7F7), dark: Color(hex: 0x1C1C1E))
    static let chatBg = Color(light: Color(hex: 0xF0F0F0), dark: Color(hex: 0x1C1C1E))

    static let textPrimary = Color(light: Color(hex: 0x111111), dark: .white)
    static let textSecondary = Color(hex: 0x888888)

    static let bubbleSelf = Color(light: Color(hex: 0x95EC69), dark: Color(hex: 0x2A5F2A))
    static let bubbleOther = Color(light: .white, dark: Color(hex: 0x2C2C2E))
    static let bubbleSelfText = Color(light: Color(hex: 0x111111), dark: .white)

    static let danger = Color(hex: 0xFA5151)
    static let border = Color(light: Color(hex: 0xE6E6E6), dark: Color(hex: 0x3A3A3C))

    static let cardBg = Color(light: .white, dark: Color(hex: 0x2C2C2E))
}

// MARK: - Layout Constants

enum CatLayout {
    static let radius: CGFloat = 8
    static let radiusLarge: CGFloat = 12
    static let avatarRadius: CGFloat = 6
    static let inputHeight: CGFloat = 44
}

// MARK: - Color Extensions

extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }

    init(light: Color, dark: Color) {
        self.init(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(dark)
                : UIColor(light)
        })
    }
}

// MARK: - Reusable Components

struct UnreadBadge: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .frame(minWidth: 16, minHeight: 16)
                .background(CatColor.danger)
                .clipShape(Capsule())
        }
    }
}

struct DateSeparator: View {
    let date: Date

    var body: some View {
        HStack {
            Spacer()
            Text(formatDate(date))
                .font(.system(size: 12))
                .foregroundStyle(CatColor.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Color.black.opacity(0.06))
                .clipShape(Capsule())
            Spacer()
        }
        .padding(.vertical, 8)
    }

    private func formatDate(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return "今天"
        } else if calendar.isDateInYesterday(date) {
            return "昨天"
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = calendar.isDate(date, equalTo: Date(), toGranularity: .year)
                ? "M月d日"
                : "yyyy年M月d日"
            return formatter.string(from: date)
        }
    }
}
