/* 连接生命周期离线用例：用假 DOM + 假 Web Bluetooth 直接跑真实的 app.js。
 * 覆盖：超时后晚到成功必须释放、手动断开取消在途流程、旧断开事件不得破坏新会话。
 * 运行：node src/lifecycle.test.mjs
 */
let pass = 0, fail = 0;
const eq = (a, e, n) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if(A === E) pass++; else { fail++; console.log(`FAIL ${n}\n  got ${A}\n  want ${E}`); }
};
const ok = (c, n) => c ? pass++ : (fail++, console.log(`FAIL ${n}`));

/* ---------------- 假 DOM ---------------- */
function el(id){
  const node = {
    id, textContent:"", innerHTML:"", className:"", disabled:false, scrollTop:0, scrollHeight:0,
    style:{}, dataset:{}, children:[], value:"",
    onclick:null, onchange:null, ondrop:null, ondragover:null, ondragleave:null,
    classList:{ add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    insertAdjacentHTML(){},
    appendChild(c){ this.children.push(c); },
    querySelectorAll(){ return []; },
    click(){ if(this.onclick) this.onclick(); },
    closest(){ return null; },
    addEventListener(ev, fn){ (this._ev = this._ev || {})[ev] = fn; }
  };
  return node;
}
const nodes = new Map();
function node(id){
  if(!nodes.has(id)) nodes.set(id, el(id));
  return nodes.get(id);
}
globalThis.document = {
  documentElement:{ dataset:{} },
  getElementById: id => node(id),
  querySelectorAll: () => [],
  createElement: () => el("tmp")
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem:()=>null, setItem(){}, removeItem(){} };
const winListeners = {};
globalThis.addEventListener = (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); };
/* 模块加载时会拉 firmware/index.json */
globalThis.fetch = async () => ({ ok:true, json:async()=>({items:[]}), arrayBuffer:async()=>new ArrayBuffer(0) });

/* ---------------- 假 Web Bluetooth ---------------- */
function makeDevice(cfg = {}){
  const listeners = {};
  const log = cfg.log || {};
  let notify;
  const reply = (bytes) => notify({ target: { value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) } });
  const dev = {
    name: cfg.name || "AIMTECH VHR",
    id: cfg.id || "dev-0001",
    addEventListener(ev, fn){ (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev){ (listeners[ev] || []).slice().forEach(f => f()); },
    gatt:{
      connected:false,
      connectCount:0, disconnectCount:0,
      connect(){
        this.connectCount++;
        const g = this;
        log.connect = (log.connect || 0) + 1;
        return new Promise((resolve)=>{
          const delay = cfg.connectDelay === undefined ? 0 : cfg.connectDelay;
          const fireResolve = () => {
            g.connected = true;
            resolve({
              getPrimaryService: async () => ({
                getCharacteristic: async () => ({
                  startNotifications: async () => {},
                  addEventListener(ev, fn){ if(ev === "characteristicvaluechanged") notify = fn; },
                  writeValueWithoutResponse: async (bytes) => cfg.onWrite?.(bytes, reply),
                  writeValueWithResponse: async () => {}
                })
              })
            });
          };
          if(delay > 0) setTimeout(fireResolve, delay);
          else fireResolve();
        });
      },
      disconnect(){
        this.disconnectCount++;
        this.connected = false;
        log.disconnect = (log.disconnect || 0) + 1;
        setTimeout(()=>dev.fire("gattserverdisconnected"), 0);
      }
    }
  };
  return {dev, log};
}

const mod = await import("./app.js");
const API = globalThis.ota;
const I = API._internals;
eq(typeof I.gatt, "function", "test hook gatt exposed");

const sleep = ms => new Promise(r=>setTimeout(r, ms));

/* 用例 1：连接超时后晚到成功 —— 必须释放，不得留下占链 */
{
  const {dev, log} = makeDevice({connectDelay: 300});
  I.setDevice(dev); I.reset();
  let err = null;
  try { await I.gatt(80); } catch(e){ err = e.message; }
  ok(err && err.includes("超时"), "connect timeout surfaces");
  eq(I.state().hasServer, false, "timeout: no server published");
  await sleep(400);                     /* 让晚到的连接完成 */
  ok(log.disconnect >= 1, "late success released by disconnect");
  ok(!dev.gatt.connected, "device link not left occupied");
}

/* 用例 2：连接成功但会话已切换 —— 结果作废并释放 */
{
  const {dev, log} = makeDevice({connectDelay: 20});
  I.setDevice(dev); I.reset();
  const p = I.gatt(2000);
  /* 模拟在连接过程中用户断开（代次递增 + 取消） */
  await sleep(5);
  API._internals.state().session;
  node("btnDisc").onclick();
  let err=null;
  try{ await p; }catch(e){ err=e.message; }
  ok(err !== null, "switched session rejects");
  await sleep(60);
  eq(I.state().hasServer, false, "switched session: no server published");
  ok(log.disconnect >= 1, "switched session link released");
}

/* 用例 3：手动断开后必须保持断开，不得自动重连 */
{
  const {dev, log} = makeDevice({});
  I.setDevice(dev); I.reset();
  await I.gatt(2000);
  const before = log.connect || 0;
  eq(I.state().hasServer, true, "healthy session established");
  node("btnDisc").onclick();
  await sleep(50);
  eq(I.state().userDisc, true, "manual disconnect flag set");
  eq(I.state().cancelled, true, "manual disconnect cancels flows");
  eq(I.state().hasServer, false, "session dropped after manual disconnect");
  eq((log.connect || 0), before, "no automatic reconnect after manual disconnect");
}

