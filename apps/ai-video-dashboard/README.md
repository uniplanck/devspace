# AI Video Tailnet Dashboard MVP

PremiereやPalmier Proがなくても、Editorial IR・文字起こし・QC・Mac反映待ちキューをEC2上で確認するための独立MVPです。Node.js標準機能だけで動作し、GPT-Agent本体のbuildには依存しません。

## 起動

```bash
cd /home/ubuntu/GPT-Agent/apps/ai-video-dashboard
AIVIDEO_HOST=127.0.0.1 AIVIDEO_PORT=4317 node server.mjs
```

確認:

```bash
curl http://127.0.0.1:4317/api/health
```

## Tailnet内公開

EC2でTailscaleが接続済みの場合のみ実行します。

```bash
sudo tailscale serve --bg http://127.0.0.1:4317
tailscale serve status
```

表示された `https://<device>.<tailnet>.ts.net` を、Tailscale接続済みiPhoneのSafariで開きます。Funnelは使用しません。

## API

- `GET /api/health`
- `GET /api/capabilities`
- `GET /api/projects`
- `GET /api/projects/:id`
- `GET /api/queue`
- `POST /api/queue`
- `PATCH /api/queue/:id`
- `GET /api/bridge/contract`

キュー作成例:

```json
{
  "projectId": "demo-talk",
  "action": "apply_ir",
  "target": "palmier-mac"
}
```

Mac上のGAG Bridgeはキューを取得し、Palmierのlocalhost MCPへ変換して実行します。Palmier MCP自体をtailnetへ直接公開しません。

### カット＋テロップ適用

`apply_ir`では、`payload.assetBindings`でEditorial IRの`assetId`をPalmier素材へ解決します。

```json
{
  "projectId": "demo-talk",
  "action": "apply_ir",
  "target": "palmier-mac",
  "payload": {
    "assetBindings": {
      "cam-a": {
        "path": "/absolute/path/to/cam-a.mp4",
        "name": "interview-cam-a"
      }
    }
  }
}
```

bindingは絶対ローカルパス、HTTPS URL、既存`mediaRef`に対応します。Bridgeは`select_range`を連続タイムラインへコンパイルし、`trimStartFrame`を適用します。`remove_range`は選択区間だけを再構築することで反映します。

同一IRの再実行はno-opです。IR変更時は新構成を作成・検証してから、Bridge自身が以前作成したclipだけを削除します。ユーザー作成clipは削除しません。失敗時は今回作成したclipだけをrollbackします。

## Mac / Palmier Bridge

Palmier Proでプロジェクトを開いた状態で起動します。

```bash
cd /path/to/GPT-Agent
node apps/ai-video-dashboard/mac-bridge.mjs --inventory
node apps/ai-video-dashboard/mac-bridge.mjs
```

既定値:

- Dashboard: `http://100.66.201.64:4317`
- Palmier MCP: `http://127.0.0.1:19789/mcp`
- Poll: 5秒
- Target: `palmier-mac`

環境変数 `AIVIDEO_DASHBOARD_URL`、`PALMIER_MCP_URL`、`AIVIDEO_POLL_MS`、`AIVIDEO_BRIDGE_TARGET` で変更できます。

現在の`apply_ir`はカット＋字幕MVPです。`select_range`を連続タイムラインへ再構築し、映像・音声へ同一のtrimを適用します。`remove_range`は選択区間だけを再構築する方式で反映し、`caption`は`add_texts`へ変換します。同一IRの再実行は`already_applied`となり、変更時は新構成の検証後にBridge管理clipだけを差し替えます。

診断コマンド:

```bash
node mac-bridge.mjs --inventory
node mac-bridge.mjs --media
node mac-bridge.mjs --timeline
node mac-bridge.mjs --self-test
```

検証用の空プロジェクトは `fixtures/empty-lab.palmier`、解析E2E用は`fixtures/analysis-lab.palmier`です。

## 文字起こしadapter

