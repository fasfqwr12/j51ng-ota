/* J51NG OTA · Web Bluetooth 升级上位机 */
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
const TUNE = { win:32, gap:4 };   // 实测：win=8 数据 8.1s；win=32 → 5.4s（与桌面版持平）   // 正在主动断开切 Boot，别报错   // {r, t}：已握手但还没发参数，20 秒内可直接复用

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
  const el=$("log"), t=new Date().toTimeString().slice(0,8);
  el.insertAdjacentHTML("beforeend", `<div class="${cls}">${t}  ${msg}</div>`);
  el.scrollTop = el.scrollHeight;
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
   这里给它一个短超时，超时就当"这次没扫到"，马上重试。 */
function withTimeout(p, ms, what){
  return Promise.race([
    p,
    new Promise((_, rej)=>setTimeout(()=>rej(new Error((what||"操作")+"超时")), ms))
  ]);
}

let __gattLock=null;
function gatt(timeoutMs){
  if(__gattLock) return __gattLock;
  __gattLock=(async()=>{
  server = device.gatt.connected ? device.gatt : await withTimeout(device.gatt.connect(), timeoutMs||8000, "连接");
  let svc;
  try{
    svc = await server.getPrimaryService(SVC);
  }catch(e){
    // 链路是陈旧的：踢一次，让下一次循环重新建立干净连接
    try{ device.gatt.disconnect(); }catch(_){}
    throw e;
  }
  chW = await svc.getCharacteristic(CH_W);
  chN = await svc.getCharacteristic(CH_N);
  await chN.startNotifications();
  chN.addEventListener("characteristicvaluechanged", ev=>{
    const dv=ev.target.value;
    const a=new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength);
    let i=0;
    while(i+7<=a.length){
      if(a[i]===0xEB && a[i+1]===0x90){
        const len=rd16(a,i+4);
        if(i+7+len<=a.length){
          const __t = rd16(a,i+2); const __p = a.slice(i+6,i+6+len);
          if(__t!==0x0302 && __t!==0x0303 && __t!==0x0301 && __t!==0x0000) logRx(__t, __p);
          frames.push({t:__t, p:__p});
          i+=7+len; continue;
        }
      }
      i++;
    }
  });
  })().finally(()=>{ __gattLock=null; });
  return __gattLock;
}
function onDisconnect(){
  if(switching){ chip("切换中…","work"); return; }
  chip("已断开",""); setBadge(null);
  $("hMeta").textContent="连接已断开";
  $("btnDisc").disabled=true; $("btnProbe").disabled=true;
  log("蓝牙连接断开","err");
}

/* ---- 原始帧日志：把蓝牙收发的每个控制帧打出来 ---- */
const FRAME_NAME = {0x0000:"BEACON",0x0101:"HS请求",0x0102:"HS应答",0x0201:"参数请求",0x0202:"参数应答",
  0x0301:"数据",0x0302:"ACK",0x0303:"NACK",0x0401:"SHA请求",0x0402:"SHA应答",
  0x0501:"完成请求",0x0502:"完成应答",0x0601:"发主控EnterBL",0x0602:"发主控Raw",0x0603:"主控命令应答"};
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
  log("发送进 Boot 命令 …","dim");
  const w=async()=>{ if(chW.writeValueWithoutResponse) await chW.writeValueWithoutResponse(APP_ENTER_BOOT); else await chW.writeValue(APP_ENTER_BOOT); };
  let sent=false;
  for(let k=1;k<=4 && !sent;k++){
    try{
      // 设备重启后旧特征会失效，先确保链路和特征都是新的
      if(k>1 || !(device && device.gatt.connected) || !chW) await gatt();
      await w(); sent=true;
    }catch(e){
      log(`进 Boot 命令写入失败(${k})：${e.message}`,"dim");
      await sleep(1500);
    }
  }
  if(!sent){ log("进 Boot 命令发送失败","err"); return null; }
  await sleep(2600);
  switching=true;
  for(let i=1;i<=30;i++){
    try{
      if(i>1) await sleep(400);
      const __t=performance.now();
      await gatt(1500);                       // 1.5 s 没连上就放弃，立刻下一轮
      await sleep(300);
      frames.length=0;
      const r=await request(T.HS, devInfo(target), T.HSR, 1200);
      if(r){ switching=false; log(`已进入 Boot 模式（第 ${i} 次尝试，${((performance.now()-__t)/1000).toFixed(1)} s）`,"ok"); return r; }
    }catch(e){ if(i%2===0||i<3) log(`    扫描中(${i})… ${e.message}`,"dim"); }
    await sleep(600);
  }
  switching=false;
  return null;
  })().finally(()=>{ __bootLock=null; });
  return __bootLock;
}

