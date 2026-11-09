
const HW={M:"J51VA-M",S:"J51VA-S",R:"J51VA-R"};
function crc8(d){let c=0;for(const b of d){c^=b;for(let i=0;i<8;i++)c=(c&0x80)?((c<<1)^0x07)&0xFF:(c<<1)&0xFF;}return c;}
function makeFrame(type,payload=new Uint8Array(0)){
  const body=new Uint8Array(4+payload.length);
  body[0]=(type>>8)&255;body[1]=type&255;body[2]=(payload.length>>8)&255;body[3]=payload.length&255;
  body.set(payload,4);
  const out=new Uint8Array(7+payload.length);out[0]=0xEB;out[1]=0x90;out.set(body,2);
  out[6+payload.length]=crc8(body);return out;}
function devInfo(t){const d=new Uint8Array(16).fill(0xFF),s=HW[t];for(let i=0;i<s.length;i++)d[i]=s.charCodeAt(i);return d;}
const hex=a=>[...a].map(b=>b.toString(16).padStart(2,"0")).join("");
const u16=n=>new Uint8Array([(n>>8)&255,n&255]);
const u32=n=>new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);
const pm=new Uint8Array(38);pm.set(u32(68224),0);pm.set(new Uint8Array(32).map((_,i)=>i),4);pm.set(u16(231),36);
const dt=new Uint8Array(6);dt.set(u16(7),0);dt.set(u16(296),2);dt.set(u16(231),4);
console.log(JSON.stringify({hs:hex(makeFrame(0x0101,devInfo("S"))),pm:hex(pm),dt:hex(dt)}));
