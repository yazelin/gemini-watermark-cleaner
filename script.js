/* 圖個清白：純瀏覽器端 Gemini 可見浮水印清理工具。 */

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ASSETS = {
  legacy: 'assets/gemini-watermark-alpha.png',
  v2Small: 'assets/gemini-v2-alpha-36.png',
  v2Large: 'assets/gemini-v2-alpha-96.png',
};

// 物理模型閘門（移植自 gemini-web `src/watermark.py`）。
//
// 原本只有 NCC 樣板比對：把 96×96 區塊的灰階跟星形樣板算相關係數。乾淨背景很準，
// 但浮水印壓在 logo、格線這類高對比圖案上時，那些跟星形無關的強邊會把相關係數整個
// 拉低 → 漏判。實測一張 VTuber 設定表：對比度 25.5（門檻 1.4 的 18 倍，星星很明顯）
// 但 NCC 只有 0.35，低於 0.42 直接被判定「沒有浮水印」。漏判比誤判糟，因為使用者
// 會以為圖是乾淨的就拿去用。
//
// 補上 Python 版那兩關：
//   1. 物理模型 — 解 obs = k·α·255 + (1−k·α)·bg。模型正確時 k 應該 ≈ 1。
//   2. 輪廓能量救援 — 背景估不準（R² 低）時改比較「移除前後星形輪廓上的邊緣能量」。
//      有浮水印時移除會讓輪廓能量下降；沒有浮水印時等於憑空刻一顆星，能量反而上升。
//      這條不需要估背景，所以星壓在材質交界上仍然可靠。
// 門檻沿用 Python 版（該版以 39 張實圖 + 117 個無浮水印角落校準：召回 25/27、誤判 0）。
const PHYS = {
  kMain: [0.70, 1.35],
  r2Min: 0.45,
  rmsMin: 2.0,
  kRescue: [0.50, 1.60],
  contourMax: 0.85,
  edgeMin: 5.0,
  // ponytail: 背景用擴散填補（Laplace 補洞）取代 cv2.inpaint，省掉一包 OpenCV.js。
  // 輪次要夠：96×96 的星區補 240 輪才收斂，太少會把背景估成接近全黑。
  fillIterations: 240,
};

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const singlePreview = document.getElementById('singlePreview');
const multiPreview = document.getElementById('multiPreview');
const originalCanvas = document.getElementById('originalCanvas');
const originalName = document.getElementById('originalName');
const originalInfo = document.getElementById('originalInfo');
const processedSection = document.getElementById('processedSection');
const processedImage = document.getElementById('processedImage');
const processedName = document.getElementById('processedName');
const processedInfo = document.getElementById('processedInfo');
const processedStatus = document.getElementById('processedStatus');
const downloadSingleBtn = document.getElementById('downloadSingleBtn');
const statusMessage = document.getElementById('statusMessage');
const imageList = document.getElementById('imageList');
const progressText = document.getElementById('progressText');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const resetSingleBtn = document.getElementById('resetSingleBtn');
const resetBatchBtn = document.getElementById('resetBatchBtn');
const previewModal = document.getElementById('previewModal');
const modalImage = document.getElementById('modalImage');
const modalTitle = document.getElementById('modalTitle');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');

const state = {
  items: [],
  activeItem: null,
  modalMode: 'original',
  batchRun: 0,
};

class WatermarkEngine {
  constructor() {
    this.images = new Map();
    this.templateCache = new Map();
  }

