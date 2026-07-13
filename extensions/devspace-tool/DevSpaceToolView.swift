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
    @AppStorage("devspaceTool.inputUsdPerMillion") private var inputUsdPerMillion = 5.0
    @AppStorage("devspaceTool.outputUsdPerMillion") private var outputUsdPerMillion = 30.0
    @AppStorage("devspaceTool.usdJpyRate") private var usdJpyRate = 160.0
    @AppStorage("devspaceTool.usdEurRate") private var usdEurRate = 0.92
    @AppStorage("devspaceTool.usdGbpRate") private var usdGbpRate = 0.79
    @AppStorage("devspaceTool.theme") private var themeRaw = AppTheme.aurora.rawValue
    @AppStorage("devspaceTool.sortMetric") private var sortMetricRaw = SortMetric.cost.rawValue
    @AppStorage("devspaceTool.autoRefreshSeconds") private var autoRefreshSeconds = 20
    @AppStorage("devspaceTool.defaultSection") private var defaultSectionRaw = AppSection.overview.rawValue
    @AppStorage("devspaceTool.hideUnknownFolders") private var hideUnknownFolders = false
    @AppStorage("devspaceTool.showCostSplit") private var showCostSplit = true
    @AppStorage("devspaceTool.compactNumbers") private var compactNumbers = true

    @State private var section: AppSection = .overview
    @State private var didApplyDefaultSection = false

    private let timer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

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
        .onReceive(timer) { _ in
            guard autoRefreshSeconds > 0,
                  Date().timeIntervalSince(model.lastUpdated) >= Double(autoRefreshSeconds) else { return }
            model.refresh(settings: settings)
        }
    }

    @ViewBuilder private var background: some View {
        switch theme {
        case .aurora:
            LinearGradient(
                colors: [Color(red: 0.025, green: 0.04, blue: 0.08), Color(red: 0.045, green: 0.025, blue: 0.09)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ).ignoresSafeArea()
        case .monochrome:
            LinearGradient(colors: [Color.black, Color(white: 0.08)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
        case .minimal:
            Color(white: 0.075).ignoresSafeArea()
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text("GPT-AGENT")
                    .font(.system(size: 10, weight: .black, design: .monospaced))
                    .foregroundStyle(palette.accent)
                Text("Tool")
                    .font(.system(size: 30, weight: .black, design: theme == .minimal ? .default : .rounded))
                Text(japanese ? "利用状況とローカル実行管理" : "Usage and local runtime control")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
            }

            VStack(spacing: 7) {
                ForEach(AppSection.allCases) { item in
                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) { section = item }
                    } label: {
                        HStack(spacing: 11) {
                            Image(systemName: item.icon).frame(width: 20)
                            Text(sectionTitle(item)).font(.system(size: 13, weight: .bold, design: theme == .minimal ? .default : .rounded))
                            Spacer()
                        }
                        .foregroundStyle(section == item ? palette.primaryText : palette.secondaryText)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 11)
                        .background(
                            RoundedRectangle(cornerRadius: theme == .minimal ? 8 : 13)
                                .fill(section == item ? palette.selection : palette.faintFill)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: theme == .minimal ? 8 : 13)
                                .stroke(section == item ? palette.accent.opacity(0.42) : Color.clear, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer()
            VStack(alignment: .leading, spacing: 9) {
                Text(japanese ? "API費用概算" : "ESTIMATED API COST")
                    .font(.system(size: 9, weight: .black, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
                sidebarCost(periodTitle(.today), model.summary.today.cost.total)
                sidebarCost(periodTitle(.week), model.summary.week.cost.total)
                sidebarCost(periodTitle(.month), model.summary.month.cost.total)
                sidebarCost(periodTitle(.year), model.summary.year.cost.total)
            }
            .padding(13)
            .background(RoundedRectangle(cornerRadius: theme == .minimal ? 8 : 16).fill(palette.panel))
        }
        .padding(20)
        .frame(width: 240)
        .background(palette.sidebar)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(sectionTitle(section)).font(.system(size: 25, weight: .black, design: theme == .minimal ? .default : .rounded))
                Text(sectionSubtitle(section))
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
            }
            Spacer()
            HStack(spacing: 9) {
                Text(lastUpdatedText)
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
                Circle().fill(model.runtimeOnline ? Color.green : Color.red).frame(width: 8, height: 8)
                Text(model.runtimeOnline ? "ONLINE" : "OFFLINE")
                    .font(.system(size: 10, weight: .black, design: .monospaced))
                Button { model.refresh(settings: settings) } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(GlassButtonStyle(palette: palette))
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 17)
        .background(palette.header)
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
        VStack(spacing: 16) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
                periodCard(periodTitle(.today), model.summary.today, accent(0))
                periodCard(periodTitle(.week), model.summary.week, accent(1))
                periodCard(periodTitle(.month), model.summary.month, accent(2))
                periodCard(periodTitle(.year), model.summary.year, accent(3))
            }
            HStack(spacing: 14) {
                statusCard(japanese ? "ランタイム" : "RUNTIME", model.runtimeOnline ? "ONLINE" : "OFFLINE", model.runtimeOnline)
                statusCard(japanese ? "ポート" : "PORT", "\(model.toolConfig.port)", model.runtimeOnline)
                statusCard(japanese ? "許可フォルダ" : "ROOTS", "\(model.roots.count)", !model.roots.isEmpty)
            }
            selectedRangeSummary
            analyticsList(limit: 6)
        }
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
        VStack(alignment: .leading, spacing: 10) {
            if model.roots.isEmpty {
                Text(japanese ? "許可フォルダがありません。~/.devspace/config.json を設定してください。" : "No allowed roots. Configure ~/.devspace/config.json.")
                    .foregroundStyle(palette.secondaryText)
            } else {
                ForEach(model.roots, id: \.self) { root in
                    HStack(spacing: 12) {
                        Image(systemName: "folder.fill").foregroundStyle(palette.accent)
                        Text(root).font(.system(size: 11, weight: .semibold, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        Spacer()
                    }
                    .padding(13)
                    .background(panelBackground)
                }
            }
        }
    }

    private var settingsView: some View {
        VStack(alignment: .leading, spacing: 16) {
            settingPanel(japanese ? "言語・地域" : "Language & region") {
                settingRow(japanese ? "言語" : "Language") {
                    Picker("Language", selection: $languageRaw) {
                        Text(japanese ? "自動" : "Automatic").tag(AppLanguage.automatic.rawValue)
                        Text("English").tag(AppLanguage.english.rawValue)
                        Text("日本語").tag(AppLanguage.japanese.rawValue)
                    }.pickerStyle(.segmented).frame(width: 360)
                }
                settingRow(japanese ? "地域形式" : "Regional format") {
                    Picker("Region", selection: $regionRaw) {
                        ForEach(RegionPreset.allCases) { value in Text(regionName(value)).tag(value.rawValue) }
                    }.frame(width: 230)
                }
                settingRow(japanese ? "集計タイムゾーン" : "Aggregation time zone") {
                    Picker("Time zone", selection: $timeZoneRaw) {
                        ForEach(TimeZonePreset.allCases) { value in Text(timeZoneName(value)).tag(value.rawValue) }
                    }.frame(width: 230)
                }
                settingRow(japanese ? "表示通貨" : "Display currency") {
                    Picker("Currency", selection: $currencyRaw) {
                        ForEach(DisplayCurrency.allCases) { value in Text(value.rawValue).tag(value.rawValue) }
                    }.pickerStyle(.segmented).frame(width: 300)
                }
            }

            settingPanel(japanese ? "期間の基準" : "Period rules") {
                settingRow(japanese ? "1週間" : "One week") {
                    Picker("Week mode", selection: $weekModeRaw) {
                        Text(japanese ? "今日を含む7日" : "Rolling 7 days").tag(WeekMode.rollingSevenDays.rawValue)
                        Text(japanese ? "曜日起点" : "Calendar week").tag(WeekMode.calendarWeek.rawValue)
                    }.pickerStyle(.segmented).frame(width: 360)
                }
                if weekMode == .calendarWeek {
                    settingRow(japanese ? "週の開始曜日" : "Week starts on") {
                        Picker("Weekday", selection: $weekStartWeekday) {
                            ForEach(1...7, id: \.self) { weekday in Text(weekdayName(weekday)).tag(weekday) }
                        }.frame(width: 180)
                    }
                }
                settingRow(japanese ? "日の切替時刻" : "Day boundary") {
                    Stepper(value: $dayBoundaryHour, in: 0...23) {
                        Text(String(format: "%02d:00", dayBoundaryHour)).font(.system(.body, design: .monospaced))
                    }.frame(width: 150)
                }
                settingRow(japanese ? "1か月" : "One month") {
                    Picker("Month mode", selection: $monthModeRaw) {
                        Text(japanese ? "今日を含む30日" : "Rolling 30 days").tag(MonthMode.rollingThirtyDays.rawValue)
                        Text(japanese ? "毎月1日起点" : "Calendar month").tag(MonthMode.calendarMonth.rawValue)
                    }.pickerStyle(.segmented).frame(width: 360)
                }
                settingRow(japanese ? "1年" : "One year") {
                    Picker("Year mode", selection: $yearModeRaw) {
                        Text(japanese ? "今日を含む365日" : "Rolling 365 days").tag(YearMode.rollingThreeSixtyFiveDays.rawValue)
                        Text(japanese ? "1月1日起点" : "Calendar year").tag(YearMode.calendarYear.rawValue)
                    }.pickerStyle(.segmented).frame(width: 360)
                }
            }

            settingPanel(japanese ? "料金計算" : "Pricing") {
                settingRow(japanese ? "入力 / 100万token (USD)" : "Input / 1M tokens (USD)") {
                    TextField("5", value: $inputUsdPerMillion, format: .number.precision(.fractionLength(0...4))).frame(width: 130)
                }
                settingRow(japanese ? "出力 / 100万token (USD)" : "Output / 1M tokens (USD)") {
                    TextField("30", value: $outputUsdPerMillion, format: .number.precision(.fractionLength(0...4))).frame(width: 130)
                }
                settingRow("USD / JPY") {
                    TextField("160", value: $usdJpyRate, format: .number.precision(.fractionLength(0...4))).frame(width: 130)
                }
                settingRow("USD / EUR") {
                    TextField("0.92", value: $usdEurRate, format: .number.precision(.fractionLength(0...4))).frame(width: 130)
                }
                settingRow("USD / GBP") {
                    TextField("0.79", value: $usdGbpRate, format: .number.precision(.fractionLength(0...4))).frame(width: 130)
                }
                Text(japanese ? "表示値は履歴上のtokenから算出する概算で、ChatGPT契約料金や実請求額ではありません。" : "Values are estimates from recorded tokens, not ChatGPT subscription billing or provider invoices.")
                    .font(.system(size: 10))
                    .foregroundStyle(palette.secondaryText)
            }

            settingPanel(japanese ? "表示" : "Appearance") {
                settingRow(japanese ? "デザイン" : "Design") {
                    Picker("Theme", selection: $themeRaw) {
                        Text(japanese ? "オーロラ" : "Aurora").tag(AppTheme.aurora.rawValue)
                        Text(japanese ? "モノクロ" : "Monochrome").tag(AppTheme.monochrome.rawValue)
                        Text(japanese ? "シンプル" : "Minimal").tag(AppTheme.minimal.rawValue)
                    }.pickerStyle(.segmented).frame(width: 360)
                }
                Toggle(japanese ? "入力・出力費用の内訳を表示" : "Show input/output cost split", isOn: $showCostSplit)
                Toggle(japanese ? "数値をK/M形式で短縮" : "Use compact K/M numbers", isOn: $compactNumbers)
            }

            settingPanel(japanese ? "動作" : "Behavior") {
                settingRow(japanese ? "自動更新" : "Auto refresh") {
                    Picker("Refresh", selection: $autoRefreshSeconds) {
                        Text(japanese ? "オフ" : "Off").tag(0)
                        Text("10 sec").tag(10)
                        Text("20 sec").tag(20)
                        Text("1 min").tag(60)
                        Text("5 min").tag(300)
                    }.frame(width: 150)
                }
                settingRow(japanese ? "起動時の画面" : "Default screen") {
                    Picker("Default screen", selection: $defaultSectionRaw) {
                        ForEach(AppSection.allCases) { value in Text(sectionTitle(value)).tag(value.rawValue) }
                    }.frame(width: 180)
                }
                settingRow(japanese ? "フォルダ並び順" : "Folder sort") {
                    Picker("Sort", selection: $sortMetricRaw) {
                        Text(japanese ? "費用" : "Cost").tag(SortMetric.cost.rawValue)
                        Text("Token").tag(SortMetric.tokens.rawValue)
                        Text(japanese ? "呼び出し数" : "Calls").tag(SortMetric.calls.rawValue)
                    }.pickerStyle(.segmented).frame(width: 300)
                }
                Toggle(japanese ? "所属不明の履歴を非表示" : "Hide unknown workspace history", isOn: $hideUnknownFolders)
            }

            settingPanel(japanese ? "詳細設定" : "Advanced") {
                Text("~/.devspace/tool.json").font(.system(size: 12, design: .monospaced)).foregroundStyle(palette.accent)
                Button { model.revealConfig() } label: {
                    Label(japanese ? "Finderで表示" : "Reveal in Finder", systemImage: "folder")
                }.buttonStyle(ActionButtonStyle(primary: false, palette: palette))
            }
        }
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
            Text(title).font(.system(size: 9, weight: .black, design: .monospaced)).foregroundStyle(accent)
            Text(formatCurrency(usage.cost.total)).font(.system(size: 23, weight: .black, design: theme == .minimal ? .default : .rounded))
            if showCostSplit {
                Text("\(formatCurrency(usage.cost.input)) / \(formatCurrency(usage.cost.output))")
                    .font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(palette.secondaryText)
            }
            Text("\(formatTokens(usage.tokens)) · \(usage.calls) calls")
                .font(.system(size: 9, weight: .medium, design: .monospaced)).foregroundStyle(palette.tertiaryText)
        }
        .frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
        .padding(14)
        .background(panelBackground)
        .overlay(RoundedRectangle(cornerRadius: palette.cornerRadius).stroke(accent.opacity(0.25), lineWidth: 1))
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

    private func settingPanel<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(title).font(.system(size: 16, weight: .black, design: theme == .minimal ? .default : .rounded))
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(panelBackground)
    }

    private func settingRow<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: 24) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
            content()
                .labelsHidden()
                .frame(width: 380, alignment: .trailing)
        }
    }

    private func sidebarCost(_ label: String, _ value: Double) -> some View {
        HStack {
            Text(label).foregroundStyle(palette.secondaryText)
            Spacer()
            Text(formatCurrency(value)).foregroundStyle(palette.primaryText)
        }
        .font(.system(size: 10, weight: .bold, design: .monospaced))
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

    private func sectionSubtitle(_ item: AppSection) -> String {
        switch item {
        case .overview: return japanese ? "状態・token・費用を俯瞰" : "Runtime, tokens, and cost at a glance"
        case .analytics: return japanese ? "期間・日別・フォルダ別の利用分析" : "Usage by period, day, and folder"
        case .runtime: return japanese ? "ローカルGPT-Agentの制御" : "Control the local GPT-Agent runtime"
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
