/* J51NG OTA 接收解析：EB90 与 54A1 双协议流式提取。
 * 纯函数、无 DOM 依赖，可在 Node 下直接做离线用例。
 * 规则：
 *   EB90 : 头 2B + type(2,BE) + len(2,BE) + payload + CRC8(0x07)
 *   54A1 : 头 2B + len(2,LE) + cmd(1) + payload + sum16(2,LE)
 * 长度非法时只丢 1 字节重新找头，绝不等待一个伪长帧卡死。
 */
export const MAX_FRAME = 256;

function crc8(bytes){
  let c = 0;
  for(const b of bytes){
    c ^= b;
    for(let i=0;i<8;i++) c = (c & 0x80) ? ((c<<1) ^ 0x07) & 0xFF : (c<<1) & 0xFF;
  }
  return c;
}

function sum16(bytes){
  let s = 0;
  for(const b of bytes) s = (s + b) & 0xFFFF;
  return s;
}

export function createParser(){
  let buf = new Uint8Array(0);

  function take(n){
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  }

  /* 只保留最后一个字节：可能是被拆开的 0xEB/0x53 头 */
  function dropLeading(){
    if(buf.length > 0) buf = buf.slice(buf.length - 1);
  }

  return {
    get pending(){ return buf.length; },
    reset(){ buf = new Uint8Array(0); },

    /* 追加一段通知数据，返回本次解析出的完整帧 */
    push(chunk){
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0);
      merged.set(chunk, buf.length);
      buf = merged;

      const frames = [];
      for(;;){
        if(buf.length < 2) break;
        const h = (buf[0] << 8) | buf[1];

        if(h === 0xEB90){
          if(buf.length < 6) break;
          const len = (buf[4] << 8) | buf[5];
          if(len > MAX_FRAME){
            frames.push({kind:"error", code:"len", type:0});
            dropLeading(); continue;
          }
          const total = 7 + len;
          if(buf.length < total) break;
          const body = buf.slice(2, 6 + len);
          const got = buf[6 + len];
          if(crc8(body) !== got){
            frames.push({kind:"error", code:"crc", type:(buf[2]<<8)|buf[3]});
            dropLeading(); continue;
          }
          frames.push({
            kind:"eb90",
            type:(buf[2]<<8)|buf[3],
            payload:buf.slice(6, 6 + len)
          });
          take(total);
          continue;
        }

        if(h === 0x54A1){
          if(buf.length < 4) break;
          const len = buf[2] | (buf[3] << 8);
          if(len < 3 || len > MAX_FRAME){
            frames.push({kind:"error", code:"len", type:0});
            dropLeading(); continue;
          }
          const total = 4 + len;
          if(buf.length < total) break;
          if(sum16(buf.slice(0, total - 2)) !== ((buf[total-2] | (buf[total-1] << 8)) & 0xFFFF)){
            frames.push({kind:"error", code:"sum", type:buf[4]});
            dropLeading(); continue;
          }
          frames.push({
            kind:"app",
            cmd:buf[4],
            payload:buf.slice(5, total - 2)
          });
          take(total);
          continue;
        }

        /* 不是帧头：丢掉 1 字节继续找，避免把二进制垃圾当文本 */
        frames.push({kind:"junk", byte:buf[0]});
        take(1);
      }

      /* 半帧过长：说明找不到头，直接清空防止无限堆积 */
      if(buf.length > MAX_FRAME * 2) dropLeading();
      return frames;
    }
  };
}

export {crc8, sum16};
