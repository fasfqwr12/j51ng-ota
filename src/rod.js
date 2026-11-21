/* ============================================================
 * rod.js —— 上位机「杆包」页：自定义 Pro（第 5 档推荐杆模型）
 *
 * 链路：
 *   本页 53A2 0x0D 分帧  → 副板暂存 68 字节
 *        53A2 0x0E 命令  → 副板 FC16 三段写主控 0x2000/0x200E/0x201C
 *                        → FC06 0x1080 提交 → 主控算 CRC/擦页/写/回读
 *                        → 副板 FC03 读 0x1050 → 53A2 0x15 回帧
 *
 * 表结构（68 字节，与主控 golf_recommend.c 一致）：
 *   [0]'G' [1]'R' [2]ver [3]count [4]tol [5]rsvd [6..7]crc16 [8..15]rsvd
 *   [16..] 13 × { mean int16, sigma uint16 }   单位：码×2
 * ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const NAMES = ["DRIVER", "3W", "5W", "H4", "4I", "5I", "6I",
                 "7I", "8I", "9I", "PW", "GW", "SW"];
  const DEF_MEAN_X2  = [480, 420, 390, 360, 320, 300, 280, 260, 230, 200, 180, 156, 130];
  const DEF_SIGMA_X2 = [ 24,  28,  30,  32,  34,  36,  36,  38,  40,  42,  44,  46,  50];

  const VER = 1, TOL = 5, COUNT = 13, BYTES = 68;

  let meanX2 = DEF_MEAN_X2.slice();
  let sigX2  = DEF_SIGMA_X2.slice();

  /* 本地 API 模式（127.0.0.1）下 BLE 归后端所有，浏览器拿不到 notify */
  const API_MODE = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
  let rxSince = 0;

  /* ---------- CRC16-CCITT（初值 0xFFFF，多项式 0x1021）---------- */
  function crc16(u8) {
    let c = 0xFFFF;
    for (const b of u8) {
      c ^= (b << 8) & 0xFFFF;
      for (let i = 0; i < 8; i++) {
        c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
      }
    }
    return c;
  }

  /* ---------- 组装 68 字节表 ---------- */
  function build() {
    const b = new Uint8Array(BYTES);
    b.fill(0xFF);                    /* 与主控 cr_default() 一致：整表先填 0xFF */
    b[0] = 0x47; b[1] = 0x52;        /* 'G','R' */
    b[2] = VER; b[3] = COUNT; b[4] = TOL; b[5] = 0;
    for (let i = 0; i < COUNT; i++) {
      const m = meanX2[i] & 0xFFFF, s = sigX2[i] & 0xFFFF;
      b[16 + i * 4 + 0] = m & 0xFF;
      b[16 + i * 4 + 1] = (m >> 8) & 0xFF;
      b[16 + i * 4 + 2] = s & 0xFF;
      b[16 + i * 4 + 3] = (s >> 8) & 0xFF;
    }
    const t = b.slice(); t[6] = 0; t[7] = 0;
    const c = crc16(t);
    b[6] = c & 0xFF; b[7] = (c >> 8) & 0xFF;
    return { bytes: b, crc: c };
  }

  /* ---------- 传输 ---------- */
  function frame(code, payload) {
    const pl = new Uint8Array(payload || []);
    const api = window.__J51NG;
    if (api && typeof api.frame === "function") return api.frame(code, pl);
    const n = pl.length + 3;
    const f = new Uint8Array(5 + pl.length + 2);
    f[0] = 0x53; f[1] = 0xA2; f[2] = n & 0xFF; f[3] = (n >> 8) & 0xFF; f[4] = code;
    f.set(pl, 5);
    let s = 0;
    for (let i = 0; i < 5 + pl.length; i++) s += f[i];
    f[5 + pl.length] = s & 0xFF;
    f[6 + pl.length] = (s >> 8) & 0xFF;
    return f;
  }

  async function send(f) {
    /* 本地 API 模式下 BLE 归后端所有，浏览器的 api.connected() 不可信，
     * 必须先判 API_MODE（和 board.js 的 send 保持一致）。 */
    const api = window.__J51NG;
    if (!API_MODE && api && typeof api.connected === "function" && api.connected()) {
      return api.send(0, f);
    }
    const r = await fetch("/api/raw", { method: "POST", body: f });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 80));
    return r.json().catch(() => ({}));
  }

  async function drain() {
    const r = await fetch("/api/rx?since=" + rxSince, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    if (typeof j.next === "number") rxSince = j.next;
    return (j.frames || []).map((h) => {
      const b = Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
      return [b[0], b.slice(1)];
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 发 0x0F 取最近一次结果；pred 决定何时收工 */
  async function pollResult(pred, timeoutMs) {
    const t0 = Date.now();
    await drain();                      /* 先丢弃积压旧帧，避免拿到上一次的结果 */
    while (Date.now() - t0 < timeoutMs) {
      await send(frame(0x0F));
      await sleep(180);
      for (const [code, p] of await drain()) {
        if (code === 0x15 && pred(p)) return p;
      }
    }
    return null;
  }

  /* ---------- UI ---------- */
  function setTail(t) { const e = $("rdTail"); if (e) e.textContent = t; }

  /* 表里存的是 mean/sigma（算法要用的量），但让用户填"最近/最远"两个边界更好懂：
   *   mean = (lo+hi)/2,   sigma = (hi-lo)/4      （覆盖 ±2σ，约 95%）
   * 两个边界都按"码"填，×2 之后就是主控要的定点，存储格式一点没变。 */
  function boundsOf(i) {
    const m = meanX2[i] / 2, sg = sigX2[i] / 2;
    return { lo: m - 2 * sg, hi: m + 2 * sg };
  }

  function setBounds(i, lo, hi) {
    const a = Math.min(lo, hi), b = Math.max(lo, hi);
    meanX2[i] = Math.round(a + b);                       /* (a+b)/2 × 2 */
    sigX2[i]  = Math.max(1, Math.round((b - a) / 2));    /* (b-a)/4 × 2，至少 0.5 码，防除零 */
  }

  function fmtMeanSigma(i) {
    return `${(meanX2[i] / 2).toFixed(1)} ± ${(sigX2[i] / 2).toFixed(1)}`;
  }

  function render() {
    const grid = $("rdGrid");
    if (!grid) return;
    grid.innerHTML = NAMES.map((n, i) => {
      const { lo, hi } = boundsOf(i);
      return `
      <div class="rdrow" data-i="${i}">
        <span class="rdname">${n}</span>
        <input class="rdin" type="number" step="1" data-k="lo" value="${lo.toFixed(1)}">
        <span class="rdunit">~</span>
        <input class="rdin" type="number" step="1" data-k="hi" value="${hi.toFixed(1)}">
        <span class="rdunit">码</span>
        <span class="rdev">${fmtMeanSigma(i)}</span>
      </div>`;
    }).join("") + `
      <div class="rdhead"><span class="rdname">杆</span><span class="rdunit">最近</span>
        <span class="rdunit"></span><span class="rdunit">最远</span>
        <span class="rdunit"></span><span class="rdunit">均值 ± σ</span></div>`;

    grid.querySelectorAll("input.rdin").forEach((el) => {
      el.addEventListener("change", () => {
        const row = el.closest(".rdrow");
        const i = parseInt(row.dataset.i, 10);
        const lo = parseFloat(row.querySelector('[data-k="lo"]').value || "0");
        const hi = parseFloat(row.querySelector('[data-k="hi"]').value || "0");
        setBounds(i, lo, hi);
        const b = boundsOf(i);
        row.querySelector('[data-k="lo"]').value = b.lo.toFixed(1);
        row.querySelector('[data-k="hi"]').value = b.hi.toFixed(1);
        row.querySelector(".rdev").textContent = fmtMeanSigma(i);
        updateCompare();
      });
    });
    updateCompare();
  }

  let lastRemote = null;   /* {valid, ver, count, crc} */

  /* 副板回 0x15 的 ack：0x02 提交完成 / 0x03 擦除完成 / 0x04 状态
   * 0x81 受理中（不算结束） / 0xE1 主控 600 ms 没回帧 / 0xE2 副板没发出去
   * 0x91 主控链路未就绪 / 0x82..0x8F 主控异常应答（0x80|Modbus 异常码） */
  const isErrAck = (c) => c === 0x91 || c === 0xE1 || c === 0xE2 || (c >= 0x82 && c <= 0x8F);
  function ackText(c) {
    if (c === 0xE1) return "主控无应答（600ms 内没回 0x1050）";
    if (c === 0xE2) return "发送失败：副板串口这一帧没发出去";
    if (c === 0x91) return "主控链路未就绪（副板刚上电或正在升级）";
    if (c >= 0x82 && c <= 0x8F) return "主控异常应答 0x" + (c & 0x0F).toString(16).toUpperCase();
    if (c === 0x92 || c === 0x93 || c === 0x94) return "下发被拒 0x" + c.toString(16).toUpperCase();
    return "错误码 0x" + c.toString(16).toUpperCase();
  }

  function updateCompare() {
    const { crc } = build();
    const local = `本地 crc=0x${crc.toString(16).toUpperCase().padStart(4, "0")}`;
    let remote = "主控：未读取";
    let verdict = "";
    if (lastRemote) {
      if (!lastRemote.valid) {
        remote = "主控：无自定义表";
        verdict = "→ 需要下发";
      } else {
        remote = `主控：v${lastRemote.ver} ${lastRemote.count} 杆 crc=0x` +
                 lastRemote.crc.toString(16).toUpperCase().padStart(4, "0");
        verdict = (lastRemote.crc === crc) ? "→ 已是最新" : "→ 需要更新";
      }
    }
    const el = $("rdStatus");
    if (el) el.textContent = `${local}　${remote}　${verdict}`;
  }

  async function readStatus() {
    setTail("读取中…");
    try {
      await send(frame(0x0E, [4]));
    } catch (e) {
      setTail("发送失败：" + e.message); return;
    }
    const p = await pollResult((x) => x[0] === 0x04 || isErrAck(x[0]), 4000);
    if (!p) { setTail("读取超时（副板没回 0x15）"); lastRemote = null; updateCompare(); return; }
    if (isErrAck(p[0])) { setTail(ackText(p[0])); lastRemote = null; updateCompare(); return; }
    lastRemote = { valid: p[1] ? 1 : 0, ver: p[2], count: p[3], crc: p[4] | (p[5] << 8) };
    setTail("已读取");
    updateCompare();
  }

  async function download() {
    const { bytes, crc } = build();
    setTail("下发中 0/3…");
    for (let k = 0; k < 3; k++) {
      const off = k * 28;
      const n = Math.min(28, BYTES - off);
      const pl = new Uint8Array(3 + n);
      pl[0] = off & 0xFF; pl[1] = (off >> 8) & 0xFF; pl[2] = n;
      pl.set(bytes.subarray(off, off + n), 3);
      await send(frame(0x0D, pl));
      setTail(`下发中 ${k + 1}/3…`);
      await sleep(450);
    }
    setTail("提交中…");
    await send(frame(0x0E, [1]));
    const p = await pollResult((x) => [2, 3].includes(x[0]) || isErrAck(x[0]) || [0x92, 0x93, 0x94].includes(x[0]), 8000);
    if (!p) { setTail("提交超时"); return; }
    if (p[0] === 0x02) {
      const r = { valid: p[1] ? 1 : 0, ver: p[2], count: p[3], crc: p[4] | (p[5] << 8) };
      lastRemote = r;
      setTail(r.crc === crc ? "下发成功 · 校验一致" : "下发完成但 crc 不一致");
    } else {
      setTail(ackText(p[0]));
    }
    updateCompare();
  }

  function loadDefault() {
    meanX2 = DEF_MEAN_X2.slice();
    sigX2  = DEF_SIGMA_X2.slice();
    render();
    setTail("已载入默认");
  }

  async function erase() {
    setTail("擦除中…");
    await send(frame(0x0E, [3]));
    const p = await pollResult((x) => x[0] === 3 || isErrAck(x[0]), 6000);
    if (!p) { setTail("擦除超时"); return; }
    lastRemote = p[0] === 0x03
      ? { valid: p[1] ? 1 : 0, ver: p[2], count: p[3], crc: p[4] | (p[5] << 8) }
      : null;
    setTail(p[0] === 0x03 ? "已擦除" : ackText(p[0]));
    updateCompare();
  }

  function init() {
    const style = document.createElement("style");
    style.textContent = `
      #rdGrid { display:grid; gap:4px; margin-top:10px; }
      .rdrow, .rdhead { display:grid; grid-template-columns:70px 1fr 14px 1fr 26px 1fr;
                        align-items:center; gap:6px; }
      .rdhead { color:var(--muted,#888); font-size:11px; order:-1; }
      .rdname { font-weight:600; font-size:13px; }
      .rdunit { font-size:12px; color:var(--muted,#888); }
      .rdev { font-size:11px; color:var(--muted,#888); white-space:nowrap; }
      .rdin { width:100%; padding:5px 7px; border:1px solid var(--line,#d8d3c4);
              border-radius:7px; background:transparent; font:inherit; text-align:right; }
      .rdbar { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
    `;
    document.head.appendChild(style);

    render();
    $("rdRead")?.addEventListener("click", () => readStatus());
    $("rdSend")?.addEventListener("click", () => download());
    $("rdDefault")?.addEventListener("click", loadDefault);
    $("rdErase")?.addEventListener("click", erase);

    if (API_MODE) drain();   /* 把游标推到当前末尾，避免重放旧帧 */
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
