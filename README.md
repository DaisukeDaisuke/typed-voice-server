# typed-voice-server
`typed-voice-server` は、typed-voice の音声生成をサーバーとして使うためのプロジェクトです。PC上でサーバーを起動し、ブラウザのTrusted Workerへ音声生成を任せながら、Remoteクライアントから読み上げを利用できます。
## はじめに
Windowsで初めて使う場合は、まず [INSTALL.md](INSTALL.md) の手順に沿ってNode.js、cloudflared、Codex CLI、Codex sandboxを準備してください。
準備が終わったら、このリポジトリで次を実行します。
```text
node server-main.mjs
```
起動後は、ターミナルに表示される案内からAdmin、Trusted Worker、Remote接続を使います。
> [!NOTE]
> サーバー本体は通常ユーザー権限で実行します。管理者として `server-main.mjs` を起動する必要はありません。
## インストール
[Windows向けインストール手順](INSTALL.md)
## 詳細仕様
セキュリティ境界、各sandbox workerの役割、認証、暗号化、Quick Tunnel、永続データの扱いなど、実装上の契約は [SPECIFICATION.md](SPECIFICATION.md) にまとめています。
