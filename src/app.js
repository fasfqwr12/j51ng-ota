/* J51NG OTA · Web Bluetooth 升级上位机 */
import {createParser, MAX_FRAME} from "./rx_parse.mjs";

const SVC   = "00002760-08c2-11e1-9073-0e8ac72e1001";
const CH_W  = "00002760-08c2-11e1-9073-0e8ac72e0001";
const CH_N  = "00002760-08c2-11e1-9073-0e8ac72e0002";
const APP_ENTER_BOOT = new Uint8Array([0x53,0xA2,0x04,0x00,0xFF,0x01,0xF9,0x01]);

const HW = { M:"J51VA-M", S:"J51VA-S", R:"J51VA-R" };
const T = { HS:0x0101, HSR:0x0102, PM:0x0201, PMR:0x0202, DT:0x0301, ACK:0x0302,
            NACK:0x0303, SHA:0x0401, SHAR:0x0402, DONE:0x0501, DONER:0x0502 };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let device=null, server=null, chW=null, chN=null;
let frames=[], running=false, abort=false, target="M", fw=null;
let hsReady=null;
let switching=false;
let writeChain=Promise.resolve();
/* 实测（2026-11-16，S 板 / Windows，连接间隔 7.5 ms 已确认）：
   128 B/包 · gap=0 → 数据 4.96 s / 15.2 kB/s；gap=4 ms → 5.59 s / 13.5 kB/s。
   228 B 档反而慢（20.6 ms/包，LL PDU 仍 27 B 被拆 9 片），不要用。 */
const TUNE = { win:32, gap:0 };
/* ★ 单包负载上限。S 板(N32WB031)在 228 B 分包时数据能传完、ACK 全正常，
 *   但设备端算出的 SHA 与主机不一致（0x0402=0x11）。
 *   实测只有 128 B 分包能通过校验（68720 B → 537 包）。
 *   不要因为握手报了 maxpkt=228 就用 228。 */
const PKT_CAP = 128;   // 实测：win=8 数据 8.1s；win=32 → 5.4s（与桌面版持平）   // 正在主动断开切 Boot，别报错   // {r, t}：已握手但还没发参数，20 秒内可直接复用

/* ---------------- 帧工具 ---------------- */
function crc8(d){
  let c=0;
  for(const b of d){ c^=b; for(let i=0;i<8;i++) c = (c&0x80) ? ((c<<1)^0x07)&0xFF : (c<<1)&0xFF; }
  return c;
}
function makeFrame(type, payload=new Uint8Array(0)){
  const body = new Uint8Array(4+payload.length);
  body[0]=(type>>8)&0xFF; body[1]=type&0xFF;
  body[2]=(payload.length>>8)&0xFF; body[3]=payload.length&0xFF;
  body.set(payload,4);
  const out = new Uint8Array(7+payload.length);
  out[0]=0xEB; out[1]=0x90; out.set(body,2);
  out[6+payload.length]=crc8(body);
  return out;
}
function devInfo(t){
  const d=new Uint8Array(16).fill(0xFF), s=HW[t];
  for(let i=0;i<s.length;i++) d[i]=s.charCodeAt(i);
  return d;
}
const u16 = n => new Uint8Array([(n>>8)&255, n&255]);
const u32 = n => new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);
const rd16 = (b,o) => (b[o]<<8)|b[o+1];

/* ---------------- 日志 / UI ---------------- */
function log(msg, cls=""){
  const box=$("log"), t=new Date().toTimeString().slice(0,8);
  /* 设备回传的字节可能是任意二进制：一律走 textContent，不拼 HTML */
  const d=document.createElement("div");
  if(cls) d.className=cls;
  d.textContent = t + "  " + msg;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}
function chip(txt, cls){
  $("chipTxt").textContent=txt;
  $("chip").className="chip"+(cls?" "+cls:"");
}
function stage(s){ $("tailStage").textContent=s; }
function setBadge(mode){
  const b=$("hBadge");
  b.style.display="inline-block";
  if(mode==="boot"){ b.textContent="BOOT"; b.className="badge boot"; $("tailDev").textContent="Boot 模式"; }
  else if(mode==="app"){ b.textContent="APP"; b.className="badge app"; $("tailDev").textContent="APP 模式"; }
  else { b.style.display="none"; $("tailDev").textContent="待连接"; }
}

/* ---------------- BLE ---------------- */
async function connect(){
  try{
    __userDisc=false; __cancelled=false;
    chip("请求中…","work");
    device = await navigator.bluetooth.requestDevice({
      filters:[{namePrefix:"AIMTECH"},{namePrefix:"J51NG"}],
      optionalServices:[SVC]
    });
    device.addEventListener("gattserverdisconnected", onDisconnect);
    await gatt();
    $("hName").textContent = device.name || "(无名设备)";
    $("hMeta").textContent = "已连接，正在识别模式…";
    $("kId").textContent = device.id.slice(0,17);
    $("btnDisc").disabled=false; $("btnProbe").disabled=false;
    chip("已连接","on");
    log("已连接 "+device.name,"ok");
    await probeMode();
    refreshGo();
  }catch(e){
    chip("未连接","");
    log("连接失败："+e.message,"err");
    // 失败也要释放链路，否则设备一直被占用、不再广播
    try{ device?.gatt?.disconnect(); }catch(_){}
    device=null;
  }
}

/* 连接超时包装：Chrome 的 gatt.connect() 在设备没广播时会挂几十秒，
   这里给它一个短超时，超时就当"这次没扫到"，马上重试。
   ★ 超时只结束等待不会取消底层连接，所以 onTimeout 里要显式断链，
     否则晚到的成功连接会在后台占住设备、让它不再广播。 */
function withTimeout(p, ms, what, onTimeout){
  return new Promise((resolve, reject)=>{
    let done = false;
    const tm = setTimeout(()=>{
      if(done) return;
      done = true;
      try{ onTimeout && onTimeout(); }catch(_){}
      reject(new Error((what||"操作")+"超时"));
    }, ms);
    p.then(v=>{ if(done) return; done=true; clearTimeout(tm); resolve(v); },
           e=>{ if(done) return; done=true; clearTimeout(tm); reject(e); });
  });
}

let __gattLock=null;
let __userDisc=false;      /* 用户手动点「断开」：禁止任何自动重连 */
let __devDisc=false;       /* 升级中设备自己断开（交班/复位），需要扫描等它回来 */
let __session=0;           /* 连接代次：断链/新会话递增，旧异步结果一律作废 */
let __cancelled=false;     /* 手动断开：取消所有在途流程 */
let __teardownPending=0;   /* 主动断链计数：这类断开事件不该判成"会话已切换" */
let __rxParser=createParser();
let __rxErr={len:0, crc:0, sum:0};
/* 主动断开旧会话（换链路/换设备时用）。产生的 gattserverdisconnected
 * 是预期内事件，不能据此作废正在进行的新连接。 */
function teardownLink(){
  if(device && device.gatt && device.gatt.connected){
    __teardownPending++;
    try{ device.gatt.disconnect(); }
    catch(_){ __teardownPending--; }
  }
}
/* force=true 才主动断旧会话；默认复用健康连接。
 * 之前每次调用都 disconnect→connect，升级一开始就连断两次，
 * 设备侧广播来不及恢复，直接导致 "Connection attempt failed"。 */
