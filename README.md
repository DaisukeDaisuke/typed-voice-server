# typed-voice-server
`typed-voice-server`は1つのNode.jsオーケストレータと、多数の信頼済みブラウザWorkerで音声合成を行うサーバーです。Node.js側はHTTP/WSS、暗号化Remoteクライアント、管理画面、履歴、Worker認証・割当を担当し、WebGPU推論は短寿命Worker接続トークンで認証されたブラウザだけが担当します。
## 構成
- `server-main.mjs`は`0.0.0.0:3000`を既定値として、`/admin/`、`/admin/ws`、`/worker/`、`/worker/ws`、`/remote`、`/health`を1つのNode.jsプロセスで提供します。
- Node.jsサーバー自身はChromeを起動しません。Chrome DevTools Protocol、Chrome PID追跡、Chrome用watchdog、WebMCPは使用しません。
- Worker browserは一般公開しません。`/worker/login#<current-token>`で短寿命Worker接続トークンをCookieへ交換したブラウザだけが`/worker/`のHTML/JS/WASMと`/worker/ws`へ到達できます。
- Workerは開いたブラウザごとに動的に増減します。固定`--multi`はありません。
- Workerが切断またはPING timeoutになった場合、そのWorkerは死亡扱いにし、処理中ジョブは全体timeout内なら待ち行列先頭へ戻して別Workerへ再割当します。
## Trusted Worker接続認証
サーバー起動ごとに64-byteのWorker access secretをメモリ内だけで生成し、その秘密と10分単位のtime windowからHMAC-SHA-512の512-bit tokenを導出します。tokenは128桁小文字hexで10分ごとに変化し、window境界の時計ずれ対策として直前tokenは新window開始後30秒間だけ受け付けます。長期secret自体はファイルへ保存しません。
現在tokenだけを`data/worker/session-token.txt`へ`0600`で原子的に上書きし、起動時とローテーション時にtoken本体ではなく絶対ファイルパスと有効期限だけをstdioへ表示します。サーバー停止時にtoken fileを削除します。
Worker参加者は`/worker/login#<session-token.txtの内容>`を開きます。fragmentはHTTP URLへ送られず、login bootstrapが同一originの`POST /worker/session`本文としてTLS内でtokenを送信します。正しい場合だけHttpOnly・SameSite=StrictのWorker Cookieを発行します。Cookieのtokenが現在windowまたは30秒grace内の直前windowと一致しない場合、Worker assetsと`/worker/ws` WebSocket Upgradeは拒否されます。すでに確立済みの暗号化Worker WSSは10分境界で強制切断せず、新規参加・再接続だけ最新tokenを要求します。
Workerは合成対象テキストと生成音声を扱えるため、Worker接続トークンは信頼できる参加者だけへ渡します。任意第三者Worker、reputation、多数決による偽音声検出はこの構成の信頼境界に含めません。
## Trusted Worker暗号化セッション
Worker参加時にブラウザとNode.jsはP-256 ECDHの一時鍵ペアを生成し、WSS上で公開鍵と32-byte nonceを交換します。共有秘密からHKDF-SHA-256で方向別AES-256-GCM鍵、方向別4-byte nonce prefix、proof keyを派生し、双方のHMAC-SHA-256 proofが一致した後だけWorkerセッションを有効化します。Worker秘密鍵はブラウザセッション外へ保存しません。
サーバーからWorkerへCONFIG、SYNTH、CANCELなどのアプリメッセージを送る前には暗号化PINGを送信し、対応するPONGを5秒以内に受信できた場合だけ本メッセージを送ります。アイドル中も15秒ごとにPINGします。モデルのダウンロード・初期化・音声生成はPING/PONG受信ループをブロックしません。
## Remoteクライアント暗号
Remoteクライアント向け`/remote`は従来どおりWSS/TLSだけに依存しません。起動ごとに32-byte `authKey`と32-byte `encryptionKey`を生成し、HMAC-SHA-256認証、HKDF-SHA-256鍵派生、方向別AES-256-GCMを使用します。AUTHは接続後20秒以内に完了する必要があります。
## ペアリング情報
公開HTTPS originが確定すると、同じoriginの`wss://<host>/remote`を使ってQR payloadと`data/pairing/typed-voice-server.tvrkey`を生成します。QR payloadは`{"v":1,"u":"wss://.../remote","a":"<authKey>","e":"<encryptionKey>","c":"<checksum>"}`です。`.tvrkey`の実パスは起動ログへ表示し、サーバー停止時に削除します。
認証済み管理ページをHTTPSで開くと、管理ページ自身の`location.origin`をNode.jsへ通知します。そのためCodespaces公開URLと`trycloudflare.com`のどちらでも、実際に開いた経路をそのままペアリング先として使用できます。`--public-origin https://...`で明示指定もできます。
## 管理ページのプライバシー保護
起動ごとに`SHA-256(random 32 bytes)`形式の64桁小文字hex管理セッショントークンを生成し、`data/admin/session-token.txt`へ`0600`で保存します。起動ログにはトークン本体ではなく絶対ファイルパスだけを表示します。
最初に`/admin/login#<session-token.txtの内容>`へアクセスします。tokenはURL fragmentなのでHTTPリクエストやproxy access URLへ送られず、login bootstrapが同一originの`POST /admin/session`本文としてTLS内で送信します。正しい場合だけHttpOnly・SameSite=Strictの管理Cookieを発行して`/admin/`へ遷移します。管理HTML/CSS/JSと`/admin/ws`のWebSocket Upgradeは同じCookie検証を通らない限り404または接続拒否になり、トークン未所持者は管理WebSocketへ到達できません。トークンはそのサーバープロセスの終了まで有効で、再起動時にローテーションします。
## モデルとWorker
管理画面で`fp32`、`fp16`、`mobile-int8`、`mobile-int4`を選択できます。選択は`data/settings.json`へ保存します。変更時は参加中Workerへ新しいCONFIGを送り、各Workerが自分のブラウザ内でモデルを再準備します。合成文章は実際に処理を担当するTrusted Workerへ送信されるため、Worker tokenを渡した参加者は入力内容を扱える信頼主体として扱います。
## 実行
Release artifactはビルド済みWorker browser assetsを`engine/`へ含みます。実行にはNode.js 22以上が必要です。
```text
node server-main.mjs --host 0.0.0.0 --port 3000
```
Quick Tunnelを使う場合は別プロセスで次を実行します。
```text
cloudflared tunnel --url http://localhost:3000
```
## Codespaces開発環境
`.devcontainer`はNode.js 22、Rust/Kanalizer、SSH server、Codex CLI 0.147.0、cloudflared 2026.8.2、Worker browser buildを準備します。Codex CLI自体は通常の`vscode`ユーザーへ導入します。Codespace内でCodexの既定Linux bubblewrap sandboxが必要とするnamespace/mount操作を許可するためcontainerは`privileged`で作成し、devcontainer作成時に`codex sandbox linux --full-auto /usr/bin/true`を実行してworkspace-write相当のLinux sandboxが実際に起動できることをsmoke testします。誤って追加していた`sudo codex sandbox setup --elevated --current-user`はLinuxではsetupコマンドではないため実行しません。SSH serverはCodespace MCP/`gh codespace ssh`から実働検証できるよう有効化します。Codespaces forwardingはdevcontainerの`forwardPorts: [3000]`へ固定し、Node.jsサーバーの既定listen先も`0.0.0.0:3000`です。サーバー自身をCodex内部から再帰起動する設計ではなく、必要な実働テスト時にサーバープロセス全体をCodex sandboxで起動します。`.devcontainer`変更後は既存Codespaceのcontainer rebuildが必要です。
## 実働検証
Codespaces、temporary public deployment、Quick Tunnel、管理セッショントークン、10分Worker接続トークン、Trusted Worker、Remote TEXT→AUDIOの検証手順は`docs/codespace-validation.md`にあります。
