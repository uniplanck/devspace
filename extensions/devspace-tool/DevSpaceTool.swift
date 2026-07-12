import SwiftUI
import AppKit
import Foundation

private let devSpaceConfigPath = "~/.devspace/config.json"
private let devSpaceToolConfigPath = "~/.devspace/tool.json"
private let usageHistoryPath = "~/.local/share/devspace/usage-history.jsonl"

private enum AppLanguage: String, CaseIterable, Identifiable {
    case automatic
    case english
    case japanese

    var id: String { rawValue }
}

private enum AppSection: String, CaseIterable, Identifiable {
    case overview
    case analytics
    case runtime
    case folders
    case settings

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .overview: return "sparkles.rectangle.stack"
        case .analytics: return "chart.xyaxis.line"
        case .runtime: return "bolt.horizontal.circle"
        case .folders: return "folder.badge.gearshape"
        case .settings: return "slider.horizontal.3"
        }
    }
}

private struct ToolConfig: Codable {
    var host: String = "127.0.0.1"
    var port: Int = 7676
    var runtimeCommand: String = ""
    var runtimeProcessMatch: String = ""
    var usdJpyRate: Double = 160
}

private struct DevSpaceConfig: Codable {
    var host: String?
    var port: Int?
    var allowedRoots: [String]?
}

private struct CostBreakdown: Hashable {
    var input: Double = 0
    var output: Double = 0
    var total: Double { input + output }

    mutating func add(_ other: CostBreakdown) {
        input += other.input
        output += other.output
    }
}

private struct PeriodUsage: Hashable {
    var tokens: Int = 0
    var calls: Int = 0
    var cost = CostBreakdown()

    mutating func add(tokens: Int, cost: CostBreakdown) {
        self.tokens += tokens
        self.calls += 1
        self.cost.add(cost)
    }
}

private struct FolderUsage: Identifiable, Hashable {
    let id: String
    let name: String
    let path: String
    var today = PeriodUsage()
    var week = PeriodUsage()
    var month = PeriodUsage()
    var total = PeriodUsage()
}

private struct UsageSummary: Hashable {
    var today = PeriodUsage()
    var week = PeriodUsage()
    var month = PeriodUsage()
    var total = PeriodUsage()
    var folders: [FolderUsage] = []
}

@MainActor
private final class DevSpaceToolModel: ObservableObject {
    @Published var summary = UsageSummary()
    @Published var roots: [String] = []
    @Published var runtimeOnline = false
    @Published var logText = "Ready"
    @Published var lastUpdated = Date()

    var toolConfig = ToolConfig()

    func refresh() {
        toolConfig = Self.readToolConfig()
        let devConfig = Self.readDevSpaceConfig()
        if let host = devConfig.host, !host.isEmpty { toolConfig.host = host }
        if let port = devConfig.port, port > 0 { toolConfig.port = port }
        roots = devConfig.allowedRoots ?? []
        runtimeOnline = Self.portIsListening(toolConfig.port)
        summary = Self.readUsageSummary(rate: toolConfig.usdJpyRate)
        lastUpdated = Date()
    }