function gatt(timeoutMs, force){
  if(__gattLock) return __gattLock;
  __gattLock=(async()=>{
  if(__cancelled) throw new Error("已取消");
  if(device.gatt.connected && !force && server && chW && chN){
    return;                     /* 会话还在、特征都在：直接用，不动链路 */
  }
  if(device.gatt.connected){
    teardownLink();             /* 预期内断开：不推进代次 */
    await sleep(200);
  }
  const gen=__session;          /* 代次在清场之后取，避免自己的断链把自己判失效 */
  const attempt = device.gatt.connect();
  let srv;
  try{
    srv = await withTimeout(attempt, timeoutMs||8000, "连接", ()=>{
      try{ device.gatt.disconnect(); }catch(_){}
    });
  }catch(e){
    /* 晚到的成功必须立刻释放，否则设备被一条"没人用"的链路占住不再广播 */
    attempt.then(
      ()=>{ try{ device.gatt.disconnect(); }catch(_){} },
      ()=>{}
    );
    throw e;
  }
  if(gen!==__session || __cancelled){
    try{ device.gatt.disconnect(); }catch(_){}
    throw new Error("连接已失效（会话已切换）");
  }
  let svc;
  try{
    svc = await srv.getPrimaryService(SVC);
    chW = await svc.getCharacteristic(CH_W);
    chN = await svc.getCharacteristic(CH_N);
    await chN.startNotifications();
  }catch(e){
    try{ device.gatt.disconnect(); }catch(_){}
    chW=null; chN=null;
    throw e;
  }
  server = srv;
  /* 新会话：丢掉上一条连接残留的半帧与旧应答 */
  __rxParser.reset();
  frames.length=0;
  __metaQ.length=0;
  /* 重连会拿到新的 characteristic 对象；用标记避免同一对象重复绑定 */
  if(!chN.__j51ngBound){
    chN.__j51ngBound = true;
    chN.addEventListener("characteristicvaluechanged", ev=>{
      const dv=ev.target.value;
      const a=new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength);
      /* ★ 统一交给流式解析器：拆包/并包/校验都在那里做，
       *   这里不再按字节猜协议（曾把小端长度读成大端导致乱码日志）。 */
      for(const f of __rxParser.push(a)){
        if(f.kind==="eb90"){
          if(f.type!==0x0302 && f.type!==0x0303 && f.type!==0x0301 && f.type!==0x0000) logRx(f.type, f.payload);
          frames.push({t:f.type, p:f.payload});
        }else if(f.kind==="app"){
          __metaQ.push({cmd:f.cmd, p:f.payload});
        }else if(f.kind==="junk"){
          appendDevLog(f.byte);
        }else if(f.kind==="error"){
          __rxErr[f.code]=(__rxErr[f.code]||0)+1;
        }
      }
    });
  }
  })().finally(()=>{ __gattLock=null; });
  return __gattLock;
}
let __discWaiters=[];
function waitGattDisconnect(ms){
  return new Promise(res=>{
    let done=false;
    const fin=(why)=>{ if(done) return; done=true;
      __discWaiters=__discWaiters.filter(x=>x!==fin); clearTimeout(tm); res(why); };
    __discWaiters.push(fin);
    const tm=setTimeout(()=>fin("timeout"), ms);
  });
}
function onDisconnect(){
  /* 链路没了：作废会话对象。自己主动断的不推进代次，否则会误伤新连接。 */
  if(__teardownPending > 0) __teardownPending--;
  else __session++;
  server=null; chW=null; chN=null;
  __rxParser.reset();
  /* ★ 不论是否在 switching，都要唤醒「等断开」的一方 */
  for(const f of __discWaiters.slice()) f("event");
  /* 用户手动断的：不接管、不自动重连 */
  if(__userDisc){
    chip("已断开",""); setBadge(null);
    $("hMeta").textContent="连接已断开";
    log("蓝牙连接断开（手动）","dim");
    return;
  }
  /* 升级中设备自己断（交班复位 / 升级完成复位）：标记，由流程扫描等它回来 */
  if(running || switching){
    __devDisc=true;
    log("升级中设备自己断开（交班/复位），开始扫描等待重连（上限 20 s）…","dim");
    if(switching){ chip("切换中…","work"); }
    return;
  }
  chip("已断开",""); setBadge(null);
  $("hMeta").textContent="连接已断开";
  $("btnDisc").disabled=true; $("btnProbe").disabled=true;
  log("蓝牙连接断开","err");
}

/* ---- 原始帧日志：把蓝牙收发的每个控制帧打出来 ---- */
const FRAME_NAME = {0x0000:"BEACON",0x0101:"HS请求",0x0102:"HS应答",0x0201:"参数请求",0x0202:"参数应答",
  0x0301:"数据",0x0302:"ACK",0x0303:"NACK",0x0401:"SHA请求",0x0402:"SHA应答",
  0x0501:"完成请求",0x0502:"完成应答",0x0601:"发主控EnterBL",0x0602:"发主控Raw",0x0603:"主控命令应答"};
/* ---- 蓝板 bootloader 日志：printf 走 BLE NTF，非 EB90 字节就是日志文本 ---- */
let __devLog = "";
function appendDevLog(c){
  if(c===0x0A){ flushDevLog(); return; }
  if(c===0x0D){ return; }
  /* 只保留可打印 ASCII：0x80 以上的二进制字节会把日志刷成一堆乱码 */
  if(c>=0x20 && c<0x7F){ __devLog += String.fromCharCode(c); }
  if(__devLog.length>=200){ flushDevLog(); }
}
function flushDevLog(){
  const t = __devLog.trim();
  __devLog = "";
  if(!t || t.length < 4) return;
  /* 只放行"像日志"的行：二进制帧残留会把 0x54/0xFF 当字符刷屏
   * （"TTTT…3J5AA#…" 就是），这里过滤掉。 */
  if(!/[ \[\]:]/.test(t)) return;
  if(/(.)\1{4,}/.test(t)) return;
  log("[设备] " + t, "dim");
}

function hex2(p, n){ return [...p.slice(0, n)].map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' '); }
function logTx(type, payload){ log(`    → ${FRAME_NAME[type]||("0x"+type.toString(16))} len=${payload.length}`,"dim"); }
function logRx(type, payload){
  const nm = FRAME_NAME[type] || ("0x"+type.toString(16).padStart(4,'0'));
  const body = payload.length ? " " + hex2(payload, 8) + (payload.length>8?" …":"") : "";
  log(`    ← ${nm} len=${payload.length}${body}`,"dim");
}

async function writeFrame(f){
  if(chW.writeValueWithoutResponse) await chW.writeValueWithoutResponse(f);
  else await chW.writeValue(f);
}
async function writeCtrl(f){
  try{ logTx(rd16(f,2), f.slice(6, f.length-1)); }catch(_){}

  // 本设备写特征不保证支持"带响应写"（Chrome 会报 NotSupportedError），
  // 优先用无响应写，失败再退回带响应写。
  try{
    if(chW.writeValueWithoutResponse) return await chW.writeValueWithoutResponse(f);
    return await chW.writeValueWithResponse(f);
  }catch(e){
    if(/not permitted|not supported/i.test(e.message||"")){
      return await chW.writeValueWithResponse(f);
    }
    throw e;
  }
}

/* 数据包写：Chrome 对同一特征不允许并发，遇到 in progress 就等几毫秒重试 */
async function writeData(f){
  const __t0=performance.now();
  for(let i=0;i<4;i++){
    try{
      if(chW.writeValueWithoutResponse) await chW.writeValueWithoutResponse(f);
      else await chW.writeValue(f);
      if(window.__perf) window.__perf.wr.push(performance.now()-__t0);
      return;
    }catch(e){
      if(/in progress/i.test(e.message||"")){ await sleep(6+ i*4); continue; }
      throw e;
    }
  }
  await chW.writeValue(f);   // 兜底：带响应写，确保一定发出去
}

async function send(type,payload){
  const f=makeFrame(type,payload);
  const go=async()=>{ if(type===T.HS||type===T.PM||type===T.SHA||type===T.DONE) await writeCtrl(f); else await writeFrame(f); };
  try{ await go(); }
  catch(e){
    if(/no longer valid|disconnected|not permitted/i.test(e.message||"")){
      await gatt();            // 重新取服务和特征
      await go();
      return;
    }
    throw e;
  }
}
async function waitFrame(type, ms){
  const t0=Date.now();
  while(Date.now()-t0<ms){
    const i=frames.findIndex(f=>f.t===type);
    if(i>=0) return frames.splice(i,1)[0].p;
    await sleep(10);
  }
  return null;
}
async function request(type,payload,waitType,ms){
  await send(type,payload);
  return waitFrame(waitType,ms);
}


