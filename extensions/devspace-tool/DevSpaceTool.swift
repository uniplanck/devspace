import SwiftUI
import AppKit
import Foundation

@main
struct DevSpaceToolApp: App {
    var body: some Scene {
        WindowGroup { DevSpaceToolView() }
            .windowStyle(.hiddenTitleBar)
            .commands {
                CommandGroup(replacing: .newItem) {}
                DevSpaceRecoveryCommands()
            }
    }
}

struct DevSpaceRecoveryCommands: Commands {
    @AppStorage("devspaceTool.language") private var languageRaw = AppLanguage.automatic.rawValue

    private var japanese: Bool {
        switch AppLanguage(rawValue: languageRaw) ?? .automatic {
        case .japanese:
            return true
        case .english:
            return false
        case .automatic:
            return Locale.current.language.languageCode?.identifier == "ja"
        }
    }

    var body: some Commands {
        CommandMenu("DevSpace") {
            Button(japanese ? "MCP URLをコピー" : "Copy MCP URL") {
                DevSpaceCommandActions.copyMcpURL()
            }
            .keyboardShortcut("u", modifiers: [.command, .shift])

            Button(japanese ? "診断コマンドをコピー" : "Copy diagnostics command") {
                DevSpaceCommandActions.copyText("devspace doctor && tailscale funnel status")
            }

            Button(japanese ? "Owner Password取得コマンドをコピー" : "Copy Owner Password retrieval command") {
                DevSpaceCommandActions.copyOwnerRetrievalCommand()
            }

            Divider()

            Button(japanese ? "設定フォルダを開く" : "Open configuration folder") {
                DevSpaceCommandActions.openConfigFolder()
            }

            Button(japanese ? "日本語セットアップガイド" : "Setup guide") {
                DevSpaceCommandActions.openSetupGuide(japanese: japanese)
            }
        }
    }
}

private enum DevSpaceCommandActions {
    private static let configDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".devspace", isDirectory: true)

    static func copyText(_ value: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(value, forType: .string)
    }

    static func copyMcpURL() {
        let configURL = configDirectory.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: configURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            NSSound.beep()
            return
        }

        let url: String
        if let publicBaseURL = object["publicBaseUrl"] as? String,
           !publicBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            url = publicBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/mcp"
        } else {
            let host = object["host"] as? String ?? "127.0.0.1"
            let port = object["port"] as? Int ?? 7676
            url = "http://\(host):\(port)/mcp"
        }
        copyText(url)
    }

    static func copyOwnerRetrievalCommand() {
        copyText(#"python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/".devspace/auth.json").read_text())["ownerToken"], end="")' | pbcopy"#)
    }

    static func openConfigFolder() {
        try? FileManager.default.createDirectory(
            at: configDirectory,
            withIntermediateDirectories: true
        )
        NSWorkspace.shared.open(configDirectory)
    }

    static func openSetupGuide(japanese: Bool) {
        let path = japanese ? "README.md" : "README.en.md"
        guard let url = URL(string: "https://github.com/uniplanck/devspace/blob/main/\(path)") else { return }
        NSWorkspace.shared.open(url)
    }
}
