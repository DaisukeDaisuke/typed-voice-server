# typed-voice-server
`typed-voice-server`は1つの通常ユーザー権限Node.jsオーケストレータと、用途別Codex sandbox worker、多数の信頼済みブラウザWorkerで音声合成を行うサーバーです。<br>親Node.jsはプロセス管理・秘密値生成・stdioメッセージ仲介だけを担当し、HTTP/WSS解析、Remote暗号処理、Trusted Worker接続処理、履歴・設定・token・pairing fileの永続I/Oは親プロセスから分離します。<br>
## 構成
- `server-main.mjs`自身はHTTP/TCP listenerを作らず、永続ファイルも書きません。<br>`admin`、`worker`、`remote`をそれぞれ別のCodex offline sandbox・別loopback portで常駐させ、各子プロセスとの双方向通信は継承stdin/stdoutの長さ制限付きNDJSONだけを使います。<br>
- `storage-worker.mjs`はCodex elevated offline sandbox childとして動かし、`server/`だけをread、`data/`だけをread/writeできるpermission profileを使います。<br>Node.js実体は起動前に絶対パスへ解決し、その実体ディレクトリだけを追加read rootとして許可します。Storage workerにfull-disk readは与えません。<br>公開HTTP 3 workerにはCodex層で`data/`を明示deny-readし、storageだけに永続データのread/writeを許可します。`unelevated` backendは使用しません。<br>
- 各Node sandbox workerはNode.js Permission Modelも有効にし、役割ごとのfilesystem allowlistだけを渡します。<br>`child_process`、native addon、Worker Threads、WASI、Inspectorを許可するフラグは渡さず、Codex Windows sandboxが公開HTTP worker間で共有sandbox accountを使うことによる追加経路を狭めます。<br>Node Permission Modelは悪意コード向けの正式sandboxではないため、各workerの主境界はCodex elevated sandboxのnetwork/filesystem ACLです。<br>
- Windows版Codexは公開HTTP workerごとに別OSユーザーを作らず、固定`CodexSandboxOffline`アカウントを共有します。<br>そのため本設計が直接保証するのは、公開HTTP worker内のJavaScript/Node実行が他loopback portへ接続できないこと、`data/`を読めないこと、Node Permission Modelで通常のprocess/addon拡張経路を持たないこと、親stdioが固定操作だけを受理することです。<br>Codex sandbox内で任意native code実行まで成立した後のWindows process-object間アクセスについて、stock Codexはsandbox invocationごとの独立OS identityを提供していません。そこまでを「別workerへ横移動不能」とするにはCodex側のper-invocation identity/AppContainer等の追加境界が必要であり、このリポジトリ側だけで完全隔離済みとは扱いません。<br>
- 通常起動で自動公開するQuick Tunnelは`remote`だけです。<br>`admin`と`worker`はloopbackだけに残し、必要な場合だけ`--open-admin=true` / `--open-worker=true`を明示して、それぞれ別のQuick Tunnelを起動します。<br>cloudflaredはCodex online workspace、各HTTP workerはCodex offline sandboxなので、公開HTTP workerが侵害されてもCodexのWindows network境界を破らない限り別loopback portへoutbound接続できない構成です。<br>
- 3つのHTTP workerがreadyになった直後、各worker自身から残り2つのloopback portへ接続を試す起動時境界probeを必ず実行します。<br>1本でも接続できた場合はQuick Tunnelを公開する前に起動失敗とし、Codex/Windows Firewall設定が想定より広い状態でfail-openしません。<br>
- Node.jsサーバー自身はChromeを起動しません。<br>Chrome DevTools Protocol、Chrome PID追跡、Chrome用watchdog、WebMCPは使用しません。<br>
- Worker browser本体は`https://daisukedaisuke.github.io/typed-voice/worker.html`から配信します。<br>`/worker/login#<current-token>`はloopback側で短寿命Worker接続トークンを確認した後、公開Remote WSS URLを`server=`へ、同じWorker tokenをfragmentへ入れてGitHub Pagesの`worker.html`へ遷移します。<br>server releaseはWorker HTML/JS/WASMを同梱・配信しません。<br>
- Workerは開いたブラウザごとに動的に増減します。<br>固定`--multi`はありません。<br>
- Workerが切断またはPING timeoutになった場合、そのWorkerは死亡扱いにし、処理中ジョブは全体timeout内なら待ち行列先頭へ戻して別Workerへ再割当します。<br>
## Trusted Worker接続認証
サーバー起動ごとに64-byteのWorker access secretをメモリ内だけで生成し、その秘密と10分単位のtime windowからHMAC-SHA-512の512-bit tokenを導出します。<br>tokenは128桁小文字hexで10分ごとに変化し、window境界の時計ずれ対策として直前tokenは新window開始後30秒間だけ受け付けます。<br>長期secret自体はファイルへ保存しません。<br>
現在tokenだけを`data/worker/session-token.txt`へstorage sandboxから原子的に上書きします。<br>POSIXでは`0600`、WindowsではPOSIX mode/chmodを使わず既存`data/`のWindows ACLを継承し、Codex storage capabilityだけにwrite権限を追加します。<br>起動時とローテーション時に絶対ファイルパス・有効期限・token入りWorker login URLをstdioへ表示します。<br>対応terminalではOSC 8 hyperlinkとしてクリック可能にし、非対応terminalでも完全URLを読める形で出力します。<br>管理tokenも起動時にtoken入りAdmin login URLとしてstdioへ表示します。<br>サーバー停止時にtoken fileを削除します。<br>
Worker参加者は`/worker/login#<session-token.txtの内容>`を開きます。<br>fragmentはHTTP URLへ送られず、login bootstrapが同一originの`POST /worker/session`本文としてtokenを送信します。<br>正しい場合だけHttpOnly・SameSite=StrictのWorker Cookieを発行し、その後GitHub Pagesの`worker.html?server=wss%3A%2F%2F...%2Fremote#<token>`へ遷移します。<br>GitHub Pages側はViteが生成した同一originのHTML/JS/WASMを使用し、Worker接続時のtoken検証は公開`/remote` WSSからTrusted Worker sandboxへ中継した後に行います。<br>すでに確立済みの暗号化Worker WSSは10分境界で強制切断せず、新規参加・再接続だけ最新tokenを要求します。<br>
緊急失効用に起動ごとに別の64-byte random secretを生成し、storage sandboxから`data/worker/reset-token.txt`へ改行なし128桁hexで保存します。<br>POSIXでは`0600`、Windowsでは既存`data/`のWindows ACLを継承します。<br>`POST /worker/reset`はTrusted Worker sandboxのloopback listenerへの直接接続だけを受け付け、`Forwarded`/`X-Forwarded-*`が付いたreverse proxy経由の要求は正しいsecretでも404にします。<br>この値をlocalhostのreset endpoint本文へそのまま送るとWorker access secret自体を即時再生成し、現在の10分token/Cookieを無効化し、接続済みWorkerも切断して新tokenを同じsession-token fileとstdioへ即時発行します。<br>誤ったreset tokenには404だけを返し、reset secret本体はstdioへ出しません。<br>
通常はreset secretを引数やstdioへ出さず、`node scripts/reset-worker-access.mjs`を実行すればローカルのreset-token fileと`data/server/listen-port.txt`を読み、実際にbindされたloopback portへPOSTして同じ緊急失効を行えます。<br>固定portで起動したい場合だけserverへ`--port`を指定します。<br>
Workerは合成対象テキストと生成音声を扱えるため、Worker接続トークンは信頼できる参加者だけへ渡します。<br>任意第三者Worker、reputation、多数決による偽音声検出はこの構成の信頼境界に含めません。<br>
## Trusted Worker暗号化セッション
Worker参加時にブラウザとNode.jsはP-256 ECDHの一時鍵ペアを生成し、WSS上で公開鍵と32-byte nonceを交換します。<br>共有秘密からHKDF-SHA-256で方向別AES-256-GCM鍵、方向別4-byte nonce prefix、proof keyを派生し、双方のHMAC-SHA-256 proofが一致した後だけWorkerセッションを有効化します。<br>Worker秘密鍵はブラウザセッション外へ保存しません。<br>
サーバーからWorkerへCONFIG、SYNTH、CANCELなどのアプリメッセージを送る前には暗号化PINGを送信し、対応するPONGを5秒以内に受信できた場合だけ本メッセージを送ります。<br>アイドル中も15秒ごとにPINGします。<br>モデルのダウンロード・初期化・音声生成はPING/PONG受信ループをブロックしません。<br>
## Remoteクライアント暗号
Remoteクライアント向け`/remote`は従来どおりWSS/TLSだけに依存しません。<br>起動ごとに32-byte `authKey`と32-byte `encryptionKey`を生成し、HMAC-SHA-256認証、HKDF-SHA-256鍵派生、方向別AES-256-GCMを使用します。<br>AUTHは接続後20秒以内に完了する必要があります。<br>
## ペアリング情報
Remote用公開HTTPS originが確定すると、そのoriginの`wss://<host>/remote`を使ってQR payloadと`data/pairing/typed-voice-server.tvrkey`をstorage sandbox内で生成します。<br>接続JSONは固定wrap鍵によるAES-256-GCMで包み、QRには`TVRKEY1`バイナリをbase64url化した`tvrkey1:<...>`だけを入れます。<br>`.tvrkey`も同じ暗号化バイナリで、生のendpoint/authKey/encryptionKeyはQRやファイルへ平文で置きません。<br>`.tvrkey`はPOSIXでは`0600`、Windowsでは既存`data/`のWindows ACLを継承します。<br>固定wrap鍵は秘匿境界ではなく公開露出を避ける難読化で、実際のRemote認証強度は起動ごとの`authKey`/`encryptionKey`が担います。<br>`.tvrkey`の実パスは起動ログへ表示し、サーバー停止時に削除します。<br>
Quick TunnelではRemote用URLだけをpairing endpointに使用し、Admin・Trusted Workerはそれぞれ別URLを持ちます。<br>Remote originを外部で用意する場合は`--public-origin https://...`、Worker/Adminは必要に応じて`--worker-public-origin`、`--admin-public-origin`で個別指定できます。<br>
## 管理ページのプライバシー保護
起動ごとに32-byte random値を64桁小文字hexへ符号化した管理セッショントークンを生成し、storage sandboxから`data/admin/session-token.txt`へ保存します。<br>POSIXでは`0600`、Windowsでは既存`data/`のWindows ACLを継承します。<br>起動ログにはトークン本体ではなく絶対ファイルパスだけを表示します。<br>
最初に`/admin/login#<session-token.txtの内容>`へアクセスします。<br>tokenはURL fragmentなのでHTTPリクエストやproxy access URLへ送られず、login bootstrapが同一originの`POST /admin/session`本文としてTLS内で送信します。<br>正しい場合だけHttpOnly・SameSite=Strictの管理Cookieを発行して`/admin/`へ遷移します。<br>管理HTML/CSS/JSと`/admin/ws`のWebSocket Upgradeは同じCookie検証を通らない限り404または接続拒否になり、トークン未所持者は管理WebSocketへ到達できません。<br>トークンはそのサーバープロセスの終了まで有効で、再起動時にローテーションします。<br>
## モデルとWorker
管理画面で`fp32`、`fp16`、`mobile-int8`、`mobile-int4`を選択できます。<br>選択は`data/settings.json`へ保存します。<br>変更時は参加中Workerへ新しいCONFIGを送り、各Workerが自分のブラウザ内でモデルを再準備します。<br>合成文章は実際に処理を担当するTrusted Workerへ送信されるため、Worker tokenを渡した参加者は入力内容を扱える信頼主体として扱います。<br>
## 実行
Release artifactにはWorker browser assetsを含めません。Worker UIと実行モジュールはtyped-voiceのGitHub Pages deploymentから取得します。<br>実行にはNode.js 22.13以上、25未満が必要です。<br>
Windowsでの通常起動はRelease artifact内の`Server.cmd`をダブルクリックします。<br>`Server.cmd`はUTF-8 consoleへ切り替え、`docker.mjs`でNode.js、cloudflared、Codex CLI、Codex sandbox setup、配布ファイルを事前確認し、失敗時は`server-main.mjs`を起動しません。<br>
直接のNode.js起動は開発・高度なオプション指定用です。<br>
```text
node server-main.mjs
```
通常起動ではsandbox内のAdmin、Trusted Worker、Remote listenerがそれぞれloopbackの実ポートを確定した後、Remote portだけに`cloudflared tunnel --url http://127.0.0.1:<実ポート>`をCodex online workspaceで起動します。<br>Admin/Trusted Workerも外部公開する場合は`--open-admin=true` / `--open-worker=true`を明示します。指定しない場合のAdmin/Worker login URLは`http://127.0.0.1:<実ポート>/...#<token>`のOSC 8リンクとしてstdioへ出し、`(tunnel disabled)`を併記します。<br>`--port`はTrusted Worker port、`--remote-port`はRemote port、`--admin-port`はAdmin portを固定する場合だけ指定します。<br>すべてのQuick Tunnelを起動しない場合は`--no-quick-tunnel`を指定します。<br>
```text
node server-main.mjs --no-quick-tunnel
```
## Codespaces開発環境
`.devcontainer`はNode.js 22、SSH server、Codex CLI 0.147.0、cloudflared 2026.8.2を準備します。<br>Codex CLI自体は通常の`vscode`ユーザーへ導入します。<br>Codespace内でCodexのLinux sandboxが必要とするnamespace/mount操作を許可するためcontainerは`privileged`で作成し、devcontainer作成時には`node scripts/codex-sandbox-check.mjs --non-interactive`で実際のsandbox起動を確認します。<br>LinuxでWindows専用setupは実行しません。<br>Windowsでは初回のelevated sandbox provisioningを自動実行せず、未初期化時だけ英語の`y/N`確認を出します。<br>Windowsの手動管理者セットアップ手順は`INSTALL.md`にあります。<br>SSH serverはCodespace MCP/`gh codespace ssh`から接続できるよう有効化します。<br>devcontainerの`forwardPorts: [3000]`は固定portを明示した手動検証用で、通常起動はOSが割り当てた実ポートをQuick Tunnelへ直接渡します。<br>`server-main.mjs`全体をCodex内部へ入れる設計ではありません。<br>通常ユーザー権限の親Node.jsが用途別sandbox workerを兄弟プロセスとして起動するため、Codex sandboxをネストしません。<br>Windowsではoffline sandboxのloopback outbound遮断をport間境界として使います。LinuxのCodex offline sandboxはnetwork namespaceを分離するため、Windowsと同じhost-loopback ingress経路は別途実働検証が必要です。<br>`.devcontainer`変更後は既存Codespaceのcontainer rebuildが必要です。<br>
Worker browserのbuild・Kanalizer/ONNX runtime asset解決は`typed-voice` repository自身のPages workflowで`npm run build`へ任せ、server repositoryは生成済みブラウザassetを作成・同梱しません。<br>
## 実働検証
Codespaces、temporary public deployment、Quick Tunnel、管理セッショントークン、10分Worker接続トークン、Trusted Worker、Remote TEXT→AUDIOの検証手順は`docs/codespace-validation.md`にあります。<br>
