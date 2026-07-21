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

現在の`apply_ir`はCaption MVPです。`caption`操作をPalmierの`add_texts`へ変換し、同じ開始frame・duration・本文が既に存在する場合は`already_present`として重複追加しません。`select_range`と`remove_range`は素材対応表とカットマッピングが完成するまで`unsupported`を明示して実行しません。

検証用の空プロジェクトは `fixtures/empty-lab.palmier` です。

## テスト

```bash
node test.mjs
```

## 現在の境界

- EC2: ダッシュボード、IR/QC/文字起こし閲覧、コマンド永続化
- Mac/GAG: キューclaim、Palmier localhost MCP操作、結果返却
- Premiere: 将来、同じEditorial IRからXMLまたはUXPへ変換

認証はTailscale Serveによるtailnet境界を前提としています。公開インターネットへ直接bindしないでください。
