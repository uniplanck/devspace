import SwiftUI
import AppKit
import Foundation

let devSpaceConfigPath = "~/.devspace/config.json"
let devSpaceToolConfigPath = "~/.devspace/tool.json"
let usageHistoryPath = "~/.local/share/devspace/usage-history.jsonl"

enum AppLanguage: String, CaseIterable, Identifiable {
    case automatic, english, japanese
    var id: String { rawValue }
}

enum RegionPreset: String, CaseIterable, Identifiable {
    case automatic, japan, unitedStates, unitedKingdom, europe
    var id: String { rawValue }

    var localeIdentifier: String {
        switch self {
        case .automatic: return Locale.current.identifier
        case .japan: return "ja_JP"
        case .unitedStates: return "en_US"
        case .unitedKingdom: return "en_GB"
        case .europe: return "en_IE"
        }
    }
}

enum TimeZonePreset: String, CaseIterable, Identifiable {
    case automatic, tokyo, utc, newYork, losAngeles, london, paris
    var id: String { rawValue }

    var timeZone: TimeZone {
        let identifier: String
        switch self {
        case .automatic: return .current
        case .tokyo: identifier = "Asia/Tokyo"
        case .utc: identifier = "UTC"
        case .newYork: identifier = "America/New_York"
        case .losAngeles: identifier = "America/Los_Angeles"
        case .london: identifier = "Europe/London"
        case .paris: identifier = "Europe/Paris"
        }
        return TimeZone(identifier: identifier) ?? .current
    }
}

enum DisplayCurrency: String, CaseIterable, Identifiable {
    case jpy = "JPY"
    case usd = "USD"
    case eur = "EUR"
    case gbp = "GBP"
    var id: String { rawValue }
}

enum WeekMode: String, CaseIterable, Identifiable {
    case rollingSevenDays, calendarWeek
    var id: String { rawValue }
}

enum MonthMode: String, CaseIterable, Identifiable {
    case rollingThirtyDays, calendarMonth
    var id: String { rawValue }
}

enum YearMode: String, CaseIterable, Identifiable {
    case rollingThreeSixtyFiveDays, calendarYear
    var id: String { rawValue }
}

enum AnalysisPeriod: String, CaseIterable, Identifiable {
    case today, week, month, year, custom, all
    var id: String { rawValue }
}

enum AppTheme: String, CaseIterable, Identifiable {
    case aurora, monochrome, minimal
    var id: String { rawValue }
}

enum SortMetric: String, CaseIterable, Identifiable {
    case cost, tokens, calls
    var id: String { rawValue }
}

enum AppSection: String, CaseIterable, Identifiable {
    case overview, analytics, runtime, folders, settings
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

struct AnalysisSettings: Equatable {
    var region: RegionPreset
    var timeZone: TimeZonePreset
    var currency: DisplayCurrency
    var weekMode: WeekMode
    var weekStartWeekday: Int
    var dayBoundaryHour: Int
    var monthMode: MonthMode
    var yearMode: YearMode
    var selectedPeriod: AnalysisPeriod
    var customStart: Date
    var customEnd: Date
    var inputUsdPerMillion: Double
    var outputUsdPerMillion: Double
    var usdJpyRate: Double
    var usdEurRate: Double
    var usdGbpRate: Double
    var sortMetric: SortMetric
    var hideUnknownFolders: Bool

    var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: region.localeIdentifier)
        calendar.timeZone = timeZone.timeZone
        return calendar
    }

    var currencyRate: Double {
        switch currency {
        case .usd: return 1
        case .jpy: return max(0, usdJpyRate)
        case .eur: return max(0, usdEurRate)
        case .gbp: return max(0, usdGbpRate)
        }
    }
}

struct ToolConfig: Codable {
    var host: String = "127.0.0.1"
    var port: Int = 7676
    var runtimeCommand: String = ""
    var runtimeProcessMatch: String = ""
    var usdJpyRate: Double = 160

    init(
        host: String = "127.0.0.1",
        port: Int = 7676,
        runtimeCommand: String = "",
        runtimeProcessMatch: String = "",
        usdJpyRate: Double = 160
    ) {
        self.host = host
        self.port = port
        self.runtimeCommand = runtimeCommand
        self.runtimeProcessMatch = runtimeProcessMatch
        self.usdJpyRate = usdJpyRate
    }