/* 用例 4：旧断开事件晚到，不得破坏新会话 */
{
  const {dev} = makeDevice({});
  I.setDevice(dev); I.reset();
  await I.gatt(2000);
  eq(I.state().hasServer, true, "session A established");
  /* 模拟旧链路晚到的 gattserverdisconnected（新会话已建立后才到） */
  const s1 = I.state().session;
  dev.fire("gattserverdisconnected");
  await sleep(10);
  /* 此时确实断链，应作废 */
  eq(I.state().hasServer, false, "disconnect clears session");
  ok(I.state().session > s1, "session generation advanced");
  await I.gatt(2000);
  eq(I.state().hasServer, true, "reconnect after real disconnect works");
}

/* 用例 5：健康会话复用，不得反复断开重连 */
{
  const {dev, log} = makeDevice({});
  I.setDevice(dev); I.reset();
  await I.gatt(2000);
  const c0 = log.connect || 0, d0 = log.disconnect || 0;
  await I.gatt(2000);
  await I.gatt(2000);
  eq((log.connect || 0), c0, "healthy session reused: no reconnect");
  eq((log.disconnect || 0), d0, "healthy session reused: no disconnect churn");
}

/* 用例 6：并发 gatt() 调用只应产生一次建链 */
{
  const {dev, log} = makeDevice({connectDelay: 30});
  I.setDevice(dev); I.reset();
  await Promise.all([I.gatt(2000), I.gatt(2000), I.gatt(2000)]);
  eq((log.connect || 0), 1, "concurrent gatt calls share one connection");
}

/* 用例 7：网页连接读 ID 后，应用回包仍须分发到板卡扫描与其他订阅者。 */
{
  node("btnDisc").onclick();
  await sleep(10);
  const {crc8} = await import("./rx_parse.mjs");
  const index = {items:[
    {target:"M", model:"N2SE_M", version:"v1.83", appCrc:"0xDB2742BD", imgType:0},
    {target:"S", model:"N2SE_S", version:"v1.17", appCrc:"0x9727166D", imgType:0}
  ]};
  globalThis.location = {hostname:"fasfqwr12.github.io"};
  globalThis.fetch = async (url) => ({ok:true, json:async()=>url.startsWith("./firmware/") ? index : {}});
  globalThis.MutationObserver = class { observe(){} };
  document.head = node("head");
  document.querySelector = () => null;
  await import("./upgrade.js");

  const seen = [];
  window.__J51NG.onApp(cmd => seen.push(cmd));
  const {dev} = makeDevice({onWrite(f, reply){
    const appReply = (cmd, payload) => {
      const r = API.appFrame(cmd, Uint8Array.from(payload));
      r[0]=0x54; r[1]=0xA1;   // 两种帧头字节和均为 0xF5
      reply(r);
    };
    if(f[0] === 0xEB && f[1] === 0x90 && f[2] === 0x06 && f[3] === 0x10){
      const r = new Uint8Array(39);
      r.set([0xEB,0x90,0x06,0x12,0,32,0x4A,0x35,0x53,0x54,1,1]);
      r[38]=crc8(r.subarray(2,38));
      reply(r);
      return;
    }
    if(f[0] !== 0x53 || f[1] !== 0xA2) return;
    const id=f[5];
    const item=index.items.find(x => x.target === (id === 1 ? "S" : "M"));
    if(f[4] === 0x24) appReply(0x25,[1,1,6,5,4,3,2,1,2,0]);
    if(f[4] === 0xFE) appReply(0xFE,[0]);
    if(f[4] === 0x20){
      const p = new Uint8Array(12), view = new DataView(p.buffer);
      p.set([id,1,1,id === 1 ? 17 : 83]);
      view.setUint32(4,id === 1 ? 0x9727166D : 0xDB2742BD,true);
      view.setUint32(8,id === 1 ? 45496 : 96084,true);
      appReply(0x21,p);
    }
    if(f[4] === 0x22){
      const p = new Uint8Array(13);
      p[0]=id; p.set(new TextEncoder().encode(item.model),1);
      appReply(0x23,p);
    }
  }});
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{bluetooth:{requestDevice:async()=>dev}}});
  I.reset();
  await node("btnConn").onclick();
  eq(node("kId").textContent,"01:02:03:04:05:06","connect reads real id frame");
  ok(seen.includes(0x25),"connect reply reaches app subscribers");
  eq(await API.readMeta(),{none:true},"readMeta still consumes its own reply");
  await node("up2Scan")._ev.click();
  eq(node("up2Tail").textContent,"扫描完成：2 块板","scan button populates both boards");
  eq(node("up2Dev").textContent,"01:02:03:04:05:06","scan shows id from 0x25");
  ok(seen.includes(0x21) && seen.includes(0x23),"description and model reach app subscribers");
  ok(node("fwCur").innerHTML.includes("v1.83"),"scan updates firmware comparison immediately");
  ok(node("up2Table").innerHTML.split("已是最新").length === 3 && node("up2Go").disabled,
    "matching online images disable one-click upgrade");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
