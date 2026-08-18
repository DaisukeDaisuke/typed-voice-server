# typed-voice-server
typed-voiceをPC側のWebGPU/ブラウザ音声エンジンで合成し、Cloudflare Quick Tunnel経由のWSSから利用するローカルサーバーです。
## セキュリティ境界
- `server-main.mjs`は通常ユーザー権限の信頼側オーケストレータです。管理HTTP/WebSocketをlistenしません。
- `worker/websocket-worker.mjs`はCodex offline sandbox内で`127.0.0.1:random`へ公開origin用WebSocketをlistenします。`allow_local_binding=true`ですが非loopback外向き通信は許可しません。
- `admin/admin-worker.mjs`はpublic workerとは別のCodex offline sandbox内で、49152-65535から初回選択して`data/settings.json`へ保存した固定`127.0.0.1:<high-port>`へ管理HTTP/WebSocketとserver-engine assetsをlistenします。同じoriginを再利用するため、固定ChromeプロファイルのService Worker/Cache Storageとモデルキャッシュも再起動後に再利用できます。管理workerと`server-main.mjs`の通信はstdin/stdout NDJSONだけです。
- `cloudflared`はCodex `onlineworkspace`で起動し、public workerのloopback portだけをQuick Tunnelへ中継します。`cloudflared`へ`allow_local_binding=true`は付けません。
- Codex sandboxのpermission profile生成と起動は`server/codex-sandbox-launcher.mjs`へ独立実装しています。`local-mcp-chatgpt-tunnel`は実行時依存ではありません。
## 通信暗号
WSS/TLSだけには依存しません。QRには起動ごとに生成する32-byte `authKey`と32-byte `encryptionKey`を入れます。認証はHMAC-SHA-256、セッション鍵派生はHKDF-SHA-256、認証後の通信は方向別AES-256-GCMです。C2S/S2CでAES keyと4-byte nonce prefixを分離し、各方向の8-byte `seq`を連結した12-byte nonceを使用します。20-byte header全体をAADとして認証します。AUTHはWSS接続後20秒以内にHMAC検証成功まで完了する必要があります。
## QR
QR payloadはraw UTF-8 JSONです。
```json
{"v":1,"u":"wss://xxxxx.trycloudflare.com/remote","a":"<authKey-base64url>","e":"<encryptionKey-base64url>","c":"<checksum-base64url>"}
```
`c`は`typed-voice-remote-qr/v1\n`、WSS URL、NUL、raw authKey、raw encryptionKeyを連結したSHA-256の先頭16 bytesです。QR生成は管理ブラウザが固定版jsDelivrライブラリを使ってcanvas上で行い、QR payloadを外部QRサービスへ送信しません。
## 接続キーファイル
QRを使えない端末向けに、同じペアリング情報をAES-256-GCMで包んだ`data/pairing/typed-voice-server.tvrkey`を起動ごとに自動生成します。ファイル包み鍵はクライアント実装にも固定で含まれる難読化用であり、通信認証の代わりではありません。実際の通信鍵は起動ごとの`authKey`/`encryptionKey`です。クライアントのpairing画面は`.tvrkey`のraw binaryと、その同一bytesをBase64/Base64URL化したテキストの両方を受け付けます。起動完了時に`realpath`で解決した絶対ファイルパスをコンソールへ表示し、停止時にその起動分のファイルを削除します。
## 音声転送
クライアントはハンドシェイク時に`PCM16LE mono`または`Float32LE mono`を選択できます。PC側Chrome/WebMCPはFloat32で合成し、PCM16指定時だけsandbox workerがPCM16LEへ変換します。AUDIOは64KiB単位で分割します。
## Chrome multi
`--multi N`はChromeプロセスをN個起動しません。1つの永続`--user-data-dir`を使うChromeプロセスを1つ起動し、その中にserver-engineタブをN枚作ります。最初のタブがService Workerとモデル準備を完了した後に残りのタブを作るため、Cache Storageとモデルキャッシュを共有します。`--disable-background-timer-throttling`、`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`を指定します。N件までは同時実行し、それを超えた要求はFIFO待ち行列へ入れます。
## WebMCP
server-engineページは`typed-voice.status`、`typed-voice.synthesize`、`typed-voice.cancel`を登録します。Node側はChrome DevTools Protocolから`document.modelContext.getTools()`と`executeTool()`を使って呼び出します。音声推論実装をNodeへ複製しません。
## UUID履歴
クライアントは認証後の暗号化`SESSION`で会話UUIDを通知します。信頼側は`data/history/index.json`へUUIDメタデータ索引を持ち、内容は`data/history/<uuid>.ndjson`へappend-onlyで保存します。TEXT到着時に`request`イベントを追記し、成功・失敗・キャンセル時に`result`イベントを追記します。管理画面へ履歴本文を常時送信せず、UUID指定の`history-get`でメタデータと内容を取得し、`history-subscribe`中のUUIDだけ新規イベントをリアルタイムpushします。
## 管理画面
管理画面自体もCodex sandbox内のadmin workerが配信します。`server-main.mjs`は起動時に32-byte管理tokenを生成し、管理URL fragmentとしてブラウザへ渡します。ブラウザはtokenをsessionStorageへ移してfragmentを即座に消し、同一originの`/admin` WebSocketを認証します。管理画面ではQR、Tunnel、Chrome/WebMCP、各`--multi`スロット、同時処理数、接続セッション、UUID指定履歴、ブラウザ内CDP JavaScriptデバッグ、モデル選択、接続切断を確認できます。選択モデルは`data/settings.json`へ永続化し、次回起動で復元します。
## 実行
Release artifactにはnpm依存を含めません。Node.js 22以上、Google Chrome、Codex、cloudflaredをPC側に用意して、展開ディレクトリで直接実行します。
```text
node server-main.mjs --multi 3
```
主なオプションは`--multi 1..8`、`--profile fp32|fp16|mobile-int8|mobile-int4`、`--chrome <path>`、`--codex <path>`、`--cloudflared <path>`、`--no-open-ui`です。
## GitHub Actions
`.github/workflows/build.yml`は親Nodeコアテストを実行し、`typed-voice` submoduleだけを初期化してCI上で`npm ci`、typed-voiceテスト、Vite buildを実行します。GitHub PagesやCodespacesは配布経路に使いません。ビルド済みbrowser assetsと既存のライセンス表示一式をRelease ZIPの`engine/`へ同梱し、実行PCではnpm/Pythonを使いません。Releaseは`typed-voice-server-latest`を更新します。`local-mcp-chatgpt-tunnel` submoduleはCIで初期化しません。
## 実働検証
Codexへ渡すWindows実機の検証項目は`docs/codex-validation.md`にあります。public/admin sandbox、暗号AUTH、multiタブ、TEXT→AUDIO、UUID履歴API、Quick Tunnelまでを実働で確認する前提です。
