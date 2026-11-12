/* 服务端闭环日志实时面板：轮询 /api/log 并显示在页面右下角。
   与 app.js 自身的日志互不干扰。*/
(() => {
  if (window.__apiLiveLoaded) return;
  window.__apiLiveLoaded = true;

  const box = document.createElement("div");
  box.id = "apiLive";
  box.style.cssText = [
    "position:fixed","right:12px","bottom:12px","width:520px","max-height:42vh",
    "background:rgba(12,16,22,.94)","color:#cfe3ff","border:1px solid #2b4a6b",
    "border-radius:8px","font:12px/1.45 ui-monospace,Consolas,monospace",
    "padding:8px 10px","overflow:auto","z-index:9999","box-shadow:0 8px 28px rgba(0,0,0,.45)",
    "white-space:pre-wrap","display:none"
  ].join(";");

  const head = document.createElement("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;color:#7fb2e8";
  head.innerHTML = '<b>服务端闭环 API</b>';
  const btn = document.createElement("button");
  btn.textContent = "×";
  btn.style.cssText = "background:none;border:none;color:#7fb2e8;cursor:pointer;font-size:15px";
  btn.onclick = () => { box.style.display = "none"; };
  head.appendChild(btn);

  const body = document.createElement("div");
  box.appendChild(head); box.appendChild(body);
  document.body.appendChild(box);

  // 左下角小开关
  const tab = document.createElement("button");
  tab.textContent = "API 日志";
  tab.style.cssText = [
    "position:fixed","left:12px","bottom:12px","z-index:9999",
    "background:#16324d","color:#9fc8f0","border:1px solid #2b4a6b","border-radius:6px",
    "padding:5px 10px","font:12px ui-monospace,Consolas,monospace","cursor:pointer","opacity:.8"
  ].join(";");
  tab.onclick = () => {
    box.style.display = box.style.display === "none" ? "block" : "none";
    if (box.style.display === "block") poll();
  };
  document.body.appendChild(tab);

  let since = 0, timer = null;

  function color(line) {
    if (line.includes("✅") || line.includes("OK") || line.includes("通过")) return "#79e08c";
    if (line.includes("❌") || line.includes("err") || line.includes("失败")) return "#ff8b8b";
    if (line.includes("[3/4]") || line.includes("[4/4]")) return "#ffd479";
    return "#cfe3ff";
  }

  async function poll() {
    try {
      const r = await fetch("/api/log?since=" + since, { cache: "no-store" });
      const j = await r.json();
      if (j.lines && j.lines.length) {
        for (const line of j.lines) {
          const d = document.createElement("div");
          d.textContent = line;
          d.style.color = color(line);
          body.appendChild(d);
        }
        since = j.total;
        box.scrollTop = box.scrollHeight;
      }
    } catch (e) { /* 忽略 */ }
    timer = setTimeout(poll, 900);
  }

  // 页面加载即开始轮询（面板默认收起，点开即可看历史）
  poll();
})();
