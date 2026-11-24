import test from "node:test";
import assert from "node:assert/strict";
import { createEchoReader, echoCsv } from "./echo_replay.mjs";

function page(index, {generation=7, count=3, status=0, timeMs=0, win=0, peaks=[]}={}) {
  const b = new Uint8Array(32), v = new DataView(b.buffer);
  b.set([0xec, index]); v.setUint32(2, generation); b.set([status,count], 6);
  v.setUint16(8, timeMs); b[10] = win;
  peaks.forEach(([cm,snr,engy], i) => {
    const at=11+i*7; b[at]=cm>>16; v.setUint16(at+1,cm&65535);
    v.setUint16(at+3,snr); v.setUint16(at+5,engy);
  });
  return b;
}
function part(req, b, i, nonce=req) { return Uint8Array.of(nonce[0],nonce[1],i, ...b.slice(i*10,i*10+10)); }
function kit(respond) {
  const reader=createEchoReader(req=>respond(req, reader.push), {timeoutMs:80, totalMs:900});
  return reader;
}
function sendPage(req, push, val) { for (let i=0;i<4;i++) push(part(req,val,i)); }
const META=255;

test("同峰的距离 / SNR / Engy、空帧、锁定窗与 CSV 对齐", async () => {
  const indexes=[];
  const r=kit((req,push)=>{
    const index=req[2]; indexes.push(index);
    const def=[{peaks:[[15011,579,260],[65536,30200,65535]]},{timeMs:50,win:1},{timeMs:110,peaks:[[15201,659,222]]}];
    const bytes=page(index,def[index]);
    push(part(req,bytes,0,[req[0]^1,req[1]])); // 旧请求
    for (const i of [3,1,1,0,2]) push(part(req,bytes,i));
  });
  const t=await r.read();
  assert.deepEqual(indexes,[META,0,1,2,META]);
  assert.deepEqual(t.frames[0].peaks,[{cm:15011,snr:579,engy:260},{cm:65536,snr:30200,engy:65535}]);
  assert.deepEqual(t.frames[1].peaks,[]); assert.equal(t.frames[1].windowMs,300);
  assert.match(echoCsv(t),/7,1,0,1,150\.11,579,260,0/);
  for (const line of echoCsv(t).trim().split(/\r?\n/)) assert.equal(line.split(",").length,8);
});

test("换轮时拒绝拼接；最后一页之后换轮也拒绝", async () => {
  for (const changeAt of [1,4]) {
    let n=0;
    await assert.rejects(kit((req,push)=>sendPage(req,push,page(req[2],{generation:n++===changeAt?8:7,timeMs:req[2]===META?0:req[2]*50}))).read(),/快照已变化/);
  }
});

test("未松手与旧主控均有明确报错", async () => {
  await assert.rejects(kit((req,push)=>sendPage(req,push,page(META,{status:1,count:0}))).read(),/松开 SHOT/);
  await assert.rejects(kit((req,push)=>push(Uint8Array.of(req[0],req[1],255,2))).read(),/更新主控/);
});

test("缺片和内容不一致的重复分片不会返回数据", async () => {
  await assert.rejects(kit((req,push)=>{for (const i of [0,2,3]) push(part(req,page(META),i));}).read(),/分片未收齐/);
  await assert.rejects(kit((req,push)=>{push(part(req,page(META),0));push(part(req,page(META,{generation:8}),0));}).read(),/不一致/);
});

test("完整 41 帧可读，最老和最新恰好相隔 2 s", async () => {
  const r=kit((req,push)=>sendPage(req,push,page(req[2],{count:41,timeMs:req[2]===META?0:50*req[2]})));
  const t=await r.read();
  assert.equal(t.frames.length,41);assert.equal(t.frames.at(-1).timeMs,2000);
});