  async load() {
    await Promise.all(Object.entries(ASSETS).map(async ([key, src]) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = src;
      await image.decode();
      this.images.set(key, image);
    }));
  }

  getTemplate(profile, size) {
    const key = `${profile}:${size}`;
    if (this.templateCache.has(key)) return this.templateCache.get(key);

    let source = this.images.get('legacy');
    if (profile === 'v2') source = this.images.get(size <= 48 ? 'v2Small' : 'v2Large');

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, size, size);
    const pixels = context.getImageData(0, 0, size, size).data;
    const alpha = new Float32Array(size * size);
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = pixels[i * 4] / 255;
    this.templateCache.set(key, alpha);
    return alpha;
  }

  getCandidates(width, height) {
    const candidates = [];
    const legacyLarge = width > 1024 && height > 1024;
    const legacySize = legacyLarge ? 96 : 48;
    const legacyMargin = legacyLarge ? 64 : 32;
    const scale = Math.min(width, height) >= 1536 ? 2 : 1;
    const v2Size = 48 * scale;
    const v2CenterX = width - 120 * scale;
    const v2CenterY = height - 120 * scale;

    const add = (profile, size, x, y, searchRadius) => {
      const steps = [-searchRadius, -Math.ceil(searchRadius / 2), 0, Math.ceil(searchRadius / 2), searchRadius];
      for (const dy of steps) {
        for (const dx of steps) {
          const left = Math.round(x + dx);
          const top = Math.round(y + dy);
          if (left >= 0 && top >= 0 && left + size <= width && top + size <= height) {
            candidates.push({ profile, size, x: left, y: top });
          }
        }
      }
    };

    add('legacy', legacySize, width - legacySize - legacyMargin, height - legacySize - legacyMargin, legacyLarge ? 16 : 10);
    add('v2', v2Size, v2CenterX - v2Size / 2, v2CenterY - v2Size / 2, scale === 2 ? 18 : 10);
    return candidates;
  }

  scoreCandidate(imageData, width, candidate) {
    const alpha = this.getTemplate(candidate.profile, candidate.size);
    const gray = [];
    const template = [];
    const outer = [];
    const active = [];
    for (let y = 0; y < candidate.size; y += 1) {
      for (let x = 0; x < candidate.size; x += 1) {
        const p = y * candidate.size + x;
        const index = ((candidate.y + y) * width + candidate.x + x) * 4;
        const value = (imageData.data[index] + imageData.data[index + 1] + imageData.data[index + 2]) / 3;
        gray.push(value);
        template.push(alpha[p]);
        if (alpha[p] < 0.035) outer.push(value);
        if (alpha[p] > 0.28) active.push(value);
      }
    }
    if (outer.length < 20 || active.length < 8) return null;
    const outerMean = outer.reduce((sum, value) => sum + value, 0) / outer.length;
    const activeMean = active.reduce((sum, value) => sum + value, 0) / active.length;
    const meanGray = gray.reduce((sum, value) => sum + value, 0) / gray.length;
    const meanTemplate = template.reduce((sum, value) => sum + value, 0) / template.length;
    let numerator = 0;
    let grayVariance = 0;
    let templateVariance = 0;
    for (let i = 0; i < gray.length; i += 1) {
      const grayDelta = gray[i] - meanGray;
      const templateDelta = template[i] - meanTemplate;
      numerator += grayDelta * templateDelta;
      grayVariance += grayDelta * grayDelta;
      templateVariance += templateDelta * templateDelta;
    }
    const ncc = numerator / (Math.sqrt(grayVariance * templateVariance) + 1e-8);
    const contrast = activeMean - outerMean;
    const strength = Math.min(Math.max(contrast, 0) / 45, 0.35);
    return { ncc, contrast, score: ncc + strength, alpha };
  }

  // canonical 幾何：星心固定在 (w−120s, h−120s)，尺寸 48s，s = 短邊 ≥1536 ? 2 : 1。
  // 跟 gemini-web 的 Python 版同一組公式，物理閘門只在這個位置判（不搜位置）。
  canonicalCandidate(width, height) {
    const scale = Math.min(width, height) >= 1536 ? 2 : 1;
    if (Math.min(width, height) < 240 * scale) return null; // 圖太小，幾何先驗不成立
    const size = 48 * scale;
    const x = Math.round(width - 120 * scale - size / 2);
    const y = Math.round(height - 120 * scale - size / 2);
    if (x < 0 || y < 0 || x + size > width || y + size > height) return null;
    return { profile: 'v2', size, x, y };
  }

  readGray(imageData, width, candidate) {
    const { x, y, size } = candidate;
    const gray = new Float32Array(size * size);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const index = ((y + row) * width + x + col) * 4;
        gray[row * size + col] =
          (imageData.data[index] + imageData.data[index + 1] + imageData.data[index + 2]) / 3;
      }
    }
    return gray;
  }

  // 星區當成未知，反覆用已知鄰居平均往內補，得到背景估計。
  // 未知處要用「已知像素的平均」當初值：初值給 0 的話中心要幾百輪才擴散得到，
  // 提早收工會把背景估成接近全黑，k 直接翻倍、rms 爆掉（實測 k=2.16、rms=140）。
  estimateBackground(gray, alpha, size) {
    const known = new Uint8Array(size * size);
    const bg = Float32Array.from(gray);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < known.length; i += 1) {
      known[i] = alpha[i] <= 0.02 ? 1 : 0;
      if (known[i]) { sum += gray[i]; count += 1; }
    }
    const seed = count ? sum / count : 0;
    for (let i = 0; i < known.length; i += 1) if (!known[i]) bg[i] = seed;
    const next = new Float32Array(size * size);
    for (let iteration = 0; iteration < PHYS.fillIterations; iteration += 1) {
      next.set(bg);
      for (let row = 0; row < size; row += 1) {
        for (let col = 0; col < size; col += 1) {
          const i = row * size + col;
          if (known[i]) continue;
          let sum = 0;
          let count = 0;
          if (col > 0) { sum += bg[i - 1]; count += 1; }
          if (col < size - 1) { sum += bg[i + 1]; count += 1; }
          if (row > 0) { sum += bg[i - size]; count += 1; }
          if (row < size - 1) { sum += bg[i + size]; count += 1; }
          if (count) next[i] = sum / count;
        }
      }
      bg.set(next);
    }
    return bg;
  }

  // 解 obs = k·α·255 + (1−k·α)·bg，回傳 k / R² / rms。
  // 灰階解與逐通道解等價（浮水印是白色，三通道同一個 k），所以只跑一次。
  fitPhysical(imageData, width, candidate) {
    const { size } = candidate;
    const alpha = this.getTemplate('v2', size);
    const gray = this.readGray(imageData, width, candidate);
    const bg = this.estimateBackground(gray, alpha, size);
    const u = [];
    const d = [];
    for (let i = 0; i < alpha.length; i += 1) {
      if (alpha[i] <= 0.02) continue;
      u.push(alpha[i] * (255 - bg[i]));
      d.push(gray[i] - bg[i]);
    }
    if (!u.length) return null;
    let numerator = 0;
    let denominator = 0;
    let ssTotal = 0;
    for (let i = 0; i < u.length; i += 1) {
      numerator += d[i] * u[i];
      denominator += u[i] * u[i];
      ssTotal += d[i] * d[i];
    }
    if (denominator < 1e-6) return null;
    const k = numerator / denominator;
    let residual = 0;
    for (let i = 0; i < u.length; i += 1) {
      const error = d[i] - k * u[i];
      residual += error * error;
    }
    return {
      k,
      r2: 1 - residual / (ssTotal + 1e-6),
      rms: Math.sqrt(ssTotal / u.length),
    };
  }

  sobelMagnitude(src, size) {
    const out = new Float32Array(size * size);
    for (let row = 1; row < size - 1; row += 1) {
      for (let col = 1; col < size - 1; col += 1) {
        const i = row * size + col;
        const gx = -src[i - size - 1] - 2 * src[i - 1] - src[i + size - 1]
          + src[i - size + 1] + 2 * src[i + 1] + src[i + size + 1];
        const gy = -src[i - size - 1] - 2 * src[i - size] - src[i - size + 1]
          + src[i + size - 1] + 2 * src[i + size] + src[i + size + 1];
        out[i] = Math.abs(gx) + Math.abs(gy);
      }
    }
    return out;
  }

  // 星形輪廓上的邊緣能量：移除前 eb，移除後/前的比值 ratio。不需要估背景。
  contourEnergy(imageData, width, candidate) {
    const { size } = candidate;
    const alpha = this.getTemplate('v2', size);
    const gray = this.readGray(imageData, width, candidate);
    const restored = new Float32Array(size * size);
    for (let i = 0; i < gray.length; i += 1) {
      const opacity = Math.min(alpha[i] * 1.01, 0.99);
      restored[i] = opacity < 0.012
        ? gray[i]
        : Math.max(0, Math.min(255, (gray[i] - 255 * opacity) / (1 - opacity)));
    }
    const alphaEdges = this.sobelMagnitude(alpha, size);
    const sorted = Array.from(alphaEdges).sort((a, b) => a - b);
    const threshold = sorted[Math.floor(sorted.length * 0.88)];
    const band = [];
    for (let i = 0; i < alphaEdges.length; i += 1) if (alphaEdges[i] > threshold) band.push(i);
    if (band.length < 8) return null;
    const meanOver = (field) => band.reduce((sum, i) => sum + field[i], 0) / band.length;
    const before = meanOver(this.sobelMagnitude(gray, size));
    const after = meanOver(this.sobelMagnitude(restored, size));
    return { ratio: after / (before + 1e-6), eb: before };
  }

  detect(imageData, width, height) {
    let best = null;
    for (const candidate of this.getCandidates(width, height)) {
      const result = this.scoreCandidate(imageData, width, candidate);
      if (!result) continue;
      if (!best || result.score > best.score) best = { ...candidate, ...result };
    }
    if (best && best.ncc >= 0.42 && best.contrast >= 1.4) return { ...best, via: 'ncc' };

    // NCC 沒過 → 用物理模型在 canonical 位置再判一次。背景花的圖靠這兩關救回來。
    const canonical = this.canonicalCandidate(width, height);
    if (!canonical) return null;
    const fit = this.fitPhysical(imageData, width, canonical);
    if (!fit) return null;
    const alpha = this.getTemplate('v2', canonical.size);
    if (fit.k >= PHYS.kMain[0] && fit.k <= PHYS.kMain[1]
      && fit.r2 >= PHYS.r2Min && fit.rms >= PHYS.rmsMin) {
      return { ...canonical, alpha, ...fit, via: 'model' };
    }
    const contour = this.contourEnergy(imageData, width, canonical);
    if (contour && fit.k >= PHYS.kRescue[0] && fit.k <= PHYS.kRescue[1]
      && contour.ratio <= PHYS.contourMax && contour.eb >= PHYS.edgeMin) {
      return { ...canonical, alpha, ...fit, ...contour, via: 'contour' };
    }
    return null;
  }

  restore(imageData, width, height, detection) {
    const output = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
    const alpha = detection.alpha;
    for (let y = 0; y < detection.size; y += 1) {
      for (let x = 0; x < detection.size; x += 1) {
        const opacity = Math.min(alpha[y * detection.size + x] * 1.01, 0.99);
        if (opacity < 0.012) continue;
        const index = ((detection.y + y) * width + detection.x + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const restored = (imageData.data[index + channel] - 255 * opacity) / (1 - opacity);
          output.data[index + channel] = Math.max(0, Math.min(255, Math.round(restored)));
        }
      }
    }
    return output;
  }

  async process(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const source = context.getImageData(0, 0, canvas.width, canvas.height);
    const detection = this.detect(source, canvas.width, canvas.height);
    if (!detection) return { canvas, removed: false, detection: null };
    const result = this.restore(source, canvas.width, canvas.height, detection);
    context.putImageData(result, 0, 0);
    return { canvas, removed: true, detection };
  }
}

