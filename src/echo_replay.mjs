/* 旗杆回波：逐页核对快照代号与帧号，不拼接不同轮次。 */
export const ECHO_READ = 0x2a, ECHO_DATA = 0x2b;
const META = 0xff, PAGE_SIZE = 32, PART_SIZE = 10, MAX_FRAMES = 41;
const windows = [0, 300, 1000, 2000];

function decodePage(bytes, index) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [tag, at, , , , , status, count] = bytes;
  if (tag !== 0xec || at !== index || count > MAX_FRAMES) throw new Error("主控回波页格式不匹配");
  if (status === 1) throw new Error("测距尚未结束，请松开 SHOT，等最后一发完成后再读。");
  if (status !== 0) throw new Error("回波快照已变化，请松开 SHOT 后重新读取。");
  const generation = v.getUint32(2), timeMs = v.getUint16(8), windowMs = windows[bytes[10]];
  if (timeMs > 2000 || windowMs === undefined || (index !== META && index >= count)) {
    throw new Error("回波页的时间或索引不合法");
  }
  const peaks = [];
  for (let i = 11; i < PAGE_SIZE; i += 7) {
    const cm = bytes[i] * 65536 + v.getUint16(i + 1);
    if (cm) peaks.push({ cm, snr: v.getUint16(i + 3), engy: v.getUint16(i + 5) });
  }
  return { index, generation, count, timeMs, windowMs, peaks };
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
        if (i === 0 ? row.timeMs !== 0 : row.timeMs <= frames[i - 1].timeMs) throw new Error("回波时间顺序不合法");
        frames.push(row);
        progress(frames.length, meta.count);
      }
      if (frames.length) check(await request(META, deadline));
      return { generation: meta.generation, frames };
    } finally { active = false; }
  }
  return { read, push };
}

export function echoCsv({ generation, frames }) {
  const lines = ["generation,frame,time_ms,peak,distance_m,snr_raw,engy_raw,lock_window_ms"];
  for (const {index, timeMs, peaks, windowMs} of frames) {
    const prefix = `${generation},${index + 1},${timeMs}`;
    if (!peaks.length) lines.push(`${prefix},,,,,${windowMs}`);
    else peaks.forEach((p, i) => lines.push(`${prefix},${i + 1},${(p.cm / 100).toFixed(2)},${p.snr},${p.engy},${windowMs}`));
  }
  return lines.join("\r\n") + "\r\n";
}
