// 偵測閘門回歸測試：召回（該抓到的有抓到）＋ 負控制（沒浮水印的別亂抓）。
//
//   node tests/regression.mjs                     只跑合成樣本
//   node tests/regression.mjs <真圖A> <真圖B> …    另外把真圖當正樣本一起驗
//
// 合成樣本在頁面裡即時做：obs = α·255 + (1−α)·bg，就是浮水印本身的疊圖模型，
// 所以「有星」與「沒星」兩組除了那顆星以外完全一樣，負控制才有意義。
// ponytail: 不引測試框架，assert + 一支腳本；壞掉時 exit 1 就夠。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(req.url.split('?')[0]));
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const realImages = process.argv.slice(2).filter((p) => {
  if (existsSync(p)) return true;
  console.log(`  （跳過不存在的真圖：${p}）`);
  return false;
}).map((p) => ({ name: p.split('/').pop(), dataUrl: `data:image/png;base64,${readFileSync(p).toString('base64')}` }));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.watermarkEngine?.images?.size === 3);

const results = await page.evaluate(async (real) => {
  const engine = window.watermarkEngine;

  // 背景樣式。busy/logo 這兩種就是害 NCC 掉到 0.42 以下的元凶，一定要有。
  const paint = (ctx, w, h, kind) => {
    if (kind === 'flat') { ctx.fillStyle = '#2ec5d8'; ctx.fillRect(0, 0, w, h); return; }
    if (kind === 'gradient') {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#123'); g.addColorStop(1, '#dfe');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); return;
    }
    if (kind === 'grid') {
      ctx.fillStyle = '#2ec5d8'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2;
      for (let x = 0; x < w; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      return;
    }
    if (kind === 'logo') { // 高對比粗字壓在右下角，模擬 VTuber 那張的失敗情境
      paint(ctx, w, h, 'grid');
      ctx.fillStyle = '#ff5ea8'; ctx.strokeStyle = '#2b1b4a'; ctx.lineWidth = 10;
      ctx.font = 'bold 120px sans-serif'; ctx.textBaseline = 'bottom';
      ctx.strokeText('AI脳', w - 300, h - 40); ctx.fillText('AI脳', w - 300, h - 40);
      return;
    }
    if (kind === 'noise') {
      const img = ctx.createImageData(w, h);
      let seed = 42;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const v = seed % 256;
        img.data[i] = v; img.data[i + 1] = (v * 3) % 256; img.data[i + 2] = (v * 7) % 256; img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
  };

  const build = (w, h, kind, withStar) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    paint(ctx, w, h, kind);
    const data = ctx.getImageData(0, 0, w, h);
    if (withStar) {
      const scale = Math.min(w, h) >= 1536 ? 2 : 1;
      const size = 48 * scale;
      const alpha = engine.getTemplate('v2', size);
      const x = Math.round(w - 120 * scale - size / 2);
      const y = Math.round(h - 120 * scale - size / 2);
      for (let row = 0; row < size; row += 1) {
        for (let col = 0; col < size; col += 1) {
          const a = alpha[row * size + col];
          if (a <= 0) continue;
          const i = ((y + row) * w + x + col) * 4;
          for (let c = 0; c < 3; c += 1) data.data[i + c] = Math.round(a * 255 + (1 - a) * data.data[i + c]);
        }
      }
    }
    return { data, w, h };
  };

  const out = [];
  const sizes = [[1024, 1024], [2816, 1536]];
  for (const [w, h] of sizes) {
    for (const kind of ['flat', 'gradient', 'grid', 'logo', 'noise']) {
      for (const withStar of [true, false]) {
        const { data } = build(w, h, kind, withStar);
        const hit = engine.detect(data, w, h);
        out.push({
          name: `${kind} ${w}×${h} ${withStar ? '有星' : '無星'}`,
          expect: withStar, got: !!hit, via: hit?.via ?? '-',
        });
      }
    }
  }

  // 清過的圖再跑一次不該再觸發（否則會被反覆扣成黑星）
  {
    const w = 1024; const h = 1024;
    const { data } = build(w, h, 'grid', true);
    const first = engine.detect(data, w, h);
    if (first) {
      const cleaned = engine.restore(data, w, h, first);
      out.push({ name: '清過的圖再跑一次', expect: false, got: !!engine.detect(cleaned, w, h), via: '-' });
    }
  }

  for (const item of real) {
    const image = new Image();
    image.src = item.dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = engine.detect(data, canvas.width, canvas.height);
    out.push({ name: `真圖 ${item.name}`, expect: true, got: !!hit, via: hit?.via ?? '-' });
  }
  return out;
}, realImages);

await browser.close();
server.close();

let failed = 0;
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const ok = r.expect === r.got;
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${r.name.padEnd(width)}  預期=${r.expect ? '偵測到' : '無'}  實際=${r.got ? '偵測到' : '無'}  路徑=${r.via}`);
}
const positives = results.filter((r) => r.expect);
const negatives = results.filter((r) => !r.expect);
console.log(`\n召回 ${positives.filter((r) => r.got).length}/${positives.length}　誤判 ${negatives.filter((r) => r.got).length}/${negatives.length}`);
process.exit(failed ? 1 : 0);
