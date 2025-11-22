# Hyakunin Web Client (H_Client_JS)

このフォルダは C++/SDL クライアント (`H_client`) をブラウザ向けに移植した最小実装です。

使い方（ローカルで静的サーバーを立てる）:

1. 簡易 HTTP サーバーを起動（Python があれば）:

```powershell
cd H_Client_JS
python -m http.server 8000
```

2. ブラウザで `http://localhost:8000/` にアクセス

3. サーバーがローカルで動いている場合は同じホストの `/ws` に接続します。別ホストに接続する場合は `main.js` の `url` 作成部を編集してください。

注意:

- 現在は基本的な描画、チャット、join/take の送受信に対応しています。細かい振る舞い（フォント fallback、UI 洗練、エラー処理等）は今後改善できます。
