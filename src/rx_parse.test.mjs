/* 离线用例：node --test 或直接 node rx_parse.test.mjs */
import {createParser, crc8, MAX_FRAME} from "./rx_parse.mjs";

let pass = 0, fail = 0;
function eq(actual, expected, name){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if(a === e){ pass++; }
  else { fail++; console.log(`FAIL ${name}\n  got ${a}\n  want ${e}`); }
}
function ok(cond, name){ cond ? pass++ : (fail++, console.log(`FAIL ${name}`)); }

function eb(type, payload = []){
  const len = payload.length;
  const body = [(type>>8)&0xFF, type&0xFF, (len>>8)&0xFF, len&0xFF, ...payload];
  const p = new Uint8Array(7 + len);
  p[0]=0xEB; p[1]=0x90; p.set(body,2);
  p[6+len] = crc8(body);
  return p;
}
function app(cmd, payload = []){
  const len = payload.length + 3;
  const p = new Uint8Array(4 + len);
  p[0]=0x54; p[1]=0xA1; p[2]=len & 0xFF; p[3]=(len>>8)&0xFF; p[4]=cmd;
  p.set(payload, 5);
  let s = 0;
  for(let i=0;i<5+payload.length;i++) s += p[i];
  p[5+payload.length] = s & 0xFF;
  p[6+payload.length] = (s>>8) & 0xFF;
  return p;
}

/* 1) 单帧 EB90 */
{
  const p = createParser();
  const r = p.push(eb(0x0102, [0,1,2,3]));
  eq(r.length, 1, "eb90 single count");
  eq(r[0].kind, "eb90", "eb90 single kind");
  eq(r[0].type, 0x0102, "eb90 single type");
  eq([...r[0].payload], [0,1,2,3], "eb90 single payload");
  eq(p.pending, 0, "eb90 single pending drained");
}

/* 2) EB90 逐字节拆包（含帧头被拆开） */
{
  const p = createParser();
  const frame = eb(0x0302, [0x00, 0x01]);
  let out = [];
  for(const b of frame) out = out.concat(p.push(new Uint8Array([b])));
  const good = out.filter(f=>f.kind === "eb90");
  eq(good.length, 1, "eb90 split count");
  eq(good[0].type, 0x0302, "eb90 split type");
  eq([...good[0].payload], [0,1], "eb90 split payload");
}

/* 3) 两帧合并到一个通知 */
{
  const p = createParser();
  const a = eb(0x0102, [9]), b = eb(0x0202, [1,2]);
  const merged = new Uint8Array([...a, ...b]);
  const r = p.push(merged);
  eq(r.filter(f=>f.kind==="eb90").length, 2, "two frames in one chunk");
  eq(r[1].type, 0x0202, "second frame type");
}

/* 4) EB90 坏 CRC -> 报错但不卡死，后续正常帧仍可解析 */
{
  const p = createParser();
  const bad = eb(0x0102, [1,2,3]);
  bad[bad.length-1] ^= 0xFF;
  const r1 = p.push(bad);
  ok(r1.some(f=>f.kind==="error" && f.code==="crc"), "bad crc reported");
  const r2 = p.push(eb(0x0502, [0]));
  ok(r2.some(f=>f.kind==="eb90" && f.type===0x0502), "recover after bad crc");
}

/* 5) 伪长帧（len 超过上限）不阻塞 */
{
  const p = createParser();
  const fake = new Uint8Array([0xEB,0x90,0x01,0x01,0xFF,0xFF]);
  const r1 = p.push(fake);
  ok(r1.some(f=>f.kind==="error" && f.code==="len"), "oversize len rejected");
  ok(p.pending <= 6, "oversize len does not accumulate");
}

/* 6) 54A1 单帧（长度小端）：48B 头 + 7 = 55B */
{
  const p = createParser();
  const payload = new Array(48).fill(0x5A);
  const r = p.push(app(0xFE, payload));
  eq(r.length, 1, "app single count");
  eq(r[0].kind, "app", "app single kind");
  eq(r[0].cmd, 0xFE, "app single cmd");
  eq(r[0].payload.length, 48, "app payload len 48");
}

/* 7) 54A1 拆包 */
{
  const p = createParser();
  const frame = app(0xFE, [1,2,3,4]);
  let out = [];
  for(let i=0;i<frame.length;i++) out = out.concat(p.push(frame.slice(i, i+1)));
  const good = out.filter(f=>f.kind === "app");
  eq(good.length, 1, "app split count");
  eq([...good[0].payload], [1,2,3,4], "app split payload");
}

/* 8) 54A1 坏校验和 */
{
  const p = createParser();
  const bad = app(0xFE, [1,2,3]);
  bad[bad.length-2] ^= 0xFF;
  const r = p.push(bad);
  ok(r.some(f=>f.kind==="error" && f.code==="sum"), "bad sum reported");
}

/* 9) 二进制垃圾 + 合法帧混排：垃圾不产生 eb90/app 帧 */
{
  const p = createParser();
  const junk = new Uint8Array([0x00,0x11,0x22,0x54,0x00,0xFF,0x7F]);
  const r = p.push(new Uint8Array([...junk, ...eb(0x0000, [])]));
  eq(r.filter(f=>f.kind==="eb90").length, 1, "junk plus valid frame");
  eq(r.filter(f=>f.kind==="app").length, 0, "junk no app frame");
  eq(r.filter(f=>f.kind==="junk").length, 7, "junk bytes counted separately");
}

/* 10) 空通知与 reset */
{
  const p = createParser();
  eq(p.push(new Uint8Array(0)).length, 0, "empty chunk");
  p.push(eb(0x0102, [1,2,3]).slice(0,3));
  ok(p.pending > 0, "half frame retained");
  p.reset();
  eq(p.pending, 0, "reset clears pending");
}

/* 11) 边界：最大合法载荷 */
{
  const p = createParser();
  const r = p.push(eb(0x0301, new Array(MAX_FRAME).fill(0x41)));
  eq(r[0].kind, "eb90", "max len accepted");
  eq(r[0].payload.length, MAX_FRAME, "max payload size");
}

/* 12) 长度 0 的 EB90 合法 */
{
  const p = createParser();
  const r = p.push(eb(0x0000, []));
  eq(r[0].type, 0x0000, "zero-length beacon");
  eq(r[0].payload.length, 0, "zero payload");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
