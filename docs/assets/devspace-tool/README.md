# DevSpace Tool screenshot capture spec

READMEへ掲載する候補画像の命名・撮影条件です。実画像は次のファイル名で追加します。

| 優先 | ファイル名 | 画面 | READMEでの用途 |
|---|---|---|---|
| 1 | `settings-ja.png` | 日本語・設定 | 日本語READMEのメイン画像。右揃えUI、言語・期間・料金設定を紹介 |
| 2 | `runtime-ja.png` | 日本語・ランタイム | ONLINE/OFFLINEと起動・停止の紹介 |
| 3 | `settings-en.png` | English・Settings | English READMEのメイン画像 |
| 4 | `overview-ja.png` | 日本語・概要 | 個人パスが表示されない場合のみ利用 |
| 5 | `analytics-ja.png` | 日本語・分析 | 個人パスが表示されない場合のみ利用 |

## Capture conditions

- Build対象: `extensions/devspace-tool/.build/DevSpace Tool.app`
- Window: アプリ既定サイズのまま。画面全体を切らずに撮る
- Theme: `Aurora`
- 日本語画像: Language=`日本語`、Region=`日本`、Time zone=`Tokyo (JST)`、Currency=`JPY`
- 英語画像: Language=`English`、Currency=`USD`または`JPY`
- ヘッダーの更新日時とONLINE/OFFLINE表示を含める
- macOSのウィンドウ影を含める。デスクトップや他アプリは極力入れない
- Owner Password、token、API key、個人メール、個人名、秘密URLは写さない
- Overview / Analytics / Foldersにはworkspace名や絶対パスが出る場合がある。個人情報が表示される場合は撮影しない
- PNG、Retina等倍、画像編集による過度なシャープ化・色変更はしない

撮影後は、元画像を `/Users/naomac/MyWorkspace2/DevSpaceToolScreenshots/` に同じファイル名で保存し、README反映時にこのディレクトリへ選択コピーします。
