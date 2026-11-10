// Two nodes in one process (src/mesh): identities made, B paired from A with B's code, a link up both ways, a
// request answered, an event delivered, a wrong code refused, the pair forgotten and the link gone. No mDNS.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLinks } = require("../src/mesh/links");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-mesh-"));
const until = (emitter, event, test = () => true, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no "${event}" within ${ms} ms`)), ms);
  const on = data => { if (test(data)) { clearTimeout(timer); emitter.off(event, on); resolve(data); } };
  emitter.on(event, on);
});
// Any free port: the default one may be the real AgentDeck's.
const node = (name, api) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  if (!fs.existsSync(path.join(root, name, "node.json"))) fs.writeFileSync(path.join(root, name, "node.json"), JSON.stringify({ port: 0 }));
  return createLinks({ dir: path.join(root, name), defaultName: name, kind: "desktop", version: "test", api, discover: false, log: line => console.log(`  [${name}] ${line}`) });
};


(async () => {
 const all=[];
 try {
 for (const name of ['A','B','C','D']) { const n=node(name, (method, params, peer)=>({method,params,from:peer.id})); all.push(n); await n.start(); }
 const [a,b,c,d]=all;
 const wait=async f=>{for(let i=0;i<300;i++){if(f())return;await new Promise(r=>setTimeout(r,50));}throw new Error('condition timeout')};
 for(const [x,y] of [[a,b],[b,c],[c,d]]){await x.pair('127.0.0.1',y.self().port,y.self().code);await wait(()=>x.online(y.self().id)&&y.online(x.self().id));}
 await wait(()=>a.discovered().some(n=>n.id===d.self().id));
 await assert.rejects(a.call(d.self().id,'test'));
 await assert.rejects(a.pair(d.self().id,0,'wrong'),e=>e.code==='wrongCode'); assert.ok(d.self().pairFailures.lastSource.startsWith('via '),'a relayed try is counted by the neighbour it came through: '+d.self().pairFailures.lastSource); await new Promise(r=>setTimeout(r,1100));
 await a.pair(d.self().id,0,d.self().code);
 await wait(()=>a.online(d.self().id));
 assert.equal(a.nodes().find(n=>n.id===d.self().id).via.length,2);
 assert.equal(a.peers().get(d.self().id).address, "");
 const r=await a.call(d.self().id,'test',{hello:1});
 assert.equal(r.from,a.self().id); assert.deepEqual(r.params,{hello:1});
 const got=until(d,'binary',e=>e.node===a.self().id);
 const payload=Buffer.alloc(256*1024, 42);
 a.sendBinary(d.self().id,payload);assert.deepEqual((await got).data,payload);
 const event=until(a,'event',e=>e.node===d.self().id&&e.name==='data');d.notify(a.self().id,'data',{ok:1});assert.deepEqual((await event).data,{ok:1});
 // Add a second path (and a cycle), then remove the first intermediary.
 await a.pair('127.0.0.1',c.self().port,c.self().code);
 await wait(()=>a.online(c.self().id));
 const lost = until(a,"link", e=>e.node===d.self().id&&!e.up);
 b.stop(); await lost;
 await wait(()=>a.online(d.self().id));
 assert.equal((await a.call(d.self().id,'after-failover')).from,a.self().id);
 assert.equal(a.nodes().find(n=>n.id===d.self().id).via.length,1);
 a.forget(d.self().id); await wait(()=>!d.peers().get(a.self().id));
 await assert.rejects(a.call(d.self().id,'forbidden'));
 console.log('relay: four-node TLS pairing, identity, RPC, events, binary and disconnect passed');
 } finally {for(const n of all)n.stop(); fs.rmSync(root,{recursive:true,force:true});}
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
