# 圖個清白｜Gemini 圖片清理工具

「把圖留給你，水印交給我。」

這是一個可直接部署到 GitHub Pages 的純前端工具：把 Gemini 生成圖片拖進瀏覽器，使用 Canvas 在本機整理可見的星形浮水印。圖片不會上傳到伺服器。

## 功能

- 支援 JPG、PNG、WebP，單張最大 20 MB
- 單張原圖／結果並排預覽與放大檢視，顯示檔名、格式、尺寸與容量
- 單張結果可直接下載；多張圖片依序處理、逐張下載或全部 ZIP 下載
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

### 偵測閘門（三關，任一關過就算偵測到）

浮水印的位置是固定的（星心在 `(w−120s, h−120s)`、邊長 `48s`，`s` 在短邊 ≥1536 時為 2），
所以難的不是「找位置」，是「確認那裡到底有沒有星」。三關由快到慢：

| 關 | 判準 | 擅長 | 失手時 |
|---|---|---|---|
| NCC 樣板比對 | `ncc ≥ 0.42` 且 `contrast ≥ 1.4` | 乾淨背景 | 星壓在 logo／格線上時，不相關的強邊把相關係數拉低 |
| 物理模型 | 解 `obs = k·α·255 + (1−k·α)·bg`，`k∈[0.70,1.35]`、`R²≥0.45`、`rms≥2` | 背景估得準的圖 | 星壓在材質交界，背景估歪 |
| 輪廓能量救援 | `k∈[0.50,1.60]` 且 輪廓邊緣能量比 `≤0.85`、原能量 `≥5` | 背景再花都行（不需要估背景） | 全平坦區比值不穩，故設能量下限 |

第二、三關移植自 [gemini-web](https://github.com/yazelin/duotify-ollama-cloud-setup) 的 `src/watermark.py`。
背景估計用擴散填補（Laplace 補洞）取代 `cv2.inpaint`，省掉一整包 OpenCV.js。

## 測試

```bash
npm i -D playwright        # 或沿用工作區既有的 playwright
node tests/regression.mjs                        # 只跑合成樣本
node tests/regression.mjs 真圖A.png 真圖B.png      # 另外拿真圖當正樣本
```

合成樣本在頁面裡即時疊出來（`obs = α·255 + (1−α)·bg`），有星／無星兩組除了那顆星以外完全一樣，
所以**每個正樣本都配一個負控制**。目前：召回 12/12、誤判 0/11（含「清過的圖再跑一次不該再觸發」）。

## 相關連結

- [LINE 實作營](https://yazelin.github.io/events/)
- [林亞澤 GitHub](https://github.com/yazelin)
- [Facebook](https://www.facebook.com/yaze.lin.gm)
- [Buy Me a Coffee](https://buymeacoffee.com/yazelin)

## 授權

MIT © 林亞澤。模板資產沿用本工作區既有的 Gemini 浮水印分析資產；`vendor/jszip.min.js` 為 JSZip 3.10.1，依其 MIT／GPLv3 雙授權條款提供。
