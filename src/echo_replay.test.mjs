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

// 真实主控 C 页编码夹具：预扫胜出、最后一批无峰、三个同批回波和下一空帧。
test("阶段诊断页仍只读一次/帧，完整保留三个峰和 16 位质量", async () => {
  const pages = ["ecff000000020002000000e2032000c803e8138800fa006401f4006401f40200","ec000000000280c21800341086420038002c80c375001700121100008421ffff","ec010000000280c200c034500000000000008000000000000010000000000000"].map(x => Uint8Array.from(Buffer.from(x,"hex")));
  const indexes = [];
  const r = kit((req,push) => { indexes.push(req[2]); sendPage(req,push,pages[req[2] === META ? 0 : req[2] + 1]); });
  const t = await r.read();
  assert.deepEqual(indexes,[META,0,1,META]);
  assert.deepEqual(t.rules,{nearCm:800,nearEngy:200,minShots:1000,strongSnr:5000,snrNear:250,snrFar:100,splitM:500,sweepMs:100,enhanceM:500,pilotPeaks:2});
  assert.deepEqual(t.frames[0].diag,{stages:13,source:3,rangeCase:4,stop:3,scanMs:96});
  assert.deepEqual(t.frames[0].peaks,[{cm:34370,snr:56,engy:44},{cm:50037,snr:23,engy:18},{cm:65536,snr:0x8421,engy:65535}]);
  assert.equal(t.frames[1].timeMs,192);
  assert.equal(t.frames[1].diag.scanMs,97);
  assert.deepEqual(t.frames[1].peaks,[]);
  assert.match(echoCsv(t),/343\.70,56,44,0,96,13,3,4,3/);
  for (const line of echoCsv(t).trim().split(/\r?\n/)) assert.equal(line.split(",").length,13);
});
