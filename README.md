<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">ChatGPTから、自分のMac・Linux環境にある開発フォルダを安全に操作するためのセルフホストMCPサーバー。</p>

<p align="center">
  <strong>日本語</strong> ｜ <a href="README.en.md">English</a>
</p>

> [!IMPORTANT]
> DevSpaceは、許可したローカルフォルダに対してファイル編集・検索・Terminal実行を行える強力なツールです。最初は作業対象のプロジェクトフォルダだけを許可し、ホームディレクトリ全体や秘密情報を含むフォルダを登録しないでください。

## できること

DevSpaceを接続すると、ChatGPTは許可された範囲内で次を実行できます。

- ファイルの読み取り・新規作成・部分編集
- コード検索、ディレクトリ確認
- テスト、build、Git確認などのTerminalコマンド
- 並列作業用のGit worktree
- `AGENTS.md` / `CLAUDE.md` のプロジェクトルール読込
- ローカルskills・subagent連携
- 利用token・概算API費用・フォルダ別利用状況の表示

macOS向けの **DevSpace Tool** では、次の汎用UIを利用できます。

- 日本語 / English / OS言語への自動切替
- Overview / Analytics / Runtime / Folders / Settings
- DevSpaceのONLINE/OFFLINE確認と起動・停止
- 許可フォルダ一覧
- token・呼出回数・概算API費用の期間別集計
- Aurora / Monochrome / Minimalテーマ
- MCP URL、診断コマンド、安全なOwner Password取得コマンドのコピー

## 最短セットアップ：macOS + Tailscale Funnel

この方法では、DevSpaceを `127.0.0.1:7676` だけで待ち受けさせ、Tailscale FunnelでHTTPS公開します。

ChatGPT Webはインターネット側からMCPサーバーへ接続するため、tailnet内だけに公開する **Tailscale ServeではなくFunnel** を使用します。FunnelのURLは公開URLですが、DevSpace側でOwner Password承認が必要です。

### 0. 必要なもの

- macOS 14以降、またはLinux
- Git
- Node.js `22.19以上、27未満`
- npm
- Tailscaleアカウント
- ChatGPTでDeveloper modeとカスタムAppを利用できる環境

確認：

```bash
node -v && npm -v && git --version
```

Node.jsがない場合のmacOS例：

```bash
brew install node@22 && brew link --overwrite --force node@22
```

### 1. Tailscaleを導入してログイン

macOSでは、Tailscale公式のStandalone版またはCLIを利用できる構成を推奨します。

Homebrew例：

```bash
brew install --cask tailscale-app && open -a Tailscale
```

ログイン後、Terminalで確認します。

```bash
tailscale status
```

`tailscale: command not found` の場合は、Tailscaleアプリが提供するCLIの場所を確認するか、公式ドキュメントのCLI対応版を導入してください。

### 2. DevSpaceをcloneして自動セットアップ

`~/Projects` の部分を、ChatGPTに操作を許可するフォルダへ変更してください。

```bash
git clone https://github.com/uniplanck/devspace.git ~/devspace && cd ~/devspace && bash ./scripts/quickstart-tailscale.sh ~/Projects
```

このスクリプトは次を順番に実行します。

1. Node.js・Git・Tailscaleを確認
2. `npm ci`、typecheck、test、build
3. `npm link` で `devspace` コマンドを登録
4. Tailscale Funnelを `7676` へ接続
5. `~/.devspace/config.json`、`auth.json`、`tool.json`を権限`600`で作成
6. DevSpaceをFull tool modeでバックグラウンド起動
7. `https://<端末名>.<tailnet>.ts.net/mcp` を表示
8. macOSではMCP URLをクリップボードへコピー

> [!NOTE]
> 初回の `tailscale funnel` 実行時は、ブラウザでFunnel有効化の承認画面が開く場合があります。

### 3. 状態確認

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh status
```

正常時の目安：

- DevSpace runtime: `ONLINE`
- Local MCP: `http://127.0.0.1:7676/mcp`
- Public MCP: `https://xxxx.ts.net/mcp`
- `devspace doctor` に重大なエラーがない

### 4. ChatGPTへ接続

OpenAIの現在の案内では、次の順番です。画面名はChatGPTの更新により多少変わる場合があります。

1. ChatGPTの **Settings → Security and login** を開く
2. **Developer mode** を有効化
3. **Settings → Plugins**、Apps、またはConnectors画面を開く
4. `+` からdeveloper-mode Appを作成
5. Server URLへ、スクリプトが表示したURLを登録

```text
https://<端末名>.<tailnet>.ts.net/mcp
```

6. 接続時にDevSpaceの承認画面が出たらOwner Passwordを入力

Owner PasswordそのものをREADMEやチャットへ貼らず、Terminalからクリップボードへ入れてください。

macOS：

```bash
python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/".devspace/auth.json").read_text())["ownerToken"], end="")' | pbcopy
```

Linuxで表示する場合：

```bash
python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/".devspace/auth.json").read_text())["ownerToken"])'
```

