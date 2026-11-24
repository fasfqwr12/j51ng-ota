import { echoCsv } from "./echo_replay.mjs";

/* 测距板既有布局不动；状态、散点和表格都来自一次完整快照。 */
export function bindEchoPanel(reader) {
  const $ = id => document.getElementById(`bdEcho${id}`);
  const button = $("Read"), csv = $("Csv"), status = $("Status"), field = $("Field");
  if (!button) return;
  let trace = null;
  const colors = ["#168a67", "#3b65c8", "#ac5522"];
  const meters = p => (p.cm / 100).toFixed(2);
  function plot() {
    const frames = trace?.frames || [], key = field.value;
    if (!frames.length) { $("Plot").replaceChildren(); return; }
    const value = p => key === "cm" ? p.cm / 100 : p[key];
    const values = frames.flatMap(f => f.peaks.map(value));
    const last = frames.at(-1).timeMs, lo = values.length ? Math.min(...values) : 0;
    const hi = Math.max(lo + 1, ...values), x = t => 59 + 537 * t / Math.max(1, last);
    const y = v => 110 - 84 * (v - lo) / (hi - lo);
    const grid = [lo, (lo + hi) / 2, hi].map(v => {
      const py = y(v), text = v.toFixed(key === "cm" ? 2 : 0);
      return `<path d="M59 ${py}H596" stroke="currentColor" opacity=".22"/><text x="54" y="${py+4}" text-anchor="end">${text}</text>`;
    }).join("");
    const dots = frames.map(f => {
      const px = x(f.timeMs);
      const mark = f.windowMs ? `<path d="M${px} 18V116" stroke="#ac5522" stroke-dasharray="4 3"><title>锁定：${f.timeMs} ms，${f.windowMs} ms 窗</title></path>` : "";
      if (!f.peaks.length) return `${mark}<circle cx="${px}" cy="120" r="3" fill="currentColor" opacity=".5"><title>${f.timeMs} ms 空帧</title></circle>`;
      return mark + f.peaks.map((p, i) => `<circle cx="${px}" cy="${y(value(p))}" r="4" fill="${colors[i]}"><title>${f.timeMs} ms · 峰${i+1} · ${meters(p)} m · SNR ${p.snr} · Engy ${p.engy}</title></circle>`).join("");
    }).join("");
    $("Plot").innerHTML = `<svg viewBox="0 0 640 150" role="img" aria-label="逐帧回波散点图"><g fill="currentColor" font-size="12">${grid}${dots}<text x="59" y="138">0 ms</text>${last ? `<text x="596" y="138" text-anchor="end">${last} ms</text>` : ""}</g></svg>`;
  }
  function render() {
    const frames = trace?.frames || [], all = frames.flatMap(f => f.peaks);
    const range = (key, div = 1) => {
      if (!all.length) return "—";
      const v = all.map(p => p[key] / div), digits = div === 1 ? 0 : 2;
      return `${Math.min(...v).toFixed(digits)}–${Math.max(...v).toFixed(digits)}`;
    };
    $("Table").hidden = !frames.length;
    csv.disabled = !frames.length;
    $("Stats").textContent = frames.length ? `${frames.length} 帧 · ${frames.filter(f=>!f.peaks.length).length} 空帧 · ${all.length} 峰｜距离 ${range("cm", 100)} m · SNR ${range("snr")} · Engy ${range("engy")}` : "";
    $("Rows").innerHTML = frames.map(f => (f.peaks.length ? f.peaks : [null]).map((p, i) => `<tr><td>${f.index+1}</td><td>${f.timeMs}</td><td>${p ? i+1 : "空"}</td><td>${p ? meters(p) : "—"}</td><td>${p?.snr ?? "—"}</td><td>${p?.engy ?? "—"}</td><td>${f.windowMs ? f.windowMs + " ms" : "—"}</td></tr>`).join("")).join("");
    plot();
  }
  field.addEventListener("change", plot);
  csv.addEventListener("click", () => {
    if (!trace?.frames.length) return;
    const a = document.createElement("a");
    const url = URL.createObjectURL(new Blob(["\uFEFF", echoCsv(trace)], { type:"text/csv;charset=utf-8" }));
    a.href = url;
    a.download = `flag_echo_${trace.generation}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  button.addEventListener("click", async () => {
    button.disabled = true;
    trace = null;
    render();
    status.textContent = "正在读取主控回波摘要…";
    try {
      trace = await reader.read((n, count) => { status.textContent = `读取 ${n}/${count} 帧…`; });
      status.textContent = trace.frames.length
        ? `读取完成 · 快照 ${trace.generation} · 三色为帧内峰序，虚线为锁定，底部灰点为空帧`
        : "没有连测记录，请按住 SHOT 扫一轮再松手。";
      render();
    } catch (e) { status.textContent = e.message; }
    finally { button.disabled = false; }
  });
}
