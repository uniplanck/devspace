import SwiftUI
import Combine

struct DevSpaceToolView: View {
    @StateObject private var model = DevSpaceToolModel()

    @AppStorage("devspaceTool.language") private var languageRaw = AppLanguage.automatic.rawValue
    @AppStorage("devspaceTool.region") private var regionRaw = RegionPreset.automatic.rawValue
    @AppStorage("devspaceTool.timeZone") private var timeZoneRaw = TimeZonePreset.automatic.rawValue
    @AppStorage("devspaceTool.currency") private var currencyRaw = DisplayCurrency.jpy.rawValue
    @AppStorage("devspaceTool.weekMode") private var weekModeRaw = WeekMode.calendarWeek.rawValue
    @AppStorage("devspaceTool.weekStart") private var weekStartWeekday = 1
    @AppStorage("devspaceTool.dayBoundaryHour") private var dayBoundaryHour = 0
    @AppStorage("devspaceTool.monthMode") private var monthModeRaw = MonthMode.calendarMonth.rawValue
    @AppStorage("devspaceTool.yearMode") private var yearModeRaw = YearMode.calendarYear.rawValue
    @AppStorage("devspaceTool.analysisPeriod") private var selectedPeriodRaw = AnalysisPeriod.week.rawValue
    @AppStorage("devspaceTool.customStart") private var customStartTimestamp = Date().addingTimeInterval(-6 * 86_400).timeIntervalSince1970
    @AppStorage("devspaceTool.customEnd") private var customEndTimestamp = Date().timeIntervalSince1970
    @AppStorage("devspaceTool.pricingModelID") private var pricingModelID = "gpt-5.6-sol"
    @AppStorage("devspaceTool.pricingCatalogJSON") private var pricingCatalogJSON = ""
    @AppStorage("devspaceTool.inputUsdPerMillion") private var inputUsdPerMillion = 5.0
    @AppStorage("devspaceTool.outputUsdPerMillion") private var outputUsdPerMillion = 30.0
    @AppStorage("devspaceTool.usdJpyRate") private var usdJpyRate = 160.0
    @AppStorage("devspaceTool.usdEurRate") private var usdEurRate = 0.92
    @AppStorage("devspaceTool.usdGbpRate") private var usdGbpRate = 0.79
    @AppStorage("devspaceTool.autoPricingUpdate") private var autoPricingUpdate = true
    @AppStorage("devspaceTool.pricingLastUpdated") private var pricingLastUpdated = 0.0
    @AppStorage("devspaceTool.exchangeLastUpdated") private var exchangeLastUpdated = 0.0
    @AppStorage("devspaceTool.pricingRefreshStatus") private var pricingRefreshStatus = ""
    @AppStorage("devspaceTool.theme") private var themeRaw = AppTheme.aurora.rawValue
    @AppStorage("devspaceTool.sortMetric") private var sortMetricRaw = SortMetric.cost.rawValue
    @AppStorage("devspaceTool.autoRefreshSeconds") private var autoRefreshSeconds = 20
    @AppStorage("devspaceTool.defaultSection") private var defaultSectionRaw = AppSection.overview.rawValue
    @AppStorage("devspaceTool.hideUnknownFolders") private var hideUnknownFolders = false
    @AppStorage("devspaceTool.showCostSplit") private var showCostSplit = true
    @AppStorage("devspaceTool.compactNumbers") private var compactNumbers = true

    @State private var section: AppSection = .overview
    @State private var didApplyDefaultSection = false
    @State private var showingPathInput = false
    @State private var pathInput = ""
    @State private var pendingRootRemoval: String?
    @State private var pricingRefreshInProgress = false
    @State private var pricingRefreshMessage = ""

    private let timer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()
    private let settingsControlWidth: CGFloat = 420
    private let segmentedPickerWidth: CGFloat = 280

    private var language: AppLanguage { AppLanguage(rawValue: languageRaw) ?? .automatic }
    private var region: RegionPreset { RegionPreset(rawValue: regionRaw) ?? .automatic }
    private var timeZone: TimeZonePreset { TimeZonePreset(rawValue: timeZoneRaw) ?? .automatic }
    private var currency: DisplayCurrency { DisplayCurrency(rawValue: currencyRaw) ?? .jpy }
    private var weekMode: WeekMode { WeekMode(rawValue: weekModeRaw) ?? .calendarWeek }
    private var monthMode: MonthMode { MonthMode(rawValue: monthModeRaw) ?? .calendarMonth }
    private var yearMode: YearMode { YearMode(rawValue: yearModeRaw) ?? .calendarYear }
    private var selectedPeriod: AnalysisPeriod { AnalysisPeriod(rawValue: selectedPeriodRaw) ?? .week }
    private var theme: AppTheme { AppTheme(rawValue: themeRaw) ?? .aurora }
    private var sortMetric: SortMetric { SortMetric(rawValue: sortMetricRaw) ?? .cost }
    private var defaultSection: AppSection { AppSection(rawValue: defaultSectionRaw) ?? .overview }
    private var pricingModels: [ModelPricingProfile] {
        _ = pricingCatalogJSON
        return ModelPricingService.catalog(prefix: "devspaceTool")
    }
    private var selectedPricingProfile: ModelPricingProfile? {
        pricingModels.first { $0.id == pricingModelID }
    }

    private var japanese: Bool {
        switch language {
        case .japanese: return true
        case .english: return false
        case .automatic: return Locale.current.language.languageCode?.identifier == "ja"
        }
    }

    private var settings: AnalysisSettings {
        AnalysisSettings(
            region: region,
            timeZone: timeZone,
            currency: currency,
            weekMode: weekMode,
            weekStartWeekday: weekStartWeekday,
            dayBoundaryHour: dayBoundaryHour,
            monthMode: monthMode,
            yearMode: yearMode,
            selectedPeriod: selectedPeriod,
            customStart: Date(timeIntervalSince1970: customStartTimestamp),
            customEnd: Date(timeIntervalSince1970: customEndTimestamp),
            inputUsdPerMillion: inputUsdPerMillion,
            outputUsdPerMillion: outputUsdPerMillion,
            usdJpyRate: usdJpyRate,
            usdEurRate: usdEurRate,
            usdGbpRate: usdGbpRate,
            sortMetric: sortMetric,
            hideUnknownFolders: hideUnknownFolders
        )
    }

    private var palette: ToolPalette { ToolPalette(theme: theme) }