    enum CodingKeys: String, CodingKey {
        case host, port, runtimeCommand, runtimeProcessMatch, usdJpyRate
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        host = try container.decodeIfPresent(String.self, forKey: .host) ?? "127.0.0.1"
        port = try container.decodeIfPresent(Int.self, forKey: .port) ?? 7676
        runtimeCommand = try container.decodeIfPresent(String.self, forKey: .runtimeCommand) ?? ""
        runtimeProcessMatch = try container.decodeIfPresent(String.self, forKey: .runtimeProcessMatch) ?? ""
        usdJpyRate = try container.decodeIfPresent(Double.self, forKey: .usdJpyRate) ?? 160
    }
}

struct DevSpaceConfig: Codable {
    var host: String?
    var port: Int?
    var allowedRoots: [String]?
}

struct CostBreakdown: Hashable {
    var input: Double = 0
    var output: Double = 0
    var total: Double { input + output }

    mutating func add(_ other: CostBreakdown) {
        input += other.input
        output += other.output
    }
}

struct PeriodUsage: Hashable {
    var tokens: Int = 0
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var calls: Int = 0
    var cost = CostBreakdown()
    var averageCostPerCall: Double { calls > 0 ? cost.total / Double(calls) : 0 }

    mutating func add(tokens: Int, inputTokens: Int = 0, outputTokens: Int = 0, cost: CostBreakdown) {
        self.tokens += tokens
        self.inputTokens += inputTokens
        self.outputTokens += outputTokens
        calls += 1
        self.cost.add(cost)
    }

    mutating func add(_ other: PeriodUsage) {
        tokens += other.tokens
        inputTokens += other.inputTokens
        outputTokens += other.outputTokens
        calls += other.calls
        cost.add(other.cost)
    }
}

struct UsageEvent: Hashable {
    let date: Date
    let workspaceRoot: String
    let workspaceName: String
    let modelID: String?
    let inputTokens: Double
    let outputTokens: Double
}

struct FolderUsage: Identifiable, Hashable {
    let id: String
    let name: String
    let path: String
    var usage = PeriodUsage()
}

struct DailyUsage: Identifiable, Hashable {
    let date: Date
    var usage: PeriodUsage
    var id: Date { date }
}

struct UsageSummary: Hashable {
    var today = PeriodUsage()
    var week = PeriodUsage()
    var month = PeriodUsage()
    var year = PeriodUsage()
    var custom = PeriodUsage()
    var total = PeriodUsage()
    var selected = PeriodUsage()
    var folders: [FolderUsage] = []
    var daily: [DailyUsage] = []
    var selectedRange: DateInterval?
}

@MainActor
final class DevSpaceToolModel: ObservableObject {
    @Published var summary = UsageSummary()
    @Published var roots: [String] = []
    @Published var runtimeOnline = false
    @Published var logText = "Ready"
    @Published var lastUpdated = Date.distantPast

    var toolConfig = ToolConfig()

    func refresh(settings: AnalysisSettings) {
        if ProcessInfo.processInfo.environment["DEVSPACE_TOOL_DEMO"] == "1" {
            toolConfig = ToolConfig(host: "127.0.0.1", port: 7676, runtimeCommand: "", runtimeProcessMatch: "")
            roots = ["/Users/demo/Projects", "/Users/demo/Automation", "/Users/demo/Web"]
            runtimeOnline = true
            summary = Self.demoSummary(settings: settings, now: Date())
            logText = "Demo data · no local paths or credentials are displayed."
            lastUpdated = Date()
            return
        }

        toolConfig = Self.readToolConfig()
        let devConfig = Self.readDevSpaceConfig()
        if let host = devConfig.host, !host.isEmpty { toolConfig.host = host }
        if let port = devConfig.port, port > 0 { toolConfig.port = port }
        roots = devConfig.allowedRoots ?? []
        runtimeOnline = Self.portIsListening(toolConfig.port)
        summary = Self.makeSummary(events: Self.readUsageEvents(), settings: settings, now: Date())
        lastUpdated = Date()
    }

