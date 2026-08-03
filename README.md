# 圖個清白｜Gemini 圖片清理工具

「把圖留給你，水印交給我。」

這是一個可直接部署到 GitHub Pages 的純前端工具：把 Gemini 生成圖片拖進瀏覽器，使用 Canvas 在本機整理可見的星形浮水印。圖片不會上傳到伺服器。

## 功能

- 支援 JPG、PNG、WebP，單張最大 20 MB
- 單張原圖／結果並排預覽與放大檢視
- 多張圖片依序處理、單張下載、全部 ZIP 下載
- 同時嘗試舊版與新版 Gemini 可見浮水印幾何配置
- 偵測不到浮水印時保留原圖，不會強行修改整張圖片
- 不需要建置工具；GitHub Pages 直接發佈靜態檔案

## 本機預覽

```bash
python3 -m http.server 8080
```

開啟 <http://localhost:8080/> 即可。使用本機伺服器是為了讓瀏覽器正常讀取 `assets/` 模板檔；不需要後端 API。

## GitHub Pages

此 repo 內的 `.github/workflows/pages.yml` 會在 `main` 有新 commit 時，使用 GitHub Pages Actions 發佈根目錄。第一次建立 repo 後，到 Settings → Pages 確認 Source 選擇 **GitHub Actions**。

## 技術說明

工具使用可見浮水印的 alpha 模板，對水印覆蓋區做反向 alpha blending：

```text
original = (watermarked - alpha × 255) / (1 - alpha)
```

這個工具只處理可見浮水印；不可見 SynthID 等標記不在範圍內。請只處理你有權使用的圖片。

## 相關連結

- [LINE 實作營](https://yazelin.github.io/events/)
- [林亞澤 GitHub](https://github.com/yazelin)
- [Facebook](https://www.facebook.com/yaze.lin.gm)
- [Buy Me a Coffee](https://buymeacoffee.com/yazelin)

## 授權

MIT © 林亞澤。模板資產沿用本工作區既有的 Gemini 浮水印分析資產；`vendor/jszip.min.js` 為 JSZip 3.10.1，依其 MIT／GPLv3 雙授權條款提供。
