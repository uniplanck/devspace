import SwiftUI

@main
struct DevSpaceToolApp: App {
    var body: some Scene {
        WindowGroup { DevSpaceToolView() }
            .windowStyle(.hiddenTitleBar)
            .commands { CommandGroup(replacing: .newItem) {} }
    }
}
