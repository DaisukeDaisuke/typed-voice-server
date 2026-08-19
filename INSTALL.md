# インストール
この手順はWindows向けです。上から順番に1つずつ実行します。
> [!IMPORTANT]
> `server-main.mjs` 自体は管理者として実行しません。通常ユーザーのPowerShellまたはWindows Terminalを使って準備してください。
## 1. コマンドプロンプトを開く
> [!TIP]
> キーボードでのコマンドプロンプトの開き方は、まずキーボードから、窓マークキーを探し、押します。<br>
> 次に、スタートが開いた状態で、`cmd`と間違えずに押します。<br>
> そのままエンターを押すと、黒い画面が表示されます。これがコマンドプロンプトです。

<br>
コマンドプロンプトを開いてください。

> [!TIP]
> コマンドはまとめて貼り付けず、以下の順番で1つずつ実行すると、途中で問題が起きた場所を確認しやすくなります。<br>
## 2. Node.js LTSをインストールする
次のコマンドでNode.js LTSをインストールします。
```powershell
winget install -e --id OpenJS.NodeJS.LTS
```
> [!NOTE]
> すでに対象のNode.js LTSがインストールされている場合、wingetはその状態を案内します。<br>
## 3. cloudflaredをインストールする
次にCloudflare Quick Tunnelで使用する`cloudflared`をインストールします。
```powershell
winget install -e --id Cloudflare.cloudflared
```
## 4. Codex CLIをインストールする
Node.jsのインストール後、npmからCodex CLIをグローバルインストールします。
```powershell
npm install -g @openai/codex
```
> [!WARNING]
> `npm` や `codex` が見つからないと表示された場合は、新しいPowerShellまたはWindows Terminalを開き直してから、その手順をもう一度実行してください。
## 5. Codex sandboxをセットアップする
最後に、WindowsでCodex sandboxを使うための初回セットアップを実行します。
```powershell
codex sandbox setup --elevated --current-user
```

> [!IMPORTANT]
> このコマンドではWindowsの管理者承認が求められる場合があります。<br>
> 表示された内容を確認して承認してください。これはCodex sandboxを準備するための一度きりの昇格です。

> [!CAUTION]
> セットアップ完了後も、`server-main.mjs` や普段の開発用PowerShellを管理者として起動しないでください。<br>
> サーバーは通常ユーザー権限で動かします。
## インストール完了
ここまで完了したら、[README.md](README.md) に戻ってサーバーを起動してください。
