/* 状态查询与镜像闸门离线用例：验证上位机解析与固件字节布局一致。
 * 运行：node src/status.test.mjs
 */
let pass = 0, fail = 0;
const eq = (a,e,n)=>{ const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E) pass++; else { fail++; console.log(`FAIL ${n}\n  got ${A}\n  want ${E}`); } };
const ok = (c,n)=> c?pass++:(fail++,console.log(`FAIL ${n}`));

/* ---- 假 DOM（仅满足模块加载） ---- */
function el(id){ return { id, textContent:"", innerHTML:"", className:"", disabled:false,
  scrollTop:0, scrollHeight:0, style:{}, dataset:{}, children:[], value:"",
  onclick:null, classList:{add(){},remove(){},toggle(){},contains(){return false;}},
  insertAdjacentHTML(){}, appendChild(){}, querySelectorAll(){return [];}, closest(){return null;},
  addEventListener(){} }; }
const nodes=new Map();
globalThis.document={ documentElement:{dataset:{}}, getElementById:id=>{
  if(!nodes.has(id)) nodes.set(id, el(id)); return nodes.get(id); },
  querySelectorAll:()=>[], createElement:()=>el('tmp') };
globalThis.window=globalThis;
globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
globalThis.addEventListener=()=>{};
globalThis.fetch=async()=>({ok:true,json:async()=>({items:[]}),arrayBuffer:async()=>new ArrayBuffer(0)});

const mod = await import('./app.js');
const api = globalThis.ota;

/* ---- 用固件同样的布局构造 0x0612 载荷（全部小端） ---- */
function buildStatusPayload(o={}){
  const p = new Uint8Array(32);
  p[0]=0x4A; p[1]=0x35; p[2]=0x53; p[3]=0x54;   /* "J5ST" */
  p[4]=1;
  p[5]= o.mode===undefined?1:o.mode;             /* 1=APP 0=Boot */
  const flags = o.flags===undefined?3:o.flags;   /* META_VALID|HCRC_OK */
  p[6]=flags&0xFF; p[7]=(flags>>8)&0xFF;
  const put32=(off,v)=>{ p[off]=v&0xFF; p[off+1]=(v>>>8)&0xFF; p[off+2]=(v>>>16)&0xFF; p[off+3]=(v>>>24)&0xFF; };
  put32(8,  o.size===undefined?74712:o.size);
  put32(12, o.crc===undefined?0xDEADBEEF:o.crc);
  const fw=o.fw===undefined?0x0606:o.fw;
  p[16]=fw&0xFF; p[17]=(fw>>8)&0xFF;
  const hw=o.hw===undefined?0x0100:o.hw;
  p[18]=hw&0xFF; p[19]=(hw>>8)&0xFF;
  p[20]=o.phase||0;
  p[21]=o.target===undefined?1:o.target;
  const mp=o.maxPayload===undefined?128:o.maxPayload;
  p[22]=mp&0xFF; p[23]=(mp>>8)&0xFF;
  put32(24, o.capacity===undefined?0x2F000:o.capacity);
  put32(28, o.received||0);
  return p;
}

/* 通过 window.ota 暴露的解析路径：借 queryStatus 不现实，这里直接验证公开钩子 */
const internals = api._internals;

/* 直接调用生产代码里的 parseStatus */
const parseStatusRef = api._internals.parseStatus;
{
  const s=parseStatusRef(buildStatusPayload());
  eq(s.mode,"app","mode APP");
  eq(s.size,74712,"size");
  eq(s.payloadCrc,0xDEADBEEF,"crc");
  eq(s.fwVersion,0x0606,"fw");
  eq(s.maxPayload,128,"maxPayload");
  eq(s.capacity,0x2F000,"capacity");
  eq(s.flags,3,"flags");
}
{
  const s=parseStatusRef(buildStatusPayload({mode:0,target:1}));
  eq(s.mode,"boot","mode Boot");
  eq(parseStatusRef(buildStatusPayload({mode:0,target:3})).target,"S","target S（Boot 自升级）");
  eq(parseStatusRef(new Uint8Array(8)), null, "short payload rejected");
  const bad=buildStatusPayload(); bad[0]=0x00;
  eq(parseStatusRef(bad), null, "bad signature rejected");
  const v2=buildStatusPayload(); v2[4]=2;
  eq(parseStatusRef(v2), null, "unknown schema rejected");
}