同名sidecarは自動検出します。優先順位は`.transcript.json`、`.srt`、`.vtt`、`.json`です。

```bash
node transcribe-media.mjs \
  --media /absolute/path/to/source.mp4 \
  --output /absolute/path/to/source.transcript.json
```

外部engineを使う場合は、実行ファイルを絶対パスで指定し、引数をJSON配列で渡します。shellは使用せず、`{media}`だけを入力動画の絶対パスへ置換します。engineのstdoutはJSON、SRT、VTTに対応します。

```bash
node transcribe-media.mjs \
  --media /absolute/path/to/source.mp4 \
  --command /absolute/path/to/transcription-engine \
  --command-args-json '["--input","{media}","--output-format","json"]' \
  --format json \
  --output /absolute/path/to/source.transcript.json
```

文字起こしengineやモデル自体は同梱・自動導入しません。Whisper系、クラウド音声認識、社内engineなどを同じ契約へ接続できます。

## メディア解析からEditorial IRを生成

```bash
node analyze-media.mjs \
  --project analysis-lab \
  --media /absolute/path/to/source.mp4 \
  --transcript /absolute/path/to/transcript.json \
  --output-dir /absolute/path/to/data/projects/analysis-lab \
  --dashboard-url http://127.0.0.1:4317
```

`--transcript`を省略すると同名sidecarを自動探索します。外部engineは`--transcript-command`、`--transcript-command-args-json`、`--transcript-format`で直接接続できます。FFmpegでメディア情報、無音、シーン変化を取得し、文字起こしからフィラー・言い直し・反復テイク候補を検出します。自動削除は高信頼候補だけに限定し、根拠ID付きの`analysis.json`、`editorial-ir.json`、`qc-report.json`を生成します。表情・反応の意味判定は未実装で、シーン変化を補助信号としてのみ保持します。

## 複数素材を同期してマルチカムIRを生成

基準プロジェクトは、先に`analyze-media.mjs`で生成した単一素材プロジェクトです。manifestへ2素材以上と、編集後タイムライン上の明示的な`cameraPlan`を指定します。

```json
{
  "referenceAssetId": "cam-a",
  "assets": [
    { "id": "cam-a", "path": "/absolute/path/to/cam-a.mp4" },
    { "id": "cam-b", "path": "/absolute/path/to/cam-b.mp4" }
  ],
  "cameraPlan": [
    { "assetId": "cam-a", "timelineIn": 0, "timelineOut": 4.5 },
    { "assetId": "cam-b", "timelineIn": 4.5, "timelineOut": 8.0 }
  ],
  "audioStrategy": "master_audio",
  "masterAudioAssetId": "cam-a",
  "sync": { "maximumOffsetSeconds": 8, "minimumSyncConfidence": 0.58 }
}
```

```bash
node analyze-multicam.mjs \
  --project multicam-project \
  --manifest /absolute/path/to/multicam-manifest.json \
  --reference-project-dir /absolute/path/to/reference-project \
  --output-dir /absolute/path/to/data/projects/multicam-project \
  --audio-strategy master_audio \
  --master-audio-asset cam-a \
  --dashboard-url http://127.0.0.1:4317
```

音声RMS包絡の相互相関から、`対象素材のsourceTime = 基準素材のsourceTime + offset`として同期します。自動同期が不安定な素材は`manualOffsetSeconds`で上書きできます。同期信頼度不足や素材範囲外では基準カメラへフォールバックし、QCを`review`へ落とします。画角の良否を根拠なく自動判断せず、カメラ切替は`cameraPlan`を正本にします。

音声戦略は`selected_asset`と`master_audio`に対応します。`selected_asset`は選択カメラの映像・音声を一緒に切り替えます。`master_audio`は映像だけを切り替え、`masterAudioAssetId`の音声を編集カットに沿って連続使用します。各`select_range`には映像source範囲とは別に`audioAssetId`、`audioSourceIn`、`audioSourceOut`が記録されます。

## 編集後プレビューを生成