    var body: some View {
        ZStack {
            background
            HStack(spacing: 0) {
                sidebar
                Divider().overlay(palette.stroke)
                VStack(spacing: 0) {
                    header
                    ScrollView { content.padding(24) }
                    footerBar
                }
            }
        }
        .frame(minWidth: 1060, minHeight: 740)
        .preferredColorScheme(.dark)
        .onAppear {
            if !didApplyDefaultSection {
                section = defaultSection
                didApplyDefaultSection = true
            }
            model.refresh(settings: settings)
        }
        .onChange(of: settings) { _, newValue in
            model.refresh(settings: newValue)
        }
        .task {
            guard autoPricingUpdate else { return }
            await refreshPricing(force: false)
        }
        .onChange(of: autoPricingUpdate) { _, enabled in
            guard enabled else {
                pricingRefreshMessage = japanese ? "自動更新を停止しました" : "Automatic updates disabled"
                return
            }
            Task { await refreshPricing(force: true) }
        }
        .onChange(of: pricingModelID) { _, modelID in
            if ModelPricingService.applySelection(prefix: "devspaceTool", modelID: modelID) {
                pricingRefreshMessage = japanese
                    ? "料金計算の基準を\(modelID)へ変更しました"
                    : "Pricing basis changed to \(modelID)"
            } else if modelID == "custom" {
                pricingRefreshMessage = japanese ? "手動単価を使用します" : "Using manual pricing"
            }
        }
        .onReceive(timer) { _ in
            guard autoRefreshSeconds > 0,
                  Date().timeIntervalSince(model.lastUpdated) >= Double(autoRefreshSeconds) else { return }
            model.refresh(settings: settings)
        }
        .alert(
            japanese ? "許可フォルダを削除しますか？" : "Remove approved folder?",
            isPresented: Binding(
                get: { pendingRootRemoval != nil },
                set: { if !$0 { pendingRootRemoval = nil } }
            )
        ) {
            Button(japanese ? "キャンセル" : "Cancel", role: .cancel) {
                pendingRootRemoval = nil
            }
            Button(japanese ? "削除" : "Remove", role: .destructive) {
                if let root = pendingRootRemoval {
                    model.removeRoot(root, settings: settings, japanese: japanese)
                }
                pendingRootRemoval = nil
            }
        } message: {
            Text(pendingRootRemoval ?? "")
        }
    }

