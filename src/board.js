/* ============================================================
 * board.js —— 「测距板」tab：实时监控 + 下发
 *
 * 只依赖 app.js 暴露的 window.__J51NG：
 *   .send(cmd, bytes)   发一帧 53A2
 *   .onApp(cb)          订阅 54A1 帧
 *   .connected()        当前是否已连接
 *
 * 副板上报的 54A1 帧（code 见 docs/06-protocol-frames.md）：
 *   0x03 球速(8B)  0x06 电量(1B)  0x07 距离/两点距(2B)
 *   0x08 坡度(2B)  0x09 垂直高度(2B)  0x0a 推荐杆(2B)
 *   0x0b 雷达(1B)  0x0c 模式(1B, 0=flag 1=2pt)  0x13 版本(4B)
 *
 * 所有 2 字节数值都是**小端**（和 Ble_Data_Pcak 的 memcpy 一致）。
 * ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* 推荐杆映射：和副板 app_logic.c 的 case 0x09 一一对应。
   * value 就是下发给副板的杆号字节。 */
  const CLUBS = [
    [0x00, "W1"], [0x01, "W3"], [0x02, "W5"], [0x03, "W7"],
    [0x04, "H3"], [0x05, "H4"], [0x06, "H5"], [0x07, "H6"],
    [0x08, "I3"], [0x09, "I4"], [0x0a, "I5"], [0x0b, "I6"],
    [0x0c, "I7"], [0x0d, "I8"], [0x0e, "I9"],
    [0x0f, "PW"], [0x10, "AM GW"], [0x11, "SW"], [0x12, "LW"],
    [0x13, "AW"], [0x14, "Pt"],
    [0xef, "无推荐"],
  ];
  const CLUB_NAME = new Map(CLUBS);

  /* 最近一次收到的值，null = 还没收到 */
  const st = {
    mode: null,      /* 0=flag 1=2pt */
    dist: null,      /* dm */
    slope: null,     /* dm */
    vd: null,        /* dm */
    bat: null,
    lidar: null,
    speed: null,
    club: null,
    ver: null,
  };

  let logEl, logCount = 0;

  /* ---------- 工具 ---------- */
  const dm2m = (dm) => (dm / 10).toFixed(2) + " m";
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

  function setTail(txt) {
    const el = $("bdTail");
    if (el) el.textContent = txt;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    /* 主显：距离 / 两点距 共用 0x07，标题由模式决定 */
    const modeEl = $("bdModeTag");
    const valEl = $("bdMainVal");
    const subEl = $("bdMainSub");

    if (modeEl) {
      if (st.mode === null) {
        modeEl.textContent = "模式 —";
        modeEl.className = "bdtag";
      } else if (st.mode === 1) {
        modeEl.textContent = "两点距";
        modeEl.className = "bdtag two";
      } else {
        modeEl.textContent = "距离";
        modeEl.className = "bdtag";
      }
    }

    if (valEl) valEl.textContent = st.dist === null ? "—" : (st.dist / 10).toFixed(2);

    if (subEl) {
      if (st.dist === null) {
        subEl.textContent = "还没收到测距数据";
      } else if (st.mode === 1) {
        subEl.textContent = "两点模式：这个数是从 A 点到 B 点的直线距离";
      } else {
        subEl.textContent = "单点模式：这一点的直线距离";
      }
    }

    const put = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    put("bdSlope", st.slope === null ? "—" : dm2m(st.slope));
    put("bdVd", st.vd === null ? "—" : (st.vd === 0 ? "0 m（单点无高差）" : dm2m(st.vd)));
    put("bdBat", st.bat === null ? "—" : `${st.bat} / 4`);
    put("bdLidar", st.lidar === null ? "—" : (st.lidar ? "开" : "关"));
    put("bdSpeed", st.speed === null ? "—" : st.speed);
    put("bdClub", st.club === null ? "—" : (CLUB_NAME.get(st.club) || `未知(0x${st.club.toString(16)})`));
  }

  function addLog(cmd, payload, raw, bad) {
    if (!logEl) return;
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const div = document.createElement("div");
    div.className = "ln" + (bad ? " bad" : "");
    div.innerHTML =
      `<span class="t">${t}</span><span class="c">${cmd}</span> ${payload}`;
    logEl.appendChild(div);
    /* 只留最近 300 行，避免长时间跑爆内存 */
    if (++logCount > 300) { logEl.removeChild(logEl.firstChild); logCount--; }
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ---------- 收到一帧 54A1 ---------- */
  function onFrame(cmd, payload) {
    const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const le16 = () => (u8.length >= 2 ? (u8[0] | (u8[1] << 8)) : null);

    switch (cmd) {
      case 0x03:
        /* 球速 8 字节：格式未确认，先原样显示 hex，确认后再解析 */
        st.speed = hex(u8);
        break;
      case 0x06: st.bat = u8[0] ?? null; break;
      case 0x07: st.dist = le16(); break;
      case 0x08: st.slope = le16(); break;
      case 0x09: st.vd = le16(); break;
      case 0x0a: st.club = le16(); break;
      case 0x0b: st.lidar = u8[0] ?? null; break;
      case 0x0c: st.mode = u8[0] ?? null; break;
      case 0x13: st.ver = hex(u8); break;
      default: break;
    }
    addLog("0x" + cmd.toString(16).padStart(2, "0").toUpperCase(), hex(u8), u8, false);
    setTail("收到 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    render();
  }

  /* ---------- 下发 ---------- */
  function send(cmd, data) {
    const api = window.__J51NG;
    if (!api) { setTail("app.js 未就绪"); return false; }
    if (!api.connected()) { setTail("未连接设备"); return false; }
    const body = new Uint8Array([cmd, ...(data || [])]);
    api.send(cmd, body);
    setTail("已发送 0x" + cmd.toString(16).padStart(2, "0").toUpperCase());
    return true;
  }

  /* ---------- 初始化 ---------- */
  function init() {
    logEl = $("bdLog");

    /* 推荐杆下拉 */
    const sel = $("bdClubSel");
    if (sel) {
      sel.innerHTML = CLUBS.map(([v, n]) =>
        `<option value="${v}">${n}${v === 0xef ? "" : `（0x${v.toString(16)}）`}</option>`).join("");
    }

    /* tab 切换 */
    const panes = { ota: $("pane-ota"), board: $("pane-board") };
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const want = btn.dataset.tab;
        document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b === btn));
        Object.entries(panes).forEach(([k, el]) => { if (el) el.hidden = k !== want; });
      });
    });

    /* 按钮绑定 */
    $("bdSendClub")?.addEventListener("click", () => {
      const v = parseInt($("bdClubSel").value, 10);
      send(0x09, [v]);
    });
    $("bdWake")?.addEventListener("click", () => send(0x03, [0x01]));
    $("bdSleep")?.addEventListener("click", () => send(0x03, [0x02]));
    $("bdLinkQ")?.addEventListener("click", () => send(0x05, [0x01]));
    $("bdVerQ")?.addEventListener("click", () => send(0x0a, []));

    $("bdRawSend")?.addEventListener("click", () => {
      const raw = ($("bdRaw").value || "").trim();
      if (!raw) { setTail("hex 为空"); return; }
      const bytes = raw.split(/[\s,]+/).filter(Boolean).map((h) => {
        const v = parseInt(h, 16);
        if (Number.isNaN(v) || v < 0 || v > 255) throw new Error("非法字节: " + h);
        return v;
      });
      if (!bytes.length) { setTail("hex 为空"); return; }
      try {
        send(bytes[0], bytes.slice(1));
      } catch (e) {
        setTail("hex 错误：" + e.message);
      }
    });

    $("bdClr")?.addEventListener("click", () => {
      if (logEl) logEl.innerHTML = "";
      logCount = 0;
    });

    /* 订阅 app.js 的帧流 */
    const api = window.__J51NG;
    if (api && typeof api.onApp === "function") {
      api.onApp(onFrame);
    } else {
      /* app.js 还没加载完：轮询等它挂上 */
      let tries = 0;
      const t = setInterval(() => {
        const a = window.__J51NG;
        if (a && typeof a.onApp === "function") { a.onApp(onFrame); clearInterval(t); }
        else if (++tries > 50) clearInterval(t);
      }, 100);
    }

    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
