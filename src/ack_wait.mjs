/* Stop waiting as soon as progress is queued; drain queued ACKs without a tail sleep. */
export async function takeDataReplies(queue, {ack=0x0302, nack=0x0303, timeout=1000,
    now=()=>performance.now(), sleep=ms=>new Promise(r=>setTimeout(r,ms)), cancelled=()=>false}={}){
  const deadline=now()+timeout;
  const replies=[];
  while(now()<deadline){
    if(cancelled()) throw new Error("已中止");
    const i=queue.findIndex(f=>f.t===ack || f.t===nack);
    if(i>=0){
      const f=queue.splice(i,1)[0];
      replies.push(f);
      if(f.t===nack) break;
      continue;
    }
    if(replies.length) break;
    await sleep(Math.min(5,Math.max(0,deadline-now())));
  }
  return replies;
}