    @ViewBuilder private var background: some View {
        switch theme {
        case .aurora:
            DevSpaceFuturisticBackground()
        case .monochrome:
            LinearGradient(colors: [Color.black, Color(white: 0.08)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
        case .minimal:
            Color(white: 0.075).ignoresSafeArea()
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 11) {
                ZStack {
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .fill(LinearGradient(colors: [palette.accent.opacity(0.34), .purple.opacity(0.28)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    Image(systemName: "terminal.fill")
                        .font(.system(size: 20, weight: .black))
                        .foregroundStyle(.white)
                }
                .frame(width: 42, height: 42)
                .overlay(RoundedRectangle(cornerRadius: 13).stroke(Color.white.opacity(0.20), lineWidth: 1))

                VStack(alignment: .leading, spacing: 2) {
                    Text("DEVSPACE")
                        .font(.system(size: 14, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                    Text("CONTROL OS")
                        .font(.system(size: 8, weight: .black, design: .monospaced))
                        .tracking(1.6)
                        .foregroundStyle(palette.accent.opacity(0.72))
                }
            }
            .padding(.bottom, 22)

            VStack(spacing: 7) {
                ForEach(AppSection.allCases) { item in
                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) { section = item }
                    } label: {
                        HStack(spacing: 11) {
                            Image(systemName: item.icon)
                                .font(.system(size: 14, weight: .semibold))
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(sectionTitle(item))
                                    .font(.system(size: 13, weight: .bold, design: .rounded))
                                Text(sectionSidebarSubtitle(item))
                                    .font(.system(size: 8, weight: .medium, design: .monospaced))
                                    .foregroundStyle(section == item ? palette.primaryText.opacity(0.58) : palette.secondaryText.opacity(0.72))
                            }
                            Spacer()
                            if section == item {
                                Capsule().fill(palette.accent).frame(width: 3, height: 24)
                                    .shadow(color: palette.accent.opacity(0.75), radius: 5)
                            }
                        }
                        .foregroundStyle(section == item ? palette.primaryText : palette.secondaryText)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: theme == .minimal ? 8 : 13)
                                .fill(section == item ? palette.selection : palette.faintFill)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: theme == .minimal ? 8 : 13)
                                .stroke(section == item ? palette.accent.opacity(0.38) : Color.clear, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer(minLength: 18)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("API SPEND")
                        .font(.system(size: 8, weight: .black, design: .monospaced))
                        .tracking(1.2)
                        .foregroundStyle(palette.secondaryText)
                    Spacer()
                    Image(systemName: "waveform.path.ecg")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(palette.accent.opacity(0.72))
                }
                sidebarCost(periodTitle(.today), model.summary.today.cost.total)
                sidebarCost(periodTitle(.week), model.summary.week.cost.total)
                sidebarCost(periodTitle(.month), model.summary.month.cost.total)
                sidebarCost(japanese ? "全期間" : "TOTAL", model.summary.total.cost.total, emphasized: true)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(palette.accent.opacity(0.045)))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.accent.opacity(0.16), lineWidth: 1))
            .padding(.bottom, 12)

            HStack(spacing: 8) {
                Circle()
                    .fill(model.runtimeOnline ? Color.green : Color.red)
                    .frame(width: 8, height: 8)
                    .shadow(color: (model.runtimeOnline ? Color.green : Color.red).opacity(0.7), radius: 6)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.runtimeOnline ? "SYSTEM ONLINE" : "SYSTEM OFFLINE")
                        .font(.system(size: 9, weight: .black, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.78))
                    Text("\(model.roots.count) roots · port \(model.toolConfig.port)")
                        .font(.system(size: 8, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.36))
                }
                Spacer()
            }
            .padding(11)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.045)))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.08), lineWidth: 1))
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
        .padding(.bottom, 14)
        .frame(width: 244)
        .background(
            LinearGradient(
                colors: [Color.black.opacity(0.46), Color(red: 0.035, green: 0.055, blue: 0.085).opacity(0.82)],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(sectionTitle(section))
                    .font(.system(size: 28, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                Text(sectionSubtitle(section))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.44))
            }
            Spacer()
            Text(model.runtimeOnline ? "LIVE" : "OFFLINE")
                .font(.system(size: 9, weight: .black, design: .monospaced))
                .foregroundStyle(model.runtimeOnline ? .green : .red)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill((model.runtimeOnline ? Color.green : Color.red).opacity(0.10)))
                .overlay(Capsule().stroke((model.runtimeOnline ? Color.green : Color.red).opacity(0.22), lineWidth: 1))
            Button { model.refresh(settings: settings) } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 13, weight: .bold))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(GlassButtonStyle(palette: palette))
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 17)
        .background(palette.header)
    }

    private var footerBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    if model.runtimeOnline {
                        model.stopRuntime(settings: settings)
                    } else {
                        model.startRuntime(settings: settings)
                    }
                } label: {
                    Label(
                        model.runtimeOnline ? (japanese ? "停止" : "Turn OFF") : (japanese ? "起動" : "Turn ON"),
                        systemImage: model.runtimeOnline ? "stop.circle.fill" : "power.circle.fill"
                    )
                }
                .buttonStyle(DevSpacePrimaryButtonStyle(active: !model.runtimeOnline, palette: palette))

                Button { model.refresh(settings: settings) } label: {
                    Label(japanese ? "更新" : "Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(DevSpaceNeoButtonStyle(palette: palette))

                Button { model.revealConfig() } label: {
                    Label(japanese ? "詳細設定" : "Advanced", systemImage: "ellipsis.circle")
                }
                .buttonStyle(DevSpaceNeoButtonStyle(palette: palette))

                Spacer()
                Text(lastUpdatedText)
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
            }
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(palette.accent.opacity(0.74))
                Text(model.logText)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(1)
                    .textSelection(.enabled)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.045)))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.08), lineWidth: 1))
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 14)
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .overview: overview
        case .analytics: analytics
        case .runtime: runtime
        case .folders: folders
        case .settings: settingsView
        }
    }

    private var overview: some View {
        VStack(spacing: 14) {
            costTimelinePanel
            usageHealthPanel
            workspaceUsagePanel
        }
    }

    private var costTimelinePanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("API Cost Timeline")
                        .font(.system(size: 18, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                    Text("\(pricingModelID) standard API conversion · total with input/output split")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.42))
                }
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) { section = .settings }
                } label: {
                    Label(japanese ? "料金設定" : "Pricing settings", systemImage: "slider.horizontal.3")
                }
                .buttonStyle(DevSpaceNeoButtonStyle(palette: palette))
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) { section = .folders }
                } label: {
                    Label(japanese ? "フォルダ" : "Folders", systemImage: "chart.bar.xaxis")
                }
                .buttonStyle(DevSpaceNeoButtonStyle(palette: palette))
            }

            HStack(spacing: 10) {
                periodCard(periodTitle(.today), model.summary.today, .cyan)
                periodCard(periodTitle(.week), model.summary.week, .blue)
                periodCard(periodTitle(.month), model.summary.month, .purple)
                periodCard(japanese ? "全期間" : "TOTAL", model.summary.total, .green)
            }
        }
        .padding(16)
        .background(DevSpaceGlassPanel(palette: palette))
    }

    private var usageHealthPanel: some View {
        HStack(spacing: 10) {
            healthMiniCard(
                title: japanese ? "INPUT TODAY" : "INPUT TODAY",
                value: formatTokens(model.summary.today.inputTokens),
                detail: "\(model.summary.today.calls) calls · model input",
                accent: .green
            )
            healthMiniCard(
                title: japanese ? "OUTPUT TODAY" : "OUTPUT TODAY",
                value: formatTokens(model.summary.today.outputTokens),
                detail: "tool arguments generated",
                accent: .green
            )
            healthMiniCard(
                title: japanese ? "API COST TODAY" : "API COST TODAY",
                value: formatCurrency(model.summary.today.cost.total),
                detail: "\(formatCurrency(model.summary.today.cost.input)) / \(formatCurrency(model.summary.today.cost.output))",
                accent: .green
            )
            healthMiniCard(
                title: japanese ? "AVG COST / CALL" : "AVG COST / CALL",
                value: formatCurrency(model.summary.today.averageCostPerCall),
                detail: pricingModelID,
                accent: palette.accent
            )
        }
    }

    private var workspaceUsagePanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(japanese ? "Workspace Usage" : "Workspace Usage")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                        Text("\(model.summary.folders.count) WORKSPACES · \(model.summary.selected.calls) CALLS")
                            .font(.system(size: 9, weight: .black, design: .monospaced))
                            .foregroundStyle(model.summary.selected.calls > 0 ? .green : .white.opacity(0.42))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Capsule().fill((model.summary.selected.calls > 0 ? Color.green : Color.white).opacity(0.10)))
                    }
                    Text(japanese ? "選択期間のフォルダ別token・API費用" : "Tokens and API cost by workspace for the selected period")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.54))
                }
                Spacer()
                Text(periodTitle(selectedPeriod))
                    .font(.system(size: 8, weight: .black, design: .monospaced))
                    .foregroundStyle(palette.accent)
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) { section = .analytics }
                } label: {
                    Label(japanese ? "詳細" : "Details", systemImage: "arrow.up.right")
                }
                .buttonStyle(DevSpaceNeoButtonStyle(palette: palette))
            }

            if model.summary.folders.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "folder.badge.questionmark")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(palette.accent.opacity(0.62))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(japanese ? "利用履歴はまだありません" : "No workspace usage reported yet")
                            .font(.system(size: 14, weight: .bold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.82))
                        Text(japanese ? "DevSpaceのtool call履歴がフォルダ別に表示されます。" : "DevSpace tool-call history will appear here, grouped by workspace.")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.46))
                    }
                    Spacer()
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.035)))
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(model.summary.folders.prefix(6)) { folder in
                        workspaceUsageRow(folder)
                    }
                }
            }
        }
        .padding(16)
        .background(DevSpaceGlassPanel(palette: palette))
    }

    private var analytics: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                Text(japanese ? "分析期間" : "Analysis period")
                    .font(.system(size: 15, weight: .bold))
                Picker("Period", selection: $selectedPeriodRaw) {
                    ForEach(AnalysisPeriod.allCases) { period in
                        Text(periodTitle(period)).tag(period.rawValue)
                    }
                }
                .pickerStyle(.segmented)

                if selectedPeriod == .custom {
                    HStack(spacing: 18) {
                        DatePicker(japanese ? "開始日" : "Start", selection: customStartBinding, displayedComponents: .date)
                        DatePicker(japanese ? "終了日" : "End", selection: customEndBinding, displayedComponents: .date)
                    }
                }
                Text(selectedRangeText)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
            }
            .padding(16)
            .background(panelBackground)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
                metricCard(japanese ? "費用" : "COST", formatCurrency(model.summary.selected.cost.total), palette.accent)
                metricCard(japanese ? "トークン" : "TOKENS", formatTokens(model.summary.selected.tokens), palette.primaryText)
                metricCard(japanese ? "呼び出し" : "CALLS", "\(model.summary.selected.calls)", palette.primaryText)
                metricCard(japanese ? "平均費用/回" : "AVG COST/CALL", formatCurrency(model.summary.selected.averageCostPerCall), palette.primaryText)
            }

            dailyTrend
            analyticsList(limit: nil)
        }
    }

    private var selectedRangeSummary: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(japanese ? "現在の分析期間" : "CURRENT ANALYSIS RANGE")
                    .font(.system(size: 9, weight: .black, design: .monospaced))
                    .foregroundStyle(palette.accent)
                Text(periodTitle(selectedPeriod))
                    .font(.system(size: 18, weight: .bold))
                Text(selectedRangeText)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(formatCurrency(model.summary.selected.cost.total)).font(.system(size: 23, weight: .black))
                Text("\(formatTokens(model.summary.selected.tokens)) · \(model.summary.selected.calls) calls")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
            }
        }
        .padding(16)
        .background(panelBackground)
    }

    private var dailyTrend: some View {
        let rows = Array(model.summary.daily.suffix(21))
        let maximum = max(rows.map(\.usage.cost.total).max() ?? 0, 0.000_001)
        return VStack(alignment: .leading, spacing: 11) {
            Text(japanese ? "日別推移（最大21日）" : "Daily trend (up to 21 days)")
                .font(.system(size: 17, weight: .black, design: theme == .minimal ? .default : .rounded))
            if rows.isEmpty {
                Text(japanese ? "対象期間に利用履歴がありません。" : "No usage in this period.")
                    .foregroundStyle(palette.secondaryText)
            } else {
                ForEach(rows) { row in
                    HStack(spacing: 10) {
                        Text(shortDate(row.date)).frame(width: 58, alignment: .leading)
                        GeometryReader { proxy in
                            RoundedRectangle(cornerRadius: 3)
                                .fill(palette.accent.opacity(0.72))
                                .frame(width: max(2, proxy.size.width * row.usage.cost.total / maximum))
                        }
                        .frame(height: 8)
                        Text(formatCurrency(row.usage.cost.total)).frame(width: 78, alignment: .trailing)
                    }
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                }
            }
        }
        .padding(16)
        .background(panelBackground)
    }

    private var runtime: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                statusCard(japanese ? "状態" : "STATUS", model.runtimeOnline ? "ONLINE" : "OFFLINE", model.runtimeOnline)
                statusCard(japanese ? "ホスト" : "HOST", model.toolConfig.host, true)
                statusCard(japanese ? "ポート" : "PORT", "\(model.toolConfig.port)", true)
            }
            HStack(spacing: 10) {
                Button { model.startRuntime(settings: settings) } label: {
                    Label(japanese ? "起動" : "Start", systemImage: "play.fill")
                }.buttonStyle(ActionButtonStyle(primary: true, palette: palette))
                Button { model.stopRuntime(settings: settings) } label: {
                    Label(japanese ? "停止" : "Stop", systemImage: "stop.fill")
                }.buttonStyle(ActionButtonStyle(primary: false, palette: palette))
                Button { model.revealConfig() } label: {
                    Label(japanese ? "設定ファイル" : "Config file", systemImage: "doc.text")
                }.buttonStyle(ActionButtonStyle(primary: false, palette: palette))
            }
            Text(model.logText)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(palette.secondaryText)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(panelBackground)
        }
    }

    private var folders: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(japanese ? "許可フォルダ" : "Approved folders")
                        .font(.system(size: 18, weight: .black, design: theme == .minimal ? .default : .rounded))
                    Text(japanese
                         ? "登録したフォルダと、その配下すべてにDevSpaceからアクセスできます。必要な範囲だけを追加してください。"
                         : "DevSpace can access each approved folder and everything below it. Add only the directories you need.")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(palette.secondaryText)
                }
                Spacer()
                HStack(spacing: 9) {
                    Button {
                        model.chooseFolderAndAdd(settings: settings, japanese: japanese)
                    } label: {
                        Label(japanese ? "Finderから追加" : "Add from Finder", systemImage: "folder.badge.plus")
                    }
                    .buttonStyle(ActionButtonStyle(primary: true, palette: palette))

                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) {
                            showingPathInput.toggle()
                        }
                    } label: {
                        Label(japanese ? "パスで追加" : "Add path", systemImage: "terminal")
                    }
                    .buttonStyle(ActionButtonStyle(primary: false, palette: palette))
                }
            }
            .padding(16)
            .background(panelBackground)

            if showingPathInput {
                HStack(spacing: 10) {
                    TextField(japanese ? "/Users/.../Project" : "/Users/.../Project", text: $pathInput)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .onSubmit {
                            model.addRoot(pathInput, settings: settings, japanese: japanese)
                            pathInput = ""
                        }
                    Button(japanese ? "追加" : "Add") {
                        model.addRoot(pathInput, settings: settings, japanese: japanese)
                        pathInput = ""
                    }
                    .buttonStyle(ActionButtonStyle(primary: true, palette: palette))
                    Button(japanese ? "閉じる" : "Close") {
                        pathInput = ""
                        withAnimation(.easeInOut(duration: 0.16)) { showingPathInput = false }
                    }
                    .buttonStyle(ActionButtonStyle(primary: false, palette: palette))
                }
                .padding(14)
                .background(panelBackground)
            }

            if model.roots.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(palette.accent)
                    Text(japanese ? "許可フォルダはまだありません" : "No approved folders yet")
                        .font(.system(size: 15, weight: .bold))
                    Text(japanese
                         ? "Finderから作業対象のプロジェクトフォルダを追加してください。ホームフォルダ全体や秘密情報を含む場所は追加しないでください。"
                         : "Add a specific project folder from Finder. Do not approve your entire home folder or directories containing secrets.")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(palette.secondaryText)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 560)
                }
                .frame(maxWidth: .infinity, minHeight: 210)
                .padding(20)
                .background(panelBackground)
            } else {
                VStack(spacing: 9) {
                    ForEach(model.roots, id: \.self) { root in
                        HStack(spacing: 12) {
                            Image(systemName: "folder.fill")
                                .foregroundStyle(palette.accent)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(URL(fileURLWithPath: root).lastPathComponent)
                                    .font(.system(size: 13, weight: .bold))
                                Text(root)
                                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                                    .foregroundStyle(palette.secondaryText)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer()
                            Button {
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: root)])
                            } label: {
                                Image(systemName: "arrow.forward.circle")
                            }
                            .buttonStyle(GlassButtonStyle(palette: palette))
                            .help(japanese ? "Finderで表示" : "Reveal in Finder")

                            Button {
                                pendingRootRemoval = root
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(GlassButtonStyle(palette: palette))
                            .help(japanese ? "許可から削除" : "Remove approval")
                        }
                        .padding(13)
                        .background(panelBackground)
                    }
                }
            }

            Text(model.logText)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundStyle(palette.secondaryText)
                .textSelection(.enabled)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(panelBackground)
        }
    }

    private var pricingBasisPanel: some View {
        settingPanel(japanese ? "料金計算の基準" : "Pricing basis") {
            settingRow(japanese ? "基準モデル" : "Reference model") {
                Picker("Pricing model", selection: $pricingModelID) {
                    ForEach(pricingModels) { profile in
                        Text(profile.displayName).tag(profile.id)
                    }
                }
                .pickerStyle(.menu)
                .fixedSize()
            }
            if let selectedPricingProfile {
                settingRow(japanese ? "標準単価" : "Standard rates") {
                    Text(String(format: "$%.4g input / $%.4g output", selectedPricingProfile.inputUsdPerMillion, selectedPricingProfile.outputUsdPerMillion))
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(palette.accent.opacity(0.86))
                }
            }
            toggleSettingRow(
                japanese ? "公式単価・為替を毎日自動更新" : "Update official pricing and exchange rates daily",
                isOn: $autoPricingUpdate
            )
            settingRow(japanese ? "更新状況" : "Update status") {
                HStack(spacing: 10) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(pricingRefreshSummary)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.74))
                        if !pricingRefreshDetail.isEmpty {
                            Text(pricingRefreshDetail)
                                .font(.system(size: 9, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.40))
                                .lineLimit(2)
                        }
                    }
                    Button {
                        Task { await refreshPricing(force: true) }
                    } label: {
                        if pricingRefreshInProgress {
                            ProgressView().controlSize(.small)
                        } else {
                            Label(japanese ? "今すぐ更新" : "Update now", systemImage: "arrow.clockwise")
                        }
                    }
                    .buttonStyle(DevSpaceNeoButtonStyle(palette: palette))
                    .disabled(pricingRefreshInProgress)
                }
            }
            Text(japanese
                 ? "このモデルは料金換算だけに使用します。DevSpaceの実行モデル自体は変更しません。"
                 : "This model is used only for cost conversion and does not change the DevSpace runtime model.")
                .font(.system(size: 10))
                .foregroundStyle(palette.secondaryText)
        }
    }

    private var settingsView: some View {
        VStack(alignment: .leading, spacing: 14) {
            pricingBasisPanel
            settingPanel(japanese ? "言語・地域" : "Language & region") {
                settingRow(japanese ? "言語" : "Language") {
                    trailingSegmented(
                        selection: $languageRaw,
                        options: [
                            (AppLanguage.automatic.rawValue, japanese ? "自動" : "Automatic"),
                            (AppLanguage.english.rawValue, "English"),
                            (AppLanguage.japanese.rawValue, "日本語")
                        ],
                        width: segmentedPickerWidth
                    )
                }
                settingRow(japanese ? "地域形式" : "Regional format") {
                    Picker("Region", selection: $regionRaw) {
                        ForEach(RegionPreset.allCases) { value in Text(regionName(value)).tag(value.rawValue) }
                    }
                    .pickerStyle(.menu)
                    .fixedSize()
                }
                settingRow(japanese ? "集計タイムゾーン" : "Aggregation time zone") {
                    Picker("Time zone", selection: $timeZoneRaw) {
                        ForEach(TimeZonePreset.allCases) { value in Text(timeZoneName(value)).tag(value.rawValue) }
                    }
                    .pickerStyle(.menu)
                    .fixedSize()
                }
                settingRow(japanese ? "表示通貨" : "Display currency") {
                    trailingSegmented(
                        selection: $currencyRaw,
                        options: DisplayCurrency.allCases.map { ($0.rawValue, $0.rawValue) },
                        width: 240
                    )
                }
            }

            settingPanel(japanese ? "期間の基準" : "Period rules") {
                settingRow(japanese ? "1週間" : "One week") {
                    trailingSegmented(
                        selection: $weekModeRaw,
                        options: [
                            (WeekMode.rollingSevenDays.rawValue, japanese ? "今日を含む7日" : "Rolling 7 days"),
                            (WeekMode.calendarWeek.rawValue, japanese ? "曜日起点" : "Calendar week")
                        ],
                        width: segmentedPickerWidth
                    )
                }
                if weekMode == .calendarWeek {
                    settingRow(japanese ? "週の開始曜日" : "Week starts on") {
                        Picker("Weekday", selection: $weekStartWeekday) {
                            ForEach(1...7, id: \.self) { weekday in Text(weekdayName(weekday)).tag(weekday) }
                        }
                        .pickerStyle(.menu)
                        .fixedSize()
                    }
                }
                settingRow(japanese ? "日の切替時刻" : "Day boundary") {
                    VStack(alignment: .trailing, spacing: 3) {
                        HStack(spacing: 8) {
                            Button {
                                dayBoundaryHour = (dayBoundaryHour + 23) % 24
                            } label: {
                                Image(systemName: "minus")
                                    .frame(width: 24, height: 22)
                            }
                            Text(String(format: "%02d:00", dayBoundaryHour))
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .frame(width: 64, alignment: .center)
                            Button {
                                dayBoundaryHour = (dayBoundaryHour + 1) % 24
                            } label: {
                                Image(systemName: "plus")
                                    .frame(width: 24, height: 22)
                            }
                        }
                        .buttonStyle(.bordered)
                        Text(japanese ? "この時刻から新しい日として集計" : "A new usage day starts at this time")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(palette.secondaryText)
                    }
                    .frame(width: 240, alignment: .trailing)
                }
                settingRow(japanese ? "1か月" : "One month") {
                    trailingSegmented(
                        selection: $monthModeRaw,
                        options: [
                            (MonthMode.rollingThirtyDays.rawValue, japanese ? "今日を含む30日" : "Rolling 30 days"),
                            (MonthMode.calendarMonth.rawValue, japanese ? "毎月1日起点" : "Calendar month")
                        ],
                        width: 290
                    )
                }
                settingRow(japanese ? "1年" : "One year") {
                    trailingSegmented(
                        selection: $yearModeRaw,
                        options: [
                            (YearMode.rollingThreeSixtyFiveDays.rawValue, japanese ? "今日を含む365日" : "Rolling 365 days"),
                            (YearMode.calendarYear.rawValue, japanese ? "1月1日起点" : "Calendar year")
                        ],
                        width: 290
                    )
                }
            }

            settingPanel(japanese ? "料金計算" : "Pricing") {
                numericSettingRow(japanese ? "入力 / 100万token (USD)" : "Input / 1M tokens (USD)", value: $inputUsdPerMillion, placeholder: "5")
                    .disabled(autoPricingUpdate && pricingModelID != "custom")
                    .opacity(autoPricingUpdate && pricingModelID != "custom" ? 0.60 : 1)
                numericSettingRow(japanese ? "出力 / 100万token (USD)" : "Output / 1M tokens (USD)", value: $outputUsdPerMillion, placeholder: "30")
                    .disabled(autoPricingUpdate && pricingModelID != "custom")
                    .opacity(autoPricingUpdate && pricingModelID != "custom" ? 0.60 : 1)
                numericSettingRow("USD / JPY", value: $usdJpyRate, placeholder: "160")
                    .disabled(autoPricingUpdate)
                    .opacity(autoPricingUpdate ? 0.60 : 1)
                numericSettingRow("USD / EUR", value: $usdEurRate, placeholder: "0.92")
                    .disabled(autoPricingUpdate)
                    .opacity(autoPricingUpdate ? 0.60 : 1)
                numericSettingRow("USD / GBP", value: $usdGbpRate, placeholder: "0.79")
                    .disabled(autoPricingUpdate)
                    .opacity(autoPricingUpdate ? 0.60 : 1)
                Text(japanese
                     ? "選択したモデルは料金換算だけに使われ、DevSpaceが実際に使用するモデルは変更しません。OpenAI公式ページからGPT-5系モデルを自動検出し、ECBの為替を24時間ごとに取得します。"
                     : "The selected model is used only for cost conversion and does not change the model used by DevSpace. GPT-5 family models are discovered from the official OpenAI pricing page, and ECB exchange rates refresh every 24 hours.")
                    .font(.system(size: 10))
                    .foregroundStyle(palette.secondaryText)
            }

            settingPanel(japanese ? "表示" : "Appearance") {
                settingRow(japanese ? "デザイン" : "Design") {
                    trailingSegmented(
                        selection: $themeRaw,
                        options: [
                            (AppTheme.aurora.rawValue, japanese ? "オーロラ" : "Aurora"),
                            (AppTheme.monochrome.rawValue, japanese ? "モノクロ" : "Monochrome"),
                            (AppTheme.minimal.rawValue, japanese ? "シンプル" : "Minimal")
                        ],
                        width: segmentedPickerWidth
                    )
                }
                toggleSettingRow(japanese ? "入力・出力費用の内訳を表示" : "Show input/output cost split", isOn: $showCostSplit)
                toggleSettingRow(japanese ? "数値をK/M形式で短縮" : "Use compact K/M numbers", isOn: $compactNumbers)
            }

            settingPanel(japanese ? "動作" : "Behavior") {
                settingRow(japanese ? "自動更新" : "Auto refresh") {
                    Picker("Refresh", selection: $autoRefreshSeconds) {
                        Text(japanese ? "オフ" : "Off").tag(0)
                        Text("10 sec").tag(10)
                        Text("20 sec").tag(20)
                        Text("1 min").tag(60)
                        Text("5 min").tag(300)
                    }
                    .pickerStyle(.menu)
                    .fixedSize()
                }
                settingRow(japanese ? "起動時の画面" : "Default screen") {
                    Picker("Default screen", selection: $defaultSectionRaw) {
                        ForEach(AppSection.allCases) { value in Text(sectionTitle(value)).tag(value.rawValue) }
                    }
                    .pickerStyle(.menu)
                    .fixedSize()
                }
                settingRow(japanese ? "フォルダ並び順" : "Folder sort") {
                    trailingSegmented(
                        selection: $sortMetricRaw,
                        options: [
                            (SortMetric.cost.rawValue, japanese ? "費用" : "Cost"),
                            (SortMetric.tokens.rawValue, "Token"),
                            (SortMetric.calls.rawValue, japanese ? "呼び出し数" : "Calls")
                        ],
                        width: 260
                    )
                }
                toggleSettingRow(japanese ? "所属不明の履歴を非表示" : "Hide unknown workspace history", isOn: $hideUnknownFolders)
            }

            settingPanel(japanese ? "詳細設定" : "Advanced") {
                Text("~/.devspace/tool.json").font(.system(size: 12, design: .monospaced)).foregroundStyle(palette.accent)
                Button { model.revealConfig() } label: {
                    Label(japanese ? "Finderで表示" : "Reveal in Finder", systemImage: "folder")
                }.buttonStyle(ActionButtonStyle(primary: false, palette: palette))
            }
        }
    }

    private func healthMiniCard(title: String, value: String, detail: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Circle().fill(accent).frame(width: 7, height: 7)
                Text(title)
                    .font(.system(size: 8, weight: .black, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.48))
            }
            Text(value)
                .font(.system(size: 17, weight: .black, design: .rounded))
                .foregroundStyle(.white)
            Text(detail)
                .font(.system(size: 8, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.36))
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.white.opacity(0.055)))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(palette.accent.opacity(0.16), lineWidth: 1))
    }

    private func workspaceUsageRow(_ folder: FolderUsage) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(palette.accent.opacity(0.09))
                Image(systemName: "folder.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(palette.accent.opacity(0.82))
            }
            .frame(width: 34, height: 34)

            VStack(alignment: .leading, spacing: 3) {
                Text(folder.name)
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.88))
                Text(folder.path)
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.36))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(formatCurrency(folder.usage.cost.total))
                    .font(.system(size: 14, weight: .black, design: .monospaced))
                    .foregroundStyle(palette.accent)
                Text("\(formatTokens(folder.usage.tokens)) · \(folder.usage.calls) calls")
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.38))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.04)))
    }

    private func analyticsList(limit: Int?) -> some View {
        let rows = limit.map { Array(model.summary.folders.prefix($0)) } ?? model.summary.folders
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(japanese ? "フォルダ別利用状況" : "Folder analytics")
                    .font(.system(size: 17, weight: .black, design: theme == .minimal ? .default : .rounded))
                Spacer()
                Text(periodTitle(selectedPeriod)).font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(palette.accent)
            }
            if rows.isEmpty {
                Text(japanese ? "対象期間に利用履歴がありません。" : "No usage history in this period.")
                    .foregroundStyle(palette.secondaryText)
            } else {
                ForEach(rows) { folder in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(folder.name).font(.system(size: 13, weight: .bold))
                            Text(folder.path).font(.system(size: 9, design: .monospaced)).foregroundStyle(palette.secondaryText).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(formatCurrency(folder.usage.cost.total))
                                .font(.system(size: 14, weight: .black, design: .monospaced))
                                .foregroundStyle(palette.accent)
                            Text("\(formatTokens(folder.usage.tokens)) · \(folder.usage.calls) calls")
                                .font(.system(size: 9, weight: .semibold, design: .monospaced)).foregroundStyle(palette.secondaryText)
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
            HStack {
                Text(title.uppercased())
                    .font(.system(size: 9, weight: .black, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.45))
                Spacer()
                Circle()
                    .fill(accent)
                    .frame(width: 6, height: 6)
                    .shadow(color: accent.opacity(0.75), radius: 5)
            }
            Text(formatCurrency(usage.cost.total))
                .font(.system(size: 23, weight: .black, design: .rounded))
                .foregroundStyle(.white)
            if showCostSplit {
                Text("\(formatCurrency(usage.cost.input)) / \(formatCurrency(usage.cost.output))")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(accent.opacity(0.80))
            }
            Text("\(formatTokens(usage.tokens)) · \(usage.calls) calls")
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.30))
        }
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(LinearGradient(colors: [accent.opacity(0.10), Color.white.opacity(0.045)], startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(accent.opacity(0.24), lineWidth: 1))
    }

    private func metricCard(_ title: String, _ value: String, _ accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 9, weight: .black, design: .monospaced)).foregroundStyle(palette.secondaryText)
            Text(value).font(.system(size: 20, weight: .black, design: theme == .minimal ? .default : .rounded)).foregroundStyle(accent)
        }
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .padding(14)
        .background(panelBackground)
    }

    private func statusCard(_ title: String, _ value: String, _ active: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 9, weight: .black, design: .monospaced)).foregroundStyle(palette.secondaryText)
            Text(value).font(.system(size: 20, weight: .black, design: theme == .minimal ? .default : .rounded))
                .foregroundStyle(active ? palette.primaryText : palette.secondaryText)
        }
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .padding(14)
        .background(panelBackground)
    }

    private var pricingRefreshSummary: String {
        if pricingRefreshInProgress { return japanese ? "更新中…" : "Updating…" }
        if pricingLastUpdated <= 0 && exchangeLastUpdated <= 0 {
            return japanese ? "未更新" : "Not updated"
        }
        if pricingLastUpdated > 0 && exchangeLastUpdated > 0 {
            return japanese ? "自動更新済み" : "Automatically updated"
        }
        return japanese ? "一部更新済み" : "Partially updated"
    }

    private var pricingRefreshDetail: String {
        if !pricingRefreshMessage.isEmpty { return pricingRefreshMessage }
        var parts: [String] = []
        if pricingLastUpdated > 0 { parts.append("OpenAI \(formatUpdateDate(pricingLastUpdated))") }
        if exchangeLastUpdated > 0 { parts.append("ECB \(formatUpdateDate(exchangeLastUpdated))") }
        if !pricingRefreshStatus.isEmpty { parts.append(pricingRefreshStatus) }
        return parts.joined(separator: " · ")
    }

    @MainActor
    private func refreshPricing(force: Bool) async {
        guard !pricingRefreshInProgress else { return }
        pricingRefreshInProgress = true
        defer { pricingRefreshInProgress = false }

        let result = await ModelPricingService.shared.refresh(
            prefix: "devspaceTool",
            selectedModelID: pricingModelID,
            force: force
        )
        if result.skipped {
            pricingRefreshMessage = japanese ? "24時間以内に更新済みです" : "Already updated within the last 24 hours"
        } else if result.pricingUpdated && result.exchangeUpdated {
            pricingRefreshMessage = japanese ? "公式単価・モデル一覧・為替を更新しました" : "Official pricing, model catalog, and exchange rates updated"
        } else if result.updatedAnything {
            pricingRefreshMessage = japanese ? "一部を更新しました。失敗した値は前回値を維持しています" : "Partially updated; failed values retained their previous values"
        } else {
            pricingRefreshMessage = japanese ? "更新に失敗しました。前回値を維持しています" : "Update failed; previous values retained"
        }
    }

    private func formatUpdateDate(_ timestamp: Double) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: japanese ? "ja_JP" : "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = japanese ? "M/d HH:mm" : "MMM d HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: timestamp))
    }

    private func settingPanel<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(title).font(.system(size: 17, weight: .black, design: theme == .minimal ? .default : .rounded))
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(panelBackground)
    }

    private func trailingSegmented(
        selection: Binding<String>,
        options: [(String, String)],
        width: CGFloat
    ) -> some View {
        HStack(spacing: 1) {
            ForEach(options.indices, id: \.self) { index in
                let option = options[index]
                let selected = selection.wrappedValue == option.0
                Button {
                    selection.wrappedValue = option.0
                } label: {
                    Text(option.1)
                        .font(.system(size: 11, weight: selected ? .bold : .semibold))
                        .foregroundStyle(selected ? Color.white : Color.white.opacity(0.82))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, minHeight: 24)
                        .padding(.horizontal, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .fill(selected ? Color.red.opacity(0.88) : Color.clear)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .frame(width: width, height: 28)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color.white.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(Color.white.opacity(0.72), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func settingRow<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: 24) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                content()
                    .labelsHidden()
            }
            .frame(width: settingsControlWidth, alignment: .trailing)
        }
        .frame(maxWidth: .infinity)
    }

    private func numericSettingRow(_ title: String, value: Binding<Double>, placeholder: String) -> some View {
        settingRow(title) {
            TextField(placeholder, value: value, format: .number.precision(.fractionLength(0...4)))
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.trailing)
                .frame(width: 160)
        }
    }

    private func toggleSettingRow(_ title: String, isOn: Binding<Bool>) -> some View {
        settingRow(title) {
            Toggle("", isOn: isOn)
                .labelsHidden()
        }
    }

    private func sidebarCost(_ label: String, _ value: Double, emphasized: Bool = false) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(emphasized ? .white.opacity(0.60) : palette.secondaryText)
            Spacer()
            Text(formatCurrency(value))
                .foregroundStyle(emphasized ? Color.green : palette.primaryText)
        }
        .font(.system(size: 10, weight: emphasized ? .black : .bold, design: .monospaced))
    }

    private var panelBackground: some View {
        RoundedRectangle(cornerRadius: palette.cornerRadius, style: .continuous)
            .fill(palette.panel)
            .overlay(RoundedRectangle(cornerRadius: palette.cornerRadius).stroke(palette.stroke, lineWidth: 1))
    }

    private var customStartBinding: Binding<Date> {
        Binding(
            get: { Date(timeIntervalSince1970: customStartTimestamp) },
            set: { customStartTimestamp = $0.timeIntervalSince1970 }
        )
    }

    private var customEndBinding: Binding<Date> {
        Binding(
            get: { Date(timeIntervalSince1970: customEndTimestamp) },
            set: { customEndTimestamp = $0.timeIntervalSince1970 }
        )
    }

    private func accent(_ index: Int) -> Color {
        guard theme == .aurora else { return palette.accent }
        switch index {
        case 1: return .blue
        case 2: return .purple
        case 3: return .green
        default: return .cyan
        }
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

    private func sectionSidebarSubtitle(_ item: AppSection) -> String {
        switch item {
        case .overview: return japanese ? "ライブ司令塔" : "Live command center"
        case .analytics: return japanese ? "token・期間・API費用" : "Tokens, periods, API cost"
        case .runtime: return japanese ? "起動・停止と接続" : "Runtime and connection"
        case .folders: return japanese ? "許可範囲の管理" : "Approved access roots"
        case .settings: return japanese ? "集計・料金・表示" : "Period, pricing, appearance"
        }
    }

    private func sectionSubtitle(_ item: AppSection) -> String {
        switch item {
        case .overview: return japanese ? "状態・token・費用を俯瞰" : "Runtime, tokens, and cost at a glance"
        case .analytics: return japanese ? "期間・日別・フォルダ別の利用分析" : "Usage by period, day, and folder"
        case .runtime: return japanese ? "ローカルDevSpaceの制御" : "Control the local DevSpace runtime"
        case .folders: return japanese ? "許可されたワークスペース" : "Approved workspace roots"
        case .settings: return japanese ? "集計基準・料金・表示・動作" : "Period, pricing, appearance, and behavior"
        }
    }

    private func periodTitle(_ period: AnalysisPeriod) -> String {
        switch period {
        case .today: return japanese ? "今日" : "Today"
        case .week:
            if weekMode == .rollingSevenDays { return japanese ? "直近7日" : "Last 7 days" }
            return japanese ? "今週" : "This week"
        case .month:
            if monthMode == .rollingThirtyDays { return japanese ? "直近30日" : "Last 30 days" }
            return japanese ? "今月" : "This month"
        case .year:
            if yearMode == .rollingThreeSixtyFiveDays { return japanese ? "直近365日" : "Last 365 days" }
            return japanese ? "今年" : "This year"
        case .custom: return japanese ? "指定期間" : "Custom"
        case .all: return japanese ? "全期間" : "All time"
        }
    }

    private var selectedRangeText: String {
        guard let interval = model.summary.selectedRange else { return japanese ? "記録されている全期間" : "All recorded history" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: region.localeIdentifier)
        formatter.timeZone = timeZone.timeZone
        formatter.dateFormat = japanese ? "yyyy/MM/dd HH:mm" : "MMM d, yyyy HH:mm"
        return "\(formatter.string(from: interval.start)) – \(formatter.string(from: interval.end.addingTimeInterval(-0.001)))"
    }

    private var lastUpdatedText: String {
        guard model.lastUpdated != .distantPast else { return "" }
        let formatter = DateFormatter()
        formatter.timeZone = timeZone.timeZone
        formatter.dateFormat = "HH:mm:ss"
        return "UPDATED \(formatter.string(from: model.lastUpdated))"
    }

    private func shortDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: region.localeIdentifier)
        formatter.timeZone = timeZone.timeZone
        formatter.dateFormat = japanese ? "M/d" : "MMM d"
        return formatter.string(from: date)
    }

    private func formatCurrency(_ value: Double) -> String {
        let symbol: String
        switch currency {
        case .jpy: symbol = "¥"
        case .usd: symbol = "$"
        case .eur: symbol = "€"
        case .gbp: symbol = "£"
        }
        if compactNumbers {
            if abs(value) >= 1_000_000 { return String(format: "%@%.2fM", symbol, value / 1_000_000) }
            if abs(value) >= 1_000 { return String(format: "%@%.1fK", symbol, value / 1_000) }
        }
        if currency == .jpy && abs(value) >= 10 { return String(format: "%@%.0f", symbol, value) }
        if abs(value) >= 100 { return String(format: "%@%.0f", symbol, value) }
        if abs(value) >= 1 { return String(format: "%@%.2f", symbol, value) }
        if value > 0 { return String(format: "%@%.4f", symbol, value) }
        return "\(symbol)0"
    }

    private func formatTokens(_ value: Int) -> String {
        guard compactNumbers else { return value.formatted() }
        if value >= 1_000_000 { return String(format: "%.2fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fK", Double(value) / 1_000) }
        return "\(value)"
    }

    private func weekdayName(_ weekday: Int) -> String {
        let ja = ["", "日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"]
        let en = ["", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return japanese ? ja[max(1, min(7, weekday))] : en[max(1, min(7, weekday))]
    }

    private func regionName(_ value: RegionPreset) -> String {
        switch value {
        case .automatic: return japanese ? "システム設定" : "System default"
        case .japan: return japanese ? "日本" : "Japan"
        case .unitedStates: return japanese ? "米国" : "United States"
        case .unitedKingdom: return japanese ? "英国" : "United Kingdom"
        case .europe: return japanese ? "欧州" : "Europe"
        }
    }

    private func timeZoneName(_ value: TimeZonePreset) -> String {
        switch value {
        case .automatic: return japanese ? "システム設定" : "System default"
        case .tokyo: return "Tokyo (JST)"
        case .utc: return "UTC"
        case .newYork: return "New York (ET)"
        case .losAngeles: return "Los Angeles (PT)"
        case .london: return "London"
        case .paris: return "Paris (CET/CEST)"
        }
    }
}

