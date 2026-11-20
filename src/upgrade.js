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

  /* ---------- 链路选择 ----------
   *   本机 serve.py（127.0.0.1/localhost）→ 走后端 /api/*
   *   GitHub Pages 等静态站                → 走 Web Bluetooth（app.js 暴露的 window.__J51NG）
   * 静态站没有后端进程，"网页叫服务器去连蓝牙"那条路不存在；但浏览器自己就是 BLE 客户端，
   * 所以同一套帧格式可以在这里直接收发，两边行为保持一致。 */
  const IS_LOCAL = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
  const WB = window.__J51NG || null;
  const wbQ = [];                        /* 公网模式收帧队列：[[code, Uint8Array]] */
  if (!IS_LOCAL && WB) {
    WB.onApp((cmd, pay) => {
      wbQ.push([cmd, pay ? Uint8Array.from(pay) : new Uint8Array(0)]);
      if (wbQ.length > 400) wbQ.shift();
    });
  }

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
    if (!IS_LOCAL) {                     /* 公网：从 BLE 收帧队列取 */
      const out = wbQ.slice();
      wbQ.length = 0;
      return out;
    }
    const r = await fetch(API + "/api/rx?since=" + rxSince, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    if (typeof j.next === "number") rxSince = j.next;
    return (j.frames || []).map((h) => [
      parseInt(h.slice(0, 2), 16),
      Uint8Array.from((h.slice(2).match(/../g) || []).map((x) => parseInt(x, 16))),
    ]);
  }

  /* 链路状态：两种链路都折成 /api/status 的形状，下游代码不用分叉 */
  async function linkStatus() {
    if (IS_LOCAL) {
      try { return await (await fetch("/api/status", { cache: "no-store" })).json(); }
      catch (e) { return null; }
    }
    const s = (window.ota && window.ota.status) ? window.ota.status() : {};
    const mm = String(s.pkts || "").split("/");
    const done = parseInt(mm[0] || "0", 10) || 0;
    const total = parseInt(mm[1] || "0", 10) || 0;
    const spd = parseInt(String(s.speed || "0").replace(/[^0-9]/g, ""), 10) || 0;
    const tData = parseFloat(String((s.timings || {}).data || "0")) || 0;
    const lg = (s.log || []).join("\n");
    return {
      ble: { connected: !!s.connected, busy: !!s.running, operation: null },
      running: !!s.running,
      stage: "",                       /* 阶段文字页面自己会写，这里不抢 */
      ok: /升级失败/.test(lg) ? false : undefined,
      progress: { done: done, total: total, speed: spd, retry: 0, elapsed: tData },
    };
  }

  async function sendFrame(code, payload) {
    const f = frame(code, payload);
    if (IS_LOCAL) return post("/api/raw", f);
    if (!WB || !WB.connected()) throw new Error("蓝牙未连接");
    await WB.send(code, f);              /* __J51NG.send 直接写 GATT 特征 */
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* retry>0 时超时重发。单次丢帧不再等于"这块板扫不到"。 */
  async function ask(code, payload, want, ms, retry) {
    const tries = 1 + (retry || 0);
    for (let t = 0; t < tries; t++) {
      await drain();                     /* 丢掉积压，避免拿到上一次的应答 */
      await sendFrame(code, payload);
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 1500)) {
        for (const [c, p] of await drain()) {
          if (c === want) return p;
        }
        await sleep(80);
      }
    }
    return null;
  }

  /* ---------- 状态 ---------- */
  let boards = [];        /* [{id, stage, fw, crc, size, model}] */
  let lib = [];           /* /api/manifest items */
  let devId = "";

  const nameOf = (id) => (id === 1 ? "蓝牙板 S" : id === 2 ? "主控 M" : "板卡 " + id);
  const verOf = (hi, lo) => `v${hi}.${lo}`;
  const hex = (n, w) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(w || 8, "0");

  /* ---------- 扫描 ---------- */
  let scanning = false;                 /* 连点两下会跑两轮交叉写 boards，必须挡住 */
  async function scan() {
    if (scanning) return;
    scanning = true;
    try { await scanOnce(); } finally { scanning = false; }
  }
  async function scanOnce() {
    if (IS_LOCAL) {
      try {
        const st = await (await fetch("/api/status", { cache: "no-store" })).json();
        if (!st.ble || !st.ble.connected) { setTail("蓝牙未连接，先点「连接蓝牙」"); return; }
        /* 升级/连接动作进行中绝不去抢链路，否则会把 OTA 数据流搅乱 */
        if (st.running || st.ble.busy || st.ble.operation) { setTail("设备忙（升级或连接中），先别扫描"); return; }
      } catch (e) { setTail("后端没起，先运行 serve.py"); return; }
    } else {
      if (!WB || !WB.connected()) { setTail("蓝牙未连接，先点「连接蓝牙」"); return; }
      const st = (window.ota && window.ota.status) ? window.ota.status() : {};
      if (st.running) { setTail("设备忙（升级中），先别扫描"); return; }
    }
    setTail("扫描中…");
    boards = []; devId = "";
    /* 扫描本身偶尔漏板（主控那条总线有时抢不到），连扫两轮取并集；
     * 单轮丢应答也不再用一次超时判死刑。 */
    let head = await ask(0x24, [], 0x25, 2500, 1);
    if (!head) { setTail("扫描超时（蓝牙板无应答）"); render(); return; }

    /* BLE 地址在固件里是小端存的，显示时反过来才和手机/系统里看到的一致 */
    devId = Array.from(head.slice(2, 8)).reverse()
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");

    const idSet = new Set([1]);            /* 1 = 蓝牙板 S 自己，先占位 */
    const mergeHead = (h) => {
      if (!h) return;
      /* 固件给的是个数，最多 8 个槽；越界一律不信，防止把脏字节当板号 */
      const n = Math.min(h[0] || 0, 8);
      for (let i = 0; i < n; i++) {
        const v = h[8 + i];
        if (v >= 1 && v <= 8) idSet.add(v);   /* Set 天然去重：不会再出现两块同名板 */
      }
    };
    mergeHead(head);
    const head2 = await ask(0x24, [], 0x25, 2500, 0);
    if (head2) mergeHead(head2);
    else setTail("第二轮扫描无应答，按第一轮结果继续…");

    /* 扫描刚结束时主控那条总线还在收尾，立刻发 0x20 容易撞车 */
    await sleep(150);

    const ids = Array.from(idSet).sort((a, b) => a - b);

    for (const id of ids) {
      /* 先给足时间，超时再重发一次；两块板不会因为一次丢帧就一好一坏 */
      const d = await ask(0x20, [id], 0x21, 2000, 1);
      const m = d ? await ask(0x22, [id], 0x23, 2000, 1) : null;
      if (!d) { boards.push({ id, missing: true }); continue; }
      boards.push({
        /* 板自己回的 id 也要校验：回 0 或越界就沿用请求的 id，别多出一行怪板 */
        id: (d[0] >= 1 && d[0] <= 8) ? d[0] : id,
        stage: d[1],
        fw: verOf(d[2], d[3]),
        hw: "",
        crc: (d[4] | (d[5] << 8) | (d[6] << 16) | (d[7] << 24)) >>> 0,
        /* 新固件在 [8..11] 放精确字节数；老固件 [8..9] 是硬件版本、[10..11] 是 KB。
         * 读出来明显不合理（0 或超过 16 MB）就按老格式换算。 */
        size: (() => {
          const v = (d[8] | (d[9] << 8) | (d[10] << 16) | (d[11] << 24)) >>> 0;
          return (v > 0 && v < 16 * 1024 * 1024) ? v : ((d[10] | (d[11] << 8)) * 1024);
        })(),
        model: m ? String.fromCharCode(...Array.from(m.slice(1, 13)).filter((c) => c >= 32 && c < 127)) : "",
        missing: false,
      });
    }
    setTail(`扫描完成：${boards.length} 块板`);
    render();
  }

  /* ---------- 在线库 ---------- */
  async function loadLib() {
    if (IS_LOCAL) {
      const r = await fetch(API + "/api/manifest", { cache: "no-store" });
      const j = await r.json();
      lib = (j.items || []).filter((x) => x.imgtype === 0);   /* 只比 APP 镜像 */
    } else {
      /* 静态站：直接读仓库里和 bin 一起发布的 firmware/index.json */
      const r = await fetch("./firmware/index.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("固件清单读取失败 HTTP " + r.status);
      const j = await r.json();
      lib = (j.items || [])
        .filter((x) => (x.imgType || 0) === 0)
        .map((x) => {
          const m = /^v(\d+)\.(\d+)$/.exec(x.version || "");
          const crc = parseInt(x.appCrc || "0x0", 16) >>> 0;
          return {
            file: x.file,
            board_id: x.target === "S" ? 1 : x.target === "M" ? 2 : 3,
            fw_major: m ? +m[1] : 0,
            fw_minor: m ? +m[2] : 0,
            app_crc: x.appCrc || "",
            app_crc_u32: crc,
            size: x.codeSize || x.size || 0,
            imgtype: 0,
          };
        });
    }
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
      const cls = v.cls === "ok" ? "eq" : (v.need ? "ne" : "");
      return `<div class="u2row ${cls}">
        <span>${nameOf(b.id)}${b.stage === 0 ? ' <b style="color:#c47">BOOT</b>' : ""}</span>
        <span>${b.model || "—"}</span>
        <span>${b.missing ? "—" : b.fw}</span>
        <span class="u2mono">${b.missing ? "—" : hex(b.crc)}</span>
        <span>${l ? verOf(l.fw_major, l.fw_minor) : "—"}</span>
        <span class="u2mono">${l ? l.app_crc : "—"}</span>
        <span class="${v.cls}"><i class="u2dot"></i>${v.text}</span>
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
    /* 开跑先把进度卡清零，避免看到上一轮的残留数字 */
    const bar = $("bar"), pc = $("sPct"), pk = $("sPkt");
    if (bar) bar.style.width = "0%";
    if (pc) pc.textContent = "0.0%";
    if (pk) pk.textContent = "0/0";
    const ts = $("tailStage"); if (ts) ts.textContent = "准备中";

    const list = boards.filter((b) => verdict(b).need);
    /* 蓝牙板永远最后：它一升级蓝牙就断 */
    list.sort((a, b) => (a.id === 1 ? 1 : 0) - (b.id === 1 ? 1 : 0) || a.id - b.id);

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const l = libFor(b.id);
      const target = b.id === 1 ? "S" : "M";
      setTail(`[${i + 1}/${list.length}] 正在升级 ${nameOf(b.id)} → ${verOf(l.fw_major, l.fw_minor)} …`);
      try {
        if (IS_LOCAL) {
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
        } else {
          /* 公网：交给页面自带的 OTA 流程（同样是 BLE 直连，含握手/窗口/断链重连） */
          if (!window.ota || !window.ota.start) throw new Error("页面 OTA 模块未加载");
          await window.ota.useUrl(`./firmware/${l.file}?t=` + Date.now());
          window.ota.setTarget(target);
          await window.ota.start();          /* 内部会在结束时把 running 落下来 */
          const lg = ((window.ota.status() || {}).log || []).join("\n");
          if (/升级失败/.test(lg)) throw new Error("设备返回失败，详见下方日志");
          if (!/总耗时/.test(lg))  throw new Error("升级没跑完（链路可能中断）");
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

  let _fwSig = "";
  function renderFwCompare() {
    const curEl = $("fwCur"), selEl = $("fwSel"), vd = $("fwVerdict");
    if (!curEl || !selEl) return;
    /* 内容没变就一个字都不写，避免每秒重建 DOM 拖慢升级进度条 */
    const sigNow = [
      curTarget(),
      (document.querySelector("#seg button.on") || {}).dataset ? 1 : 0,
      (boards.find((x) => x.id === idOfTarget(curTarget())) || {}).crc || 0,
      (window.__j5aa && window.__j5aa.payloadCrc) || 0,
      ($("kMeta") && $("kMeta").textContent) || "",
      ($("kFile") && $("kFile").textContent) || "",
    ].join("|");
    if (sigNow === _fwSig) return;
    _fwSig = sigNow;
    const t = curTarget();
    const b = boards.find((x) => x.id === idOfTarget(t));
    const m = fileMetaFromDom();
    const fname = ($("kFile") && $("kFile").textContent) || "";

    curEl.innerHTML = (b && !b.missing)
      ? `<div class="cl">当前 · ${nameOf(b.id)}</div>
         <div class="cv">${b.model || "?"} ${b.fw}</div>
         <div class="cx">crc=${crc8(b.crc)} · ${b.size} B</div>
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
    const sameSize = (b.size >>> 0) === (m.size >>> 0);
    /* 一样就把两栏都标绿；不一样就把两栏标黄并说清差在哪 */
    const eq = sameFw && sameCrc && sameSize;
    curEl.className = "cmpcol " + (eq ? "eq" : "ne");
    selEl.className = "cmpcol " + (eq ? "eq" : "ne");
    if (eq) {
      vd.className = "cmpverdict ok";
      vd.textContent = "一致：这块板已经是这个固件，不用烧。";
    } else {
      const diff = [];
      if (!sameFw)   diff.push(`版本 ${b.fw} ≠ ${m.verText}`);
      if (!sameCrc)  diff.push(`CRC ${crc8(b.crc)} ≠ ${crc8(m.payloadCrc)}`);
      if (!sameSize) diff.push(`大小 ${b.size} ≠ ${m.size} B`);
      vd.className = "cmpverdict ne";
      vd.textContent = `不一致（${diff.join("，")}），建议烧这个文件。`;
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
      .u2row.eq { background:linear-gradient(90deg,#e6f4ea,#fbfdfb 75%);
                  box-shadow:inset 3px 0 0 #3f8f57; border-radius:6px; padding-left:6px; }
      .u2row.ne { background:linear-gradient(90deg,#fdf1cf,#fffdf7 75%);
                  box-shadow:inset 3px 0 0 #c9a227; border-radius:6px; padding-left:6px; }
      .u2row { animation:fadein .35s ease; }
      @keyframes fadein { from { opacity:0; transform:translateY(-2px) } to { opacity:1; transform:none } }
      .u2dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:1px; }
      .ok .u2dot { background:#3f8f57; } .warn .u2dot { background:#c9a227; } .bad .u2dot { background:#b3352c; }
      .cmpcol { transition:border-color .25s, background .25s, box-shadow .25s; }
      .cmpcol.eq { border-color:#3f8f57; background:#f1f8f2; box-shadow:0 0 0 1px #3f8f5720 inset; }
      .cmpcol.eq .cv { color:#2c6e42; }
      .cmpcol.ne { border-color:#c9a227; background:#fdf8e8; }
      .cmpcol.ne .cv { color:#8a6d10; }
      .cmpverdict.ne { border-color:#c9a227; border-style:solid; color:#7a5f0c; background:#fdf8e8; }
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
          const st = await linkStatus();
          if (st && st.ble && st.ble.connected) { clearInterval(timer); setTimeout(scan, 1500); }
        } catch (e) { /* 连接期间接口可能短暂不可用，忽略 */ }
        if (n > 25) clearInterval(timer);
      }, 800);
    });

    (async () => {
      try {
        const st = await linkStatus();
        if (st && st.ble && st.ble.connected) { await loadLib(); scan(); return; }
      } catch (e) { /* 后端没起也不影响页面 */ }
      render();
      loadLib();
    })();

    /* 文件/元数据一被写入就立刻重画右栏，不用等轮询 */
    ["kMeta", "kFile", "kSize"].forEach((id) => {
      const el = $(id);
      if (el) new MutationObserver(renderFwCompare).observe(el, { childList: true, characterData: true, subtree: true });
    });
    /* 目标按钮切换时重画（class 变化） */
    const seg = $("seg");
    if (seg) new MutationObserver(renderFwCompare).observe(seg, { subtree: true, attributes: true, attributeFilter: ["class"] });
    renderFwCompare();
  }

  /* ---------- 升级状态监听：进行中有进度、结束有明确结果 ---------- */
  let s_wasBusy = false;
  let s_toastTimer = 0;

  function toast(text, kind, ms) {
    let el = $("up2Toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "up2Toast";
      el.style.cssText = "position:fixed;right:20px;bottom:64px;z-index:99999;max-width:320px;" +
        "padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.45;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.18);transition:opacity .25s;background:#fff;color:#222;" +
        "border:1px solid #ddd";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    el.style.background = kind === "ok" ? "#e8f5ea" : kind === "err" ? "#fdeceb" : "#fdf8e8";
    el.style.borderColor = kind === "ok" ? "#3f8f57" : kind === "err" ? "#b3352c" : "#c9a227";
    clearTimeout(s_toastTimer);
    if (ms) s_toastTimer = setTimeout(() => { el.style.opacity = "0"; }, ms);
  }

  /* 进度卡（#6）统一由这里画：不管升级是从「一键升级」还是「开始升级」发起的，
   * 进度条/百分比/包数/速率/耗时都跟着真实状态走，结束后落到 100%。 */
  function paintProgress(st, finished) {
    const p = st.progress;
    const bar = $("bar"), pc = $("sPct"), pk = $("sPkt"), sp = $("sSpd");
    const rt = $("sRtx"), td = $("tData"), ta = $("tAll"), ts = $("tailStage");
    if (ts && st.stage) ts.textContent = st.stage;
    if (ta && st.elapsed !== undefined) ta.textContent = st.elapsed + " s";
    if (!p || !p.total) {
      if (finished && bar) {
        bar.style.width = "100%";
        if (pc) pc.textContent = "100.0%";
      }
      return;
    }
    const pct = finished ? 100 : Math.min(100, 100 * p.done / p.total);
    if (bar) bar.style.width = pct + "%";
    if (pc) pc.textContent = pct.toFixed(1) + "%";
    if (pk) pk.textContent = `${finished ? p.total : p.done}/${p.total}`;
    if (sp) sp.textContent = Math.round(p.speed).toLocaleString();
    if (rt) rt.textContent = p.retry;
    if (td) td.textContent = p.elapsed.toFixed(1) + " s";
  }

  async function watchOta() {
    const st = await linkStatus();
    if (!st) return;
    const busy = !!(st.running || (st.ble && st.ble.busy));
    const p = st.progress;
    if (busy) {
      s_wasBusy = true;
      paintProgress(st, false);
      if (p && p.total) toast(`升级中 ${Math.min(100, 100 * p.done / p.total).toFixed(1)}%　${p.done}/${p.total} 包`, "");
      else toast("升级进行中，请不要断开…", "");
      setTail("升级进行中…");
      return;
    }
    if (s_wasBusy) {
      s_wasBusy = false;
      const ok = st.ok === undefined ? true : !!st.ok;
      paintProgress(st, ok);
      toast(ok ? "升级完成，正在重新扫描核对…" : "升级结束（未确认成功），重新扫描看看", ok ? "ok" : "err", 6000);
      setTail(ok ? "升级完成" : "升级未确认");
      await sleep(2000);
      if (st.ble && st.ble.connected) scan(); else render();
    }
  }
  setInterval(watchOta, 1200);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
