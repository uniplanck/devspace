import Foundation

struct ModelPricingProfile: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let inputUsdPerMillion: Double
    let outputUsdPerMillion: Double
    let source: String

    var displayName: String {
        id == "custom" ? "Custom / Manual" : id
    }
}

struct ModelPricingRefreshResult: Sendable {
    let pricingUpdated: Bool
    let exchangeUpdated: Bool
    let catalogUpdated: Bool
    let pricingError: String?
    let exchangeError: String?
    let skipped: Bool

    var updatedAnything: Bool { pricingUpdated || exchangeUpdated || catalogUpdated }
}

actor ModelPricingService {
    static let shared = ModelPricingService()

    private let defaults = UserDefaults.standard
    private var activeTasks: [String: Task<ModelPricingRefreshResult, Never>] = [:]
    private static let oneDay: TimeInterval = 24 * 60 * 60

    static let builtInCatalog: [ModelPricingProfile] = [
        ModelPricingProfile(id: "gpt-5.6-sol", inputUsdPerMillion: 5.0, outputUsdPerMillion: 30.0, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "gpt-5.6-terra", inputUsdPerMillion: 2.5, outputUsdPerMillion: 15.0, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "gpt-5.6-luna", inputUsdPerMillion: 1.0, outputUsdPerMillion: 6.0, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "gpt-5.5", inputUsdPerMillion: 5.0, outputUsdPerMillion: 30.0, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "gpt-5.5-pro", inputUsdPerMillion: 30.0, outputUsdPerMillion: 180.0, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "gpt-5.4", inputUsdPerMillion: 2.5, outputUsdPerMillion: 15.0, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "gpt-5.4-mini", inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "gpt-5.4-nano", inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.25, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "gpt-5.4-pro", inputUsdPerMillion: 30.0, outputUsdPerMillion: 180.0, source: "OpenAI standard short context"),
        ModelPricingProfile(id: "custom", inputUsdPerMillion: 5.0, outputUsdPerMillion: 30.0, source: "Manual")
    ]

    nonisolated static func catalog(prefix: String) -> [ModelPricingProfile] {
        let key = "\(prefix).pricingCatalogJSON"
        if let raw = UserDefaults.standard.string(forKey: key),
           let data = raw.data(using: .utf8),
           let decoded = try? JSONDecoder().decode([ModelPricingProfile].self, from: data),
           !decoded.isEmpty {
            return mergeWithCustom(decoded)
        }
        return builtInCatalog
    }

    nonisolated static func profile(prefix: String, modelID: String) -> ModelPricingProfile? {
        catalog(prefix: prefix).first { $0.id == modelID }
    }

    nonisolated static func applySelection(prefix: String, modelID: String) -> Bool {
        guard modelID != "custom",
              let profile = profile(prefix: prefix, modelID: modelID) else { return false }
        let defaults = UserDefaults.standard
        defaults.set(profile.inputUsdPerMillion, forKey: "\(prefix).inputUsdPerMillion")
        defaults.set(profile.outputUsdPerMillion, forKey: "\(prefix).outputUsdPerMillion")
        defaults.set("Pricing basis changed to \(profile.id)", forKey: "\(prefix).pricingRefreshStatus")
        return true
    }

    func refresh(prefix: String, selectedModelID: String, force: Bool = false) async -> ModelPricingRefreshResult {
        if let task = activeTasks[prefix] { return await task.value }

        let autoKey = "\(prefix).autoPricingUpdate"
        let autoEnabled: Bool
        if defaults.object(forKey: autoKey) == nil {
            defaults.set(true, forKey: autoKey)
            autoEnabled = true
        } else {
            autoEnabled = defaults.bool(forKey: autoKey)
        }
        guard force || autoEnabled else {
            return ModelPricingRefreshResult(
                pricingUpdated: false,
                exchangeUpdated: false,
                catalogUpdated: false,
                pricingError: nil,
                exchangeError: nil,
                skipped: true
            )
        }

        let now = Date().timeIntervalSince1970
        let pricingUpdatedKey = "\(prefix).pricingLastUpdated"
        let exchangeUpdatedKey = "\(prefix).exchangeLastUpdated"
        let pricingDue = force || now - defaults.double(forKey: pricingUpdatedKey) >= Self.oneDay
        let exchangeDue = force || now - defaults.double(forKey: exchangeUpdatedKey) >= Self.oneDay
        guard pricingDue || exchangeDue else {
            _ = Self.applySelection(prefix: prefix, modelID: selectedModelID)
            return ModelPricingRefreshResult(
                pricingUpdated: false,
                exchangeUpdated: false,
                catalogUpdated: false,
                pricingError: nil,
                exchangeError: nil,
                skipped: true
            )
        }

        let task = Task {
            await Self.performRefresh(
                prefix: prefix,
                selectedModelID: selectedModelID,
                pricingDue: pricingDue,
                exchangeDue: exchangeDue
            )
        }
        activeTasks[prefix] = task
        let result = await task.value
        activeTasks[prefix] = nil
        return result
    }

    private static func performRefresh(
        prefix: String,
        selectedModelID: String,
        pricingDue: Bool,
        exchangeDue: Bool
    ) async -> ModelPricingRefreshResult {
        let defaults = UserDefaults.standard
        let now = Date().timeIntervalSince1970
        var pricingUpdated = false
        var exchangeUpdated = false
        var catalogUpdated = false
        var pricingError: String?
        var exchangeError: String?

        if pricingDue {
            do {
                let fetched = try await fetchOpenAIPricingCatalog()
                let catalog = mergeWithCustom(fetched)
                let data = try JSONEncoder().encode(catalog)
                defaults.set(String(decoding: data, as: UTF8.self), forKey: "\(prefix).pricingCatalogJSON")
                defaults.set(now, forKey: "\(prefix).pricingLastUpdated")
                catalogUpdated = true

                if selectedModelID == "custom" {
                    pricingUpdated = false
                } else if let selected = catalog.first(where: { $0.id == selectedModelID }) {
                    defaults.set(selected.inputUsdPerMillion, forKey: "\(prefix).inputUsdPerMillion")
                    defaults.set(selected.outputUsdPerMillion, forKey: "\(prefix).outputUsdPerMillion")
                    pricingUpdated = true
                } else {
                    pricingError = "Selected model \(selectedModelID) was not found in OpenAI pricing"
                }
            } catch {
                pricingError = error.localizedDescription
                _ = applySelection(prefix: prefix, modelID: selectedModelID)
            }
        } else {
            _ = applySelection(prefix: prefix, modelID: selectedModelID)
        }

        if exchangeDue {
            do {
                let rates = try await fetchECBExchangeRates()
                defaults.set(rates.jpy, forKey: "\(prefix).usdJpyRate")
                defaults.set(rates.eur, forKey: "\(prefix).usdEurRate")
                defaults.set(rates.gbp, forKey: "\(prefix).usdGbpRate")
                defaults.set(now, forKey: "\(prefix).exchangeLastUpdated")
                exchangeUpdated = true
            } catch {
                exchangeError = error.localizedDescription
            }
        }

        let modelLabel = selectedModelID == "custom" ? "custom pricing" : selectedModelID
        let status: String
        if pricingError == nil && exchangeError == nil {
            status = "\(modelLabel) pricing and ECB exchange rates are current"
        } else if pricingError == nil {
            status = "\(modelLabel) pricing updated; ECB update failed"
        } else if exchangeError == nil {
            status = "ECB exchange rates updated; model pricing update failed"
        } else {
            status = "Automatic pricing update failed; previous values retained"
        }
        defaults.set(status, forKey: "\(prefix).pricingRefreshStatus")

        return ModelPricingRefreshResult(
            pricingUpdated: pricingUpdated,
            exchangeUpdated: exchangeUpdated,
            catalogUpdated: catalogUpdated,
            pricingError: pricingError,
            exchangeError: exchangeError,
            skipped: false
        )
    }

    private static func fetchOpenAIPricingCatalog() async throws -> [ModelPricingProfile] {
        let html = try await fetchText(
            urlString: "https://developers.openai.com/api/docs/pricing",
            source: "OpenAI pricing"
        )
        let pattern = #"(gpt-5(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?)(?:\s*\([^)]*\))?&quot;\],\[0,([0-9]+(?:\.[0-9]+)?)\],\[0,(?:[0-9]+(?:\.[0-9]+)?|&quot;-&quot;)\],\[0,(?:[0-9]+(?:\.[0-9]+)?|&quot;-&quot;)\],\[0,([0-9]+(?:\.[0-9]+)?)\]"#
        let regex = try NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        let matches = regex.matches(in: html, range: NSRange(html.startIndex..., in: html))
        var seen = Set<String>()
        var profiles: [ModelPricingProfile] = []
        for match in matches where match.numberOfRanges >= 4 {
            guard let modelRange = Range(match.range(at: 1), in: html),
                  let inputRange = Range(match.range(at: 2), in: html),
                  let outputRange = Range(match.range(at: 3), in: html),
                  let input = Double(html[inputRange]),
                  let output = Double(html[outputRange]) else { continue }
            let modelID = String(html[modelRange]).lowercased()
            guard seen.insert(modelID).inserted else { continue }
            profiles.append(ModelPricingProfile(
                id: modelID,
                inputUsdPerMillion: input,
                outputUsdPerMillion: output,
                source: "OpenAI standard short context"
            ))
        }
        guard !profiles.isEmpty else {
            throw NSError(
                domain: "ModelPricingService",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "OpenAI model pricing catalog could not be parsed"]
            )
        }
        return profiles
    }

    private static func fetchECBExchangeRates() async throws -> (jpy: Double, eur: Double, gbp: Double) {
        let xml = try await fetchText(
            urlString: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
            source: "ECB exchange rates"
        )
        guard let usdPerEur = currencyRate("USD", in: xml),
              let jpyPerEur = currencyRate("JPY", in: xml),
              let gbpPerEur = currencyRate("GBP", in: xml),
              usdPerEur > 0 else {
            throw NSError(
                domain: "ModelPricingService",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "ECB exchange-rate data could not be parsed"]
            )
        }
        return (jpy: jpyPerEur / usdPerEur, eur: 1 / usdPerEur, gbp: gbpPerEur / usdPerEur)
    }

    private static func fetchText(urlString: String, source: String) async throws -> String {
        guard let url = URL(string: urlString) else {
            throw NSError(domain: "ModelPricingService", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid \(source) URL"])
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("DevSpace-Tool/0.4", forHTTPHeaderField: "User-Agent")
        request.setValue("text/html,application/xml;q=0.9,*/*;q=0.8", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let text = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "ModelPricingService", code: 5, userInfo: [NSLocalizedDescriptionKey: "\(source) request failed"])
        }
        return text
    }

    private static func currencyRate(_ currency: String, in xml: String) -> Double? {
        let escaped = NSRegularExpression.escapedPattern(for: currency)
        let pattern = "currency=['\\\"]\(escaped)['\\\"]\\s+rate=['\\\"]([0-9.]+)['\\\"]"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: xml, range: NSRange(xml.startIndex..., in: xml)),
              match.numberOfRanges >= 2,
              let range = Range(match.range(at: 1), in: xml) else { return nil }
        return Double(xml[range])
    }

    private nonisolated static func mergeWithCustom(_ profiles: [ModelPricingProfile]) -> [ModelPricingProfile] {
        var result = profiles.filter { $0.id != "custom" }
        if !result.contains(where: { $0.id == "custom" }) {
            result.append(ModelPricingProfile(id: "custom", inputUsdPerMillion: 5.0, outputUsdPerMillion: 30.0, source: "Manual"))
        }
        return result
    }
}