/* ---------------- 模式识别 ---------------- */
async function probeMode(){
  frames.length=0;
  let r = await request(T.HS, devInfo(target), T.HSR, 2000);
  if(r){
    setBadge("boot");
    const hw=new TextDecoder().decode(r.slice(1,17)).replace(/[\uFFFD\x00]/g,"");
    $("kHw").textContent = hw || "—";
    $("kVer").textContent = r.length>=21 ? [...r.slice(17,21)].map(b=>b.toString(16).padStart(2,"0")).join(".") : "—";
    $("hMeta").textContent = "Boot 模式，可直接升级";
    log("模式：Boot（握手有应答）","ok");
    hsReady = {r, t: Date.now()};
    return "boot";
  }
  setBadge("app");
  $("hMeta").textContent = "APP 模式，正在切换进 Boot…";
  log("模式：APP（握手无应答）","dim");
  r = await enterBoot();
  if(r){
    setBadge("boot");
    const hw=new TextDecoder().decode(r.slice(1,17)).replace(/[\uFFFD\x00]/g,"");
    $("kHw").textContent = hw || "—";
    $("kVer").textContent = r.length>=21 ? [...r.slice(17,21)].map(b=>b.toString(16).padStart(2,"0")).join(".") : "—";
    $("hMeta").textContent = "已进入 Boot 模式";
    hsReady = {r, t: Date.now()};
    return "boot";
  }
  $("hMeta").textContent = "切换 Boot 失败，请重试";
  log("未能进入 Boot","err");
  return "app";
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
    const row=(it,i,canOta)=>{
      const kb=(it.size/1024).toFixed(1);
      const tail = canOta
        ? `<button data-i="${i}">选用</button>`
        : `<span class="tag swd">仅 SWD</span>`;
      return `<div class="fw${canOta?"":" noota"}">
        <span class="tag">${it.targetName}</span>
        <div class="nm"><b>${it.title}</b><span>${kb} KB · ${it.sha256.slice(0,12)}…</span></div>
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
    log(`已选用 ${it.title}（${it.targetName}）`,"ok");
  }catch(e){
    log("下载失败："+e.message,"err");
  }finally{
    if(btn){ btn.disabled=false; btn.textContent="选用"; }
  }
}

/* ---------------- 升级 ---------------- */

/* 只读模式判断：握手有应答=Boot，无应答=APP（不主动切 Boot） */
async function probeModeOnly(timeout=2000){
  frames.length=0;
  const r = await request(T.HS, devInfo(target), T.HSR, timeout);
  return r ? "boot" : "app";
}
/* 设备复位后自动重连：每 1.2 s 试一次，直到回来或超时 */
async function waitReconnect(maxMs=30000){
  const t0=performance.now(); let n=0;
  while(performance.now()-t0<maxMs){
    n++;
    try{
      // 只连不踢：反复 disconnect 会让 Chrome 的连接状态机卡死
      const __t=performance.now();
      await gatt(1500);
      const m = await probeModeOnly(900);
      log(`    重连成功（第 ${n} 次尝试，${((performance.now()-t0)/1000).toFixed(1)} s）`,"ok");
      setBadge(m);
      return m;
    }catch(e){
      if(n%5===0) log(`    等待设备重启…（${Math.round((performance.now()-t0)/1000)} s）`,"dim");
      await sleep(800);
    }
  }
  return null;
}

async function startUpgrade(){
  if(!fw || running) return;
  running=true; abort=false; refreshGo();
  $("btnStop").disabled=false;
  $("log").innerHTML="";
  const t0=performance.now();
  const img=fw, win=TUNE.win, gap=TUNE.gap;
  let pkt=231, total=0;

  $("sPct").textContent="0%"; $("bar").style.width="0%";
  $("sPkt").textContent=`0/${total}`; $("sSpd").textContent="0"; $("sRtx").textContent="0";
  $("tConn").textContent="--"; $("tHs").textContent="--"; $("tData").textContent="--"; $("tAll").textContent="--";
  chip("升级中","work");

  window.__perf={wr:[],rounds:[]};
  log(`目标 ${target} · 镜像 ${img.length} B · win=${TUNE.win} gap=${TUNE.gap}`);
  try{
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
    stage("握手");
    let r = null;
    if(hsReady && Date.now()-hsReady.t < 20000){ r = hsReady.r; hsReady=null; log("[1] 复用已完成的握手","st"); }
    if(!r){
      try{
        r = await request(T.HS, devInfo(target), T.HSR, 4000);
      }catch(e){
        log("握手写入失败（"+e.message+"），重连后重试","dim");
        await gatt(); hsReady=null;
        r = await request(T.HS, devInfo(target), T.HSR, 4000);
      }
      if(!r){
        log("握手无应答 → 设备在 APP，自动切 Boot 后重试","dim");
        stage("切换 Boot");
        r = await enterBoot();
        if(!r) throw new Error("握手无应答，且自动切 Boot 失败");
        setBadge("boot");
      }
    }
    if(r[0]!==0) throw new Error("握手状态 0x"+r[0].toString(16));
    $("tHs").textContent=((performance.now()-t0)/1000).toFixed(1)+" s";
    log("[1] 握手成功","st");

    // 设备会把包长向下 4 字节对齐（pkt & ~3），必须按对齐后的值分包
    const devMax = r.length>=23 ? rd16(r,21) : 0;
    let want = devMax ? Math.min(231, devMax) : 231;
    pkt = want & ~3;
    if(pkt<4) pkt=4;
    total = Math.ceil(img.length/pkt);
    log(`[1b] 分包 pkt=${pkt} B × ${total}（设备 maxpkt=${devMax||"?"}）`,"dim");
    $("sPkt").textContent = `0/${total}`;

    stage("擦除暂存区");
    const sha=await sha256(img);
    const pm=new Uint8Array(38);
    pm.set(u32(img.length),0); pm.set(sha,4); pm.set(u16(pkt),36);
    r = await request(T.PM, pm, T.PMR, 25000);
    if(!r) throw new Error("参数无应答");
    if(r[0]!==0) throw new Error("参数被拒 0x"+r[0].toString(16));
    log("[2] 参数已接受，暂存区擦除完成","st");

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
    // 设备要先算整片 SHA，0x0401 是无响应写，可能丢 → 重发
    for(let k=1;k<=5;k++){
      r = await request(T.SHA, sha, T.SHAR, 8000);
      if(r) break;
      log(`    0x0401 第 ${k} 次无应答（设备可能在算 SHA），重发…`,"dim");
      await sleep(1500);
    }
    if(!r || r[0]!==0) throw new Error("SHA-256 校验失败");
    log("[4] SHA-256 匹配","st");

    stage("写入并跳转");
    log("[5] 正在写入并跳转，设备会复位重启（约 10~20 s，请勿断电）","dim");
    // 0x0501：升级期间蓝牙板可能主动断链，断了重连再发；单次只等 3 s，多发几次
    r = null;
    // 设备在把暂存区搬到 APP 区：先给 4 s 安静时间，期间发帧会拖慢它
    await sleep(4000);
    for(let k=1;k<=30;k++){
      if(!(device && device.gatt.connected)){
        try{ await gatt(); log("    链路已断开，已重连","dim"); }
        catch(e){ await sleep(1000); continue; }
      }
      r = await request(T.DONE, new Uint8Array(0), T.DONER, 1500);
      if(r) break;
      if(k%4===0) log(`    设备仍在写入，等待确认…（${k}/30）`,"dim");
      await sleep(500);
    }
    if(!r){
      // 设备可能已经写完直接复位，0x0502 丢在断开里 —— 重连看它跑的是不是新 APP
      log("未收到 0x0502（设备可能已复位），重连确认实际状态…","dim");
      const m0 = await waitReconnect(15000);
      if(m0==="app"){
        log("[7] ✅ 升级成功（0x0502 丢失，但设备已重启并运行新 APP）","st");
        chip("升级成功","on"); stage("升级成功");
        $("tAll").textContent=((performance.now()-t0)/1000).toFixed(1)+" s";
        return;
      }
      throw new Error("等待设备确认超时，且设备未回到 APP");
    }
    if(r[0]!==0) throw new Error("设备报告写入失败，状态码 0x"+r[0].toString(16).padStart(2,"0"));
    log(`[5] 设备已确认接管（0x0502=0x00）`,"st");

    $("bar").style.width="100%"; $("sPct").textContent="100%";

    // 主控/雷达：副板固件没变，新 Boot 会原地待命、不断链，直接判成功
    if(target !== "S"){
      const tot=((performance.now()-t0)/1000).toFixed(1);
      $("tAll").textContent=tot+" s";
      log("[7] ✅ 升级成功：目标已升级，蓝牙板保持连接（无需重连）","st");
      chip("升级成功","on"); stage("升级成功");
      log(`==== 总耗时 ${tot} s（数据阶段 ${$("tData").textContent}）====`,"st");
      return;
    }

    stage("等待设备重启");
    log("[6] 设备复位中，等待重新连接…","dim");
    const mode = await waitReconnect(30000);
    if(mode==="app"){
      log("[7] ✅ 升级成功：设备已重启并运行新 APP","st");
      chip("升级成功","on");
      stage("升级成功");
    }else if(mode==="boot"){
      log("[7] ❌ 升级未完成：设备重启后仍停在 Boot（镜像未跳转）","err");
      chip("需重试",""); stage("需重试");
    }else{
      throw new Error("已派发但设备 30 s 内未回来，请断电重启确认");
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

/* ---------------- 事件 ---------------- */
$("btnConn").onclick=connect;
$("btnDisc").onclick=()=>{ try{ device.gatt.disconnect(); }catch(_){} };
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

/* 能力检测 */
if(!navigator.bluetooth){
  log("当前浏览器不支持 Web Bluetooth：请用安卓 Chrome / Edge，并确保是 https 页面","err");
}

/* ---------------- 对外 API（便于自动化/联调） ---------------- */
window.ota = {
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
  async scanAndConnect(maxMs=30000){
    const t0=performance.now(); let n=0;
    while(performance.now()-t0<maxMs){
      n++;
      try{ await gatt(1500); const m=await probeModeOnly(1000); log(`扫描成功（第 ${n} 次，${((performance.now()-t0)/1000).toFixed(1)} s）→ ${m==="boot"?"Boot":"APP"}`,"ok"); return m; }
      catch(e){ await sleep(400); }
    }
    throw new Error("扫描超时：设备未重新广播");
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
  stop: ()=>{ abort=true; }
};