struct ToolPalette {
    let theme: AppTheme

    var accent: Color {
        switch theme {
        case .aurora: return .cyan
        case .monochrome: return .white
        case .minimal: return Color(white: 0.78)
        }
    }
    var primaryText: Color { .white }
    var secondaryText: Color { .white.opacity(theme == .minimal ? 0.62 : 0.48) }
    var tertiaryText: Color { .white.opacity(0.30) }
    var panel: Color { .white.opacity(theme == .minimal ? 0.045 : 0.060) }
    var stroke: Color { .white.opacity(theme == .minimal ? 0.07 : 0.10) }
    var faintFill: Color { .white.opacity(theme == .minimal ? 0.015 : 0.025) }
    var selection: Color { accent.opacity(theme == .monochrome ? 0.10 : 0.16) }
    var sidebar: Color { .black.opacity(theme == .minimal ? 0.10 : 0.24) }
    var header: Color { .black.opacity(theme == .minimal ? 0.08 : 0.14) }
    var cornerRadius: CGFloat { theme == .minimal ? 8 : 18 }
}

struct DevSpaceFuturisticBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.02, green: 0.03, blue: 0.08),
                    Color(red: 0.02, green: 0.07, blue: 0.13),
                    Color(red: 0.07, green: 0.04, blue: 0.12)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Circle()
                .fill(.cyan.opacity(0.16))
                .blur(radius: 70)
                .frame(width: 320, height: 320)
                .offset(x: -300, y: -230)
            Circle()
                .fill(.purple.opacity(0.16))
                .blur(radius: 90)
                .frame(width: 360, height: 360)
                .offset(x: 310, y: 240)
            Circle()
                .stroke(.white.opacity(0.04), lineWidth: 1)
                .frame(width: 720, height: 720)
                .offset(x: 260, y: -220)
        }
        .ignoresSafeArea()
    }
}