/* 让设备从 APP 进 Boot，成功后返回握手应答 */
let __bootLock=null;
function enterBoot(){
  if(__bootLock) return __bootLock;
  __bootLock=(async()=>{
  log("交班进 Boot：发握手，等设备自己复位断开（不主动断链）","dim");
  /* 只在"确实没连上"时才建链；已连且健康就直接复用，绝不断开重连 */
  if(!(device && device.gatt && device.gatt.connected) || !chW){
    try{ await gatt(6000); }catch(e){ log("连接失败："+e.message,"err"); return null; }
  }
  frames.length=0;
  try{
    await send(T.HS, devInfo(target));
  }catch(e){
    log("交班握手写入失败："+e.message,"err"); return null;
  }
  /* 已在 Boot：握手直接回 ff.ff.ff.ff */
  const rNow = await waitFrame(T.HSR, 1500);
  if(rNow){
    const v=[...rNow.slice(17,21)].map(b=>b.toString(16).padStart(2,"0")).join(".");
    if(v.startsWith("ff.ff")){ log("设备已在 Boot，直接升级","ok"); return rNow; }
    log(`当前在 APP（版本 ${v}），握手已下发，等设备自己复位…`,"dim");
  }

  switching=true;
  /* ★ 交给设备：APP 收到握手会自行复位，链路由设备侧断开，
   * 这里只"等" gattserverdisconnected 事件，不主动 disconnect。 */
  const why = await waitGattDisconnect(12000);
  log(`设备侧断开(${why})，开始扫描等待设备重新广播（上限 20 s）…`,"dim");

  /* ★ 断开后：反复尝试连接（Chrome 每次 connect 都会扫描），
   * 连上就握手确认 ff.ff.ff.ff；总时长上限 20 s。 */
  const t0=performance.now();
  while(performance.now()-t0 < 20000){
    if(__userDisc || __cancelled){ switching=false; log("已手动断开，停止自动重连","dim"); return null; }
    try{
      if(!(device && device.gatt && device.gatt.connected)) await gatt(2500, true);
      frames.length=0;
      const r=await request(T.HS, devInfo(target), T.HSR, 1200);
      if(r){
        const v=[...r.slice(17,21)].map(b=>b.toString(16).padStart(2,"0")).join(".");
        if(v.startsWith("ff.ff")){
          switching=false;
          log(`已发现 Boot 并重连（${((performance.now()-t0)/1000).toFixed(1)} s）`,"ok");
          return r;
        }
      }
    }catch(e){ /* 还没广播出来，继续扫 */ }
    await sleep(700);
  }
  switching=false;
  log("20 s 内没等到 Boot 广播，交班失败","err");
  return null;
  })().finally(()=>{ __bootLock=null; });
  return __bootLock;
}

/* ---------------- 模式识别（只读，无副作用） ---------------- */
/* 把 0x0612 的结果刷到界面 */
function applyStatus(st){
  setBadge(st.mode);
  $("kHw").textContent = st.mode==="boot" ? "J51VA-S (Boot)" : (st.metaValid ? "J51VA-S" : "—");
  $("kVer").textContent = st.metaValid ? `${(st.fwVersion>>8)&0xFF}.${st.fwVersion&0xFF}` : "—";
  $("kMeta").textContent = st.metaValid
    ? `运行镜像 ${st.size} B · crc ${h(st.payloadCrc)} · 容量 ${st.capacity} B`
    : "无镜像头信息";
  $("hMeta").textContent = st.mode==="boot"
    ? `Boot 模式 · 可直接升级${st.resetPend?" · 已排定复位":""}`
    : `APP 模式 · 运行 v${(st.fwVersion>>8)&0xFF}.${st.fwVersion&0xFF}`;
  if(st.resetPend) log("    设备已排定复位（升级交班中）","dim");
  if(st.metaValid && !st.hcrcOk) log("    ⚠ 设备镜像头自校验不通过","err");
}

/* 发一次握手并等应答（唯一允许改变设备模式的调用） */
async function sendHandshake(ms=4000){
  try{
    return await request(T.HS, devInfo(target), T.HSR, ms);
  }catch(e){
    log("握手写入失败（"+e.message+"），重连后重试","dim");
    await gatt(4000, true);
    hsReady=null;
    return await request(T.HS, devInfo(target), T.HSR, ms);
  }
}

async function probeMode(){
  const st = await queryStatus(1200, 1);
  hsReady = null;
  if(!st){
    setBadge(null);
    $("hMeta").textContent = "模式未知 · 设备无只读查询应答（可能是旧固件）";
    $("kHw").textContent = "—"; $("kVer").textContent = "—";
    log("只读查询无应答。不在这里发握手：对 S APP 来说握手=交班复位，"
      + "只有点「开始升级」才会做。","dim");
    return "unknown";
  }
  applyStatus(st);
  log(`只读查询 → ${st.mode==="boot"?"Boot":"APP"}`
    + (st.metaValid ? ` · v${(st.fwVersion>>8)&0xFF}.${st.fwVersion&0xFF} · ${st.size} B` : "")
    + "（未握手，设备状态未改变）","ok");
  return st.mode;
}

/* ---------------- 固件 ---------------- */
function parseHex(txt){
  const map=new Map(); let hi=0;
  for(const line of txt.split(/\r?\n/)){
    const s=line.trim();
    if(!s || s[0]!==":") continue;
    const n=parseInt(s.substr(1,2),16);
    const addr=parseInt(s.substr(3,4),16);
    const ty=parseInt(s.substr(7,2),16);
    if(ty===0){
      const a=(hi<<16)+addr;
      for(let i=0;i<n;i++) map.set(a+i, parseInt(s.substr(9+i*2,2),16));
    }else if(ty===4){ hi=parseInt(s.substr(9,4),16); }
  }
  const keys=[...map.keys()].sort((a,b)=>a-b);
  if(!keys.length) throw new Error("HEX 无数据");
  const lo=keys[0], hiA=keys[keys.length-1];
  const out=new Uint8Array(hiA-lo+1);
  for(const k of keys) out[k-lo]=map.get(k);
  return out;
}
async function sha256(u8){
  return new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
}


/* ---------------- APP 层命令（53A2 / 54A1） ---------------- */
let __metaQ = [];          /* 收到的 54A1 应答 */

function appFrame(cmd, payload){
  const pl = payload || new Uint8Array(0);
  const n  = pl.length + 3;                       /* cmd + payload + cs */
  const f  = new Uint8Array(4 + 1 + pl.length + 2);
  f[0]=0x53; f[1]=0xA2; f[2]=n & 0xFF; f[3]=(n>>8) & 0xFF; f[4]=cmd;
  f.set(pl, 5);
  let s=0; for(let i=0;i<5+pl.length;i++) s+=f[i];
  f[5+pl.length]   = s & 0xFF;
  f[6+pl.length]   = (s>>8) & 0xFF;
  return f;
}

/* 读设备当前运行镜像的 J5AA 头（命令 0xFE，回 48B 原始头） */
async function readDeviceMeta(ms=3000){
  __metaQ = __metaQ.filter(x=>x.cmd!==0xFE);
  const f = appFrame(0xFE, null);
  try{
    if(chW.writeValueWithoutResponse) await chW.writeValueWithoutResponse(f);
    else await chW.writeValue(f);
  }catch(e){ log("读镜像头下发失败："+e.message,"dim"); return null; }
  const t0=Date.now();
  while(Date.now()-t0<ms){
    const i=__metaQ.findIndex(x=>x.cmd===0xFE);
    if(i>=0){
      const pl=__metaQ.splice(i,1)[0].p;
      if(pl.length < 48) return {none:true};      /* 旧镜像，无头 */
      return parseJ5AA(pl, 0);
    }
    await sleep(30);
  }
  return null;
}

/* ---------------- J5AA 镜像头（单一事实源，只读不算） ----------------
 * 规范: 01_docs/IMAGE_HEADER_SPEC → 48B @ image+0x200, 小端
 * 0x00 magic "J5AA"  0x04 header_ver  0x06 image_type(0=APP 1=BOOT)
 * 0x07 target(0=W515 1=N32)  0x08 fw_version  0x0A hw_version
 * 0x0C payload_size  0x10 payload_crc32  0x14 payload_base
 * 0x18 flags  0x1C min_boot_ver  0x1E reserved  0x20 model[12]  0x2C header_crc32
 */
const J5AA_OFF = 0x200, J5AA_SIZE = 48, J5AA_MAGIC = 0x4141354A;

