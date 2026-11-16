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
                  addEventListener(){},
                  writeValueWithoutResponse: async () => {},
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

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