```bash
node render-preview.mjs \
  --media /absolute/path/to/source.mp4 \
  --ir /absolute/path/to/editorial-ir.json \
  --output /absolute/path/to/preview.mp4
```

単一素材では`--media`を使用します。複数素材ではasset IDと絶対パスを記載したJSONを渡します。

```bash
node render-preview.mjs \
  --asset-bindings /absolute/path/to/asset-bindings.json \
  --ir /absolute/path/to/multicam-editorial-ir.json \
  --output /absolute/path/to/multicam-preview.mp4
```

`select_range`を素材ごとに切り出し、解像度・フレームレート・音声形式を正規化して連結します。再配置済み字幕を日本語フォントで焼き込み、出力尺をEditorial IRの期待値と照合します。`master_audio`ではカメラ切替に関係なく指定したmaster音声だけを使用します。

Palmier Bridgeも`master_audio`へ対応します。選択カメラの映像配置時に自動生成されるリンク音声を消音し、master素材から抽出・importした音声clipを別トラックへ配置します。抽出音声名には元ファイルのsize・更新時刻由来fingerprintを含めるため、素材更新後に古い音声assetを再利用しません。同一IRの再実行は`already_applied`となります。

## Premiere Pro XMLを書き出す

```bash
node export-premiere-xml.mjs \
  --project /absolute/path/to/project.json \
  --ir /absolute/path/to/editorial-ir.json \
  --asset-bindings /absolute/path/to/asset-bindings.json \
  --output /absolute/path/to/sequence.xml \
  --captions /absolute/path/to/captions.srt
```

Final Cut Pro 7系の`xmeml version="5"`として、映像カット、独立した音声カット、素材参照、sequence markerを生成します。`master_audio`では映像の選択カメラと音声素材を分離してA1へ配置します。字幕本文はSRT sidecarにも保存します。Dashboardの「XML書き出し待ちへ」はMac BridgeでXML・SRTを生成し、Driveへ登録します。

## 確認用ファイルをGoogle Driveへ保存

```bash
node upload-artifact.mjs \
  --project demo-talk \
  --file /absolute/path/to/preview.mp4 \
  --kind preview \
  --label "初回カットプレビュー" \
  --note "無音除去とテロップ位置の確認用"
```

既定では`grive:AI-Video-Production-OS/Test-Artifacts/YYYY-MM-DD/<projectId>/`へアップロードし、共有URL・SHA-256・用途を`artifacts.json`へ記録します。Dashboardの「確認用ファイル」から直接開けます。保存先は`AIVIDEO_DRIVE_REMOTE`と`AIVIDEO_DRIVE_BASE`で変更できます。

## 実撮影素材を品質評価

マルチカム解析済みプロジェクトと編集後プレビューを指定します。

```bash
node evaluate-real-footage.mjs \
  --project-dir /absolute/path/to/data/projects/multicam-project \
  --preview /absolute/path/to/multicam-preview.mp4 \
  --dashboard-url http://100.66.201.64:4317
```

冒頭・中央・終端の音声を再照合し、同期ドリフトを`ms/分`で算出します。さらに出力尺、source範囲、master音声統一、平均音量、クリッピングリスク、カット境界の音切れを100点満点で採点し、`evaluation-report.json`へ改善指示付きで保存します。Dashboardの「実素材品質評価」に同じ結果を表示します。

## テスト

```bash
node transcription-adapters.test.mjs
node analysis-core.test.mjs
node multicam-core.test.mjs
node real-footage-quality.test.mjs
node export-premiere-xml.test.mjs
node render-preview.mjs --self-test
node test.mjs
```

## 現在の境界

- EC2: ダッシュボード、IR/QC/文字起こし閲覧、コマンド永続化
- Mac/GAG: キューclaim、Palmier localhost MCP操作、結果返却
- Premiere: XMEML v5＋SRT adapter対応。複雑なEssential Graphics・エフェクト・トランジションは未変換

認証はTailscale Serveによるtailnet境界を前提としています。公開インターネットへ直接bindしないでください。
