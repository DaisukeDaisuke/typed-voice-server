# typed-voice-server Codespaces実働検証
## 目的
Windows実機の用途別Codex sandbox境界を壊さず、Codespacesでは同じstdio protocol・認証・Trusted Worker・Remote暗号通信のうち実行可能な部分を再現可能に確認する。
## 前提
- `server-main.mjs`は通常ユーザー権限の親オーケストレータで、HTTP listenerと永続ファイルwriteを持たない。Admin、Trusted Worker、Remoteは別々のCodex elevated offline sandbox child、storageはCodex unelevated restricted-token childとして起動し、親とはstdioだけで通信する。
- Windowsでは公開HTTP childすべてに`data/`のCodex deny-readを適用する。storageだけを共有`CodexSandboxOffline` identityから外すことで、このdeny-readをstorageへ波及させず、elevated write-root setupがsandbox groupへ秘密ファイルreadを付与する問題を避ける。
- Windowsでは各HTTP workerをCodex offline sandboxの別portに置き、offline sandboxのloopback outbound遮断を横移動防止境界として使う。Quick Tunnelは各portごとに別Codex online workspaceで起動する。
- Linux/CodespacesのCodex offline sandboxはnetwork namespaceを分離するため、Windowsと同じ「host側cloudflared→offline sandbox loopback listener」はそのまま成立すると仮定しない。Linux実働で到達不能ならsandboxを弱めず、その検証項目をWindows専用として扱う。
- `--port`はTrusted Worker listenerだけを固定する。Adminは`--admin-port`、Remoteは`--remote-port`で個別に固定できる。実Worker portは起動ログと`data/server/listen-port.txt`で確認する。
- Chrome/CDP自動起動、PID探索、Chrome kill、Chrome watchdogは行わない。
- WebGPU Workerは現在の10分Worker接続トークンを持つ信頼済み参加者だけが`/worker/login#<token>`から認証し、参加UIを押した場合だけ増える。
## devcontainer確認
1. `node --version`が22以上であることを確認する。
2. `codex --version`が成功することを確認する。
3. `cloudflared --version`が成功することを確認する。
4. `node scripts/codex-sandbox-check.mjs --non-interactive`が通常の`vscode`ユーザーで成功することを確認する。Linuxでは内部で`codex sandbox /usr/bin/true`または`/bin/true`を実行し、Windows専用setupや`sudo codex sandbox ...`は使わない。
5. `gh codespace ssh`/Codespace MCPから接続できるようSSH serverが有効であることを確認する。
6. `engine/server-engine.html`と対応するVite assetsが生成済みであることを確認する。
7. `node --test test/*.test.mjs`を実行する。
## Node.jsサーバー確認
1. 通常ユーザー権限で`node server-main.mjs`を起動し、親プロセス自身がlistenしていないことを確認する。親全体をCodex sandboxへ入れて子sandboxをネストしない。
2. 起動ログにAdmin、Trusted Worker、Remoteの3つの異なるloopback portが表示されることを確認する。Windowsでは各portのlistenerが別Codex offline sandbox childであることを確認する。
3. 起動ログに`data/admin/session-token.txt`の絶対パスと、token入りAdmin login URLが出ることを確認する。
4. `data/admin/session-token.txt`が64桁小文字hexであり、POSIX環境では0600であることを確認する。
5. 起動ログに`data/worker/session-token.txt`の絶対パス・有効期限・token入りWorker login URLが出ることを確認する。対応terminalではOSC 8 hyperlinkとしてクリック可能であり、非対応terminalでも完全URLが表示されることを確認する。Admin login URLも同様に起動時へ出す。
6. `data/worker/session-token.txt`が128桁小文字hexであり、POSIX環境では0600であること、10分window切替後に同じファイルへ新tokenだけが上書きされることを確認する。WindowsではPOSIX mode/chmodを使わず実行ユーザーのWindows ACLを継承することを確認する。
## Codespaces temporary public deployment
1. この項目はLinux Codex sandboxのnetwork namespace制約を確認した上で実施する。Windowsと同じoffline sandbox ingressが成立しない場合、HTTP workerをsandbox外へ移す・network権限を広げるなどの迂回はしない。
2. 実施可能な環境ではAdmin、Trusted Worker、Remoteの各portを混同せず、必要なportだけを個別にpublicにする。
3. tokenなしのAdmin originの`/admin/`が管理画面を返さないことを確認する。
4. `session-token.txt`の内容を使ってAdmin originの`/admin/login#<token>`へアクセスし、fragmentがHTTP URLへ送信されず、同一originの`POST /admin/session`成功後にCookie付き`/admin/`だけが表示されることを確認する。
5. token/Cookieなしの`/admin/ws` Upgradeが拒否されることを確認する。
6. Worker originとRemote originがAdmin originとは別port・別公開URLであることを確認する。
7. relayがbackendのHostを変更する場合でも、転送された公開originと設定済みrole originが厳密一致する場合だけAdmin/Worker sessionとWSSを受理することを確認する。
8. 検証後は公開した各portをすべてprivateへ戻す。
## Cloudflare Quick Tunnel実経路
1. Windows実機で通常起動し、3つのsandbox HTTP listenerがreadyになった後にAdmin、Trusted Worker、Remoteそれぞれのcloudflaredが別Codex online workspaceとして起動することを確認する。
2. 3本のcloudflaredログから別々の`https://<random>.trycloudflare.com`が抽出され、Admin login URL、Worker login URL、Remote pairing endpointがそれぞれ対応するURLを使うことを確認する。
3. pairing fileのWSS URLがRemote用Quick Tunnelの`wss://<remote-host>/remote`であり、Admin/Worker URLを誤って使わないことを確認する。
4. `data/pairing/typed-voice-server.tvrkey`を`codespace__copy_from_codespace`でローカルへ取得できることを確認する。
5. 実クライアントモードへそのファイルを投入し、AUTH、SERVER_CONFIG、PING/PONGまで通ることを確認する。
## Trusted Worker
1. tokenなしの`/worker/`と`/worker/ws`が拒否され、Worker HTML/JS/WASMやWSS鍵交換へ到達できないことを確認する。
2. `data/worker/session-token.txt`の内容を使って`/worker/login#<token>`へアクセスし、fragmentがHTTP URLへ送信されず、同一originの`POST /worker/session`成功後だけ`/worker/`が表示されることを確認する。
3. 誤tokenと期限切れtokenが拒否され、10分window切替直後30秒だけ直前tokenが境界graceとして受理されることを確認する。
4. 「このブラウザで参加する」を押して初めて`/worker/ws`へ接続することを確認する。
5. P-256一時ECDH公開鍵交換、双方proof、方向別AES-256-GCMセッション確立を確認する。
6. サーバーがCONFIGを送る前にPINGし、PONG成功後だけCONFIGが届くことを確認する。
7. モデル準備中でもPING/PONGへ即応し、モデルダウンロード時間を死活timeoutとして誤判定しないことを確認する。
8. モデル準備完了後に管理画面のWorker一覧がreadyになることを確認する。
9. Workerブラウザを追加で認証・参加すると固定上限数ではなく参加数に応じてWorkerが増えることを確認する。
10. 同一ブラウザcontextで2タブを同じmodel profileへ同時参加させる。最初のタブだけがHugging Faceのmodel assetsを外部GETし、2枚目はmanifest取得後にService Workerのdownload lockを待つことを確認する。
11. 最初のタブのdownload/検証完了後、2枚目が外部model assetsを再downloadせず`/__typed_voice_assets/...`の共有Cache Storageから読み、自分自身のWebGPU/WASM engineを独立初期化することを確認する。モデル実体・推論workerはタブ間共有しない。
12. `/health`の`workers`が2になり、両タブがreadyになることを確認する。
## Worker接続の緊急失効
1. 起動時に`data/worker/reset-token.txt`が生成され、改行なし128桁小文字hex、POSIXでは0600であることを確認する。WindowsではPOSIX mode/chmodを使わず実行ユーザーのWindows ACLを継承することを確認する。reset secret本体はstdioへ出さない。
2. `POST /worker/reset`は`127.0.0.1`/`::1`からの直接接続だけを受け付けることを確認する。`Forwarded`または`X-Forwarded-*`付きのreverse proxy要求は、正しいreset secretでも404にする。
3. `node scripts/reset-worker-access.mjs`を実行し、reset secretを引数/stdoutへ露出せずlocalhostへPOSTできることを確認する。
4. reset直前に2 Workerを接続した状態でhelperを実行し、`/health`が`workers: 2`から`workers: 0`へ変化し、両WSSが1008で切断されることを確認する。
5. reset前の10分tokenとWorker Cookieが即時無効化され、旧Cookieのまま再参加してもWSS Upgradeが拒否されることを確認する。
6. Worker UIは1008切断時に「Worker接続認証が失効しました。現在のWorker接続URLから認証し直してください。」を表示し、古いCookieでの再参加ボタンを無効化することを確認する。
7. `data/worker/session-token.txt`だけが新しいtokenへ即時更新され、reset-token自体は同じserver process中は変化せず、stdioへ新しいWorker login URLが出ることを確認する。
## Worker障害と再割当
1. 合成要求を1台のWorkerへ割り当てる直前にPING/PONGが成功していることを確認する。
2. 合成中Workerを閉じ、PING timeoutまたはWSS closeで死亡扱いになることを確認する。
3. 処理中ジョブが全体timeout内なら待ち行列先頭へ戻り、別のready Workerへ同じrequest idで再割当されることを確認する。
4. Trusted Workerが0台の場合、要求は即座に偽成功せず、全体timeoutまで待機して明確に失敗することを確認する。
## Remote TEXT→AUDIO
1. 実クライアントから暗号化TEXTを送る。
2. Node.jsがready Workerへ割り当て、Workerがブラウザ内WebGPUで合成することを確認する。
3. Worker→Node.jsは暗号化WorkerセッションでFloat32 audio metadataと64KiB以下のchunksを返すことを確認する。
4. Node.js→Remoteクライアントは選択されたFloat32LEまたはPCM16LE monoでAUDIO START/ENDを返すことを確認する。
5. UUID履歴へrequest/resultが記録され、管理画面は選択UUIDだけを取得・購読することを確認する。
6. ready Workerを2台接続した状態でRemote TEXTを2件連続投入し、2台へ同時割当されることを確認する。それぞれのAUDIOで`Float32 byteLength == sampleCount * 4`を満たし、両要求が独立して完了することを確認する。
## 完了条件
- Windowsでは親Node.jsにlistener/file-writeを戻さず、Admin・Worker・Remote・storageの用途別Codex sandbox境界を維持したままtrycloudflare実経路が動く。
- Codespaces/LinuxでWindowsと同じloopback ingressが成立しない場合、その制約を明記し、sandboxを弱めた代替実装を完了扱いしない。
- 管理セッショントークンなしでは管理HTMLと管理WSSへ到達できない。
- Worker assetsとWorker WSSは10分接続tokenを持つ信頼済み参加者だけに開き、認証後の明示参加で暗号化セッションとPING死活監視が成立する。
- 同一PCの複数WorkerはモデルdownloadだけをService Workerで束ね、各タブのmodel load/WebGPU推論は独立する。
- localhost専用reset secretでWorker accessを即時失効でき、接続済みWorker・旧token・旧Cookieがその場で無効になる。
- Worker脱落時にジョブが別Workerへ再割当される。
- pairing fileをCodespaceから取得し、実クライアントのRemote TEXT→AUDIOまで通る。
