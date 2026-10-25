# リング × フック クレーンゲーム練習

アームからぶら下がったリングを、アクリル板上の固定フックに引っ掛けて網台を吊り上げる「フック設定」台の練習ゲームです。ブラウザだけで動きます（Three.js + cannon-es）。

- 操作: 固定移動ボタン（①→②） / フリースティック
- リング: 大・中・小、フックとリングの向き（360°）、チェーンの長さ、揺れやすさなどを調整可能
- スマホ対応（ホーム画面に追加するとフルスクリーンで遊べます）

## ローカルで遊ぶ

```bash
python3 -m http.server 8000
```

ブラウザで http://localhost:8000 を開く。

## 使用ライブラリ

- [Three.js](https://threejs.org/)（MIT License）— 3D 描画
- [cannon-es](https://github.com/pmndrs/cannon-es)（MIT License）— 物理演算

いずれも CDN（jsDelivr）から読み込んでいます。