let __crcTab = null;
function crc32(u8){
  if(!__crcTab){
    __crcTab = new Uint32Array(256);
    for(let n=0;n<256;n++){
      let c=n;
      for(let k=0;k<8;k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
      __crcTab[n]=c>>>0;
    }
  }
  let crc = 0xFFFFFFFF;
  for(let i=0;i<u8.length;i++) crc = __crcTab[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function parseJ5AA(buf, off){
  off = (off===undefined) ? J5AA_OFF : off;
  if(!buf || buf.length < off + J5AA_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if(dv.getUint32(off, true) !== J5AA_MAGIC) return null;
  const hcrcStored = dv.getUint32(off + 0x2C, true);
  const hcrcCalc   = crc32(buf.subarray(off, off + 0x2C));
  const model = [];
  for(let i=0;i<12;i++){
    const b = buf[off + 0x20 + i];
    if(!b) break;
    model.push(String.fromCharCode(b));
  }
  const fwv = dv.getUint16(off + 0x08, true);
  return {
    headerVer : dv.getUint16(off + 0x04, true),
    imageType : buf[off + 0x06],
    target    : buf[off + 0x07],
    fwVersion : fwv,
    verText   : ((fwv>>8)&0xFF) + "." + (fwv&0xFF),
    hwVersion : dv.getUint16(off + 0x0A, true),
    size      : dv.getUint32(off + 0x0C, true),
    payloadCrc: dv.getUint32(off + 0x10, true),
    base      : dv.getUint32(off + 0x14, true),
    model     : model.join(""),
    hcrcStored, hcrcCalc,
    hcrcOk    : hcrcStored === hcrcCalc
  };
}

/* 把 J5AA 头显示到界面 + 打印日志 */
function showJ5AA(meta, fwLen){
  const el = $("kMeta");
  if(!meta){
    if(el) el.textContent = "—（无 J5AA 头，旧格式镜像）";
    return;
  }
  const kind = meta.imageType === 0 ? "APP" : "BOOT";
  const chip = meta.target === 1 ? "N32" : "W515";
  const txt = `${kind} · ${chip} · v${meta.verText} · ${meta.model || "?"}`
            + ` · size ${meta.size} · crc ${meta.payloadCrc.toString(16).padStart(8,"0").toUpperCase()}`
            + (meta.hcrcOk ? "" : " · ⚠头CRC坏");
  if(el) el.textContent = txt;
  log(`J5AA 头: ${kind} target=${chip} fw=v${meta.verText} hw=0x${meta.hwVersion.toString(16)}`
     + ` base=0x${meta.base.toString(16).padStart(8,"0")} size=${meta.size}`
     + ` payload_crc=0x${meta.payloadCrc.toString(16).padStart(8,"0").toUpperCase()}`
     + ` model="${meta.model}"`, meta.hcrcOk ? "dim" : "err");
  if(!meta.hcrcOk){
    log(`⚠ header_crc32 校验失败: 存 0x${meta.hcrcStored.toString(16)} / 算 0x${meta.hcrcCalc.toString(16)}`,"err");
  }
  if(meta.size !== fwLen){
    log(`⚠ 头里 payload_size=${meta.size} 与实际文件 ${fwLen} B 不一致`,"err");
  }
}

/* ---------------- 只读状态查询（0x0610 -> 0x0612） ----------------
 * 这是唯一允许的"读状态"手段：不改设备 OTA 状态、不触发复位、不发 M 握手。
 * 32B 应答，多字节字段统一小端（与固件一致）。 */
const BOOT_TARGET = {0:"NONE", 1:"M", 2:"R", 3:"S"};
function parseStatus(p){
  if(!p || p.length < 32) return null;
  if(p[0]!==0x4A || p[1]!==0x35 || p[2]!==0x53 || p[3]!==0x54) return null;  /* "J5ST" */
  if(p[4] !== 1) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    mode      : p[5]===0 ? "boot" : "app",
    flags     : dv.getUint16(6, true),
    size      : dv.getUint32(8, true),
    payloadCrc: dv.getUint32(12, true),
    fwVersion : dv.getUint16(16, true),
    hwVersion : dv.getUint16(18, true),
    phase     : p[20],
    target    : BOOT_TARGET[p[21]] || "?",
    maxPayload: dv.getUint16(22, true),
    capacity  : dv.getUint32(24, true),
    received  : dv.getUint32(28, true),
    metaValid : !!(dv.getUint16(6, true) & 0x0001),
    hcrcOk    : !!(dv.getUint16(6, true) & 0x0002),
    resetPend : !!(dv.getUint16(6, true) & 0x0004)
  };
}
async function queryStatus(ms=1000, retry=1){
  for(let k=0;k<=retry;k++){
    frames.length=0;
    try{ await send(0x0610, new Uint8Array(0)); }
    catch(e){ if(k===retry) return null; continue; }
    const p = await waitFrame(0x0612, ms);
    const st = parseStatus(p);
    if(st) return st;
  }
  return null;
}

/* ---------------- 本地镜像闸门（先验，有副作用动作之前） ----------------
 * S 镜像必须带 J5AA 头且自洽；M 镜像按约定不带头，只做尺寸检查。
 * payload_crc32 口径：整镜像去掉 [0x200,0x230) 这段头块。 */
function crc32Image(img){
  const a=img.subarray(0, J5AA_OFF), b=img.subarray(J5AA_OFF + J5AA_SIZE);
  const buf=new Uint8Array(a.length + b.length);
  buf.set(a,0); buf.set(b,a.length);
  return crc32(buf);
}
function validateLocalImage(img, target){
  if(!img || !img.length) throw new Error("固件为空");
  if(target !== "S") return null;                 /* M/R 镜像无 J5AA 头 */
  const j = parseJ5AA(img);
  if(!j) throw new Error("镜像缺少 J5AA 头（需 48B @0x200）：请确认选的是 APP 镜像而不是裸 bin/旧版 hex");
  /* Keil 原始输出（Objects/sapp.hex）里 J5AA 头是占位块：size/crc/hcrc 全为 0，
   * 真正可升级的镜像是后处理脚本 post_build_crc.py 生成的 S_app_latest.bin。 */
  if(!j.hcrcOk && j.size === 0 && j.payloadCrc === 0 && j.hcrcStored === 0)
    throw new Error("这是 Keil 原始输出（头部未填充：size/crc/hcrc 全为 0），不能直接升级；"
      + "请改用 post_build_crc.py 生成的 firmware/S_app_latest.bin，或直接在下方「在线固件库」点 S_app_latest 的「选用」");
  if(!j.hcrcOk) throw new Error(`镜像头 CRC 不符（存 0x${h(j.hcrcStored)} / 算 0x${h(j.hcrcCalc)}），文件已损坏`);
  if(j.imageType !== 0) throw new Error("这不是 APP 镜像（image_type=" + j.imageType + "）");
  if(j.target !== 1) throw new Error("镜像目标不是 N32 蓝牙板");
  if(j.size !== img.length)
    throw new Error(`镜像头声明 ${j.size} B，实际文件 ${img.length} B，不一致`);
  const calc = crc32Image(img);
  if(calc !== j.payloadCrc)
    throw new Error(`镜像内容 CRC 不符（头 0x${h(j.payloadCrc)} / 实算 0x${h(calc)}）`);
  return j;
}
const h = v => (v>>>0).toString(16).padStart(8,"0").toUpperCase();

async function loadFile(f){
  try{
    $("kFile").textContent=f.name;
    if(f.name.toLowerCase().endsWith(".hex")){
      fw=parseHex(await f.text());
    }else{
      fw=new Uint8Array(await f.arrayBuffer());
    }
    const sha=await sha256(fw);
    $("kSize").textContent=fw.length.toLocaleString()+" B";
    $("kSha").textContent=[...sha].map(b=>b.toString(16).padStart(2,"0")).join("");
    const j5=parseJ5AA(fw);
    window.__j5aa=j5;                 /* 供升级流程比对版本 */
    showJ5AA(j5, fw.length);
    $("tailFw").textContent=f.name;
    $("drop").classList.add("has");
    $("drop").innerHTML=`<div class="t">${f.name}</div><div class="h">${fw.length.toLocaleString()} B · 点击可更换</div>`;
    log(`固件已载入：${f.name}  ${fw.length} B`,"dim");
    refreshGo();
  }catch(e){ log("固件解析失败："+e.message,"err"); }
}
function refreshGo(){
  $("btnGo").disabled = running || !fw || !(device && device.gatt.connected);
}


/* ---------------- 在线固件库 ---------------- */
async function loadLibrary(){
  const box=$("lib");
  box.innerHTML='<div class="hint">加载中…</div>';
  try{
    const res=await fetch("./firmware/index.json?t="+Date.now(),{cache:"no-store"});
    if(!res.ok) throw new Error("HTTP "+res.status);
    const data=await res.json();
    const items=data.items||[];
    if(!items.length){ box.innerHTML='<div class="hint">库为空</div>'; return; }
    const ota=items.filter(it=>it.role!=="boot");
    const boot=items.filter(it=>it.role==="boot");
    /* 生成时间：index.json 的 mtime（unix 秒）→ 本地 "YYYY-MM-DD HH:mm" */
    const fmtTime=(m)=>{
      if(!m) return "—";
      const d=new Date(m*1000);
      const p2=n=>String(n).padStart(2,"0");
      return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    };
    const row=(it,i,canOta)=>{
      const kb=(it.size/1024).toFixed(1);
      const tail = canOta
        ? `<button data-i="${i}">选用</button>`
        : `<span class="tag swd">仅 SWD</span>`;
      const tstr = fmtTime(it.mtime);
      return `<div class="fw${canOta?"":" noota"}">
        <span class="tag">${it.targetName}</span>
        <div class="nm"><b>${it.title}</b>
          <span>${kb} KB · ${tstr} · ${it.sha256.slice(0,12)}…</span>
        </div>
        <a class="dl" href="./firmware/${encodeURIComponent(it.file)}" download>下载</a>
        ${tail}
      </div>`;
    };
    box.innerHTML =
      `<div class="hint" style="margin:0 0 2px">可 OTA 升级（APP）</div>` +
      ota.map((it,i)=>row(it,i,true)).join("") +
      (boot.length ? `<div class="hint" style="margin:10px 0 2px">Boot 固件 · 只能 SWD 烧录，不能 OTA</div>`
                    + boot.map(it=>row(it,0,false)).join("") : "");
    box.querySelectorAll("button[data-i]").forEach(b=>{
      b.onclick=()=>useLibItem(ota[+b.dataset.i], b);
    });
  }catch(e){
    box.innerHTML=`<div class="hint">加载失败：${e.message}</div>`;
  }
}
async function useLibItem(it, btn){
  try{
    if(btn){ btn.disabled=true; btn.textContent="下载中"; }
    log(`在线库：下载 ${it.file} …`,"dim");
    const res=await fetch("./firmware/"+encodeURIComponent(it.file));
    if(!res.ok) throw new Error("HTTP "+res.status);
    const buf=await res.arrayBuffer();
    await loadFile(new File([buf], it.file));
    const segBtn=[...$("seg").children].find(x=>x.dataset.t===it.target);
    if(segBtn) segBtn.click();
    const __d=new Date((it.mtime||0)*1000), __p2=n=>String(n).padStart(2,"0");
    const __ts=it.mtime?`${__d.getFullYear()}-${__p2(__d.getMonth()+1)}-${__p2(__d.getDate())} ${__p2(__d.getHours())}:${__p2(__d.getMinutes())}`:"—";
    log(`已选用 ${it.title}（${it.targetName}）· ${it.size} B · 生成于 ${__ts}`,"ok");
  }catch(e){
    log("下载失败："+e.message,"err");
  }finally{
    if(btn){ btn.disabled=false; btn.textContent="选用"; }
  }
}

/* ---------------- 升级 ---------------- */

/* 只读模式判断：只用 0x0610 查询，绝不发握手（握手对 S APP = 交班复位） */
const modeTxt = m => m==="boot" ? "Boot" : (m==="app" ? "APP" : "模式未知");

async function probeModeOnly(timeout=2000){
  const st = await queryStatus(Math.max(600, timeout), 1);
  return st ? st.mode : "unknown";
}
/* 设备复位后自动重连：每 1.2 s 试一次，直到回来或超时 */
async function waitReconnect(maxMs=20000, waitDiscMs=12000, trustApp=false){
  const t0=performance.now();

  /* ★ 阶段1：先等"真实断链"。
   * apply 期间设备仍在 Boot 里搬运/校验，握手照常应答；
   * 若此时重连会立刻判成"仍在 Boot"→ 误报升级失败（15:51 那次就是）。
   * 必须以 gattserverdisconnected 事件作为"复位开始"的信号。 */
  if(device && device.gatt && device.gatt.connected){
    const why = await waitGattDisconnect(waitDiscMs);
    if(why === "event") log("    已检测到断链事件，设备开始复位","dim");
    else                log(`    ${Math.round(waitDiscMs/1000)} s 内未见断链事件，继续尝试重连`,"dim");
  }

  /* ★ 阶段2：重连。
   * 只用 0x0610 只读查询判模式：绝不再发 0x0101 ——
   * 新固件 APP 收到握手就会交班复位，会把刚升好的 APP 又踢回 Boot。
   * trustApp 参数保留只为兼容旧调用，判定一律以设备实际应答为准。 */
  let n=0;
  while(performance.now()-t0<maxMs){
    n++;
    if(__userDisc || __cancelled){ log("已手动断开，停止自动重连","dim"); return null; }
    try{
      await gatt(2500, true);
      const secs=((performance.now()-t0)/1000).toFixed(1);
      const st = await queryStatus(1200, 1);
      if(!st){
        log(`    重连成功（第 ${n} 次，${secs} s），但只读查询无应答 · 模式未知`,"dim");
        return "unknown";
      }
      log(`    重连成功（第 ${n} 次，${secs} s）· ${st.mode==="boot"?"Boot":"APP"}`
        + (st.metaValid ? ` · ${st.size} B / crc ${h(st.payloadCrc)}` : ""),"ok");
      applyStatus(st);
      return st.mode;
    }catch(e){
      if(n%5===0) log(`    等待设备重启…（${Math.round((performance.now()-t0)/1000)} s）`,"dim");
      await sleep(800);
    }
  }
  return null;
}

async function startUpgrade(){
  if(!fw || running) return;
  running=true; abort=false; __userDisc=false; __devDisc=false; __cancelled=false; refreshGo();
  $("btnStop").disabled=false;
  $("log").innerHTML="";
  const t0=performance.now();
  const img=fw, win=TUNE.win, gap=TUNE.gap;
  let pkt=PKT_CAP, total=0;

  $("sPct").textContent="0%"; $("bar").style.width="0%";
  $("sPkt").textContent=`0/${total}`; $("sSpd").textContent="0"; $("sRtx").textContent="0";
  $("tConn").textContent="--"; $("tHs").textContent="--"; $("tData").textContent="--"; $("tAll").textContent="--";
  chip("升级中","work");

  window.__perf={wr:[],rounds:[]};
  log(`目标 ${target} · 镜像 ${img.length} B · win=${TUNE.win} gap=${TUNE.gap}`);
  try{
    /* ★ 本地闸门先跑：镜像不自洽就直接停，绝不先碰设备 */
    if(target === "S"){
      const j = validateLocalImage(img, target);
      log(`本地校验通过：J5AA v${j.verText} · ${j.size} B · crc ${h(j.payloadCrc)}`,"dim");
    }

    /* ★ 第一步只用只读查询识别模式，不握手、不复位、不发 M 命令 */
    const st0 = await queryStatus(1200, 1);
    log(st0
      ? `只读查询 → ${st0.mode==="boot"?"Boot":"APP"}`
        + `（运行镜像 ${st0.size} B / crc ${h(st0.payloadCrc)} / 容量 ${st0.capacity} B`
        + `${st0.resetPend?" / 已排定复位":""}）`
      : "只读查询无应答（设备可能是旧固件）","dim");
    if(st0) applyStatus(st0);

    let r = null;
    if(st0 && st0.mode === "boot"){
      /* 已在 Boot：发一次握手进入等参数阶段，随后复用 */
      stage("握手");
      r = await sendHandshake();
      hsReady = {r, t: Date.now()};
      setBadge("boot");
    }else if(target === "S"){
      /* S 自升级：只有这一步会触发 APP 交班复位 */
      stage("切换 Boot");
      const bootR = await enterBoot();
      if(!bootR) throw new Error("自动交班进 Boot 失败");
      hsReady = {r: bootR, t: Date.now()};
      setBadge("boot");
    }else{
      /* M/R：留在 S APP 透传，S 绝不复位 */
      stage("握手");
      log(`目标 ${target}：走 S APP 透传，复位的是 ${target} 自己，蓝牙板保持连接`,"dim");
      r = await sendHandshake();
      hsReady = {r, t: Date.now()};
      setBadge("app");
    }

    // 设备刚重启过，链路可能还没恢复：先确保连通，且不复用旧握手
    if(!(device && device.gatt.connected)){
      stage("重连");
      log("链路已断开，正在重连…","dim");
      let ok=false;
      for(let i=1;i<=12 && !ok;i++){
        try{ await gatt(); ok=true; }
        catch(e){ if(i%4===0) log(`    重连中(${i})…`,"dim"); await sleep(600); }
      }
      if(!ok) throw new Error("设备未连接，重连失败");
      hsReady=null;
      log("已重连设备","ok");
    }
    if(!r){
      if(hsReady && Date.now()-hsReady.t < 20000){ r = hsReady.r; hsReady=null; log("[1] 复用已完成的握手","st"); }
    }
    if(!r){
      r = await sendHandshake();
      if(!r) throw new Error("握手无应答：设备既不在 APP 也不在 Boot？请确认目标与固件");
    }
    if(r[0]!==0){
      const st=r[0];
      let msg="握手状态 0x"+st.toString(16);
      if(st===0xE1) msg="握手被拒 0xE1（硬件码不匹配）—— Boot 只接受『蓝牙板 S』，M/R 需在 S APP 下透传";
      else if(st===0x10) msg="握手被拒 0x10（参数/尺寸错误）";
      throw new Error(msg);
    }
    $("tHs").textContent=((performance.now()-t0)/1000).toFixed(1)+" s";
    log("[1] 握手成功","st");

    // 设备会把包长向下 4 字节对齐（pkt & ~3），必须按对齐后的值分包
    const devMax = r.length>=23 ? rd16(r,21) : 0;
    let want = devMax ? Math.min(PKT_CAP, devMax) : PKT_CAP;
    pkt = want & ~3;
    if(pkt<4) pkt=4;
    if(devMax && devMax>pkt)
      log(`    设备报 maxpkt=${devMax}，本版按 ${pkt} B 分包（228 B 档留待单独验证）`,"dim");
    total = Math.ceil(img.length/pkt);
    log(`[1b] 分包 pkt=${pkt} B × ${total}（设备 maxpkt=${devMax||"?"}）`,"dim");
    $("sPkt").textContent = `0/${total}`;

    /* 容量闸门：按"目标自己的"可用容量判，不能拿 S 的容量去卡 M/R。
     * S 用设备自报（无暂存，镜像直接写 APP 区）；M 用 APP 区上限；
     * R 不由本工具定义，交给雷达板自己在 0x0201 校验。 */
    const CAP = { S: st0 ? st0.capacity : 0, M: 0x19800, R: 0 };
    const capDev = CAP[target] || 0;
    if(capDev && img.length > capDev)
      throw new Error(`镜像 ${img.length} B 超过 ${target} 可用容量 ${capDev} B，已停止（未发参数）`);
    log(`[1c] 容量闸门：${img.length} B ≤ ${capDev ? capDev+" B" : "目标自校验"}（${target}）`,"dim");

    stage("擦除目标 APP 区");
    const sha=await sha256(img);
    const pm=new Uint8Array(38);
    pm.set(u32(img.length),0);
    if(target === "M"){
      /* M Boot 只认 CRC32(整镜像) 小端，后 28 字节忽略 */
      const c = crc32(img);
      pm.set(new Uint8Array([c&0xFF,(c>>>8)&0xFF,(c>>>16)&0xFF,(c>>>24)&0xFF]), 4);
      log(`    M 校验参考 = CRC32 0x${h(c)}（LE）`,"dim");
    }else{
      pm.set(sha,4);
    }
    pm.set(u16(pkt),36);
    r = await request(T.PM, pm, T.PMR, 25000);
    if(!r) throw new Error("参数无应答");
    if(r[0]!==0) throw new Error("参数被拒 0x"+r[0].toString(16));
    log("[2] 参数已接受，目标 APP 区擦除完成","st");

    stage("传输数据");
    const td=performance.now();
    let sent=0, acked=0, rtx=0, stale=0;
    while(acked<total){
      if(abort) throw new Error("已中止");
      const r0=Date.now();
      while(sent<total && sent-acked<win){
        const chunk=img.slice(sent*pkt,(sent+1)*pkt);
        const body=new Uint8Array(6+chunk.length);
        body.set(u16(sent),0); body.set(u16(total),2); body.set(u16(chunk.length),4);
        body.set(chunk,6);
        await writeData(makeFrame(T.DT, body));
        sent++;
        if(gap) await sleep(gap);
      }
      const deadline=Date.now()+1000;
      let moved=false;
      while(Date.now()<deadline){
        const i=frames.findIndex(f=>f.t===T.ACK||f.t===T.NACK);
        if(i<0){ await sleep(10); if(Date.now()>deadline-900) break; continue; }
        const f=frames.splice(i,1)[0];
        if(f.p.length<3) continue;
        const code=f.p[0], seq=rd16(f.p,1);
        if(f.t===T.ACK && code===0 && seq+1<=sent && seq+1>acked){ acked=seq+1; moved=true; }
        else if(f.t===T.NACK){ rtx++; acked=Math.min(acked,seq); moved=true; }
      }
      if(window.__perf) window.__perf.rounds.push({dt:Date.now()-r0, acked, sent, moved});
      if(!moved && acked<sent){
        if(frames.length>50) frames.length=0;
        stale++;
        if(stale>60) throw new Error("设备无应答（ACK 超时）");
      }else{ stale=0; }
      const el=(performance.now()-td)/1000;
      const pct=Math.round(acked/total*100);
      $("bar").style.width=pct+"%"; $("sPct").textContent=pct+"%";
      $("sPkt").textContent=`${acked}/${total}`;
      $("sSpd").textContent=Math.round(acked*pkt/Math.max(el,0.3)).toLocaleString();
      $("sRtx").textContent=rtx;
    }
    const dt=((performance.now()-td)/1000);
    $("tData").textContent=dt.toFixed(1)+" s";
    log(`[3] 数据完成 ${img.length} B · ${dt.toFixed(1)} s · 重传 ${rtx}`,"st");

    stage("校验");
    // 设备按接收累计 CRC 校验（0x0401/0x0402 保留为兼容应答，可能丢 → 重发）
    for(let k=1;k<=5;k++){
      r = await request(T.SHA, sha, T.SHAR, 8000);
      if(r) break;
      log(`    0x0401 第 ${k} 次无应答（设备仍在收尾），重发…`,"dim");
      await sleep(800);
    }
    if(!r || r[0]!==0) throw new Error("设备校验失败（0x0402 状态 0x"+(r?r[0].toString(16):"无应答")+"）");
    log("[4] 设备校验通过","st");

    stage("完成放行");
    log("[5] 请求设备接管并跳转（设备会复位重启，请勿断电）","dim");
    r = null;
    for(let k=1;k<=30;k++){
      if(!(device && device.gatt.connected)){
        try{ await gatt(); log("    链路已断开，已重连","dim"); }
        catch(e){ await sleep(1000); continue; }
      }
      r = await request(T.DONE, new Uint8Array(0), T.DONER, 1500);
      if(r) break;
      if(k%4===0) log(`    设备仍在收尾，等待确认…（${k}/30）`,"dim");
      await sleep(500);
    }
    if(!r){
      log("未收到 0x0502（设备可能已复位），重连确认实际状态…","dim");
      const m0 = await waitReconnect(15000);
      if(m0==="app" && await confirmRunningImage(img, "0x0502 丢失")) return finishOk(t0, "0x0502 丢失，设备已运行新 APP");
      throw new Error("等待设备确认超时，且设备未回到 APP");
    }
    if(r[0]!==0) throw new Error("设备报告写入失败，状态码 0x"+r[0].toString(16).padStart(2,"0"));
    log(`[5] 设备已确认接管（0x0502=0x00）`,"st");

    $("bar").style.width="100%"; $("sPct").textContent="100%";

    // M/R：升级的是目标自己的 APP，蓝牙板保持连接、不重启
    if(target !== "S"){
      const tot=((performance.now()-t0)/1000).toFixed(1);
      $("tAll").textContent=tot+" s";
      log("[7] ✅ 传输与校验完成：目标已接收并校验通过，蓝牙板保持连接","st");
      log("    注意：这一步只证明传输/校验/放行成功；目标是否已运行新固件需由该目标自己的应答确认","dim");
      chip("升级成功","on"); stage("升级成功");
      log(`==== 总耗时 ${tot} s（数据阶段 ${$("tData").textContent}）====`,"st");
      return;
    }

    stage("等待设备重启");
    log("[6] 设备复位中，等待重新连接…","dim");
    const mode = await waitReconnect(20000, 12000, true);
    if(mode === "boot"){
      log("[7] ❌ 升级未完成：设备复位后仍停在 Boot（镜像未跳转）","err");
      log("    可能原因：镜像头校验失败 / 完整性记录不匹配 / 镜像不完整","dim");
      chip("需重试",""); stage("需重试");
    }else if(mode !== "app"){
      throw new Error("已派发但设备 30 s 内未回来，请断电重启确认");
    }else if(await confirmRunningImage(img, "复位后")){
      finishOk(t0, "设备已运行新 APP，版本已确认");
    }
    const __tot=((performance.now()-t0)/1000).toFixed(1);
    $("tAll").textContent=__tot+" s";
    log(`==== 总耗时 ${__tot} s（数据阶段 ${$("tData").textContent}）====`,"st");
  }catch(e){
    stage("失败");
    chip("失败","");
    log("❌ 升级失败："+e.message,"err");
    log("   设备仍在，可重新点击「开始升级」重试","dim");
  }finally{
    running=false; $("btnStop").disabled=true; hsReady=null; refreshGo();
  }
}

/* 版本确认：只读查询设备当前运行的镜像身份，与刚下发的逐字段比对。
 * 只有 APP 模式 + size/payload_crc 都对上，才算真的升级成功。 */
async function confirmRunningImage(img, tag){
  const sent = parseJ5AA(img);
  const st = await queryStatus(1500, 1);
  if(!st){
    log(`[7] ⚠ 版本未确认（${tag}）：设备对只读查询无应答`,"err");
    chip("版本未确认","");
    return false;
  }
  if(st.mode !== "app"){
    log(`[7] ❌ 设备仍不在 APP 模式（${tag}）`,"err");
    return false;
  }
  if(!st.metaValid){
    log(`[7] ⚠ 版本未确认（${tag}）：设备没有 J5AA 头（旧镜像）`,"err");
    chip("版本未确认","");
    return false;
  }
  if(sent && st.size === sent.size && st.payloadCrc === sent.payloadCrc){
    log(`[7] ✅ 版本已确认：设备运行 ${st.size} B · crc ${h(st.payloadCrc)}（与下发一致）`,"st");
    return true;
  }
  log(`[7] ❌ 版本不匹配（${tag}）：设备 ${st.size} B / crc ${h(st.payloadCrc)}`
    + `　下发 ${sent?sent.size:"?"} B / crc ${sent?h(sent.payloadCrc):"?"}`,"err");
  chip("版本不匹配","");
  return false;
}

function finishOk(t0, msg){
  const tot=((performance.now()-t0)/1000).toFixed(1);
  $("tAll").textContent=tot+" s";
  log(`[7] ✅ 升级成功：${msg}`,"st");
  chip("升级成功 · 已确认","on");
  stage("升级成功");
  log(`==== 总耗时 ${tot} s（数据阶段 ${$("tData").textContent}）====`,"st");
  return true;
}

/* ---------------- 事件 ---------------- */
$("btnConn").onclick=connect;
$("btnDisc").onclick=()=>{
  /* 用户手动断开：置标志，任何"升级中自动重连"都不许接管。
   * 同时作废会话代次并取消在途流程，防止超时后晚到的连接/AI 定时器再连回来。 */
  __userDisc=true; __cancelled=true; __session++;
  frames.length=0; __metaQ.length=0; __rxParser.reset();
  log("已手动断开（本次不会自动重连）","dim");
  try{ device.gatt.disconnect(); }catch(_){}
};
$("btnProbe").onclick=async()=>{ await probeMode(); refreshGo(); };
$("btnGo").onclick=startUpgrade;
$("btnStop").onclick=()=>{ abort=true; log("已请求中止…","dim"); };
$("btnClr").onclick=()=>{ $("log").innerHTML=""; };
$("btnLib").onclick=loadLibrary;
loadLibrary();
$("drop").onclick=()=>$("file").click();
$("file").onchange=e=>{ const f=e.target.files[0]; if(f) loadFile(f); };
$("drop").ondragover=e=>{ e.preventDefault(); $("drop").classList.add("has"); };
$("drop").ondragleave=()=>$("drop").classList.remove("has");
$("drop").ondrop=e=>{ e.preventDefault(); const f=e.dataTransfer.files[0]; if(f) loadFile(f); };
$("seg").onclick=e=>{
  const b=e.target.closest("button"); if(!b) return;
  [...$("seg").children].forEach(x=>x.classList.remove("on"));
  b.classList.add("on"); target=b.dataset.t;
  $("tailTarget").textContent=b.textContent.trim();
};

/* 主题 */
const THEMES=["olive","light","graphite","teal","warm","night"];
function applyTheme(t){
  document.documentElement.dataset.theme=t;
  localStorage.setItem("j51ng-theme",t);
  [...$("themes").children].forEach(b=>b.classList.toggle("sel", b.dataset.th===t));
}
applyTheme(localStorage.getItem("j51ng-theme")||"olive");
$("themes").onclick=e=>{ const b=e.target.closest("button"); if(b) applyTheme(b.dataset.th); };

/* ★ 刷新/关闭页面必须主动断链：
 * Chrome 在页面导航时不一定发链路终止，设备侧还以为"有人连着"→ 停广播 →
 * 新打开的页就扫不到设备（17:26 那次就是刷新时还连着）。
 * 这里补一刀，刷新前后都能立刻重连。 */
function releaseBle(){
  try{ if(device && device.gatt && device.gatt.connected) device.gatt.disconnect(); }catch(_){}
}
window.addEventListener("pagehide", releaseBle);
window.addEventListener("beforeunload", releaseBle);

/* 能力检测 */
if(!navigator.bluetooth){
  log("当前浏览器不支持 Web Bluetooth：请用安卓 Chrome / Edge，并确保是 https 页面","err");
}

/* ---------------- 对外 API（便于自动化/联调） ---------------- */
window.ota = {
  /* 调试/自检入口：镜像头解析与设备回读 */
  parseJ5AA(buf, off){ return parseJ5AA(buf, off); },
  appFrame(cmd, payload){ return appFrame(cmd, payload); },
  readMeta(){ return readDeviceMeta(3000); },
  sentMeta(){ return window.__j5aa || null; },
  status(){
    return {
      connected: !!(device && device.gatt.connected),
      name: device ? device.name : null,
      mode: $("hBadge").textContent,
      hw: $("kHw").textContent,
      ver: $("kVer").textContent,
      running,
      pct: $("sPct").textContent,
      pkts: $("sPkt").textContent,
      speed: $("sSpd").textContent,
      timings: { hs:$("tHs").textContent, data:$("tData").textContent, total:$("tAll").textContent },
      log: [...document.querySelectorAll("#log div")].map(d=>d.textContent)
    };
  },
  async connectGranted(){
    if(!navigator.bluetooth.getDevices) throw new Error("浏览器不支持 getDevices");
    const devs = await navigator.bluetooth.getDevices();
    if(!devs.length) throw new Error("没有已授权的设备，请手动点一次「连接蓝牙」");
    device = devs.find(d=>/AIMTECH|J51NG/i.test(d.name||"")) || devs[0];
    device.addEventListener("gattserverdisconnected", onDisconnect);
    await gatt();
    $("hName").textContent = device.name || "(已授权设备)";
    $("kId").textContent = device.id.slice(0,17);
    $("btnDisc").disabled=false; $("btnProbe").disabled=false;
    chip("已连接","on");
    log("已连接（授权设备）"+device.name,"ok");
    return await probeMode();
  },
  probe: ()=>probeMode(),
  async useLibrary(index=0){
    const res=await fetch("./firmware/index.json?t="+Date.now(),{cache:"no-store"});
    const data=await res.json();
    const ota=(data.items||[]).filter(x=>x.role!=="boot");
    if(!ota[index]) throw new Error("库中没有该固件");
    await useLibItem(ota[index]);
    return ota[index].file;
  },
  async useUrl(url){
    const res=await fetch(url); const buf=await res.arrayBuffer();
    await loadFile(new File([buf], url.split("/").pop()));
    return true;
  },
  setTarget(t){ const b=[...$("seg").children].find(x=>x.dataset.t===t); if(b) b.click(); return t; },
  /* 手动让蓝牙板给主控发 Enter-BL（0x0601），用来单独验证 S→M 链路 */
  async mainEnterBL(){
    await send(0x0601, new Uint8Array(0));
    log("已发送：让蓝牙板给主控发 Enter-BL","st");
  },
  /* 原样透传一段字节给主控（0x0602） */
  async mainRaw(bytes){
    await send(0x0602, new Uint8Array(bytes));
    log("已发送：主控原始字节 "+bytes.map(b=>b.toString(16).padStart(2,'0')).join(' '),"st");
  },

  /* 读蓝牙板串口收到了什么（0x0604 / 0x0605）——S→M 链路的一把尺子 */
  async mainDump(ms=1500){
    frames.length=0;
    await send(0x0604, new Uint8Array(0));
    const p=await waitFrame(0x0605, ms);
    if(!p){ log("主控串口：超时，蓝牙板没回（S 板可能不在 boot 或没烧新固件）","err"); return null; }
    const n=((p[0]<<8)|p[1])>>>0;
    const data=p.slice(2,2+n);
    if(!n){ log("主控串口：缓冲区为空 —— 蓝牙板没收到主控任何字节","err"); return []; }
    log(`主控串口收到 ${n} 字节：`+[...data].map(b=>b.toString(16).padStart(2,"0")).join(" "),"ok");
    return [...data];
  },
  /* 连续取样：看主控 50ms 一次的 0x1001 广播能不能稳定收到 */
  async mainDumpLoop(times=6, gapMs=300){
    const out=[];
    for(let i=0;i<times;i++){
      try{ out.push(await this.mainDump(900)); }catch(e){ out.push(null); }
      await sleep(gapMs);
    }
    const hit=out.filter(x=>x&&x.length>0).length;
    log(`取样 ${times} 次，收到 ${hit} 次 —— ${hit>=times-1?"S→M 链路正常":(hit===0?"S→M 完全不通":"S→M 不稳定")}`, hit>=times-1?"ok":"err");
    return out;
  },
  async scanAndConnect(maxMs=30000){
    const t0=performance.now(); let n=0;
    /* 已经连着同一个中心时绝不 re-requestDevice：BLE 从机连上后不再广播，
       重复请求只会让 chooser 空列表或把现有连接踢掉。直接复用现有连接。 */
    if(device && device.gatt && device.gatt.connected && chW && chN){
      const m = await probeModeOnly(1200);
      log(`复用现有连接（${device.name||"AIMTECH VHR"}）→ ${modeTxt(m)}`,"ok");
      setBadge(m); return m;
    }
    /* 已授权设备：用 getDevices() 直接连，不弹 chooser */
    if(navigator.bluetooth.getDevices){
      try{
        const devs = await navigator.bluetooth.getDevices();
        const d = devs.find(x=>/AIMTECH|J51NG/i.test(x.name||"")) || devs[0];
        if(d){
          device = d;
          device.addEventListener("gattserverdisconnected", onDisconnect);
          await gatt(8000);
          const m = await probeModeOnly(1500);
          setBadge(m);
          log(`自动连接已授权设备 ${device.name} → ${modeTxt(m)}`,"ok");
          return m;
        }
      }catch(e){ log(`已授权直连失败：${e.message}`,"dim"); }
    }
    /* 最后才按名字请求（需要用户手势；由 UI 按钮触发） */
    while(performance.now()-t0<maxMs){
      n++;
      try{ await gatt(1500); const m=await probeModeOnly(1000); log(`扫描成功（第 ${n} 次，${((performance.now()-t0)/1000).toFixed(1)} s）→ ${modeTxt(m)}`,"ok"); return m; }
      catch(e){ await sleep(400); }
    }
    throw new Error("扫描超时：设备未重新广播");
  },
  /* 全自动闭环：复用/自动连接 -> 确保 boot -> 载入固件 -> 升级 -> 回读状态。
     不弹 chooser（前提：本页已有一次授权或已连接）。 */
  async autoClosure(opt={}){
    const targetSel = opt.target || "M";
    const url = opt.url || "./firmware/M_9501-000-02166_v1.hex";
    const rounds = opt.rounds || 1;
    const out = [];
    window.ota.setTarget(targetSel);
    for(let i=1;i<=rounds;i++){
      const step = {round:i};
      step.connect = await window.ota.scanAndConnect(opt.connectMs||30000);
      if(step.connect==="app"){
        log(`[auto ${i}] 在 APP，发送进 Boot 命令…`,"dim");
        step.enterBoot = await enterBoot();
        if(!step.enterBoot) throw new Error("自动进 Boot 失败");
        setBadge("boot");
      }
      await window.ota.useUrl(url);
      step.fw = {size: fw.length};
      log(`[auto ${i}] 开始升级 ${url} (${fw.length} B)`,"st");
      await startUpgrade();
      const st = window.ota.status();
      step.status = {pct:st.pct, pkts:st.pkts, timings:st.timings,
                     ok: st.log.some(l=>l.includes("升级成功"))};
      out.push(step);
      if(!step.status.ok) throw new Error(`第 ${i} 轮未成功：${JSON.stringify(step.status)}`);
    }
    return out;
  },
  async reconnect(){
    try{ device?.gatt?.disconnect(); }catch(_){}
    await sleep(700);
    await gatt();
    return await probeModeOnly();
  },
  tune(win,gap){ if(win) TUNE.win=win; if(gap!==undefined) TUNE.gap=gap; return {...TUNE}; },
  perf(){
    const p=window.__perf||{wr:[],rounds:[]};
    const s=[...p.wr].sort((a,b)=>a-b);
    const q=f=>s.length?+s[Math.min(s.length-1,Math.floor(s.length*f))].toFixed(1):null;
    const rd=p.rounds.filter(r=>r.moved);
    return { writes:s.length, wrAvg:s.length?+(s.reduce((a,b)=>a+b,0)/s.length).toFixed(1):null,
      wrP50:q(0.5), wrP90:q(0.9), wrMax:s.length?+s[s.length-1].toFixed(1):null,
      rounds:p.rounds.length, movedRounds:rd.length,
      ackAvg: rd.length?+(rd.reduce((a,b)=>a+b.dt,0)/rd.length).toFixed(0):null };
  },
  start: ()=>startUpgrade(),
  stop: ()=>{ abort=true; },
  /* 自检钩子：供离线用例直接驱动连接生命周期（不参与正常流程） */
  _internals:{
    gatt, withTimeout,
    state(){
      return {
        session:__session, cancelled:__cancelled, userDisc:__userDisc,
        devDisc:__devDisc, hasServer:!!server, hasChW:!!chW, hasChN:!!chN,
        rxPending:__rxParser.pending, rxErr:{...__rxErr},
        frames:frames.length, meta:__metaQ.length
      };
    },
    /* 与 connect() 一致：设置设备同时绑定断链监听，供离线用例复现真实路径 */
    setDevice(d){
      device=d;
      d.addEventListener("gattserverdisconnected", onDisconnect);
    },
    reset(){ __cancelled=false; __userDisc=false; __devDisc=false; server=null; chW=null; chN=null; },
    queryStatus, validateLocalImage, crc32Image, parseStatus
  }
};
