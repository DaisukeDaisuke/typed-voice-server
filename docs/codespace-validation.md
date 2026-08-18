# typed-voice-server Codespaces実働検証
## 目的
Windows実機でChrome起動やプロセス管理を自動化せず、Node.jsサーバー単体をCodespacesで再現可能に動かし、公開経路・管理認証・短寿命Worker認証・Trusted Worker・Remote暗号通信を実経路で確認する。
## 前提
- サーバーは`node server-main.mjs --host 0.0.0.0 --port 3000`で1プロセス起動する。
- Codexを使う場合はサーバープロセス全体をCodespace内のCodex sandboxで起動する。サーバー自身からCodexを再帰起動しない。
- Chrome/CDP自動起動、PID探索、Chrome kill、Chrome watchdogは行わない。
- WebGPU Workerは現在の10分Worker接続トークンを持つ信頼済み参加者だけが`/worker/login#<token>`から認証し、参加UIを押した場合だけ増える。
## devcontainer確認
1. `node --version`が22以上であることを確認する。
2. `codex --version`が成功することを確認する。
3. `cloudflared --version`が成功することを確認する。
4. `sudo codex sandbox setup --elevated --current-user`がdevcontainer作成時に成功済みであることを確認する。
5. `engine/server-engine.html`と対応するVite assetsが生成済みであることを確認する。
6. `node --test test/*.test.mjs`を実行する。
## Node.jsサーバー確認
1. Codex sandbox内で`node server-main.mjs --host 0.0.0.0 --port 3000`を起動する。
2. `/health`が200を返すことを確認する。
3. 起動ログに`data/admin/session-token.txt`の絶対パスが出ることを確認する。トークン本体をログへ出してはいけない。
4. `data/admin/session-token.txt`が64桁小文字hexであり、POSIX環境では0600であることを確認する。
5. 起動ログに`data/worker/session-token.txt`の絶対パスと有効期限が出ることを確認し、Worker token本体がstdioへ出ないことを確認する。
6. `data/worker/session-token.txt`が128桁小文字hexで0600であり、10分window切替後に同じファイルへ新tokenだけが上書きされることを確認する。
## Codespaces temporary public deployment
1. `3000`を`codespace__open_temporary_public_deployment`でpublicにする。
2. tokenなしの`https://<codespace-host>/admin/`が管理画面を返さないことを確認する。
3. `session-token.txt`の内容を使って`/admin/login#<token>`へアクセスし、fragmentがHTTP URLへ送信されず、同一originの`POST /admin/session`成功後にCookie付き`/admin/`だけが表示されることを確認する。
4. token/Cookieなしの`/admin/ws` Upgradeが拒否されることを確認する。
5. 認証済み管理ページが実際のCodespaces originをサーバーへ通知し、`data/pairing/typed-voice-server.tvrkey`がそのhostの`wss://.../remote`で生成されることを確認する。
6. 検証後は`codespace__close_temporary_public_deployment`で3000をprivateへ戻す。
## Cloudflare Quick Tunnel実経路
1. 同じCodespaceで`cloudflared tunnel --url http://localhost:3000`を起動する。
2. 発行された`https://<random>.trycloudflare.com/admin/login#<token>`を開く。
3. 認証済み管理ページがtrycloudflare originを通知し、pairing fileのWSS URLが`wss://<random>.trycloudflare.com/remote`へ更新されることを確認する。
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
## 完了条件
- Codespaces公開経路とtrycloudflare実経路の両方で同じNode.jsサーバーが動く。
- 管理セッショントークンなしでは管理HTMLと管理WSSへ到達できない。
- Worker assetsとWorker WSSは10分接続tokenを持つ信頼済み参加者だけに開き、認証後の明示参加で暗号化セッションとPING死活監視が成立する。
- Worker脱落時にジョブが別Workerへ再割当される。
- pairing fileをCodespaceから取得し、実クライアントのRemote TEXT→AUDIOまで通る。
