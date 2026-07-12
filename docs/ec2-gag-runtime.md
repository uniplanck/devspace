# EC2 GAG Runtime

EC2上でGPT-Agent Runtimeを安全に準備するための手順。既定ではlistener、systemd、外部公開を開始しない。

## 前提

- user: `ubuntu`
- GPT-Agent: `/home/ubuntu/GPT-Agent`
- AI-Agent-Core: `/home/ubuntu/AI-Agent-Core`
- digest: `/home/ubuntu/copy.txt`
- Node.js: 22.19以上

## 準備

```bash
cd /home/ubuntu/GPT-Agent
bash scripts/ec2-gag-bootstrap.sh prepare
bash scripts/ec2-gag-bootstrap.sh verify
bash scripts/ec2-gag-doctor.sh
```

`prepare`は依存導入とbuildまで行う。runtime起動、systemd登録、Tailscale Funnel、public listenerは行わない。

## Tailscale内限定の常駐化

明示承認後に次を実行する。

```bash
cd /home/ubuntu/GPT-Agent
npm run ec2:configure
npm run ec2:service:install
npm run ec2:service:verify
```

`gpt-agent-ec2.service`は`127.0.0.1:7676`だけにbindし、Tailscale Serveがtailnet内限定HTTPSで中継する。`0.0.0.0`、Public IP、Tailscale Funnelには公開しない。Minecraftを優先するため、GAGには低いCPU/IO weight、`MemoryHigh=768M`、`MemoryMax=1400M`、高いOOM scoreを設定する。

停止・無効化は次で行う。

```bash
npm run ec2:service:disable
```

OAuth owner tokenは`/home/ubuntu/.devspace/auth.json`へ権限600で保存し、標準出力には表示しない。

## 設定値の確認

```bash
bash scripts/ec2-gag-bootstrap.sh print-env
```

出力にはsecretを含めない。OAuth owner tokenは既存の`devspace init`または認証手順で別途生成し、Chatへ出力しない。

## 接続先識別

EC2側では`DEVSPACE_NODE_ROLE=ec2`、Mac側では`DEVSPACE_NODE_ROLE=mac`を利用する。ChatGPTの接続名は`GPT-Agent Mac`と`GPT-Agent EC2`のように明示的に分ける。自動フェイルオーバーは、誤ったホストで本番操作する危険があるため初期段階では行わない。

Tailscale内限定URLはChatGPTクラウドから直接到達できない。ChatGPTへ`GPT-Agent EC2`として登録するには、別途Cloudflare Tunnel等のHTTPS中継が必要になる。Tailscale Funnelや外部HTTPS中継は、外部公開を伴うため別承認で実施する。

## 許可範囲

初期allowed roots:

- `/home/ubuntu/AI-Agent-Core`
- `/home/ubuntu/GPT-Agent`
- `/home/ubuntu`

実運用では`/home/ubuntu`全体より、案件ごとのrootを個別追加する方が安全。

## 明示承認が必要な操作

- systemd/cron/listenerの有効化
- Tailscale Funnelまたは外部公開
- main push、deploy、queue mutation
- secret表示・変更
- 本番サービスの再起動