/* ---- 镜像闸门：构造带 J5AA 头的合法镜像 ---- */
const J5AA_OFF=0x200, J5AA_SIZE=48, MAGIC=0x4141354A;
function tab(){ const t=new Uint32Array(256);
  for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; } return t; }
const T=tab();
function crc32b(u8){ let c=0xFFFFFFFF; for(const b of u8) c=T[(c^b)&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
function buildImage(len=2048){
  const img=new Uint8Array(len);
  for(let i=0;i<len;i++) img[i]=(i*7+3)&0xFF;
  const dv=new DataView(img.buffer);
  dv.setUint32(J5AA_OFF+0x00, MAGIC, true);
  dv.setUint16(J5AA_OFF+0x04, 1, true);
  img[J5AA_OFF+0x06]=0;      /* APP */
  img[J5AA_OFF+0x07]=1;      /* N32 */
  dv.setUint16(J5AA_OFF+0x08, 0x0606, true);
  dv.setUint16(J5AA_OFF+0x0A, 0x0100, true);
  dv.setUint32(J5AA_OFF+0x0C, len, true);
  dv.setUint32(J5AA_OFF+0x14, 0x01010000, true);
  /* payload_crc32 = 整镜像去掉 [0x200,0x230) */
  const a=img.subarray(0,J5AA_OFF), b=img.subarray(J5AA_OFF+J5AA_SIZE);
  const body=new Uint8Array(a.length+b.length); body.set(a,0); body.set(b,a.length);
  dv.setUint32(J5AA_OFF+0x10, crc32b(body), true);
  /* header_crc32 over [0x200,0x22C) */
  dv.setUint32(J5AA_OFF+0x2C, crc32b(img.subarray(J5AA_OFF, J5AA_OFF+0x2C)), true);
  return img;
}
{
  const img=buildImage();
  const j=api.parseJ5AA(img, J5AA_OFF);
  ok(j && j.hcrcOk, "synthetic image header self-consistent");
  ok(j.payloadCrc === api._internals.crc32Image(img), "payload crc excludes header block");
  const v=api._internals.validateLocalImage(img,"S");
  ok(v && v.size===img.length, "valid image passes host gate");
}
{
  /* 头坏了 -> 必须拒绝 */
  const img=buildImage(); img[J5AA_OFF+0x10]^=0xFF;   /* 改 payload_crc 字段 -> 头CRC也坏 */
  let e=null; try{ api._internals.validateLocalImage(img,"S"); }catch(x){ e=x.message; }
  ok(e && /CRC/.test(e), "corrupt header rejected: "+e);
}
{
  /* 内容篡改 -> 头仍自洽但 payload crc 不符 */
  const img=buildImage(); img[1000]^=0x01;
  let e=null; try{ api._internals.validateLocalImage(img,"S"); }catch(x){ e=x.message; }
  ok(e && /内容 CRC/.test(e), "tampered content rejected: "+e);
}
{
  /* 长度不符 */
  const img=buildImage(); const cut=img.subarray(0,img.length-4);
  let e=null; try{ api._internals.validateLocalImage(cut,"S"); }catch(x){ e=x.message; }
  ok(e && /不一致|声明/.test(e), "size mismatch rejected: "+e);
}
{
  /* 无头镜像 */
  let e=null; try{ api._internals.validateLocalImage(new Uint8Array(4096),"S"); }catch(x){ e=x.message; }
  ok(e && /J5AA/.test(e), "headerless image rejected: "+e);
}
{
  /* M 目标不做 J5AA 校验 */
  eq(api._internals.validateLocalImage(new Uint8Array(4096),"M"), null, "M skips J5AA gate");
}
{
  /* 篡改 1 字节 -> 头 CRC 仍对但 payload CRC 不符 */
  const img=buildImage();
  img[1000]^=0x01;
  const j=api.parseJ5AA(img, J5AA_OFF);
  const a=img.subarray(0,J5AA_OFF), b=img.subarray(J5AA_OFF+J5AA_SIZE);
  const body=new Uint8Array(a.length+b.length); body.set(a,0); body.set(b,a.length);
  ok(crc32b(body)!==j.payloadCrc, "tampered byte detected by payload crc");
}

console.log(`\n${fail===0?"PASS":"FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