    func startRuntime() {
        let command = toolConfig.runtimeCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            logText = "Set runtimeCommand in ~/.devspace/tool.json first."
            return
        }
        let result = Self.shell("/usr/bin/nohup /bin/zsh -lc \(Self.shellQuote(command)) >/tmp/devspace-tool-runtime.log 2>&1 &")
        logText = result.isEmpty ? "Runtime start requested." : result
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.refresh() }
    }

    func stopRuntime() {
        let match = toolConfig.runtimeProcessMatch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !match.isEmpty else {
            logText = "Set runtimeProcessMatch in ~/.devspace/tool.json first."
            return
        }
        _ = Self.shell("/usr/bin/pkill -f -- \(Self.shellQuote(match))")
        logText = "Runtime stop requested."
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.refresh() }
    }

    func revealConfig() {
        let path = (devSpaceToolConfigPath as NSString).expandingTildeInPath
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: path) {
            let example = ToolConfig(runtimeCommand: "devspace serve", runtimeProcessMatch: "devspace.*serve")
            if let data = try? JSONEncoder.pretty.encode(example) { try? data.write(to: url, options: .atomic) }
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private static func readToolConfig() -> ToolConfig {
        let path = (devSpaceToolConfigPath as NSString).expandingTildeInPath
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let config = try? JSONDecoder().decode(ToolConfig.self, from: data) else { return ToolConfig() }
        return config
    }

    private static func readDevSpaceConfig() -> DevSpaceConfig {
        let path = (devSpaceConfigPath as NSString).expandingTildeInPath
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let config = try? JSONDecoder().decode(DevSpaceConfig.self, from: data) else { return DevSpaceConfig() }
        return config
    }

    private static func readUsageSummary(rate: Double) -> UsageSummary {
        let path = (usageHistoryPath as NSString).expandingTildeInPath
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let text = String(data: data, encoding: .utf8) else { return UsageSummary() }

        let now = Date()
        let calendar = Calendar.current
        let weekBoundary = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        let monthBoundary = calendar.date(byAdding: .day, value: -30, to: now) ?? now
        let isoFraction = ISO8601DateFormatter()
        isoFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]

        var summary = UsageSummary()
        var folders: [String: FolderUsage] = [:]

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let lineData = String(rawLine).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                  let timestamp = object["ts"] as? String,
                  let date = isoFraction.date(from: timestamp) ?? iso.date(from: timestamp) else { continue }

            let pair = modelTokenPair(object)
            let tokens = max(0, Int(pair.input + pair.output))
            let configuredRate = number(object["usdJpyRate"])
            let effectiveRate = configuredRate > 0 ? configuredRate : max(1, rate)
            let cost = CostBreakdown(
                input: pair.input * 5 / 1_000_000 * effectiveRate,
                output: pair.output * 30 / 1_000_000 * effectiveRate
            )
            let isToday = calendar.isDate(date, inSameDayAs: now)
            let isWeek = date >= weekBoundary
            let isMonth = date >= monthBoundary

            summary.total.add(tokens: tokens, cost: cost)
            if isToday { summary.today.add(tokens: tokens, cost: cost) }
            if isWeek { summary.week.add(tokens: tokens, cost: cost) }
            if isMonth { summary.month.add(tokens: tokens, cost: cost) }

            let root = ((object["workspaceRoot"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let normalizedRoot = root.isEmpty || root == "unknown" ? "legacy:unknown" : root
            let fallbackName = URL(fileURLWithPath: normalizedRoot).lastPathComponent
            let rawName = ((object["workspaceName"] as? String) ?? fallbackName).trimmingCharacters(in: .whitespacesAndNewlines)
            let name = rawName.isEmpty ? "Unknown" : rawName
            var folder = folders[normalizedRoot] ?? FolderUsage(id: normalizedRoot, name: name, path: normalizedRoot)
            folder.total.add(tokens: tokens, cost: cost)
            if isToday { folder.today.add(tokens: tokens, cost: cost) }
            if isWeek { folder.week.add(tokens: tokens, cost: cost) }
            if isMonth { folder.month.add(tokens: tokens, cost: cost) }
            folders[normalizedRoot] = folder
        }

        summary.folders = folders.values.sorted {
            if $0.total.cost.total == $1.total.cost.total { return $0.name < $1.name }
            return $0.total.cost.total > $1.total.cost.total
        }
        return summary
    }

    private static func modelTokenPair(_ object: [String: Any]) -> (input: Double, output: Double) {
        let recordedInput = number(object["inputTokens"])
        let recordedOutput = number(object["outputTokens"])
        let inputChars = number(object["inputChars"])
        let outputChars = number(object["outputChars"])
        let note = (object["note"] as? String) ?? ""
        let modern = object["estimatedJpyMax"] != nil || note.contains("maps MCP tool results to model input")
        if modern {
            return (
                recordedInput > 0 ? recordedInput : ceil(inputChars / 4),
                recordedOutput > 0 ? recordedOutput : ceil(outputChars / 4)
            )
        }
        return (
            recordedOutput > 0 ? recordedOutput : ceil(outputChars / 4),
            recordedInput > 0 ? recordedInput : ceil(inputChars / 4)
        )
    }

    private static func number(_ value: Any?) -> Double {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        return 0
    }

    private static func portIsListening(_ port: Int) -> Bool {
        shell("/usr/sbin/lsof -nP -iTCP:\(port) -sTCP:LISTEN 2>/dev/null").isEmpty == false
    }

    private static func shell(_ command: String) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch { return error.localizedDescription }
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

private extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

private struct DevSpaceToolView: View {
    @StateObject private var model = DevSpaceToolModel()
    @AppStorage("devspaceTool.language") private var languageRaw = AppLanguage.automatic.rawValue
    @State private var section: AppSection = .overview
    @State private var selectedFolder: String?
    private let timer = Timer.publish(every: 20, on: .main, in: .common).autoconnect()

    private var language: AppLanguage { AppLanguage(rawValue: languageRaw) ?? .automatic }
    private var japanese: Bool {
        switch language {
        case .japanese: return true
        case .english: return false
        case .automatic: return Locale.current.language.languageCode?.identifier == "ja"
        }
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.025, green: 0.04, blue: 0.08), Color(red: 0.045, green: 0.025, blue: 0.09)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ).ignoresSafeArea()
            HStack(spacing: 0) {
                sidebar
                Divider().overlay(Color.white.opacity(0.1))
                VStack(spacing: 0) {
                    header
                    ScrollView { content.padding(24) }
                }
            }
        }
        .frame(minWidth: 1020, minHeight: 700)
        .preferredColorScheme(.dark)
        .onAppear { model.refresh() }
        .onReceive(timer) { _ in model.refresh() }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text("DEVSPACE")
                    .font(.system(size: 10, weight: .black, design: .monospaced))
                    .foregroundStyle(.cyan)
                Text("Tool")
                    .font(.system(size: 30, weight: .black, design: .rounded))
                Text(japanese ? "ローカル開発司令塔" : "Local development command center")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.45))
            }

            VStack(spacing: 7) {
                ForEach(AppSection.allCases) { item in
                    Button { withAnimation(.easeInOut(duration: 0.16)) { section = item } } label: {
                        HStack(spacing: 11) {
                            Image(systemName: item.icon).frame(width: 20)
                            Text(sectionTitle(item)).font(.system(size: 13, weight: .bold, design: .rounded))
                            Spacer()
                        }
                        .foregroundStyle(section == item ? .white : .white.opacity(0.52))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 11)
                        .background(RoundedRectangle(cornerRadius: 13).fill(section == item ? Color.cyan.opacity(0.16) : Color.white.opacity(0.025)))
                        .overlay(RoundedRectangle(cornerRadius: 13).stroke(section == item ? Color.cyan.opacity(0.38) : Color.clear, lineWidth: 1))
                    }.buttonStyle(.plain)
                }
            }

            Spacer()
            VStack(alignment: .leading, spacing: 9) {
                Text(japanese ? "API費用" : "API SPEND")
                    .font(.system(size: 9, weight: .black, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.38))
                sidebarCost(japanese ? "今日" : "TODAY", model.summary.today.cost.total)
                sidebarCost(japanese ? "7日" : "7 DAYS", model.summary.week.cost.total)
                sidebarCost(japanese ? "30日" : "30 DAYS", model.summary.month.cost.total)
                sidebarCost(japanese ? "全期間" : "TOTAL", model.summary.total.cost.total)
            }
            .padding(13)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.045)))
        }
        .padding(20)
        .frame(width: 230)
        .background(Color.black.opacity(0.22))
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(sectionTitle(section)).font(.system(size: 25, weight: .black, design: .rounded))
                Text(sectionSubtitle(section)).font(.system(size: 11, weight: .medium, design: .monospaced)).foregroundStyle(.white.opacity(0.42))
            }
            Spacer()
            HStack(spacing: 8) {
                Circle().fill(model.runtimeOnline ? .green : .red).frame(width: 8, height: 8)
                Text(model.runtimeOnline ? "ONLINE" : "OFFLINE").font(.system(size: 10, weight: .black, design: .monospaced))
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(GlassButtonStyle())
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 17)
        .background(Color.black.opacity(0.12))
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .overview: overview
        case .analytics: analytics
        case .runtime: runtime
        case .folders: folders
        case .settings: settings
        }
    }

    private var overview: some View {
        VStack(spacing: 16) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
                periodCard(japanese ? "今日" : "TODAY", model.summary.today, .cyan)
                periodCard(japanese ? "7日" : "7 DAYS", model.summary.week, .blue)
                periodCard(japanese ? "30日" : "30 DAYS", model.summary.month, .purple)
                periodCard(japanese ? "全期間" : "TOTAL", model.summary.total, .green)
            }
            HStack(spacing: 14) {
                statusCard(japanese ? "ランタイム" : "RUNTIME", model.runtimeOnline ? "ONLINE" : "OFFLINE", model.runtimeOnline)
                statusCard(japanese ? "ポート" : "PORT", "\(model.toolConfig.port)", model.runtimeOnline)
                statusCard(japanese ? "許可フォルダ" : "ROOTS", "\(model.roots.count)", !model.roots.isEmpty)
            }
            analyticsList(limit: 6)
        }
    }

    private var analytics: some View {
        VStack(alignment: .leading, spacing: 14) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
                periodCard(japanese ? "今日" : "TODAY", model.summary.today, .cyan)
                periodCard(japanese ? "7日" : "7 DAYS", model.summary.week, .blue)
                periodCard(japanese ? "30日" : "30 DAYS", model.summary.month, .purple)
                periodCard(japanese ? "全期間" : "TOTAL", model.summary.total, .green)
            }
            analyticsList(limit: nil)
        }
    }

    private var runtime: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                statusCard(japanese ? "状態" : "STATUS", model.runtimeOnline ? "ONLINE" : "OFFLINE", model.runtimeOnline)
                statusCard(japanese ? "ホスト" : "HOST", model.toolConfig.host, true)
                statusCard(japanese ? "ポート" : "PORT", "\(model.toolConfig.port)", true)
            }
            HStack(spacing: 10) {
                Button { model.startRuntime() } label: { Label(japanese ? "起動" : "Start", systemImage: "play.fill") }.buttonStyle(ActionButtonStyle(primary: true))
                Button { model.stopRuntime() } label: { Label(japanese ? "停止" : "Stop", systemImage: "stop.fill") }.buttonStyle(ActionButtonStyle(primary: false))
                Button { model.revealConfig() } label: { Label(japanese ? "設定を開く" : "Open config", systemImage: "doc.text") }.buttonStyle(ActionButtonStyle(primary: false))
            }
            Text(model.logText)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.58))
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(panelBackground)
        }
    }

    private var folders: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.roots.isEmpty {
                Text(japanese ? "許可フォルダがありません。~/.devspace/config.json を設定してください。" : "No allowed roots. Configure ~/.devspace/config.json.")
                    .foregroundStyle(.white.opacity(0.55))
            } else {
                ForEach(model.roots, id: \.self) { root in
                    HStack(spacing: 12) {
                        Image(systemName: "folder.fill").foregroundStyle(.cyan)
                        Text(root).font(.system(size: 11, weight: .semibold, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        Spacer()
                    }
                    .padding(13)
                    .background(panelBackground)
                }
            }
        }
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 9) {
                Text(japanese ? "言語" : "Language").font(.system(size: 14, weight: .bold))
                Picker("Language", selection: $languageRaw) {
                    Text(japanese ? "自動" : "Automatic").tag(AppLanguage.automatic.rawValue)
                    Text("English").tag(AppLanguage.english.rawValue)
                    Text("日本語").tag(AppLanguage.japanese.rawValue)
                }.pickerStyle(.segmented).frame(maxWidth: 440)
            }
            VStack(alignment: .leading, spacing: 9) {
                Text(japanese ? "設定ファイル" : "Configuration").font(.system(size: 14, weight: .bold))
                Text("~/.devspace/tool.json").font(.system(size: 12, design: .monospaced)).foregroundStyle(.cyan)
                Button { model.revealConfig() } label: { Label(japanese ? "Finderで表示" : "Reveal in Finder", systemImage: "folder") }.buttonStyle(ActionButtonStyle(primary: false))
            }
        }
        .padding(18)
        .background(panelBackground)
    }

    private func analyticsList(limit: Int?) -> some View {
        let rows = limit.map { Array(model.summary.folders.prefix($0)) } ?? model.summary.folders
        return VStack(alignment: .leading, spacing: 10) {
            Text(japanese ? "フォルダ別利用状況" : "Folder analytics").font(.system(size: 17, weight: .black, design: .rounded))
            if rows.isEmpty {
                Text(japanese ? "利用履歴がありません。" : "No usage history yet.").foregroundStyle(.white.opacity(0.5))
            } else {
                ForEach(rows) { folder in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(folder.name).font(.system(size: 13, weight: .bold))
                            Text(folder.path).font(.system(size: 9, design: .monospaced)).foregroundStyle(.white.opacity(0.38)).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(compactYen(folder.total.cost.total)).font(.system(size: 14, weight: .black, design: .monospaced)).foregroundStyle(.green)
                            Text("\(compactYen(folder.total.cost.input)) / \(compactYen(folder.total.cost.output))")
                                .font(.system(size: 9, weight: .semibold, design: .monospaced)).foregroundStyle(.white.opacity(0.4))
                        }
                    }
                    .padding(13)
                    .background(panelBackground)
                }
            }
        }
        .padding(16)
        .background(panelBackground)
    }

    private func periodCard(_ title: String, _ usage: PeriodUsage, _ accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 9, weight: .black, design: .monospaced)).foregroundStyle(accent)
            Text(compactYen(usage.cost.total)).font(.system(size: 23, weight: .black, design: .rounded))
            Text("\(compactYen(usage.cost.input)) / \(compactYen(usage.cost.output))")
                .font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(.white.opacity(0.42))
            Text("\(compactTokens(usage.tokens)) · \(usage.calls) calls")
                .font(.system(size: 9, weight: .medium, design: .monospaced)).foregroundStyle(.white.opacity(0.3))
        }
        .frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
        .padding(14)
        .background(panelBackground)
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(accent.opacity(0.22), lineWidth: 1))
    }

    private func statusCard(_ title: String, _ value: String, _ active: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 9, weight: .black, design: .monospaced)).foregroundStyle(.white.opacity(0.38))
            Text(value).font(.system(size: 20, weight: .black, design: .rounded)).foregroundStyle(active ? .white : .white.opacity(0.45))
        }
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .padding(14)
        .background(panelBackground)
    }

    private func sidebarCost(_ label: String, _ value: Double) -> some View {
        HStack { Text(label).foregroundStyle(.white.opacity(0.42)); Spacer(); Text(compactYen(value)).foregroundStyle(.white) }
            .font(.system(size: 10, weight: .bold, design: .monospaced))
    }

    private var panelBackground: some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(Color.white.opacity(0.055))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.08), lineWidth: 1))
    }

    private func sectionTitle(_ item: AppSection) -> String {
        switch item {
        case .overview: return japanese ? "概要" : "Overview"
        case .analytics: return japanese ? "分析" : "Analytics"
        case .runtime: return japanese ? "ランタイム" : "Runtime"
        case .folders: return japanese ? "フォルダ" : "Folders"
        case .settings: return japanese ? "設定" : "Settings"
        }
    }

    private func sectionSubtitle(_ item: AppSection) -> String {
        switch item {
        case .overview: return japanese ? "状態と費用を俯瞰" : "Runtime and cost at a glance"
        case .analytics: return japanese ? "期間・フォルダ別の利用分析" : "Usage by period and folder"
        case .runtime: return japanese ? "ローカルDevSpaceの制御" : "Control the local DevSpace runtime"
        case .folders: return japanese ? "許可されたワークスペース" : "Approved workspace roots"
        case .settings: return japanese ? "言語と接続設定" : "Language and connection settings"
        }
    }

    private func compactYen(_ value: Double) -> String {
        if value >= 100 { return String(format: "¥%.0f", value) }
        if value >= 1 { return String(format: "¥%.1f", value) }
        if value > 0 { return String(format: "¥%.2f", value) }
        return "¥0"
    }

    private func compactTokens(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.2fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
        return "\(value)"
    }
}

private struct GlassButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: 34, height: 34)
            .background(Circle().fill(Color.white.opacity(configuration.isPressed ? 0.05 : 0.1)))
            .foregroundStyle(.cyan)
    }
}

private struct ActionButtonStyle: ButtonStyle {
    let primary: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .bold))
            .padding(.horizontal, 15)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(primary ? Color.cyan.opacity(0.22) : Color.white.opacity(0.07)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(primary ? Color.cyan.opacity(0.4) : Color.white.opacity(0.1), lineWidth: 1))
            .foregroundStyle(.white)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

@main
private struct DevSpaceToolApp: App {
    var body: some Scene {
        WindowGroup { DevSpaceToolView() }
            .windowStyle(.hiddenTitleBar)
            .commands { CommandGroup(replacing: .newItem) {} }
    }
}