### 5. 接続テスト

ChatGPTで次のように依頼します。

```text
DevSpaceを使い、許可されたworkspace候補だけを一覧表示してください。ファイル変更やTerminal実行はしないでください。
```

次に、特定のプロジェクトを読み取り専用で確認します。

```text
<プロジェクトの絶対パス> をworkspaceとして開き、git branch、git status --short、最新commitだけ報告してください。変更・commit・pushは行わないでください。
```

## 日常操作

### 起動

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh start
```

### 停止

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh stop
```

Funnelも停止する場合：

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh stop --with-funnel
```

### 再起動

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh restart
```

### 状態確認

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh status
```

### ログ

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh logs
```

### MCP URLをコピー

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh url
```

### Owner Password取得コマンドをコピー

Owner Password本体ではなく、安全な取得コマンドをクリップボードへ入れます。

```bash
cd ~/devspace && bash ./scripts/devspace-control.sh owner-cmd
```

## DevSpace Tool（macOS GUI）

```bash
cd ~/devspace/extensions/devspace-tool && bash ./build-macos.sh && open ".build/DevSpace Tool.app"
```

アプリ内の **Settings → Language** から、`Automatic / English / 日本語` を即時切替できます。

メニューバーの **DevSpace** から以下を実行できます。

- MCP URLをコピー
- 診断コマンドをコピー
- Owner Passwordそのものではなく取得コマンドをコピー
- 設定フォルダを開く
- 日本語 / Englishセットアップガイドを開く

Runtimeの起動・停止を有効にする場合、`~/.devspace/tool.json` を設定します。自動セットアップでは作成済みです。

```json
{
  "host": "127.0.0.1",
  "port": 7676,
  "runtimeCommand": "DEVSPACE_TOOL_MODE=full devspace serve",
  "runtimeProcessMatch": "devspace.*serve",
  "usdJpyRate": 160
}
```

## 手動セットアップ

自動スクリプトを使わない場合：

```bash
git clone https://github.com/uniplanck/devspace.git ~/devspace
cd ~/devspace
npm ci
npm run typecheck
npm test
npm run build
npm link
devspace init
tailscale funnel --bg 7676
DEVSPACE_TOOL_MODE=full devspace serve
```

`devspace init` では次を入力します。

- 許可するプロジェクトフォルダ
- Port: 通常 `7676`
- Public base URL: `https://xxxx.ts.net`（`/mcp`を付けない）

ChatGPTへ登録するURLでは、末尾に `/mcp` を付けます。

## 更新

```bash
cd ~/devspace && git pull --ff-only && npm ci && npm run typecheck && npm test && npm run build && npm link
```

その後、再起動します。

```bash
bash ./scripts/devspace-control.sh stop && bash ./scripts/devspace-control.sh start
```

## セキュリティ

- `allowedRoots` は必要なプロジェクトだけに限定する
- `~/.devspace/auth.json` をGitへcommitしない
- Owner Password、token、cookie、秘密鍵をチャットへ貼らない
- 最初は読み取り専用の依頼で接続テストする
- main push、本番deploy、課金操作などはプロジェクトの`AGENTS.md`で禁止・承認制にする
- 不要時はDevSpaceとFunnelを停止する
- 信頼できないMCPサーバーや不明なtool定義へ接続しない
- 停止スクリプトは記録済みPIDがDevSpaceプロセスであることを確認し、未知のプロセスをkillしない

## トラブルシューティング

### ChatGPTから接続できない

```bash
cd ~/devspace
bash ./scripts/devspace-control.sh status
tailscale funnel status
devspace doctor
```

確認項目：

- DevSpaceが `127.0.0.1:7676` で起動している
- Public URLが `https://` である
- ChatGPT登録URLの末尾が `/mcp`
- Tailscale Funnelが有効
- MagicDNS・HTTPS・Funnel権限が有効
- DNS反映待ちではない（初回は数分かかる場合あり）

### `401` が返る

未承認状態では正常です。ChatGPTの接続画面からOwner Password承認を完了してください。

### Node.jsのnative dependency error

```bash
cd ~/devspace && npm rebuild better-sqlite3 && npm run build && devspace doctor
```

### 設定をやり直す

```bash
devspace init --force
```

## 主なCLI

```text
devspace serve
devspace init
devspace init --force
devspace doctor
devspace config get
devspace config set publicBaseUrl <url|null>
devspace agents ls
devspace jobs ls
devspace computer doctor
```

## 対応環境

| 環境 | 状態 | 備考 |
|---|---|---|
| macOS | 対応 | GUIのDevSpace Toolあり |
| Linux | 対応 | Bash、Node.js、Gitが必要 |
| Windows + WSL / Git Bash | 対応 | PowerShell単体は未対応 |

## 開発

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run start
```

## クレジット

DevSpaceは [Waishnav/devspace](https://github.com/Waishnav/devspace) を基盤とするforkです。原作者とコントリビューターに感謝します。

ライセンス: MIT
