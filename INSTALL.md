# インストール
この手順はWindows向けです。上から順番に1つずつ実行します。
> [!IMPORTANT]
> `Server.cmd` や `server-main.mjs` 自体は管理者として実行しません。通常ユーザーのPowerShellまたはWindows Terminalを使って準備してください。
## 1. typed-voice-serverの最新版をダウンロードする
次のリンクを開いて、`typed-voice-server.zip`をダウンロードしてください。

[typed-voice-server 最新版をダウンロード](https://github.com/DaisukeDaisuke/typed-voice-server/releases/download/typed-voice-server-latest/typed-voice-server.zip)


<img width="313" height="99" alt="image" src="https://github.com/user-attachments/assets/a9e7efd9-8617-4589-8a52-ab14af09e5d5" />

<img width="1153" height="339" alt="image" src="https://github.com/user-attachments/assets/56cd5b99-ec20-40b2-8590-5fa18390392d" />


> [!NOTE]
> このリンクは、typed-voice-serverの最新配布版を取得するための直リンクです。
## 2. ダウンロードしたZIPを展開する
ダウンロードした`typed-voice-server.zip`をエクスプローラーで開き、右クリックして「すべて展開」を選びます。

<img width="476" height="589" alt="image" src="https://github.com/user-attachments/assets/d5e830e0-a7b1-4059-8c52-705ceb07ce87" />

展開先は、あとで見つけやすい場所を選んでください。展開が終わったら、`Server.cmd`と`server-main.mjs`が入っている展開先フォルダーを開いておきます。

<img width="1143" height="444" alt="image" src="https://github.com/user-attachments/assets/a61f4915-4d43-4371-9edb-8a8bc4e4e42e" />


> [!IMPORTANT]
> 以降のサーバー起動は、ダウンロードしたZIPそのものではなく、必ず展開後のフォルダーで行います。
## 3. コマンドプロンプトを開く
> [!TIP]
> キーボードでのコマンドプロンプトの開き方は、まずキーボードから、窓マークキーを探し、押します。<br>
> 1回だけ押したらスタートが開いた状態で、そのままキーボードで`cmd`と順番に、間違えずに押します。<br>
> そのままエンターを押すと、黒い画面が表示されます。これがコマンドプロンプトです。

<br>
コマンドプロンプトを開いてください。


## 4. Node.js LTSをインストールする
次のコマンドでNode.js LTSをインストールします。

> [!TIP]
> コマンドはまとめて貼り付けず、以下の順番で1つずつ実行すると、途中で問題が起きた場所を確認しやすくなります。<br>

<br>

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```
> [!NOTE]
> すでに対象のNode.js LTSがインストールされている場合、wingetはその状態を案内します。<br>
## 5. cloudflaredをインストールする
次にCloudflare Quick Tunnelで使用する`cloudflared`をインストールします。
```powershell
winget install -e --id Cloudflare.cloudflared
```
## 6. Codex CLIをインストールする
Node.jsのインストール後、npmからCodex CLIをグローバルインストールします。
```powershell
npm install -g @openai/codex
```
> [!WARNING]
> `npm` や `codex` が見つからないと表示された場合は、新しいPowerShellまたはWindows Terminalを開き直してから、その手順をもう一度実行してください。
## 7. Codex sandboxをセットアップする
最後に、WindowsでCodex sandboxを使うための初回セットアップを実行します。
```powershell
codex sandbox setup --elevated --current-user
```

> [!IMPORTANT]
> このコマンドは、管理者として実行する必要があります。
> cmdを開く際に、詳細メニューから「管理者として実行」をクリックしたコマンドプロンプト(黒い画面)に張り付けてエンターを押す必要があります。

> [!CAUTION]
> セットアップ完了後も、`Server.cmd`、`server-main.mjs`、普段の開発用PowerShellを管理者として起動しないでください。<br>
> サーバーは通常ユーザー権限で動かします。
## 8. Server.cmdをダブルクリックして起動する
展開した`typed-voice-server`フォルダーへ戻り、`Server.cmd`をダブルクリックしてください。

`Server.cmd`は最初に起動環境を確認します。Node.js、cloudflared、Codex CLI、Codex sandbox、配布ファイルのどれかが足りない場合や、対応していないバージョンの場合は、不足している内容と必要な手順を日本語で表示し、サーバーを起動せず停止します。

> [!TIP]
> エラーが表示された場合は、画面に表示された不足項目を確認してください。エラー時は画面がすぐ閉じないよう、キー入力を待ってから終了します。

必要なものがすべて揃っていれば、そのまま`typed-voice-server`が起動します。

# 管理リンクの発行
起動後は、ターミナルで紫色の「Admin URL」の右のリンクをctrlキーを押しながらクリックし、管理ページにログインしてください。そうすると、接続用QRコードが表示されます。

<img width="720" height="312" alt="terminal" src="https://github.com/user-attachments/assets/47f779b2-5557-41ba-bf9b-b0e616a3aa55" />

また、開発者であれば、Start.cmdの引数に`--open-admin=true --open-worker=true`のようなオプションを付与することで、管理ページを外出先で開くこともできます。
```
Start.cmd  --open-admin=true 
```

> [!TIP]
> QRコードは株式会社デンソーウェーブの登録商標です
> QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in other countries.

## インストール完了
ここまで完了したら、以後は展開したフォルダーの`Server.cmd`をダブルクリックするだけで起動できます。
