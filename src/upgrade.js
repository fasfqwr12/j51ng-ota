/* ============================================================
 * upgrade.js —— 板卡扫描 / 在线库对照 / 一键升级（v2 协议）
 *
 * 链路（全部走蓝牙板，其他板子由它转述）：
 *   0x24           → 0x25  清单：附属板数量 + 机型 + 本机 MAC(=设备ID) + id 列表
 *   0x20 <id>      → 0x21  版本/CRC：id,stage,fw_hi,fw_lo,hw_hi,hw_lo,crc32(4),size_kb(2)
 *   0x22 <id>      → 0x23  型号字符串 12 字节
 *   在线库：GET /api/manifest  （后端读 firmware/*.bin 的镜像头）
 *   升级：  POST /api/ota?target=M|S   （沿用现有 OTA 通道）
 * ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API = "";
  let rxSince = 0;

  /* ---------- 帧收发 ---------- */
  function frame(code, payload) {
    const pl = Uint8Array.from(payload || []);
    const n = pl.length + 3;
    const f = new Uint8Array(5 + pl.length + 2);
    f[0] = 0x53; f[1] = 0xA2;
    f[2] = n & 0xFF; f[3] = (n >> 8) & 0xFF;
    f[4] = code;
    f.set(pl, 5);
    let s = 0;
    for (let i = 0; i < 5 + pl.length; i++) s += f[i];
    f[5 + pl.length] = s & 0xFF;
    f[6 + pl.length] = (s >> 8) & 0xFF;
    return f;
  }

  async function post(path, body) {
    const r = await fetch(API + path, { method: "POST", body });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json().catch(() => ({}));
  }

  async function drain() {
    const r = await fetch(API + "/api/rx?since=" + rxSince, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    if (typeof j.next === "number") rxSince = j.next;
    return (j.frames || []).map((h) => [
      parseInt(h.slice(0, 2), 16),
      Uint8Array.from((h.slice(2).match(/../g) || []).map((x) => parseInt(x, 16))),
    ]);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ask(code, payload, want, ms) {
    await drain();                       /* 丢掉积压，避免拿到上一次的应答 */
    await post("/api/raw", frame(code, payload));
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 1500)) {
      for (const [c, p] of await drain()) {
        if (c === want) return p;
      }
      await sleep(80);
    }
    return null;
  }

  /* ---------- 状态 ---------- */
  let boards = [];        /* [{id, stage, fw, hw, crc, sizeKb, model}] */
  let lib = [];           /* /api/manifest items */
  let devId = "";

  const nameOf = (id) => (id === 1 ? "蓝牙板 S" : id === 2 ? "主控 M" : "板卡 " + id);
  const verOf = (hi, lo) => `v${hi}.${lo}`;
  const hex = (n, w) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(w || 8, "0");

  /* ---------- 扫描 ---------- */
  async function scan() {
    setTail("扫描中…");
    boards = []; devId = "";
    const head = await ask(0x24, [], 0x25, 2000);
    if (!head) { setTail("扫描超时（蓝牙板无应答）"); render(); return; }

    const count = head[0];
    /* BLE 地址在固件里是小端存的，显示时反过来才和手机/系统里看到的一致 */
    devId = Array.from(head.slice(2, 8)).reverse()
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
    const ids = [1];
    for (let i = 0; i < count; i++) if (head[8 + i]) ids.push(head[8 + i]);

    for (const id of ids) {
      const d = await ask(0x20, [id], 0x21, 1200);
      const m = await ask(0x22, [id], 0x23, 1200);
      if (!d) { boards.push({ id, missing: true }); continue; }
      boards.push({
        id: d[0],
        stage: d[1],
        fw: verOf(d[2], d[3]),
        hw: verOf(d[4], d[5]),
        crc: (d[6] | (d[7] << 8) | (d[8] << 16) | (d[9] << 24)) >>> 0,
        sizeKb: d[10] | (d[11] << 8),
        model: m ? String.fromCharCode(...Array.from(m.slice(1, 13)).filter((c) => c >= 32 && c < 127)) : "",
        missing: false,
      });
    }
    setTail(`扫描完成：${boards.length} 块板`);
    render();
  }

  /* ---------- 在线库 ---------- */
  async function loadLib() {
    const r = await fetch(API + "/api/manifest", { cache: "no-store" });
    const j = await r.json();
    lib = (j.items || []).filter((x) => x.imgtype === 0);   /* 只比 APP 镜像 */
    render();
  }

  /* 设备板卡 ↔ 库条目：用 board_id（= META_TARGET）配对 */
  function libFor(id) {
    return lib.find((x) => x.board_id === id) || null;
  }

  function verdict(b) {
    if (b.missing) return { text: "无应答", cls: "bad", need: false };
    const l = libFor(b.id);
    if (!l) return { text: "库里没有这块板的固件", cls: "warn", need: false };
    const sameVer = (b.fw === verOf(l.fw_major, l.fw_minor));
    const sameCrc = (b.crc === l.app_crc_u32);
    if (sameVer && sameCrc) return { text: "已是最新", cls: "ok", need: false };
    if (!sameVer) return { text: `需升级 ${b.fw} → ${verOf(l.fw_major, l.fw_minor)}`, cls: "warn", need: true };
    return { text: "版本相同但 CRC 不同（需重烧）", cls: "warn", need: true };
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const box = $("up2Table");
    if (!box) return;

    const head = `<div class="u2row u2head">
      <span>板卡</span><span>型号</span><span>设备版本</span><span>设备 CRC</span>
      <span>库版本</span><span>库 CRC</span><span>结论</span></div>`;

    const rows = boards.map((b) => {
      const l = libFor(b.id);
      const v = verdict(b);
      return `<div class="u2row">
        <span>${nameOf(b.id)}${b.stage === 0 ? ' <b style="color:#c47">BOOT</b>' : ""}</span>
        <span>${b.model || "—"}</span>
        <span>${b.missing ? "—" : b.fw}</span>
        <span class="u2mono">${b.missing ? "—" : hex(b.crc)}</span>
        <span>${l ? verOf(l.fw_major, l.fw_minor) : "—"}</span>
        <span class="u2mono">${l ? l.app_crc : "—"}</span>
        <span class="${v.cls}">${v.text}</span>
      </div>`;
    }).join("");

    box.innerHTML = head + (rows || `<div class="u2row u2empty">点「扫描设备」开始</div>`);

    const need = boards.filter((b) => verdict(b).need).length;
    const btn = $("up2Go");
    if (btn) {
      btn.disabled = need === 0;
      btn.textContent = need ? `一键升级（${need} 块）` : "一键升级";
    }
    const idEl = $("up2Dev");
    if (idEl) idEl.textContent = devId || "—";
  }

  function setTail(t) { const e = $("up2Tail"); if (e) e.textContent = t; }

  /* ---------- 一键升级 ---------- */
  async function upgradeAll() {
    const list = boards.filter((b) => verdict(b).need);
    /* 蓝牙板永远最后：它一升级蓝牙就断 */
    list.sort((a, b) => (a.id === 1 ? 1 : 0) - (b.id === 1 ? 1 : 0) || a.id - b.id);

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const l = libFor(b.id);
      const target = b.id === 1 ? "S" : "M";
      setTail(`[${i + 1}/${list.length}] 正在升级 ${nameOf(b.id)} → ${verOf(l.fw_major, l.fw_minor)} …`);
      try {
        const bin = await (await fetch(`/firmware/${l.file}`)).arrayBuffer();
        const r = await post(`/api/ota?target=${target}`, bin);
        if (!r.ok) throw new Error(r.err || "提交失败");
        for (;;) {
          await sleep(1500);
          const st = await (await fetch("/api/status", { cache: "no-store" })).json();
          if (!st.running) {
            if (st.stage && String(st.stage).indexOf("通过") < 0 && !st.ok) throw new Error(st.stage);
            break;
          }
        }
      } catch (e) {
        setTail(`升级 ${nameOf(b.id)} 失败：${e.message}`);
        return;
      }
      if (b.id === 1) { setTail("蓝牙板已升级，连接会断开，请重新连接后再扫描"); return; }
    }
    setTail("全部完成，重新扫描核对…");
    await sleep(1200);
    await scan();
  }


  /* ---------- 固件卡：左=这块板现在跑的，右=你选的固件 ---------- */
  function curTarget() {
    const b = document.querySelector("#seg button.on");
    return b ? (b.dataset.t || "M") : "M";
  }
  const idOfTarget = (t) => (t === "S" ? 1 : t === "M" ? 2 : -1);
  const crc8 = (n) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(8, "0");


  /* 选中文件的镜像头：优先用 app.js 解析好的全局对象，拿不到就从
   * 「元数据」那一行文本反解——两边字段一致，避免跨模块耦合出问题。 */
  function fileMetaFromDom() {
    const g = window.__j5aa;
    if (g && g.model) return g;
    const el = $("kMeta");
    const txt = el ? el.textContent || "" : "";
    const r = txt.match(/^(APP|BOOT)\s*·\s*(.+?)\s*→\s*(.+?)\s*·\s*v([\d.]+)\s*·\s*代码区\s*(\d+)\s*B\s*·\s*crc\s*([0-9A-Fa-f]{8})/);
    if (!r) return null;
    return {
      imageType: r[1] === "APP" ? 0 : 1,
      model: r[2],
      target: r[3].indexOf("主控") >= 0 ? 2 : r[3].indexOf("蓝牙") >= 0 ? 1 : 0,
      verText: r[4],
      size: parseInt(r[5], 10),
      payloadCrc: parseInt(r[6], 16),
    };
  }

  function renderFwCompare() {
    const curEl = $("fwCur"), selEl = $("fwSel"), vd = $("fwVerdict");
    if (!curEl || !selEl) return;
    const t = curTarget();
    const b = boards.find((x) => x.id === idOfTarget(t));
    const m = fileMetaFromDom();
    const fname = ($("kFile") && $("kFile").textContent) || "";

    curEl.innerHTML = (b && !b.missing)
      ? `<div class="cl">当前 · ${nameOf(b.id)}</div>
         <div class="cv">${b.model || "?"} ${b.fw}</div>
         <div class="cx">crc=${crc8(b.crc)} · ${b.sizeKb} KB</div>
         <div class="cm">${b.stage === 0 ? "BOOT 模式" : "APP 模式"} · 从镜像头读的</div>`
      : `<div class="cl">当前 · ${t === "S" ? "蓝牙板 S" : t === "M" ? "主控 M" : t}</div>
         <div class="cv">—</div>
         <div class="cm">先点上面「扫描设备」</div>`;

    selEl.innerHTML = m
      ? `<div class="cl">选中 · ${fname || "文件"}</div>
         <div class="cv">${m.model || "?"} v${m.verText}</div>
         <div class="cx">crc=${crc8(m.payloadCrc)} · ${m.size} B</div>
         <div class="cm">${m.imageType === 0 ? "APP" : "BOOT"} · 指向 ${m.target === 2 ? "主控 M" : m.target === 1 ? "蓝牙板 S" : "?"}</div>`
      : `<div class="cl">选中 · 文件</div>
         <div class="cv">—</div>
         <div class="cm">从在线库点「选用」，或把 bin 拖进来</div>`;

    if (!vd) return;
    if (!b || b.missing || !m) {
      vd.className = "cmpverdict dim";
      vd.textContent = "左边是这块板现在跑的，右边是你选的固件。两边都有数据才给结论。";
      return;
    }
    const want = idOfTarget(t);
    if (m.target && m.target !== want) {
      vd.className = "cmpverdict";
      vd.textContent = `选错板了：这个文件是给${m.target === 2 ? "主控 M" : "蓝牙板 S"}的，当前目标选的是${t === "M" ? "主控 M" : "蓝牙板 S"}。`;
      return;
    }
    const sameFw = b.fw === "v" + m.verText;
    const sameCrc = (b.crc >>> 0) === (m.payloadCrc >>> 0);
    if (sameFw && sameCrc) {
      vd.className = "cmpverdict ok";
      vd.textContent = "一致：这块板已经是这个固件，不用烧。";
    } else {
      vd.className = "cmpverdict";
      vd.textContent = `不一致：${sameFw ? "版本号相同但 CRC 不同（重新编译过）" : "版本号不同"}，需要烧。`;
    }
  }

  /* ---------- 初始化 ---------- */
  function init() {
    const st = document.createElement("style");
    st.textContent = `
      #up2Table { display:grid; gap:2px; margin-top:10px; font-size:12px; }
      .u2row { display:grid; grid-template-columns:96px 74px 74px 94px 66px 94px 1fr;
               gap:6px; align-items:center; padding:5px 0; border-bottom:1px solid var(--line,#eee); }
      .u2head { color:var(--muted,#888); font-size:11px; font-weight:600; }
      .u2mono { font-family:var(--mono,Consolas,monospace); font-size:11px; }
      .u2row .ok   { color:#2b7a3d; }
      .u2row .warn { color:#b4761a; font-weight:600; }
      .u2row .bad  { color:#b3352c; }
      .u2empty { color:var(--muted,#888); }
    `;
    document.head.appendChild(st);

    $("up2Scan")?.addEventListener("click", () => scan());
    $("up2Lib")?.addEventListener("click", () => loadLib());
    $("up2Go")?.addEventListener("click", () => upgradeAll());

    /* 用户只要"连接 + 对比"：连上就自动扫一次，页面打开时已连接也直接扫 */
    $("btnConn")?.addEventListener("click", () => {
      let n = 0;
      const timer = setInterval(async () => {
        n++;
        try {
          const st = await (await fetch("/api/status", { cache: "no-store" })).json();
          if (st.ble && st.ble.connected) { clearInterval(timer); setTimeout(scan, 1500); }
        } catch (e) { /* 连接期间接口可能短暂不可用，忽略 */ }
        if (n > 25) clearInterval(timer);
      }, 800);
    });

    (async () => {
      try {
        const st = await (await fetch("/api/status", { cache: "no-store" })).json();
        if (st.ble && st.ble.connected) { await loadLib(); scan(); return; }
      } catch (e) { /* 后端没起也不影响页面 */ }
      render();
      loadLib();
    })();

    /* 文件/元数据一被写入就立刻重画右栏，不用等轮询 */
    ["kMeta", "kFile", "kSize"].forEach((id) => {
      const el = $(id);
      if (el) new MutationObserver(renderFwCompare).observe(el, { childList: true, characterData: true, subtree: true });
    });
    renderFwCompare();
    setInterval(renderFwCompare, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