    func startRuntime(settings: AnalysisSettings) {
        let command = toolConfig.runtimeCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            logText = "Set runtimeCommand in ~/.devspace/tool.json first."
            return
        }
        let result = Self.shell("/usr/bin/nohup /bin/zsh -lc \(Self.shellQuote(command)) >/tmp/devspace-tool-runtime.log 2>&1 &")
        logText = result.isEmpty ? "Runtime start requested." : result
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.refresh(settings: settings) }
    }

    func stopRuntime(settings: AnalysisSettings) {
        let match = toolConfig.runtimeProcessMatch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !match.isEmpty else {
            logText = "Set runtimeProcessMatch in ~/.devspace/tool.json first."
            return
        }
        _ = Self.shell("/usr/bin/pkill -f -- \(Self.shellQuote(match))")
        logText = "Runtime stop requested."
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.refresh(settings: settings) }
    }

    func chooseFolderAndAdd(settings: AnalysisSettings, japanese: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.message = japanese
            ? "DevSpaceからアクセスを許可するフォルダを選択してください"
            : "Choose a folder that DevSpace may access"
        panel.prompt = japanese ? "追加" : "Add"
        if panel.runModal() == .OK, let url = panel.url {
            addRoot(url.path, settings: settings, japanese: japanese)
        }
    }

    func addRoot(_ rawPath: String, settings: AnalysisSettings, japanese: Bool) {
        let normalized = Self.normalizedPath(rawPath)
        guard !normalized.isEmpty else {
            logText = japanese ? "フォルダのパスを入力してください。" : "Enter a folder path."
            return
        }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: normalized, isDirectory: &isDirectory), isDirectory.boolValue else {
            logText = japanese ? "フォルダが存在しません:\n\(normalized)" : "Folder does not exist:\n\(normalized)"
            return
        }

        let currentRoots = Self.compactRoots(roots)
        if let parent = currentRoots.first(where: { Self.isSameOrDescendant(normalized, of: $0) }) {
            logText = japanese
                ? "すでに次の許可フォルダに含まれています:\n\(parent)"
                : "Already covered by this approved root:\n\(parent)"
            return
        }

        let removedChildren = currentRoots.filter { Self.isSameOrDescendant($0, of: normalized) }
        let updatedRoots = Self.compactRoots(currentRoots + [normalized])
        do {
            let backup = try Self.writeAllowedRoots(updatedRoots)
            roots = updatedRoots
            var message = japanese ? "許可フォルダを追加しました:\n\(normalized)" : "Approved root added:\n\(normalized)"
            if !removedChildren.isEmpty {
                message += japanese
                    ? "\n\n親フォルダに統合したため、次の子フォルダ設定を整理しました:\n" + removedChildren.joined(separator: "\n")
                    : "\n\nCollapsed child roots now covered by the parent:\n" + removedChildren.joined(separator: "\n")
            }
            if let backup {
                message += japanese ? "\n\nバックアップ: \(backup.path)" : "\n\nBackup: \(backup.path)"
            }
            finishRootChange(message: message, settings: settings, japanese: japanese)
        } catch {
            logText = japanese ? "設定の保存に失敗しました:\n\(error.localizedDescription)" : "Failed to save configuration:\n\(error.localizedDescription)"
        }
    }

    func removeRoot(_ root: String, settings: AnalysisSettings, japanese: Bool) {
        let normalized = Self.normalizedPath(root)
        guard roots.contains(where: { Self.normalizedPath($0) == normalized }) else {
            logText = japanese ? "対象の許可フォルダが見つかりません。" : "The approved root was not found."
            return
        }
        let updatedRoots = Self.compactRoots(roots.filter { Self.normalizedPath($0) != normalized })

        do {
            let backup = try Self.writeAllowedRoots(updatedRoots)
            roots = updatedRoots
            var message = japanese ? "許可フォルダを削除しました:\n\(normalized)" : "Approved root removed:\n\(normalized)"
            if let backup {
                message += japanese ? "\n\nバックアップ: \(backup.path)" : "\n\nBackup: \(backup.path)"
            }
            finishRootChange(message: message, settings: settings, japanese: japanese)
        } catch {
            logText = japanese ? "設定の保存に失敗しました:\n\(error.localizedDescription)" : "Failed to save configuration:\n\(error.localizedDescription)"
        }
    }

    private func finishRootChange(message: String, settings: AnalysisSettings, japanese: Bool) {
        let wasOnline = runtimeOnline || Self.portIsListening(toolConfig.port)
        guard wasOnline else {
            logText = message + (japanese ? "\n\n次回起動時に反映されます。" : "\n\nThe change will apply on the next start.")
            refresh(settings: settings)
            return
        }

        let command = toolConfig.runtimeCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let match = toolConfig.runtimeProcessMatch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty, !match.isEmpty else {
            logText = message + (japanese
                ? "\n\nDevSpaceは稼働中です。設定を反映するには再起動してください。"
                : "\n\nDevSpace is running. Restart it to apply the updated roots.")
            refresh(settings: settings)
            return
        }

        _ = Self.shell("/usr/bin/pkill -f -- \(Self.shellQuote(match))")
        Thread.sleep(forTimeInterval: 0.4)
        let result = Self.shell("/usr/bin/nohup /bin/zsh -lc \(Self.shellQuote(command)) >/tmp/devspace-tool-runtime.log 2>&1 &")
        logText = message
            + (japanese ? "\n\nDevSpaceを再起動して反映しました。" : "\n\nDevSpace was restarted with the updated roots.")
            + (result.isEmpty ? "" : "\n\n\(result)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.refresh(settings: settings) }
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

    static func demoSummary(settings: AnalysisSettings, now: Date) -> UsageSummary {
        let calendar = settings.calendar
        let today = businessDayStart(for: now, settings: settings)
        let demoRows: [(String, String, Int, Int, Int, Int)] = [
            ("Atlas Web", "/Users/demo/Projects/atlas-web", 241_000, 52_000, 431, 0),
            ("Board Manager", "/Users/demo/Projects/board-manager", 116_000, 28_000, 186, 0),
            ("Automation Core", "/Users/demo/Automation/core", 83_000, 19_000, 124, -1),
            ("Commerce API", "/Users/demo/Projects/commerce-api", 58_000, 15_000, 91, -2),
            ("Design System", "/Users/demo/Web/design-system", 39_000, 11_000, 68, -3),
            ("Docs", "/Users/demo/Projects/docs", 22_000, 7_000, 37, -4)
        ]
        var events: [UsageEvent] = []
        for row in demoRows {
            let (name, path, input, output, calls, dayOffset) = row
            let baseDate = calendar.date(byAdding: .day, value: dayOffset, to: today) ?? today
            let callCount = max(1, calls)
            let inputPerCall = Double(input) / Double(callCount)
            let outputPerCall = Double(output) / Double(callCount)
            for index in 0..<callCount {
                let seconds = Double(8 * 60 * 60 + index % (10 * 60 * 60))
                events.append(
                    UsageEvent(
                        date: baseDate.addingTimeInterval(seconds),
                        workspaceRoot: path,
                        workspaceName: name,
                        modelID: nil,
                        inputTokens: inputPerCall,
                        outputTokens: outputPerCall
                    )
                )
            }
        }
        return makeSummary(events: events, settings: settings, now: now)
    }

    static func makeSummary(events: [UsageEvent], settings: AnalysisSettings, now: Date) -> UsageSummary {
        var summary = UsageSummary()
        let todayRange = range(for: .today, now: now, settings: settings)
        let weekRange = range(for: .week, now: now, settings: settings)
        let monthRange = range(for: .month, now: now, settings: settings)
        let yearRange = range(for: .year, now: now, settings: settings)
        let customRange = range(for: .custom, now: now, settings: settings)
        let selectedRange = range(for: settings.selectedPeriod, now: now, settings: settings)
        summary.selectedRange = selectedRange

        var folders: [String: FolderUsage] = [:]
        var daily: [Date: PeriodUsage] = [:]

        for event in events {
            let usage = usage(for: event, settings: settings)
            summary.total.add(usage)
            if contains(event.date, in: todayRange) { summary.today.add(usage) }
            if contains(event.date, in: weekRange) { summary.week.add(usage) }
            if contains(event.date, in: monthRange) { summary.month.add(usage) }
            if contains(event.date, in: yearRange) { summary.year.add(usage) }
            if contains(event.date, in: customRange) { summary.custom.add(usage) }

            let selected = settings.selectedPeriod == .all || contains(event.date, in: selectedRange)
            guard selected else { continue }
            summary.selected.add(usage)

            let unknown = event.workspaceRoot == "legacy:unknown"
            if !(settings.hideUnknownFolders && unknown) {
                var folder = folders[event.workspaceRoot] ?? FolderUsage(
                    id: event.workspaceRoot,
                    name: event.workspaceName,
                    path: event.workspaceRoot
                )
                folder.usage.add(usage)
                folders[event.workspaceRoot] = folder
            }

            let day = businessDayStart(for: event.date, settings: settings)
            var dayUsage = daily[day] ?? PeriodUsage()
            dayUsage.add(usage)
            daily[day] = dayUsage
        }

        summary.folders = folders.values.sorted { left, right in
            switch settings.sortMetric {
            case .cost:
                if left.usage.cost.total == right.usage.cost.total { return left.name < right.name }
                return left.usage.cost.total > right.usage.cost.total
            case .tokens:
                if left.usage.tokens == right.usage.tokens { return left.name < right.name }
                return left.usage.tokens > right.usage.tokens
            case .calls:
                if left.usage.calls == right.usage.calls { return left.name < right.name }
                return left.usage.calls > right.usage.calls
            }
        }
        summary.daily = daily.map { DailyUsage(date: $0.key, usage: $0.value) }
            .sorted { $0.date < $1.date }
            .suffix(90)
            .map { $0 }
        return summary
    }

    static func range(for period: AnalysisPeriod, now: Date, settings: AnalysisSettings) -> DateInterval? {
        let calendar = settings.calendar
        let currentBoundary = businessDayStart(for: now, settings: settings)
        let endNow = now.addingTimeInterval(0.001)

        switch period {
        case .today:
            return DateInterval(start: currentBoundary, end: endNow)
        case .week:
            if settings.weekMode == .rollingSevenDays {
                let start = calendar.date(byAdding: .day, value: -6, to: currentBoundary) ?? currentBoundary
                return DateInterval(start: start, end: endNow)
            }
            let weekday = calendar.component(.weekday, from: currentBoundary)
            let delta = (weekday - max(1, min(7, settings.weekStartWeekday)) + 7) % 7
            let start = calendar.date(byAdding: .day, value: -delta, to: currentBoundary) ?? currentBoundary
            return DateInterval(start: start, end: endNow)
        case .month:
            if settings.monthMode == .rollingThirtyDays {
                let start = calendar.date(byAdding: .day, value: -29, to: currentBoundary) ?? currentBoundary
                return DateInterval(start: start, end: endNow)
            }
            let components = calendar.dateComponents([.year, .month], from: currentBoundary)
            var startComponents = DateComponents()
            startComponents.year = components.year
            startComponents.month = components.month
            startComponents.day = 1
            startComponents.hour = max(0, min(23, settings.dayBoundaryHour))
            let start = calendar.date(from: startComponents) ?? currentBoundary
            return DateInterval(start: start, end: endNow)
        case .year:
            if settings.yearMode == .rollingThreeSixtyFiveDays {
                let start = calendar.date(byAdding: .day, value: -364, to: currentBoundary) ?? currentBoundary
                return DateInterval(start: start, end: endNow)
            }
            let year = calendar.component(.year, from: currentBoundary)
            var startComponents = DateComponents()
            startComponents.year = year
            startComponents.month = 1
            startComponents.day = 1
            startComponents.hour = max(0, min(23, settings.dayBoundaryHour))
            let start = calendar.date(from: startComponents) ?? currentBoundary
            return DateInterval(start: start, end: endNow)
        case .custom:
            var start = boundaryForSelectedDate(settings.customStart, settings: settings)
            var endStart = boundaryForSelectedDate(settings.customEnd, settings: settings)
            if endStart < start { swap(&start, &endStart) }
            let end = calendar.date(byAdding: .day, value: 1, to: endStart) ?? endStart.addingTimeInterval(86_400)
            return DateInterval(start: start, end: end)
        case .all:
            return nil
        }
    }

    static func businessDayStart(for date: Date, settings: AnalysisSettings) -> Date {
        let calendar = settings.calendar
        let hour = max(0, min(23, settings.dayBoundaryHour))
        let startOfDay = calendar.startOfDay(for: date)
        let candidate = calendar.date(byAdding: .hour, value: hour, to: startOfDay) ?? startOfDay
        if date < candidate {
            return calendar.date(byAdding: .day, value: -1, to: candidate) ?? candidate
        }
        return candidate
    }

    private static func boundaryForSelectedDate(_ date: Date, settings: AnalysisSettings) -> Date {
        let calendar = settings.calendar
        let start = calendar.startOfDay(for: date)
        return calendar.date(byAdding: .hour, value: max(0, min(23, settings.dayBoundaryHour)), to: start) ?? start
    }

    private static func contains(_ date: Date, in interval: DateInterval?) -> Bool {
        guard let interval else { return false }
        return date >= interval.start && date < interval.end
    }

    private static func usage(for event: UsageEvent, settings: AnalysisSettings) -> PeriodUsage {
        let eventProfile = event.modelID.flatMap { ModelPricingService.profile(prefix: "devspaceTool", modelID: $0) }
        let inputRate = eventProfile?.inputUsdPerMillion ?? settings.inputUsdPerMillion
        let outputRate = eventProfile?.outputUsdPerMillion ?? settings.outputUsdPerMillion
        let inputUsd = event.inputTokens * max(0, inputRate) / 1_000_000
        let outputUsd = event.outputTokens * max(0, outputRate) / 1_000_000
        let cost = CostBreakdown(
            input: inputUsd * settings.currencyRate,
            output: outputUsd * settings.currencyRate
        )
        var usage = PeriodUsage()
        usage.add(
            tokens: max(0, Int(event.inputTokens + event.outputTokens)),
            inputTokens: max(0, Int(event.inputTokens)),
            outputTokens: max(0, Int(event.outputTokens)),
            cost: cost
        )
        return usage
    }

    private static func readUsageEvents() -> [UsageEvent] {
        let path = (usageHistoryPath as NSString).expandingTildeInPath
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let text = String(data: data, encoding: .utf8) else { return [] }

        let isoFraction = ISO8601DateFormatter()
        isoFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        var events: [UsageEvent] = []

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let lineData = String(rawLine).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                  let timestamp = object["ts"] as? String,
                  let date = isoFraction.date(from: timestamp) ?? iso.date(from: timestamp) else { continue }

            let pair = modelTokenPair(object)
            let root = ((object["workspaceRoot"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let normalizedRoot = root.isEmpty || root == "unknown" ? "legacy:unknown" : root
            let fallbackName = normalizedRoot == "legacy:unknown" ? "Unknown" : URL(fileURLWithPath: normalizedRoot).lastPathComponent
            let rawName = ((object["workspaceName"] as? String) ?? fallbackName).trimmingCharacters(in: .whitespacesAndNewlines)
            let name = rawName.isEmpty ? fallbackName : rawName
            let modelID = ["model", "modelId", "modelID", "modelName"]
                .compactMap { object[$0] as? String }
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .first { !$0.isEmpty }
            events.append(UsageEvent(
                date: date,
                workspaceRoot: normalizedRoot,
                workspaceName: name,
                modelID: modelID,
                inputTokens: max(0, pair.input),
                outputTokens: max(0, pair.output)
            ))
        }
        return events
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

    private static func normalizedPath(_ rawPath: String) -> String {
        let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let expanded = (trimmed as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .path
    }

    private static func isSameOrDescendant(_ path: String, of parent: String) -> Bool {
        let candidatePath = normalizedPath(path)
        let parentPath = normalizedPath(parent)
        guard !candidatePath.isEmpty, !parentPath.isEmpty else { return false }
        if candidatePath == parentPath { return true }
        return candidatePath.hasPrefix(parentPath.hasSuffix("/") ? parentPath : parentPath + "/")
    }

    private static func compactRoots(_ rawRoots: [String]) -> [String] {
        var roots: [String] = []
        for rawRoot in rawRoots {
            let root = normalizedPath(rawRoot)
            guard !root.isEmpty else { continue }
            if roots.contains(where: { isSameOrDescendant(root, of: $0) }) { continue }
            roots.removeAll { isSameOrDescendant($0, of: root) }
            roots.append(root)
        }
        return roots
    }

    @discardableResult
    private static func writeAllowedRoots(_ roots: [String]) throws -> URL? {
        let configURL = URL(fileURLWithPath: (devSpaceConfigPath as NSString).expandingTildeInPath)
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        var object: [String: Any] = [:]
        if fileManager.fileExists(atPath: configURL.path) {
            let existingData = try Data(contentsOf: configURL)
            guard let existingObject = try JSONSerialization.jsonObject(with: existingData) as? [String: Any] else {
                throw NSError(
                    domain: "DevSpaceTool.Config",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "~/.devspace/config.json is not a JSON object"]
                )
            }
            object = existingObject
        }

        var backupURL: URL?
        if fileManager.fileExists(atPath: configURL.path) {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyyMMdd_HHmmss_SSS"
            let candidate = configURL.deletingLastPathComponent()
                .appendingPathComponent("config.json.bak.\(formatter.string(from: Date()))")
            try fileManager.copyItem(at: configURL, to: candidate)
            backupURL = candidate
        }

        object["allowedRoots"] = compactRoots(roots)
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: configURL, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
        return backupURL
    }

    private static func portIsListening(_ port: Int) -> Bool {
        !shell("/usr/sbin/lsof -nP -iTCP:\(port) -sTCP:LISTEN 2>/dev/null").isEmpty
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

extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
