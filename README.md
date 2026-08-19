# typed-voice-server
`typed-voice-server`は1つのNode.jsオーケストレータと、多数の信頼済みブラウザWorkerで音声合成を行うサーバーです。<br>Node.js側はHTTP/WSS、暗号化Remoteクライアント、管理画面、履歴、Worker認証・割当を担当し、WebGPU推論は短寿命Worker接続トークンで認証されたブラウザだけが担当します。<br>
## 構成
- `server-main.mjs`は`0.0.0.0`へbindし、`--port`未指定時はOSが空いているエフェメラルポートを割り当てます。<br>`/admin/`、`/admin/ws`、`/worker/`、`/worker/ws`、`/remote`、`/health`を1つのNode.jsプロセスで提供します。<br>
- Node.jsサーバー自身はChromeを起動しません。<br>Chrome DevTools Protocol、Chrome PID追跡、Chrome用watchdog、WebMCPは使用しません。<br>
- Worker browserは一般公開しません。<br>`/worker/login#<current-token>`で短寿命Worker接続トークンをCookieへ交換したブラウザだけが`/worker/`のHTML/JS/WASMと`/worker/ws`へ到達できます。<br>
- Workerは開いたブラウザごとに動的に増減します。<br>固定`--multi`はありません。<br>
- Workerが切断またはPING timeoutになった場合、そのWorkerは死亡扱いにし、処理中ジョブは全体timeout内なら待ち行列先頭へ戻して別Workerへ再割当します。<br>
## Trusted Worker接続認証
サーバー起動ごとに64-byteのWorker access secretをメモリ内だけで生成し、その秘密と10分単位のtime windowからHMAC-SHA-512の512-bit tokenを導出します。<br>tokenは128桁小文字hexで10分ごとに変化し、window境界の時計ずれ対策として直前tokenは新window開始後30秒間だけ受け付けます。<br>長期secret自体はファイルへ保存しません。<br>
現在tokenだけを`data/worker/session-token.txt`へ原子的に上書きします。<br>POSIXでは`0600`、WindowsではPOSIX mode/chmodを使わず実行ユーザーで作成してWindows ACLを継承します。<br>起動時とローテーション時に絶対ファイルパス・有効期限・token入りWorker login URLをstdioへ表示します。<br>対応terminalではOSC 8 hyperlinkとしてクリック可能にし、非対応terminalでも完全URLを読める形で出力します。<br>管理tokenも起動時にtoken入りAdmin login URLとしてstdioへ表示します。<br>サーバー停止時にtoken fileを削除します。<br>
Worker参加者は`/worker/login#<session-token.txtの内容>`を開きます。<br>fragmentはHTTP URLへ送られず、login bootstrapが同一originの`POST /worker/session`本文としてTLS内でtokenを送信します。<br>正しい場合だけHttpOnly・SameSite=StrictのWorker Cookieを発行します。<br>Cookieのtokenが現在windowまたは30秒grace内の直前windowと一致しない場合、Worker assetsと`/worker/ws` WebSocket Upgradeは拒否されます。<br>すでに確立済みの暗号化Worker WSSは10分境界で強制切断せず、新規参加・再接続だけ最新tokenを要求します。<br>
緊急失効用に起動ごとに別の64-byte random secretを生成し、`data/worker/reset-token.txt`へ改行なし128桁hexで保存します。<br>POSIXでは`0600`、WindowsではPOSIX mode/chmodを使わず実行ユーザーで作成してWindows ACLを継承します。<br>`POST /worker/reset`はloopbackからの直接接続だけを受け付け、`Forwarded`/`X-Forwarded-*`が付いたreverse proxy経由の要求は正しいsecretでも404にします。<br>この値をlocalhostのreset endpoint本文へそのまま送るとWorker access secret自体を即時再生成し、現在の10分token/Cookieを無効化し、接続済みWorkerも切断して新tokenを同じsession-token fileとstdioへ即時発行します。<br>誤ったreset tokenには404だけを返し、reset secret本体はstdioへ出しません。<br>
通常はreset secretを引数やstdioへ出さず、`node scripts/reset-worker-access.mjs`を実行すればローカルのreset-token fileと`data/server/listen-port.txt`を読み、実際にbindされたloopback portへPOSTして同じ緊急失効を行えます。<br>固定portで起動したい場合だけserverへ`--port`を指定します。<br>
Workerは合成対象テキストと生成音声を扱えるため、Worker接続トークンは信頼できる参加者だけへ渡します。<br>任意第三者Worker、reputation、多数決による偽音声検出はこの構成の信頼境界に含めません。<br>
## Trusted Worker暗号化セッション
Worker参加時にブラウザとNode.jsはP-256 ECDHの一時鍵ペアを生成し、WSS上で公開鍵と32-byte nonceを交換します。<br>共有秘密からHKDF-SHA-256で方向別AES-256-GCM鍵、方向別4-byte nonce prefix、proof keyを派生し、双方のHMAC-SHA-256 proofが一致した後だけWorkerセッションを有効化します。<br>Worker秘密鍵はブラウザセッション外へ保存しません。<br>
サーバーからWorkerへCONFIG、SYNTH、CANCELなどのアプリメッセージを送る前には暗号化PINGを送信し、対応するPONGを5秒以内に受信できた場合だけ本メッセージを送ります。<br>アイドル中も15秒ごとにPINGします。<br>モデルのダウンロード・初期化・音声生成はPING/PONG受信ループをブロックしません。<br>
## Remoteクライアント暗号
Remoteクライアント向け`/remote`は従来どおりWSS/TLSだけに依存しません。<br>起動ごとに32-byte `authKey`と32-byte `encryptionKey`を生成し、HMAC-SHA-256認証、HKDF-SHA-256鍵派生、方向別AES-256-GCMを使用します。<br>AUTHは接続後20秒以内に完了する必要があります。<br>
## ペアリング情報
公開HTTPS originが確定すると、同じoriginの`wss://<host>/remote`を使ってQR payloadと`data/pairing/typed-voice-server.tvrkey`を生成します。<br>接続JSONは固定wrap鍵によるAES-256-GCMで包み、QRには`TVRKEY1`バイナリをbase64url化した`tvrkey1:<...>`だけを入れます。<br>`.tvrkey`も同じ暗号化バイナリで、生のendpoint/authKey/encryptionKeyはQRやファイルへ平文で置きません。<br>`.tvrkey`はPOSIXでは`0600`、WindowsではPOSIX mode/chmodを使わず実行ユーザーで作成してWindows ACLを継承します。<br>固定wrap鍵は秘匿境界ではなく公開露出を避ける難読化で、実際のRemote認証強度は起動ごとの`authKey`/`encryptionKey`が担います。<br>`.tvrkey`の実パスは起動ログへ表示し、サーバー停止時に削除します。<br>
認証済み管理ページをHTTPSで開くと、管理ページ自身の`location.origin`をNode.jsへ通知します。<br>そのためCodespaces公開URLと`trycloudflare.com`のどちらでも、実際に開いた経路をそのままペアリング先として使用できます。<br>`--public-origin https://...`で明示指定もできます。<br>
## 管理ページのプライバシー保護
起動ごとに`SHA-256(random 32 bytes)`形式の64桁小文字hex管理セッショントークンを生成し、`data/admin/session-token.txt`へ保存します。<br>POSIXでは`0600`、WindowsではPOSIX mode/chmodを使わず実行ユーザーで作成してWindows ACLを継承します。<br>起動ログにはトークン本体ではなく絶対ファイルパスだけを表示します。<br>
最初に`/admin/login#<session-token.txtの内容>`へアクセスします。<br>tokenはURL fragmentなのでHTTPリクエストやproxy access URLへ送られず、login bootstrapが同一originの`POST /admin/session`本文としてTLS内で送信します。<br>正しい場合だけHttpOnly・SameSite=Strictの管理Cookieを発行して`/admin/`へ遷移します。<br>管理HTML/CSS/JSと`/admin/ws`のWebSocket Upgradeは同じCookie検証を通らない限り404または接続拒否になり、トークン未所持者は管理WebSocketへ到達できません。<br>トークンはそのサーバープロセスの終了まで有効で、再起動時にローテーションします。<br>
## モデルとWorker
管理画面で`fp32`、`fp16`、`mobile-int8`、`mobile-int4`を選択できます。<br>選択は`data/settings.json`へ保存します。<br>変更時は参加中Workerへ新しいCONFIGを送り、各Workerが自分のブラウザ内でモデルを再準備します。<br>合成文章は実際に処理を担当するTrusted Workerへ送信されるため、Worker tokenを渡した参加者は入力内容を扱える信頼主体として扱います。<br>
## 実行
Release artifactはビルド済みWorker browser assetsを`engine/`へ含みます。<br>実行にはNode.js 22以上が必要です。<br>
```text
node server-main.mjs --host 0.0.0.0
```
通常起動ではbind後の実ポートへ`cloudflared tunnel --url http://127.0.0.1:<実ポート> --no-autoupdate`を自動起動し、cloudflaredのstdout/stderrから`https://<random>.trycloudflare.com`を抽出してpairingを生成します。<br>固定portが必要なら`--port 3000`のように明示できます。<br>Quick Tunnelを起動しない場合は`--no-quick-tunnel`を指定します。<br>
```text
node server-main.mjs --host 0.0.0.0 --no-quick-tunnel
```
## Codespaces開発環境
`.devcontainer`はNode.js 22、Rust/Kanalizer、SSH server、Codex CLI 0.147.0、cloudflared 2026.8.2、Worker browser buildを準備します。<br>Codex CLI自体は通常の`vscode`ユーザーへ導入します。<br>Codespace内でCodexのLinux sandboxが必要とするnamespace/mount操作を許可するためcontainerは`privileged`で作成し、devcontainer作成時には`node scripts/codex-sandbox-check.mjs --non-interactive`で実際のsandbox起動を確認します。<br>LinuxでWindows専用setupは実行しません。<br>Windowsでは初回のelevated sandbox provisioningを自動実行せず、未初期化時だけ英語の`y/N`確認を出します。<br>手動の管理者セットアップを含むWindows/Linux共通手順は`INSTALL.md`にあります。<br>SSH serverはCodespace MCP/`gh codespace ssh`から接続できるよう有効化します。<br>devcontainerの`forwardPorts: [3000]`は固定portを明示した手動検証用で、通常起動はOSが割り当てた実ポートをQuick Tunnelへ直接渡します。<br>サーバー自身をCodex内部から再帰起動する設計ではなく、必要な実働テスト時にサーバープロセス全体をCodex sandboxで起動します。<br>`.devcontainer`変更後は既存Codespaceのcontainer rebuildが必要です。<br>
Worker buildは親repositoryが記録している`typed-voice` submodule commitをそのまま使用します。<br>post-create再実行時は親serverが生成する`vite.config.js`・`server-engine.html`・`src/server-engine.js`だけを戻し、それ以外のsubmodule変更がある場合は上書きせず停止します。<br>Trusted Workerはそのsubmoduleの`src/text/kanalizer-normalizer.js`から`src/kanalizer-wasm`を利用し、ASCII英字をKanalizer v5で正規化してから音声engineへ渡します。<br>
## 実働検証
Codespaces、temporary public deployment、Quick Tunnel、管理セッショントークン、10分Worker接続トークン、Trusted Worker、Remote TEXT→AUDIOの検証手順は`docs/codespace-validation.md`にあります。<br>
