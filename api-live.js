/* 服务端闭环日志面板：默认展开，常驻右上角。轮询 /api/log，纯 HTTP，不碰 BLE。 */
(() => {
  if (window.__apiLiveLoaded) return;
  window.__apiLiveLoaded = true;

  const box = document.createElement("div");
  box.id = "apiLive";
  box.style.cssText = [
    "position:fixed","right:12px","top:12px","width:560px","height:46vh",
    "background:rgba(10,14,20,.96)","color:#cfe3ff","border:1px solid #2b4a6b",
    "border-radius:10px","font:12px/1.5 ui-monospace,Consolas,monospace",
    "padding:0","overflow:hidden","z-index:99999",
    "box-shadow:0 10px 34px rgba(0,0,0,.55)","display:flex","flex-direction:column"
  ].join(";");

  const head = document.createElement("div");
  head.style.cssText = [
    "display:flex","justify-content:space-between","align-items:center",
    "padding:7px 10px","background:#132b42","color:#9fc8f0","border-bottom:1px solid #2b4a6b",
    "font-weight:600","flex:0 0 auto"
  ].join(";");
  const title = document.createElement("span");
  title.textContent = "服务端闭环日志（API）";
  const right = document.createElement("span");
  right.style.cssText = "display:flex;gap:8px;align-items:center;font-weight:400";

  const stage = document.createElement("span");
  stage.style.cssText = "padding:1px 8px;border-radius:9px;background:#1d3b57;color:#8fd0ff";
  stage.textContent = "—";

  const btnHide = document.createElement("button");
  btnHide.textContent = "收起";
  btnHide.style.cssText = "background:none;border:1px solid #2b4a6b;color:#9fc8f0;border-radius:5px;cursor:pointer;padding:1px 8px";

  right.appendChild(stage); right.appendChild(btnHide);
  head.appendChild(title); head.appendChild(right);

  const body = document.createElement("div");
  body.style.cssText = "flex:1 1 auto;overflow:auto;padding:7px 10px;white-space:pre-wrap";

  box.appendChild(head); box.appendChild(body);
  document.body.appendChild(box);

  const tab = document.createElement("button");
  tab.textContent = "显示 API 日志";
  tab.style.cssText = [
    "position:fixed","right:12px","top:12px","z-index:99999","display:none",
    "background:#16324d","color:#9fc8f0","border:1px solid #2b4a6b","border-radius:6px",
    "padding:6px 12px","font:12px ui-monospace,Consolas,monospace","cursor:pointer"
  ].join(";");
  document.body.appendChild(tab);

  btnHide.onclick = () => { box.style.display = "none"; tab.style.display = "block"; };
  tab.onclick = () => { box.style.display = "flex"; tab.style.display = "none"; };

  let since = 0, first = true, lastStage = "";

  function color(line) {
    if (line.includes("✅") || line.includes("通过")) return "#79e08c";
    if (line.includes("❌") || line.includes("err") || line.includes("失败")) return "#ff8b8b";
    if (line.includes("[3/4]") || line.includes("[4/4]")) return "#ffd479";
    if (line.includes("[1/4]")) return "#9fc8f0";
    return "#cfe3ff";
  }

  async function poll() {
    try {
      const st = await (await fetch("/api/status", { cache: "no-store" })).json();
      const tag = st.running ? (st.stage + " …") : (st.ok === true ? "通过" : (st.ok === false ? st.stage : "空闲"));
      if (tag !== lastStage) {
        stage.textContent = tag;
        stage.style.background = st.ok === true ? "#1c4a2a" : (st.ok === false ? "#4a1c1c" : "#1d3b57");
        lastStage = tag;
      }
      if (first) {
        since = 0;                                   // 首次拉全量历史
        body.textContent = "";
        first = false;
      }
      const j = await (await fetch("/api/log?since=" + since, { cache: "no-store" })).json();
      if (j.lines && j.lines.length) {
        for (const line of j.lines) {
          const d = document.createElement("div");
          d.textContent = line;
          d.style.color = color(line);
          body.appendChild(d);
        }
        since = j.total;
        body.scrollTop = body.scrollHeight;
      }
    } catch (e) { /* 服务重启时忽略 */ }
    setTimeout(poll, 800);
  }
  poll();
})();
