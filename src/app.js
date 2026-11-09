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
let switching=false;   // 正在主动断开切 Boot，别报错   // {r, t}：已握手但还没发参数，20 秒内可直接复用

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
  }
}
async function gatt(){
  server = await device.gatt.connect();
  const svc = await server.getPrimaryService(SVC);
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
          frames.push({t:rd16(a,i+2), p:a.slice(i+6,i+6+len)});
          i+=7+len; continue;
        }
      }
      i++;
    }
  });
}
function onDisconnect(){
  if(switching){ chip("切换中…","work"); return; }
  chip("已断开",""); setBadge(null);
  $("hMeta").textContent="连接已断开";
  $("btnDisc").disabled=true; $("btnProbe").disabled=true;
  log("蓝牙连接断开","err");
}
async function writeFrame(f){
  if(chW.writeValueWithoutResponse) await chW.writeValueWithoutResponse(f);
  else await chW.writeValue(f);
}
async function writeCtrl(f){ await chW.writeValueWithResponse(f); }
async function send(type,payload){
  const f=makeFrame(type,payload);
  if(type===T.HS||type===T.PM||type===T.SHA||type===T.DONE) await writeCtrl(f);
  else await writeFrame(f);
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
async function enterBoot(){
  log("发送进 Boot 命令 …","dim");
  try{
    if(chW.writeValueWithoutResponse) await chW.writeValueWithoutResponse(APP_ENTER_BOOT);
    else await chW.writeValue(APP_ENTER_BOOT);
  }catch(_){
    try{ await chW.writeValue(APP_ENTER_BOOT); }catch(e){ log("进 Boot 命令发送失败："+e.message,"err"); return null; }
  }
  await sleep(3200);
  switching=true;
  for(let i=1;i<=4;i++){
    try{
      try{ device.gatt.disconnect(); }catch(_){}
      await sleep(1000);
      await gatt();
      await sleep(500);
      frames.length=0;
      const r=await request(T.HS, devInfo(target), T.HSR, 3000);
      if(r){ switching=false; log("已进入 Boot 模式","ok"); return r; }
    }catch(e){ log(`重连失败(${i})：${e.message}`,"dim"); }
    await sleep(1200);
  }
  switching=false;
  return null;
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
async function startUpgrade(){
  if(!fw || running) return;
  running=true; abort=false; refreshGo();
  $("btnStop").disabled=false;
  $("log").innerHTML="";
  const t0=performance.now();
  const img=fw, pkt=231, total=Math.ceil(img.length/pkt), win=8, gap=4;

  $("sPct").textContent="0%"; $("bar").style.width="0%";
  $("sPkt").textContent=`0/${total}`; $("sSpd").textContent="0"; $("sRtx").textContent="0";
  $("tConn").textContent="--"; $("tHs").textContent="--"; $("tData").textContent="--"; $("tAll").textContent="--";
  chip("升级中","work");

  log(`目标 ${target} · 镜像 ${img.length} B · 包 ${pkt} B × ${total}`);
  try{
    stage("握手");
    let r = null;
    if(hsReady && Date.now()-hsReady.t < 20000){ r = hsReady.r; hsReady=null; log("[1] 复用已完成的握手","st"); }
    if(!r){
      r = await request(T.HS, devInfo(target), T.HSR, 4000);
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
      while(sent<total && sent-acked<win){
        const chunk=img.slice(sent*pkt,(sent+1)*pkt);
        const body=new Uint8Array(6+chunk.length);
        body.set(u16(sent),0); body.set(u16(total),2); body.set(u16(chunk.length),4);
        body.set(chunk,6);
        await writeFrame(makeFrame(T.DT, body));
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
    r = await request(T.SHA, sha, T.SHAR, 8000);
    if(!r || r[0]!==0) throw new Error("SHA-256 校验失败");
    log("[4] SHA-256 匹配","st");

    stage("写入并跳转");
    r = await request(T.DONE, new Uint8Array(0), T.DONER, 30000);
    if(!r) throw new Error("完成应答超时");
    if(r[0]!==0) throw new Error("设备报错 0x"+r[0].toString(16));

    $("bar").style.width="100%"; $("sPct").textContent="100%";
    $("tAll").textContent=((performance.now()-t0)/1000).toFixed(1)+" s";
    stage("升级成功");
    chip("升级成功","on");
    log("[5] 升级成功，设备即将复位","ok");
  }catch(e){
    stage("失败");
    chip("失败","");
    log("!! "+e.message,"err");
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
