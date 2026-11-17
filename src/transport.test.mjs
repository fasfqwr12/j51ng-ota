/* Execute the real page against fake DOM/HTTP/Bluetooth in both deployment modes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createParser, MAX_FRAME} from './rx_parse.mjs';
import {takeDataReplies} from './ack_wait.mjs';
import {webcrypto} from 'node:crypto';

const source=fs.readFileSync(new URL('./app.js',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'');
function setup(hostname){
  const nodes=new Map(), requests=[];let browserCalls=0;
  function node(id){
    if(!nodes.has(id)) nodes.set(id,{id,textContent:'',innerHTML:'',disabled:false,hidden:false,
      style:{},dataset:{},children:[],classList:{add(){},remove(){},toggle(){}},
      appendChild(c){this.children.push(c);},querySelectorAll(){return [];},addEventListener(){},
      click(){return this.onclick?.({target:this});}});
    return nodes.get(id);
  }
  let job=null;
  let ble={connected:false,name:'AIMTECH TEST',address:'FAKE',status:null,busy:false};
  const device={name:'AIMTECH TEST',id:'browser-device',addEventListener(){},gatt:{connected:false,
    async connect(){this.connected=true;throw Error('test stops at browser GATT');},
    disconnect(){this.connected=false;}}};
  const ctx={console,createParser,MAX_FRAME,takeDataReplies,Uint8Array,ArrayBuffer,DataView,
    crypto:webcrypto,performance,AbortSignal,Date,Math,Promise,File,
    location:{hostname},navigator:{bluetooth:{async requestDevice(){browserCalls++;return device;}}},
    localStorage:{getItem(){return null;},setItem(){}},addEventListener(){},
    setInterval(){return 0;},setTimeout,clearTimeout,
    document:{documentElement:{dataset:{}},getElementById:node,createElement:()=>node(Symbol()),
      querySelector(){return null;},querySelectorAll(){return [];}},
    fetch:async(path,opts={})=>{
      requests.push({path,opts});
      const response=data=>({ok:true,status:200,json:async()=>data});
      if(path.startsWith('./firmware/index.json'))return response({items:[]});
      if(path==='/api/status')return response({transport:'native-ble-v1',ble,running:false,
        stage:job?'通过':'-',job_id:job,ok:job?true:null,elapsed:0});
      if(path==='/selected.bin')return {ok:true,arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer};
      if(path==='/api/ota?target=M'){job='native-job';return response({ok:true,job_id:job});}
      if(path.startsWith('/api/log'))return response({lines:[],total:0});
      if(path==='/api/connect'||path==='/api/probe'){
        ble={...ble,connected:true,status:{mode:'app',meta_valid:true,hcrc_ok:true,
          fw_version:0x0606,size:42120,payload_crc:0xf6ddc8b4,capacity:102400}};
        return response({ok:true,ble});
      }
      if(path==='/api/disconnect'){ble={...ble,connected:false,status:null};return response({ok:true,ble});}
      throw Error('unexpected fetch '+path);
    }};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
  return {ctx,nodes,requests,browserCalls:()=>browserCalls};
}
const local=setup('127.0.0.1');
await new Promise(r=>setTimeout(r,0));
assert.equal(local.ctx.ota.status().transport,'api');
await local.ctx.ota.connectGranted();
assert.equal(local.browserCalls(),0,'local connect must never request browser Bluetooth');
assert.equal(local.ctx.ota.status().connected,true);
assert.equal(local.nodes.get('kId').textContent,'FAKE');
await local.ctx.ota.probe();
assert.ok(local.requests.some(r=>r.path==='/api/probe'));
assert.equal(local.nodes.get('btnApiGo').hidden,true);
await local.ctx.ota.useUrl('/selected.bin');
assert.equal(local.nodes.get('btnGo').disabled,false);
await local.nodes.get('btnGo').onclick();
const upload=local.requests.find(r=>r.path==='/api/ota?target=M');
assert.ok(upload,'normal upgrade button must call native API');
assert.deepEqual([...upload.opts.body],[1,2,3,4]);
assert.equal(local.browserCalls(),0,'normal upgrade never requests browser BLE');
await local.nodes.get('btnDisc').onclick();
assert.equal(local.ctx.ota.status().connected,false);
assert.ok(local.requests.some(r=>r.path==='/api/disconnect'));
await assert.rejects(local.ctx.ota._internals.gatt(1),/API/);
const staticPage=setup('example.github.io');
await new Promise(r=>setTimeout(r,0));
assert.equal(staticPage.ctx.ota.status().transport,'web-bluetooth');
await staticPage.nodes.get('btnConn').onclick();
assert.equal(staticPage.browserCalls(),1);
assert.equal(staticPage.requests.filter(r=>r.path.startsWith('/api/')).length,0,
  'published static page must not contact local API');
const overlay=fs.readFileSync(new URL('../api-live.js',import.meta.url),'utf8');
vm.runInContext(overlay,staticPage.ctx);
assert.equal(staticPage.requests.filter(r=>r.path.startsWith('/api/')).length,0);
console.log('PASS 2 deployment modes: local API-only connect/probe/normal-upgrade/disconnect, Git static Web Bluetooth with no API polling');
