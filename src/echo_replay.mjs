/* 旗杆回波：逐页核对快照代号与帧号，不拼接不同轮次。 */
export const ECHO_READ = 0x2a, ECHO_DATA = 0x2b;
const META = 0xff, PAGE_SIZE = 32, PART_SIZE = 10, MAX_FRAMES = 41;
const windows = [0, 300, 1000, 2000];

const DIAG_META = 0xe2, DIAG_FRAME = 0x80;

function decodePage(bytes, index) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [tag, at, , , , , status] = bytes;
  const extended = index !== META && status === DIAG_FRAME;
  const count = extended ? bytes[7] & 63 : bytes[7];
  if (tag !== 0xec || at !== index || count > MAX_FRAMES) throw new Error("主控回波页格式不匹配");
  if (status === 1) throw new Error("测距尚未结束，请松开 SHOT，等最后一发完成后再读。");
  if (status !== 0 && !extended) throw new Error("回波快照已变化，请松开 SHOT 后重新读取。");
  const generation = v.getUint32(2);
  const timeMs = extended ? v.getUint16(8) & 0x7ff : v.getUint16(8);
  const windowMs = windows[extended ? bytes[10] & 3 : bytes[10]];
  if (timeMs > 2000 || windowMs === undefined || (index !== META && index >= count)) {
    throw new Error("回波页的时间或索引不合法");
  }
  if (index === META) {
    const rules = bytes[11] === DIAG_META ? {
      nearCm:v.getUint16(12), nearEngy:v.getUint16(14), minShots:v.getUint16(16),
      strongSnr:v.getUint16(18), snrNear:v.getUint16(20), snrFar:v.getUint16(22),
      splitM:v.getUint16(24), sweepMs:v.getUint16(26), enhanceM:v.getUint16(28), pilotPeaks:bytes[30]
    } : null;
    return {index, generation, count, rules};
  }
  let bits = extended ? (bytes[10] >> 2) | ((bytes[8] >> 3) << 6) | ((bytes[7] >> 6) << 11) : 0;
  const peaks = [];
  for (let i = 11, n = 0; i < PAGE_SIZE; i += 7, ++n) {
    if (extended) bits |= (bytes[i] >> 4) << (13 + 4 * n);
    const cm = (extended ? bytes[i] & 15 : bytes[i]) * 65536 + v.getUint16(i + 1);
    if (cm) peaks.push({ cm, snr: v.getUint16(i + 3), engy: v.getUint16(i + 5) });
  }
  const diag = extended ? {
    stages:bits & 63, source:(bits >> 6) & 7, rangeCase:(bits >> 9) & 7,
    stop:(bits >> 12) & 7, scanMs:bits >> 15
  } : null;
  return { index, generation, count, timeMs, windowMs, peaks, diag };
}

export function createEchoReader(send, { timeoutMs = 2100, totalMs = 30000 } = {}) {
  let seq = Math.floor(Math.random() * 65536), waiting = null, active = false;
  function push(payload) {
    const w = waiting;
    if (!w || payload.length < 3 || (payload[0] | (payload[1] << 8)) !== w.id) return;
    const part = payload[2];
    if (part === 0xff && payload.length === 4) {
      w.finish(new Error(payload[3] === 2 ? "主控不支持回波读取，请更新主控固件。" : "副板等待主控回波超时，请重试。"));
      return;
    }
    const start = part * PART_SIZE;
    if (start >= PAGE_SIZE || payload.length !== 3 + Math.min(PART_SIZE, PAGE_SIZE - start)) return;
    if (w.mask & (1 << part)) {
      if (payload.subarray(3).some((b, i) => b !== w.page[start + i])) {
        w.finish(new Error("收到内容不一致的重复分片，请重新读取。"));
      }
      return;
    }
    w.page.set(payload.subarray(3), start);
    w.mask |= 1 << part;
    if (w.mask === 15) w.finish(null, w.page);
  }
  function request(index, deadline) {
    const id = (seq = (seq + 1) & 65535), remain = deadline - Date.now();
    if (remain <= 0) throw new Error("整轮读取超时，请重新读取。");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("回波分片未收齐。请确认主控、副板均已更新，蓝牙仍连接。")), Math.min(timeoutMs, remain));
      function finish(err, page) {
        if (waiting?.id !== id) return;
        waiting = null;
        clearTimeout(timer);
        if (err) reject(err); else resolve(page);
      }
      waiting = { id, mask: 0, page: new Uint8Array(PAGE_SIZE), finish };
      Promise.resolve().then(() => send(Uint8Array.of(id & 255, id >> 8, index))).catch(finish);
    }).then(bytes => decodePage(bytes, index));
  }
  async function read(progress = () => {}) {
    if (active) throw new Error("正在读取回波。");
    active = true;
    try {
      const deadline = Date.now() + totalMs;
      const meta = await request(META, deadline), frames = [];
      const check = row => {
        if (row.generation !== meta.generation || row.count !== meta.count) throw new Error("回波快照已变化，请松开 SHOT 后重新读取。");
      };
      progress(0, meta.count);
      for (let i = 0; i < meta.count; i++) {
        const row = await request(i, deadline);
        check(row);
        if (!!row.diag !== !!meta.rules) throw new Error("回波诊断版本不一致");
        if (i === 0 ? row.timeMs !== 0 : row.timeMs <= frames[i - 1].timeMs) throw new Error("回波时间顺序不合法");
        frames.push(row);
        progress(frames.length, meta.count);
      }
      if (frames.length) check(await request(META, deadline));
      return { generation: meta.generation, frames, rules: meta.rules };
    } finally { active = false; }
  }
  return { read, push };
}

const stageNames = ["—", "1 近探", "2 近距细扫", "3 预扫", "4 主扫", "5 复扫", "6 增强"];
export function echoStageName(stage) { return stageNames[stage] || "—"; }
export function echoStages(mask) {
  return stageNames.slice(1).filter((_, i) => mask & (1 << i)).join(" → ") || "—";
}
export function echoStopName(stop) {
  return ["—", "近距命中", "主扫达标", "脉冲预算用完", "雷达故障"][stop] || "—";
}

export function echoCsv({ generation, frames, rules }) {
  const base = "generation,frame,time_ms,peak,distance_m,snr_raw,engy_raw,lock_window_ms";
  const extra = ",scan_ms,stages_mask,peak_source_stage,main_case,scan_stop";
  const lines = [base + (rules ? extra : "")];
  for (const {index, timeMs, peaks, windowMs, diag} of frames) {
    const prefix = `${generation},${index + 1},${timeMs}`;
    const suffix = rules ? `,${diag.scanMs},${diag.stages},${diag.source},${diag.rangeCase},${diag.stop}` : "";
    if (!peaks.length) lines.push(`${prefix},,,,,${windowMs}${suffix}`);
    else peaks.forEach((p, i) => lines.push(`${prefix},${i + 1},${(p.cm / 100).toFixed(2)},${p.snr},${p.engy},${windowMs}${suffix}`));
  }
  return lines.join("\r\n") + "\r\n";
}
