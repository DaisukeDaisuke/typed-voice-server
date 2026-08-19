# typed-voice-server
`typed-voice-server` は、[typed-voice](https://github.com/DaisukeDaisuke/typed-voice) の音声生成を、リモートパソコンで行い、マイニングプールのようにボランティアを募れるサーバープロジェクトです。<br>
PC上でサーバーを起動し、ブラウザのTrusted Workerへ音声生成を任せながら、Remoteクライアントから読み上げを利用できます。
## typed-voiceとの連携
`typed-voice-server` と `typed-voice` は密接に連携しています。<br>
サーバーが用意するQRコードを読み取るか、接続鍵ファイルを `typed-voice` に渡すことで、接続先などの情報をまとめて受け渡せます。<br>
接続情報を手入力する必要はありません。<br>
QRコードと接続鍵ファイルは、同じサーバーへ接続するための2つの受け渡し方法として利用できます。<br>
スマートフォンやタブレットではQRコード、ファイルを受け渡せる環境では接続鍵ファイルを使えます。<br>
## はじめに
Windowsで初めて使う場合は、まず [INSTALL.md](INSTALL.md) の手順に沿ってNode.js、cloudflared、Codex CLI、Codex sandboxを準備してください。<br>
準備が終わったら、展開した `typed-voice-server` フォルダーにある **`Server.cmd` をダブルクリック**してください。
`Server.cmd` は起動前にNode.js、cloudflared、Codex CLI、Codex sandbox、配布ファイルを確認します。足りないものや対応していないバージョンがあれば、日本語で不足内容を表示してサーバーを起動せず停止します。
起動後は、ターミナルに表示される案内からAdmin、Trusted Worker、Remote接続を使います。
> [!NOTE]
> サーバー本体は通常ユーザー権限で実行します。<br>
> `Server.cmd` を「管理者として実行」する必要はありません。
## 高度な使い方：Admin / Trusted Workerを公開する
通常起動では、AdminとTrusted Workerは外部へ公開せず、Remote接続だけを公開します。<br>
ボランティアのTrusted Workerをインターネット越しに参加させたい場合や、Admin画面を外部から管理したい場合は、`Server.cmd` に公開オプションを付けて起動できます。
両方を公開する場合は、展開した`typed-voice-server`フォルダーでコマンドプロンプトを開き、次を実行します。
```text
Server.cmd --open-admin=true --open-worker=true
```
Adminだけ公開する場合は次のように指定します。
```text
Server.cmd --open-admin=true
```
Trusted Workerだけ公開する場合は次のように指定します。
```text
Server.cmd --open-worker=true
```
`--open-admin=true`はAdmin用の公開URLを有効にし、`--open-worker=true`はボランティアのTrusted Workerが参加するための公開URLを有効にします。オプションを指定しなかった側は通常どおり外部公開しません。
> [!WARNING]
> AdminやTrusted Workerを公開すると、通常起動より公開範囲が広がります。必要なときだけ指定してください。
## インストール
[Windows向けインストール手順](INSTALL.md)
## 詳細仕様
セキュリティ境界、各sandbox workerの役割、認証、暗号化、Quick Tunnel、永続データの扱いなど、実装上の契約は [SPECIFICATION.md](SPECIFICATION.md) にまとめています。
## 商標
QRコードは株式会社デンソーウェーブの登録商標です。<br>
QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in other countries.