const engine = new WatermarkEngine();
// 測試掛勾：tests/regression.mjs 直接打 engine.detect()，不用穿過整個 UI 流程。
window.watermarkEngine = engine;
const engineReady = engine.load().catch((error) => {
  console.error('清理模板載入失敗', error);
  return null;
});

function setLoading(visible, message = '準備圖片中…') {
  loadingText.textContent = message;
  loadingOverlay.classList.toggle('is-hidden', !visible);
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? '#a34f36' : '';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || value >= 10 || unitIndex === 1 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatType(file) {
  const type = file?.type?.split('/')[1]?.toUpperCase();
  return type === 'JPEG' ? 'JPG' : type || '圖片';
}

function formatDimensions(width, height) {
  return `${width.toLocaleString()} × ${height.toLocaleString()} px`;
}

function formatOriginalInfo(item) {
  const width = item.image?.naturalWidth || item.width;
  const height = item.image?.naturalHeight || item.height;
  return `${formatDimensions(width, height)} · ${formatType(item.file)} · ${formatBytes(item.file.size)}`;
}

function formatProcessedInfo(item) {
  const sizeChange = item.file.size ? ` · 原檔 ${formatBytes(item.file.size)}` : '';
  return `${formatDimensions(item.canvas.width, item.canvas.height)} · PNG · ${formatBytes(item.blob.size)}${sizeChange}`;
}

function releaseItemUrls(items) {
  items.forEach((item) => {
    ['originalUrl', 'processedUrl'].forEach((key) => {
      if (item[key]) URL.revokeObjectURL(item[key]);
      item[key] = null;
    });
  });
}

function updateProgress() {
  const completed = state.items.filter((item) => item.status === 'completed').length;
  const finished = state.items.filter((item) => ['completed', 'error'].includes(item.status)).length;
  const failed = state.items.filter((item) => item.status === 'error').length;
  if (finished === state.items.length && failed) {
    progressText.textContent = `完成 ${completed}/${state.items.length} · ${failed} 張失敗`;
  } else if (finished === state.items.length) {
    progressText.textContent = `全部完成 ${completed}/${state.items.length}`;
  } else {
    progressText.textContent = `處理中 ${completed}/${state.items.length}`;
  }
  downloadAllBtn.classList.toggle('is-hidden', completed === 0);
}

function decodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('圖片無法讀取'));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error('檔案無法讀取'));
    reader.readAsDataURL(file);
  });
}

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('圖片輸出失敗'))), type, .95);
  });
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '') || 'image';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reset() {
  state.batchRun += 1;
  releaseItemUrls(state.items);
  state.items = [];
  state.activeItem = null;
  fileInput.value = '';
  singlePreview.classList.add('is-hidden');
  multiPreview.classList.add('is-hidden');
  processedSection.classList.add('is-hidden');
  originalCanvas.width = 1;
  originalCanvas.height = 1;
  originalName.textContent = '';
  originalInfo.textContent = '';
  processedImage.removeAttribute('src');
  processedName.textContent = '';
  processedInfo.textContent = '';
  processedStatus.textContent = '處理完成';
  downloadSingleBtn.classList.add('is-hidden');
  imageList.replaceChildren();
  setStatus('');
  downloadAllBtn.classList.add('is-hidden');
  uploadArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function createBatchItem(item) {
  const row = document.createElement('article');
  row.className = 'batch-item';
  row.dataset.id = item.id;

  const thumb = document.createElement('div');
  thumb.className = 'batch-thumb';
  const image = document.createElement('img');
  image.alt = item.file.name;
  image.src = item.originalUrl;
  thumb.appendChild(image);

  const info = document.createElement('div');
  info.className = 'batch-info';
  const title = document.createElement('strong');
  title.textContent = item.file.name;
  const meta = document.createElement('div');
  meta.className = 'batch-meta';
  meta.textContent = `${formatType(item.file)} · ${formatBytes(item.file.size)}`;
  const status = document.createElement('div');
  status.className = 'batch-status';
  status.textContent = '等待處理…';
  info.append(title, meta, status);
  item.batchMeta = meta;

  const button = document.createElement('button');
  button.className = 'button button-primary batch-download is-hidden';
  button.type = 'button';
  button.textContent = '下載';
  button.addEventListener('click', () => downloadItem(item));
  row.append(thumb, info, button);
  return { row, image, status, button };
}

function setBatchStatus(item, message, done = false) {
  const row = document.querySelector(`[data-id="${item.id}"]`);
  if (!row) return;
  const status = row.querySelector('.batch-status');
  status.textContent = message;
  status.classList.toggle('done', done);
  if (done) row.querySelector('.batch-download').classList.remove('is-hidden');
}

async function processItem(item) {
  try {
    item.image = await decodeFile(item.file);
    item.width = item.image.naturalWidth;
    item.height = item.image.naturalHeight;
    const result = await engine.process(item.image);
    item.canvas = result.canvas;
    item.removed = result.removed;
    item.detection = result.detection;
    item.blob = await canvasToBlob(item.canvas, 'image/png');
    item.processedUrl = URL.createObjectURL(item.blob);
    item.status = 'completed';
    return item;
  } catch (error) {
    console.error(error);
    item.status = 'error';
    item.error = error;
    return item;
  }
}

async function processSingle(item, runId) {
  setLoading(true, '正在整理圖片…');
  downloadSingleBtn.classList.add('is-hidden');
  processedStatus.textContent = '整理中…';
  const isCurrent = () => runId === state.batchRun && state.activeItem === item;
  try {
    await engineReady;
    if (!isCurrent()) return;
    item.image = await decodeFile(item.file);
    if (!isCurrent()) return;
    item.width = item.image.naturalWidth;
    item.height = item.image.naturalHeight;
    originalCanvas.width = item.image.naturalWidth;
    originalCanvas.height = item.image.naturalHeight;
    originalCanvas.getContext('2d').drawImage(item.image, 0, 0);
    originalName.textContent = item.file.name;
    originalName.title = item.file.name;
    originalInfo.textContent = formatOriginalInfo(item);
    const result = await engine.process(item.image);
    if (!isCurrent()) return;
    item.canvas = result.canvas;
    item.removed = result.removed;
    item.detection = result.detection;
    item.blob = await canvasToBlob(result.canvas, 'image/png');
    if (!isCurrent()) return;
    item.processedUrl = URL.createObjectURL(item.blob);
    item.status = 'completed';
    processedImage.src = item.processedUrl;
    processedName.textContent = `cleaned_${baseName(item.file.name)}.png`;
    processedName.title = processedName.textContent;
    processedInfo.textContent = formatProcessedInfo(item);
    processedStatus.textContent = result.removed ? '已整理 Gemini 水印' : '未偵測到 Gemini 水印';
    downloadSingleBtn.classList.remove('is-hidden');
    processedSection.classList.remove('is-hidden');
    setStatus(result.removed ? '完成：只在圖片的 Gemini 星形水印區域做像素整理。' : '未偵測到 Gemini 星形水印，已保留原圖；圖片內其他文字或標誌不在處理範圍。');
  } catch (error) {
    if (!isCurrent()) return;
    console.error(error);
    processedStatus.textContent = '處理失敗';
    setStatus('圖片處理失敗，請換一張圖片再試。', true);
  } finally {
    if (isCurrent()) setLoading(false);
  }
}

async function processBatch(items, runId) {
  await engineReady;
  for (const item of items) {
    if (runId !== state.batchRun) return;
    setBatchStatus(item, '處理中…');
    await processItem(item);
    if (runId !== state.batchRun) {
      releaseItemUrls([item]);
      return;
    }
    if (item.status === 'completed') {
      const row = document.querySelector(`[data-id="${item.id}"]`);
      const image = row?.querySelector('img');
      if (image) image.src = item.processedUrl;
      if (item.batchMeta) item.batchMeta.textContent = `${formatDimensions(item.width, item.height)} · ${formatType(item.file)} ${formatBytes(item.file.size)} → PNG ${formatBytes(item.blob.size)}`;
      setBatchStatus(item, item.removed ? '完成：已整理 Gemini 水印' : '完成：未偵測到 Gemini 水印', true);
    } else {
      setBatchStatus(item, '處理失敗');
    }
    updateProgress();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function downloadItem(item) {
  if (!item?.blob) return;
  downloadBlob(item.blob, `cleaned_${baseName(item.file.name)}.png`);
}

async function downloadAll() {
  const completed = state.items.filter((item) => item.status === 'completed' && item.blob);
  if (!completed.length || !window.JSZip) return;
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = '正在打包…';
  try {
    const zip = new window.JSZip();
    completed.forEach((item) => zip.file(`cleaned_${baseName(item.file.name)}.png`, item.blob));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(blob, `cleaned-images-${Date.now()}.zip`);
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = '全部下載 ZIP';
  }
}

function receiveFiles(fileList) {
  const files = Array.from(fileList || []);
  const invalid = files.filter((file) => !ACCEPTED_TYPES.has(file.type) || file.size > MAX_FILE_SIZE);
  if (invalid.length) setStatus('部分檔案不是支援的格式，或超過 20 MB，已略過。', true);
  const valid = files.filter((file) => ACCEPTED_TYPES.has(file.type) && file.size <= MAX_FILE_SIZE);
  if (!valid.length) return;
  releaseItemUrls(state.items);
  state.batchRun += 1;
  const runId = state.batchRun;
  state.items = valid.map((file, index) => ({
    id: `${Date.now()}-${index}`,
    file,
    status: 'pending',
    originalUrl: URL.createObjectURL(file),
  }));
  if (valid.length === 1) {
    state.activeItem = state.items[0];
    singlePreview.classList.remove('is-hidden');
    multiPreview.classList.add('is-hidden');
    processedSection.classList.add('is-hidden');
    processedImage.removeAttribute('src');
    processedStatus.textContent = '處理中…';
    processSingle(state.activeItem, runId);
  } else {
    singlePreview.classList.add('is-hidden');
    multiPreview.classList.remove('is-hidden');
    imageList.replaceChildren();
    state.items.forEach((item) => imageList.appendChild(createBatchItem(item).row));
    progressText.textContent = `處理中 0/${state.items.length}`;
    downloadAllBtn.classList.add('is-hidden');
    multiPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });
    processBatch(state.items, runId);
  }
}

function openModal(mode) {
  const item = state.activeItem;
  if (!item?.image || (mode === 'processed' && !item.processedUrl)) return;
  state.modalMode = mode;
  modalImage.src = mode === 'original' ? item.image.src : item.processedUrl;
  modalTitle.textContent = mode === 'original' ? '原圖' : '整理完成';
  previewModal.classList.remove('is-hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  previewModal.classList.add('is-hidden');
  document.body.style.overflow = '';
}

uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
});
uploadArea.addEventListener('dragover', (event) => { event.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (event) => { event.preventDefault(); uploadArea.classList.remove('dragover'); receiveFiles(event.dataTransfer.files); });
fileInput.addEventListener('change', (event) => receiveFiles(event.target.files));
document.addEventListener('paste', (event) => { if (event.clipboardData?.files?.length) receiveFiles(event.clipboardData.files); });
document.getElementById('originalPreviewContainer').addEventListener('click', () => openModal('original'));
document.getElementById('processedPreviewContainer').addEventListener('click', () => openModal('processed'));
document.getElementById('closePreview').addEventListener('click', closeModal);
previewModal.addEventListener('click', (event) => { if (event.target === previewModal) closeModal(); });
downloadAllBtn.addEventListener('click', downloadAll);
downloadSingleBtn.addEventListener('click', () => downloadItem(state.activeItem));
resetSingleBtn.addEventListener('click', reset);
resetBatchBtn.addEventListener('click', reset);
document.addEventListener('keydown', (event) => {
  if (previewModal.classList.contains('is-hidden')) return;
  if (event.key === 'Escape') closeModal();
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') openModal(state.modalMode === 'original' ? 'processed' : 'original');
});

// Footer 三件套中的 Buy Me a Coffee 輕提示：不攔截操作，最多出現三次。
const footerCoffee = document.querySelector('.footer-social-bmc');
const promoLines = [
  '嘿，這裡這裡，我是咖啡按鈕',
  '我是一顆很努力的按鈕，求被點一下',
  '一杯咖啡，是下一個作品的燃料',
  '覺得好玩嗎？抖內一下下',
  '這個網站沒有廣告，只有我這顆按鈕',
];
let promoBubble;
let promoShown = 0;

function showPromoBubble() {
  if (!footerCoffee || document.hidden || promoShown >= 3) return;
  const rect = footerCoffee.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) return;
  if (!promoBubble) {
    promoBubble = document.createElement('div');
    promoBubble.className = 'yz-bubble';
    promoBubble.setAttribute('role', 'status');
    document.body.appendChild(promoBubble);
  }
  const bubbleWidth = Math.min(260, window.innerWidth - 28);
  const left = Math.max(14, Math.min(window.innerWidth - bubbleWidth - 14, rect.left + rect.width / 2 - bubbleWidth / 2));
  const above = rect.top > 82;
  promoBubble.textContent = promoLines[Math.floor(Math.random() * promoLines.length)];
  promoBubble.classList.remove('yz-on', 'yz-above', 'yz-below');
  promoBubble.classList.add(above ? 'yz-above' : 'yz-below');
  promoBubble.style.left = `${left}px`;
  promoBubble.style.width = `${bubbleWidth}px`;
  promoBubble.style.top = `${above ? rect.top - 13 : rect.bottom + 13}px`;
  footerCoffee.classList.remove('yz-hop');
  void footerCoffee.offsetWidth;
  footerCoffee.classList.add('yz-hop');
  requestAnimationFrame(() => promoBubble?.classList.add('yz-on'));
  window.setTimeout(() => promoBubble?.classList.remove('yz-on'), 5200);
  promoShown += 1;
}

if (footerCoffee && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
  footerCoffee.classList.add('yz-idle');
  window.__yzPromo = showPromoBubble;
  const schedulePromo = (delay) => window.setTimeout(() => {
    showPromoBubble();
    if (promoShown < 3) schedulePromo(90000 + Math.random() * 90000);
  }, delay);
  schedulePromo(18000 + Math.random() * 12000);
}
