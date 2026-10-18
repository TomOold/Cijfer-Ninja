import test from 'node:test';
import assert from 'node:assert/strict';
import { laadRR } from './helpers/rekenrace-laden.mjs';
const RR=laadRR("rekenracev2"),W=RR.World,J=RR.Journey;
function memory(seed={}){const map=new Map(Object.entries(seed));return {map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),persistent:()=>true};}
function player(store,name='Lotte'){const p=store.profiles.addPlayer({name,grade:4,hero:'egel'}).player;store.profiles.select(p.id);return p;}
function arrive(run){run.position=W.nodes[J.target(run)].slice();assert.equal(J.arrive(run),true);}
function independentlySolve(q){const m=q.text.match(/^(\d+) ([+−×:]) (\d+) = \?$/);assert.ok(m,q.text);const a=+m[1],b=+m[3];return ({'+':()=>a+b,'−':()=>a-b,'×':()=>a*b,':':()=>a/b})[m[2]]();}

test('Alle negen sommen passen onafhankelijk bij groep en onderwerp, ongeacht landschap',()=>{
 for(const grade of [4,5])for(const focus of RR.Lesson.focuses)for(let seed=0;seed<60;seed++){
  const sums=RR.Lesson.series(grade,focus,[],seed);assert.equal(sums.length,9);
  for(const q of sums){assert.equal(q.answer,independentlySolve(q));assert.ok(RR.Lesson.allowed(q,grade,focus));assert.ok(q.hint);assert.ok(q.explain);assert.ok(Number.isInteger(q.answer)&&q.answer>=0);}
  for(const ch of RR.Chapters)assert.deepEqual(J.create(ch.id,grade,focus,[],seed).questions,sums);
 }
});
test('Tafeloefeningen bereiken alle tafels tot en met tien',()=>{
 const factors=new Set(),divisors=new Set();for(let seed=0;seed<100;seed++){
  for(const q of RR.Lesson.series(4,'times',[],seed)){const parts=q.text.match(/\d+/g).map(Number);factors.add(parts[0]);}
  for(const q of RR.Lesson.series(4,'div',[],seed)){const parts=q.text.match(/\d+/g).map(Number);divisors.add(parts[1]);}
 }
 assert.deepEqual([...factors].sort((a,b)=>a-b),[1,2,3,4,5,6,7,8,9,10]);assert.deepEqual([...divisors].sort((a,b)=>a-b),[1,2,3,4,5,6,7,8,9,10]);
});
test('Herhaling is begrensd en moeilijke oude sommen lekken niet naar een lager niveau',()=>{
 const repeat=['add:199+200','times:12x12','times:7x8','div:24:3'];
 const sums=RR.Lesson.series(4,'mix',repeat,123);assert.equal(sums[2].key,'times:7x8');assert.ok(sums.every(q=>RR.Lesson.allowed(q,4,'mix')));
});
test('Bewegen blijft op de weg, ook bij diagonalen, randen en lange frames',()=>{
 for(let seed=0;seed<20;seed++){
  const rng=RR.Rng.make(seed);let p=W.nodes[0].slice();
  for(let t=0;t<3000;t++){const prev=p.slice();p=W.move(p,[rng()*2-1,rng()*2-1],t%17===0?100:1/60);assert.ok(W.onRoad(p));assert.ok(W.distance(prev,p)<=W.SPEED*.05+.001);}
 }
 assert.deepEqual(W.move(W.nodes[0],[0,0],1),W.nodes[0]);
});
test('Tikroutes blijven op de weg tussen iedere stop en zijweg',()=>{
 for(const from of W.nodes)for(const to of W.nodes){const path=W.path(from,to);let a=from;
  for(const b of path){for(let t=0;t<=1;t+=.02)assert.ok(W.onRoad([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]),`${from} -> ${to}`);a=b;}
  assert.ok(W.distance(a,to)<.01);
 }
});
test('Een hele tocht telt precies negen sommen en eindigt pas terug op het plein',()=>{
 const r=J.create('dorp',4,'mix',[],24);assert.equal(r.phase,'intro');J.next(r);
 for(let stop=0;stop<3;stop++){arrive(r);assert.equal(r.phase,'conversation');J.next(r);
  for(let q=0;q<3;q++){assert.ok(J.answer(r,r.questions[r.index].answer).outcome);assert.equal(r.phase,'explanation');assert.equal(J.answer(r,1),null);J.next(r);}
  assert.equal(r.phase,'stopDone');assert.equal(r.stops,stop+1);J.next(r);
 }
 assert.equal(r.phase,'driving');assert.equal(r.index,9);arrive(r);assert.equal(r.phase,'complete');assert.equal(r.outcomes.length,9);
});
test('Twee foute antwoorden blokkeren nooit en wachten op een bewuste vervolgactie',()=>{
 const r=J.create('haven',5,'div',[],9);J.next(r);arrive(r);J.next(r);const q=r.questions[0];
 assert.deepEqual(J.answer(r,q.answer+100),{hint:true});assert.equal(r.phase,'question');assert.equal(r.attempt,1);
 assert.equal(J.answer(r,q.answer+100).outcome,'miss');assert.equal(r.phase,'explanation');assert.equal(r.index,0);assert.equal(r.position[0],W.nodes[2][0]);J.next(r);assert.equal(r.index,1);
});
test('Migratie bewaart spelers, instellingen, stempels en het oorspronkelijke opslagbestand',()=>{
 const mem=memory(),old=RR.Store.create(mem,()=>1234);const p=old.addPlayer({name:'Eva',grade:5,hero:'uil'}).player;old.select(p.id);old.recordAnswer('times:7x8','times','miss',{grade:5,level:1});old.stamp(1,2);old.setSetting('music',true);
 const original=mem.getItem(RR.Store.KEY),fresh=RR.AdventureStore.create(mem,()=>5678);assert.equal(fresh.current().name,'Eva');assert.equal(fresh.profiles.settings().music,true);assert.equal(fresh.profiles.stamps()[1].place,2);assert.equal(fresh.profiles.kindStats().find(s=>s.kind==='times').total,1);assert.deepEqual(fresh.completed(),{});
 fresh.setPref('car','red');assert.equal(mem.getItem(RR.Store.KEY),original);assert.equal(JSON.parse(mem.getItem('rekenrace:v2')).v,2);
});
test('Antwoord en fase worden atomair opgeslagen: herladen telt niet dubbel',()=>{
 const mem=memory(),s=RR.AdventureStore.create(mem),p=player(s),r=J.create('dorp',4,'add',[],11);J.next(r);arrive(r);J.next(r);s.saveRun(r);
 s.answer(r,String(r.questions[0].answer));let fresh=RR.AdventureStore.create(mem);fresh.profiles.select(p.id);let loaded=fresh.loadRun();assert.equal(loaded.phase,'explanation');assert.equal(loaded.index,0);assert.equal(fresh.answer(loaded,'1'),null);
 assert.equal(fresh.profiles.kindStats().find(s=>s.kind==='add').total,1);J.next(loaded);fresh.saveRun(loaded);fresh=RR.AdventureStore.create(mem);fresh.profiles.select(p.id);loaded=fresh.loadRun();assert.equal(loaded.index,1);assert.equal(loaded.phase,'question');assert.deepEqual(loaded.questions,r.questions);
});
test('Een onderbroken tweede poging en invoer blijven bewaard',()=>{
 const mem=memory(),s=RR.AdventureStore.create(mem);player(s);const r=J.create('polder',4,'sub',[],66);J.next(r);arrive(r);J.next(r);s.answer(r,String(r.questions[0].answer+100));r.input='1';s.saveRun(r);
 const restored=RR.AdventureStore.create(mem).loadRun();assert.equal(restored.attempt,1);assert.equal(restored.input,'1');assert.equal(restored.phase,'question');
});
test('Spelers hebben elk een eigen tocht en autokeuze',()=>{
 const mem=memory(),s=RR.AdventureStore.create(mem),a=player(s,'A'),r=J.create('dorp',4,'add',[],1);s.saveRun(r);s.setPref('car','gold');const b=player(s,'B');assert.equal(s.loadRun(),null);assert.equal(s.pref().car,'teal');s.profiles.select(a.id);assert.equal(s.loadRun().chapter,'dorp');assert.equal(s.pref().car,'gold');s.remove(b.id);assert.equal(s.profiles.players().length,1);
});
test('Corrupte of toekomstige V2-opslag wordt niet overschreven',()=>{
 for(const raw of ['{broken',JSON.stringify({v:99}),JSON.stringify({v:2,profiles:{v:99},journeys:{}})]){const mem=memory({'rekenrace:v2':raw}),s=RR.AdventureStore.create(mem);player(s);s.saveRun(J.create('dorp',4,'add',[],1));assert.equal(mem.getItem('rekenrace:v2'),raw);assert.equal(s.status().persistent,false);}
});
test('Opslagfouten laten doorspelen en voortgang in geheugen toe',()=>{
 const bad={getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('quota')}};const s=RR.AdventureStore.create(bad);player(s);const r=J.create('dorp',4,'add',[],1);s.saveRun(r);assert.equal(s.loadRun().chapter,'dorp');assert.equal(s.status().persistent,false);
});
test('Een tweede tab kan nieuwere voortgang niet overschrijven',()=>{
 const mem=memory(),a=RR.AdventureStore.create(mem);player(a);a.setPref('car','red');const b=RR.AdventureStore.create(mem);b.setPref('car','gold');const latest=mem.getItem('rekenrace:v2');a.setPref('car','teal');assert.equal(mem.getItem('rekenrace:v2'),latest);assert.equal(a.status().persistent,false);
});
test('Ongeldige of inconsistente tochtdata wordt geweigerd',()=>{
 const r=J.create('dorp',4,'mix',[],42);assert.ok(J.restore(r));for(const patch of [{index:10},{stops:3},{phase:'question',index:9},{grade:99},{questions:[{}]},{outcomes:['first']}])assert.equal(J.restore({...r,...patch}),null);
});

test('Oorspronkelijke race en V2 kunnen op dezelfde oorsprong onafhankelijk bewaren',()=>{
 const original=laadRR(),mem=memory(),old=original.Store.create(mem);
 const p=old.addPlayer({name:'Samen',hero:'egel',grade:4}).player;old.select(p.id);
 const raw=mem.getItem(original.Store.KEY),adventure=RR.AdventureStore.create(mem);
 assert.equal(adventure.current().name,'Samen');adventure.setPref('car','gold');
 adventure.saveRun(J.create('dorp',4,'mix',[],21));
 assert.equal(mem.getItem(original.Store.KEY),raw);
 const v2=mem.getItem(RR.AdventureStore.KEY);old.stamp(1,2);old.recordAnswer('times:7x8','times','first');
 assert.equal(mem.getItem(RR.AdventureStore.KEY),v2);
 assert.equal(original.Store.create(mem).stamps()[1].place,2);
 const restored=RR.AdventureStore.create(mem);assert.deepEqual(restored.profiles.stamps(),{});assert.equal(restored.loadRun().chapter,'dorp');
});