struct DevSpaceGlassPanel: View {
    let palette: ToolPalette

    var body: some View {
        RoundedRectangle(cornerRadius: 28, style: .continuous)
            .fill(Color.white.opacity(0.07))
            .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [palette.accent.opacity(0.40), .white.opacity(0.12), .purple.opacity(0.32)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            )
            .shadow(color: palette.accent.opacity(0.08), radius: 24, x: 0, y: 12)
    }
}

struct DevSpaceNeoButtonStyle: ButtonStyle {
    let palette: ToolPalette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .foregroundStyle(.white.opacity(configuration.isPressed ? 0.70 : 0.90))
            .background(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.06 : 0.10))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(Color.white.opacity(configuration.isPressed ? 0.10 : 0.16), lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

struct DevSpacePrimaryButtonStyle: ButtonStyle {
    let active: Bool
    let palette: ToolPalette

    func makeBody(configuration: Configuration) -> some View {
        let tint = active ? palette.accent : Color.red
        configuration.label
            .font(.system(size: 11, weight: .black, design: .rounded))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .foregroundStyle(.white)
            .background(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(tint.opacity(configuration.isPressed ? 0.20 : 0.28))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(tint.opacity(0.56), lineWidth: 1)
            )
            .shadow(color: tint.opacity(0.14), radius: 10, x: 0, y: 5)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

struct GlassButtonStyle: ButtonStyle {
    let palette: ToolPalette
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: 34, height: 34)
            .background(Circle().fill(Color.white.opacity(configuration.isPressed ? 0.05 : 0.10)))
            .foregroundStyle(palette.accent)
    }
}

struct ActionButtonStyle: ButtonStyle {
    let primary: Bool
    let palette: ToolPalette
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .bold))
            .padding(.horizontal, 15)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: palette.theme == .minimal ? 7 : 12)
                    .fill(primary ? palette.accent.opacity(0.20) : Color.white.opacity(0.07))
            )
            .overlay(
                RoundedRectangle(cornerRadius: palette.theme == .minimal ? 7 : 12)
                    .stroke(primary ? palette.accent.opacity(0.42) : palette.stroke, lineWidth: 1)
            )
            .foregroundStyle(.white)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}
