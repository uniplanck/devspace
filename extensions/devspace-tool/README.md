# DevSpace Tool

A bilingual macOS companion application for DevSpace.

## Features

- English / Japanese / automatic locale selection
- Sidebar navigation for Overview, Analytics, Runtime, Folders, and Settings
- Runtime status and optional start/stop commands
- API cost estimates for today, the last 7 days, the last 30 days, and all recorded history
- Input/output cost split using configurable USD/JPY conversion
- Folder-level usage analytics
- Reads the existing DevSpace configuration and usage history

## Requirements

- macOS 14 or later
- Swift 5.9 or later
- A local DevSpace installation

## Configuration

DevSpace Tool reads:

- `~/.devspace/config.json`
- `~/.local/share/devspace/usage-history.jsonl`
- `~/.devspace/tool.json`

Example `~/.devspace/tool.json`:

```json
{
  "host": "127.0.0.1",
  "port": 7676,
  "runtimeCommand": "devspace serve",
  "runtimeProcessMatch": "devspace.*serve",
  "usdJpyRate": 160
}
```

Runtime start/stop remains disabled until `runtimeCommand` and `runtimeProcessMatch` are explicitly configured.

## Build

```bash
./build-macos.sh
```

The app is written to `.build/DevSpace Tool.app` and receives an ad-hoc local signature.

## Cost estimates

The displayed values are API-rate conversions of text observed by DevSpace. They are not ChatGPT subscription billing and may not equal provider invoices.
