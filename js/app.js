"use strict";

const $ = id => document.getElementById(id);
const drop = $("drop"), fileInput = $("file"), errorBox = $("error");

// ---------- PNG 基础 ----------
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const u32 = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
const u16 = (b, i) => b[i] << 8 | b[i + 1];

function parseChunks(bytes) {
  const chunks = [];
  for (let i = 8; i + 12 <= bytes.length;) {
    const size = u32(bytes, i);
    if (size > bytes.length - i - 12) throw new Error("PNG 文件不完整。");
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    chunks.push({ type, data: bytes.subarray(i + 8, i + 8 + size) });
    i += 12 + size;
    if (type === "IEND") break;
  }
  return chunks;
}

async function inflate(data) {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 将 PNG 原始解压数据（含滤波字节）解码为 RGBA
function unfilter(ihdr, raw) {
  const { width, height, depth, color } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (channels === undefined || depth !== 8 && depth !== 16)
    throw new Error(`不支持的颜色类型 ${color} / 位深 ${depth}。`);
  const bpp = Math.max(1, channels * depth / 8);       // 滤波步长（字节）
  const stride = Math.ceil(width * channels * depth / 8);
  if (raw.length < (stride + 1) * height) throw new Error("图像数据不完整。");
  const lines = new Uint8Array(stride * height);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1), filter = raw[off];
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    cur.set(raw.subarray(off + 1, off + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 1: cur[x] = (cur[x] + a) & 255; break;
        case 2: cur[x] = (cur[x] + b) & 255; break;
        case 3: cur[x] = (cur[x] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
      }
    }
    prev.set(cur);
  }
  // 展开为 RGBA8
  const out = new Uint8Array(width * height * 4);
  const bitMask = (1 << depth) - 1;
  const scale = { 1: 255, 2: 85, 4: 17 }[depth];
  const get = (base, i) => {  // 第 i 个样本（8/16 位深）的取值
    if (depth === 16) return lines[base + i * 2];
    if (depth === 8) return lines[base + i];
    const bitPos = i * depth, byte = lines[base + (bitPos >> 3)];
    return (((byte >> (8 - depth - (bitPos & 7))) & bitMask) * scale);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4, base = y * stride;
    let r = 0, g = 0, b = 0, a = 255;
    switch (color) {
      case 0: r = g = b = get(base, x * channels); break;
      case 4: r = g = b = get(base, x * channels); a = get(base, x * channels + 1); break;
      case 2: r = get(base, x * 3); g = get(base, x * 3 + 1); b = get(base, x * 3 + 2); break;
      case 6: r = get(base, x * 4); g = get(base, x * 4 + 1); b = get(base, x * 4 + 2); a = get(base, x * 4 + 3); break;
      case 3: {
        const i = get(base, x);
        r = ihdr.plte[i * 3]; g = ihdr.plte[i * 3 + 1]; b = ihdr.plte[i * 3 + 2];
        a = ihdr.trns && i < ihdr.trns.length ? ihdr.trns[i] : 255;
        break;
      }
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return out;
}

async function decodeImage(ihdr, idatParts) {
  const raw = await inflate(concat(idatParts));
  return { width: ihdr.width, height: ihdr.height, data: unfilter(ihdr, raw) };
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n);
  let i = 0; for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

// ---------- 输出 ----------
function drawTo(canvas, image) {
  canvas.width = image.width; canvas.height = image.height;
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
}

async function toBlob(image) {
  const c = document.createElement("canvas");
  drawTo(c, image);
  return new Promise(res => c.toBlob(res, "image/png"));
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function makeZip(entries) {
  const zip = new JSZip();
  for (const { name, blob } of entries) zip.file(name, blob);
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

// ---------- APNG 解析 ----------
const fmtFcTL = d =>
  `尺寸 ${u32(d, 4)}×${u32(d, 8)}  位置 (${u32(d, 12)},${u32(d, 16)})  ` +
  `延时 ${u16(d, 20)}/${u16(d, 23) ? u16(d, 22) * 256 + u16(d, 23) : 100}s  ` +
  `disposal=${d[24]} blend=${d[25]}`;

async function parseAPNG(bytes) {
  const chunks = parseChunks(bytes);
  if (chunks[0]?.type !== "IHDR" || chunks[0].data.length < 13) throw new Error("PNG 文件头无效。");
  const h = chunks[0].data;
  const baseIHDR = {
    width: u32(h, 0), height: u32(h, 4), depth: h[8], color: h[9],
    plte: (chunks.find(c => c.type === "PLTE") || {}).data,
    trns: (chunks.find(c => c.type === "tRNS") || {}).data,
  };
  const acTL = chunks.find(c => c.type === "acTL");
  const meta = [
    `画布 ${baseIHDR.width}×${baseIHDR.height}  位深 ${baseIHDR.depth}  颜色类型 ${baseIHDR.color}`,
    `块序列：${chunks.map(c => c.type).join(" → ")}`,
  ];
  if (acTL) meta.push(`acTL：帧数 ${u32(acTL.data, 0)}  循环 ${u32(acTL.data, 4)}${u32(acTL.data, 4) === 0 ? "（无限）" : ""}`);

  // IDAT 静态帧
  const idat = chunks.filter(c => c.type === "IDAT").map(c => c.data);
  let cover = null;
  if (idat.length) cover = await decodeImage(baseIHDR, idat);
  else meta.push("（无 IDAT 数据）");

  // fcTL / fdAT 动画帧
  const frames = [];
  let ctl = null, parts = [], seqInfo = [];
  const finish = async () => {
    if (!ctl) return;
    if (!parts.length) throw new Error("动画帧缺少数据。");
    const ihdr = { ...baseIHDR, width: u32(ctl, 4), height: u32(ctl, 8) };
    frames.push({ image: await decodeImage(ihdr, parts), ctl });  // 原始差分（未合成）
    seqInfo.push(`#${frames.length - 1}: seq ${u32(ctl, 0)} ${u32(ctl, 4)}×${u32(ctl, 8)}+${u32(ctl, 12)}+${u32(ctl, 16)}`);
    ctl = null; parts = [];
  };
  for (const c of chunks) {
    if (c.type === "fcTL") { await finish(); if (c.data.length !== 26) throw new Error("fcTL 数据块无效。"); ctl = c.data; }
    else if (c.type === "fdAT") { if (!ctl || c.data.length < 4) throw new Error("fdAT 数据块无效。"); parts.push(c.data.subarray(4)); }
    else if (c.type === "IDAT" && ctl) parts.push(c.data);
  }
  await finish();
  if (acTL && frames.length !== u32(acTL.data, 0))
    meta.push(`⚠ 帧数不匹配：实际 ${frames.length}，acTL 声称 ${u32(acTL.data, 0)}`);
  return { baseIHDR, cover, frames, meta, seqInfo };
}

// 按 APNG 规则重放第 0..i 帧（disposal/blend），返回第 i 帧的完整 RGBA 画面
function composite(canvasData, canvasW, canvasH, patch, x, y, blend) {
  for (let row = 0; row < patch.height; row++) for (let col = 0; col < patch.width; col++) {
    const s = (row * patch.width + col) * 4;
    const dx = x + col, dy = y + row;
    if (dx < 0 || dy < 0 || dx >= canvasW || dy >= canvasH) continue;
    const d = (dy * canvasW + dx) * 4, alpha = patch.data[s + 3];
    if (!blend || alpha === 255) { canvasData.set(patch.data.subarray(s, s + 4), d); }
    else if (alpha) {
      const a = alpha * 255 + canvasData[d + 3] * (255 - alpha);
      for (let c2 = 0; c2 < 3; c2++)
        canvasData[d + c2] = Math.floor((patch.data[s + c2] * alpha * 255 + canvasData[d + c2] * canvasData[d + 3] * (255 - alpha) + a / 2) / a);
      canvasData[d + 3] = Math.floor((a + 127) / 255);
    }
  }
}

function clearRect(data, W, H, x, y, w, h) {
  for (let row = y; row < y + h && row < H; row++)
    for (let col = x; col < x + w && col < W; col++)
      data.fill(0, (row * W + col) * 4, (row * W + col) * 4 + 4);
}

function compositeUpTo(i) {
  const W = current.baseIHDR.width, H = current.baseIHDR.height;
  const data = new Uint8Array(W * H * 4);
  let before = null, rect = null, disposal = 0;
  for (let k = 0; k <= i; k++) {
    // disposal 针对的是上一帧（k-1），在绘制第 k 帧前执行
    if (k > 0) {
      if (disposal === 1 && rect) clearRect(data, W, H, ...rect);
      else if (disposal === 2 && before) data.set(before);
    }
    const c = current.frames[k].ctl;
    before = data.slice();
    rect = [u32(c, 12), u32(c, 16), u32(c, 4), u32(c, 8)];
    disposal = c[24];
    composite(data, W, H, current.frames[k].image, u32(c, 12), u32(c, 16), c[25] === 1);
  }
  return { width: W, height: H, data };
}

// ---------- 点击放大查看 ----------
const lightbox = $("lightbox"), zoomCanvas = $("zoom"), caption = $("caption");
function showZoom(image, text) {
  drawTo(zoomCanvas, image);
  caption.textContent = `${text}  ·  ${image.width}×${image.height}`;
  lightbox.classList.remove("hidden");
}
lightbox.addEventListener("click", () => lightbox.classList.add("hidden"));

// ---------- UI ----------
let current = null;

function showError(msg) { errorBox.textContent = "错误：" + msg; }

async function loadFile(file) {
  errorBox.textContent = "";
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!SIGNATURE.every((n, i) => bytes[i] === n)) { showError("不是 PNG / APNG 文件。"); return; }
  try {
    current = await parseAPNG(bytes);
    render(file.name);
  } catch (e) { showError(String(e.message || e)); console.error(e); }
}

function render(name) {
  $("result").classList.remove("hidden");
  $("meta").innerHTML = current.meta.map(m => "· " + m).join("<br>") +
    (current.seqInfo.length ? "<br>· 动画帧：" + current.seqInfo.join("；") : "");

  // IDAT
  if (current.cover) {
    const coverCanvas = $("cover");
    drawTo(coverCanvas, current.cover);
    coverCanvas.onclick = () => showZoom(current.cover, "静态帧（封面）");
    $("dl-idat").onclick = async () =>
      saveBlob(await toBlob(current.cover), name.replace(/\.png$/i, "") + "_cover_frame.png");
  }

  // 动画帧
  const list = $("frames"); list.innerHTML = "";
  const diffMode = $("mode").checked;

  current.frames.forEach((f, i) => {
    const card = document.createElement("div"); card.className = "frame";
    const thumb = document.createElement("canvas"); thumb.className = "thumb";
    const label = document.createElement("div"); label.className = "name";
    label.textContent = `动画帧 ${i}${i === 0 ? "（首帧）" : ""}`;
    const info = document.createElement("div"); info.className = "info";
    info.textContent = fmtFcTL(f.ctl);
    const btn = document.createElement("button"); btn.textContent = "下载 PNG"; btn.className = "secondary";

    if (diffMode) {
      drawTo(thumb, f.image);
      thumb.onclick = () => showZoom(f.image, `动画帧 ${i}（差分，透明背景）`);
      btn.onclick = async () => saveBlob(await toBlob(f.image), `${name.replace(/\.png$/i, "")}_frame${i}_diff.png`);
    } else {
      const full = compositeUpTo(i);
      drawTo(thumb, full);
      thumb.onclick = () => showZoom(full, `动画帧 ${i}（完整合成画面）`);
      btn.onclick = async () => saveBlob(await toBlob(full), `${name.replace(/\.png$/i, "")}_frame${i}_full.png`);
    }
    card.append(thumb, label, info, btn); list.append(card);
  });
}

$("mode").addEventListener("change", () => current && render($("file").files[0]?.name || "apng"));

$("dl-all").addEventListener("click", async () => {
  if (!current) return;
  const name = ($("file").files[0]?.name || "apng").replace(/\.png$/i, "");
  const suffix = $("mode").checked ? "diff" : "full";
  $("dl-all").disabled = true;
  const entries = [];
  for (let i = 0; i < current.frames.length; i++) {
    const image = $("mode").checked ? current.frames[i].image : compositeUpTo(i);
    entries.push({ name: `${name}_frame${i}_${suffix}.png`, blob: await toBlob(image) });
    await new Promise(r => setTimeout(r, 0));
  }
  saveBlob(await makeZip(entries), `${name}_${suffix}_frames.zip`);
  $("dl-all").disabled = false;
});

// 拖放与选择
drop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => fileInput.files[0] && loadFile(fileInput.files[0]));
["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => {
  const f = [...e.dataTransfer.files].find(f => /\.png$/i.test(f.name) || /image\/(png|apng)/.test(f.type));
  if (f) loadFile(f); else showError("请拖入 .png 文件。");
});
