# Codex実働検証指示書
## 目的
`typed-voice-server`の実装はChatGPT側で行ってある。Codexは実装を丸投げされる側ではなく、Windows実機でのCodex sandbox・Chrome WebMCP・Cloudflare Quick Tunnelを含む実働検証と、失敗時の最小修正だけを担当する。
## 禁止
- `local-mcp-chatgpt-tunnel`へ機能を戻さない。
- 公開入力を解釈する`worker/websocket-worker.mjs`をsandbox外で起動しない。
- 管理HTTP/WebSocketを`server-main.mjs`へ戻さない。
- 実行PCで`npm install`を行わない。
- AES-GCM/HMAC/HKDFを削除してWSS/TLSだけにしない。
## 前提境界
- `server-main.mjs`: 通常ユーザー権限の信頼側オーケストレータ。管理HTTP/WebSocket listenerを持たない。
- `worker/websocket-worker.mjs`: Codex offline sandbox、`allow_local_binding=true`。Cloudflare origin用WSSを`127.0.0.1:random`へbindする。
- `admin/admin-worker.mjs`: 別Codex offline sandbox、`allow_local_binding=true`。管理HTTP/WebSocketとserver-engine assetsを、`data/settings.json`へ保存した固定高位`127.0.0.1:<port>`へbindし、mainとはstdin/stdout NDJSONだけで通信する。
- `cloudflared`: Codex `onlineworkspace`。`cloudflared tunnel --url http://127.0.0.1:<public-worker-port>`。
- `server-main.mjs`↔public workerの音声データ経路は32-byte control key付きlocalhost binary TCP。
- 音声エンジンは1つのChromeプロファイル・1プロセスに`--multi N`枚のタブを作る。全タブで同一Service Worker/Cache Storageを共有する。background timer throttlingは無効化する。
- ChromeプロファイルはReleaseディレクトリ配下`data/chrome-profile`固定で、tmpへ作らない。モデルキャッシュを再起動後も再利用する。
- public/admin/control listenerは`127.0.0.1`固定かつ49152-65535の高位portを使う。
## 検証1: 静的検査
1. Node 22以上で`server-main.mjs`、`server/*.mjs`、`admin/*.mjs`、`worker/*.mjs`、`web/server-ui.js`を構文検査する。
2. `typed-voice` submoduleで既存テストとremote関連テストを実行する。
3. 親repoで追加されたprotocol/history/controlのテストを実行する。
## 検証2: admin sandbox境界
1. admin workerをCodex offline sandbox + `allow_local_binding=true`で起動する。
2. admin workerがsandbox内で`data/settings.json`に保存された49152-65535の固定portへlistenでき、再起動後も同じoriginを使うことを確認する。
3. `server-main.mjs`自身が管理HTTP/WebSocket listenerを作っていないことを確認する。
4. 正しいfragment tokenで管理WebSocket認証が通り、誤tokenでは切断されることを確認する。
5. admin worker→mainの管理要求がstdin/stdout NDJSONだけで届くことを確認する。
## 検証3: public worker sandbox境界
1. `worker/websocket-worker.mjs`をCodex offline sandbox + `allow_local_binding=true`で起動する。
2. control channel認証後に`127.0.0.1:random`へpublic origin listenerを作れることを確認する。
3. sandbox外から`/health`へ到達できることを確認する。
4. workerが非loopbackインターネットへ直接出られないことを確認する。
5. workerへ渡すread権限がworker実装とNode実行環境の最低限に留まっていることを確認する。
## 検証4: 暗号ハンドシェイク
1. QR payloadの`v/u/a/e/c`を使い、checksum不一致では接続開始しないことを確認する。
2. `HELLO_CLIENT`→`HELLO_SERVER`→`AUTH`を行い、HMAC-SHA-256が双方で一致することを確認する。
3. `AUTH`成功後に暗号化`SERVER_CONFIG`でサーバー選択モデルが届き、その後の暗号化PINGをクライアントが復号してPONGを返せることを確認する。
4. 接続から20秒以内にAUTH検証成功しなければ切断されることを確認する。
5. C2S/S2CでAES-256-GCM keyとnonce prefixが別であること、seq不連続・AAD改ざん・tag不一致で即切断されることを確認する。
## 検証5: Chrome WebMCPとmulti
1. `--multi 3`でChromeプロセスが1つだけ起動し、同じ`--user-data-dir`内にserver-engineタブが必ず3枚できることを確認する。
2. 1枚目がService Workerとモデル準備を終えてから残り2枚が起動することを確認する。
3. 3枚とも`typed-voice.status`がreadyを返すことを確認する。
4. 3リクエストを同時送信し、3枚で並列実行されることを確認する。
5. 4件目を追加し、BUSYにせずFIFO待ち行列へ入り、最初に空いたタブへ流れることを確認する。
6. 待機中CANCELは行列から削除され、実行中CANCELは該当タブの`typed-voice.cancel`へ届くことを確認する。
## 検証6: TEXT→AUDIO
1. クライアントから暗号化TEXTを送る。
2. worker→control→Chrome WebMCP→control→workerの経路で合成されることを確認する。
3. Float32設定ではFloat32LE mono、PCM16設定ではworkerでPCM16LE monoへ変換して返ることを確認する。
4. AUDIO STARTにformat/channels/sampleRate/sampleCountが入り、64KiB単位の後続AUDIOとENDまで同一request idで届くことを確認する。
## 検証7: UUID履歴API
1. 暗号化SESSIONで会話UUIDを通知後、TEXTを送る。
2. `data/history/index.json`にUUIDメタデータが入り、`data/history/<uuid>.ndjson`へ`request`イベントが要求到着時点で追記されることを確認する。
3. 合成成功・失敗・キャンセル後に`result`イベントが追記されることを確認する。
4. admin WebSocketから`history-get(uuid)`した場合だけmainがメタデータ＋内容を返すことを確認する。
5. `history-subscribe(uuid)`中だけ、そのUUIDの新規イベントがリアルタイムpushされることを確認する。
6. 別UUIDの本文がadmin sandboxへ無条件pushされないことを確認する。
## 検証8: Quick Tunnel
1. public workerがreadyになった後だけcloudflaredを`onlineworkspace`で起動する。
2. `allow_local_binding`をcloudflaredへ追加しない。
3. Quick Tunnel URL取得後、`wss://<host>/remote`をQRへ入れる。
4. 外部クライアントからWSS→暗号AUTH→TEXT→AUDIOまで通す。
5. `server-main.mjs`自身の起動完了判定もadmin WebSocket認証と外部Quick Tunnel経由の暗号AUTH→`SERVER_CONFIG`→PING/PONG→短いTEXT→AUDIOまで成功した後にだけ`接続できます`になることを確認する。
## 検証9: 接続キーファイルとモデル設定
1. 起動前に古い`data/pairing/typed-voice-server.tvrkey`が消されることを確認する。
2. Quick Tunnel URL確定後、新しい`.tvrkey`が生成され、起動完了ログに`realpath`解決済み絶対パスが表示されることを確認する。
3. typed-voiceのpairing画面でraw `.tvrkey`を選び、QRと同じ接続情報が保存されることを確認する。
4. 同じbinaryをBase64/Base64URL化したテキストファイルでも接続できることを確認する。
5. 改ざんファイルはAES-GCM tag検証で拒否されることを確認する。
6. 管理UIでモデルを変更すると`data/settings.json`へ保存され、次回`--profile`未指定起動で同じモデルが復元されることを確認する。
7. Remoteクライアント側のモデルUIがサーバー設定へ自動で切り替わり、radioとモデル変更ボタンが変更不可になることを確認する。
8. Remote時の「チュートリアルをもう一度見る」がサーバー再接続になり、「サーバー登録解除」がWSS切断後に保存pairingを削除することを確認する。
## 完了条件
- 上記全項目がPASSする。
- 失敗が実装バグなら最小修正して再実行する。
- Codex sandbox自体の環境制約で実行不能なら、実装を迂回せず、どの検証が未実施かを明記する。
