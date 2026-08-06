const fs=require('fs');const path=require('path');
const src=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
const m=src.match(/\/\/ ===PURE===([\s\S]*?)\/\/ ===ENDPURE===/);
if(!m){ console.error('PURE block missing'); process.exit(1); }
eval(m[1].replace(/\bconst\b/g,'var'));   // let const-declared data leak into this scope

let fails=0;
const ck=(c,msg,x)=>{ if(!c){ fails++; console.log('FAIL:',msg, x||''); } };

// ---- generators still healthy ----
for(const [name,gen] of Object.entries({genOps,genMachine,genEquation,genFraction,genFactor,genShape,genMix})){
  for(let tier=1;tier<=4;tier++) for(let i=0;i<300;i++){
    const q=gen(tier);
    ck(q.choices.length===4 && q.choices.filter(c=>c.ok).length===1, name+' t'+tier+' structure');
  }
}


// ---- tier-4 (expert) answer correctness ----
function solveEq(disp,x){
  let e=disp.replace(/<[^>]+>/g,'').replace(/·/g,'*').replace(/−/g,'-').replace(/÷/g,'/').replace(/\s+/g,'');
  e=e.replace(/(\d)x/g,'$1*x').replace(/(\d)\(/g,'$1*(').replace(/x/g,'('+x+')');
  const sides=e.split('=');
  return Math.abs(Function('return ('+sides[0]+')')()-Function('return ('+sides[1]+')')())<1e-9;
}
for(let i=0;i<800;i++){
  const q=genEquation(4); const x=Number(q.choices.find(c=>c.ok).h);
  const disp=(q.qHTML.match(/qBig">([^<]*(?:<i>[^<]*<\/i>[^<]*)*)</)||[])[0];
  const m=q.qHTML.replace(/<div class="qSub">.*/,'').match(/qBig">(.*?)<\/div>/s);
  ck(m && solveEq(m[1],x), 'eq4 solves', (m&&m[1])+' x='+x);
}
for(let i=0;i<800;i++){
  const q=genMachine(4); const x=Number(q.choices.find(c=>c.ok).h);
  const t=q.qHTML.replace(/<[^>]+>/g,'');
  const mm=t.match(/multiplied my number by (\d+), then added (\d+), then divided by (\d+), and got (\d+)/);
  ck(mm && ((x*+mm[1]+ +mm[2])/+mm[3]===+mm[4]), 'machine4 solves', t.slice(0,80)+' x='+x);
}
for(let i=0;i<600;i++){
  const q=genFactor(4); const a=Number(q.choices.find(c=>c.ok).h);
  const mm=q.qHTML.match(/LCM\((\d+), (\d+), (\d+)\)/);
  ck(mm && a===lcm(lcm(+mm[1],+mm[2]),+mm[3]), 'lcm3 correct', JSON.stringify(mm));
}


// ---- new-topic generator correctness ----
for(let i=0;i<600;i++){ for(const tt of [1,2,3,4]){
  const q=genMultiply(tt); const m=q.qHTML.match(/(\d+) × (\d+)/); const a=Number(q.choices.find(c=>c.ok).h);
  ck(m && a===(+m[1])*(+m[2]),'multiply correct', (m&&m[0])+' got '+a);
}}
for(let i=0;i<600;i++){ for(const tt of [1,2,3]){
  const q=genAngle(tt); const ans=Number(q.choices.find(c=>c.ok).h);
  ck(ans>0 && ans<360 && Number.isInteger(ans),'angle plausible', String(ans));
}}
for(let i=0;i<400;i++){
  const q=genCompare(1); const ok=q.choices.find(c=>c.ok).h;
  ck(['&lt;','=','&gt;'].includes(ok),'compare has a symbol answer', ok);
  ck(q.choices.filter(c=>c.ok).length===1,'compare one correct');
}

// ---- workbook: every single problem ----
let total=0;
WB.forEach((lvl,li)=>{
  lvl.qs.forEach((t,qi)=>{
    total++;
    const tag=lvl.n+' q'+(qi+1);
    const type=t[0];

    // answer integrity: recompute from the check expression
    if(type==='e'){
      const v=evalExpr(t[2]);
      ck(Number.isFinite(v), tag+' eval finite', t[2]);
      ck(Number.isInteger(v) && v>=0, tag+' integer answer', t[2]+' = '+v);
    }
    if((type==='b'||type==='s') && t[3]){
      const v=evalExpr(t[3]);
      ck(Math.abs(v-t[2])<1e-9, tag+' stated answer matches check expr', t[3]+' = '+v+' but stated '+t[2]);
    }
    // extra independent check for GCF/LCM displays
    if(type==='b'){
      let mm;
      if(mm=String(t[1]).match(/GCF\((\d+),\s*(\d+)\)/)) ck(gcd(+mm[1],+mm[2])===t[2], tag+' GCF value', t[1]+' stated '+t[2]);
      if(mm=String(t[1]).match(/LCM\((\d+),\s*(\d+)\)/)) ck(lcm(+mm[1],+mm[2])===t[2], tag+' LCM value', t[1]+' stated '+t[2]);
    }
    if(type==='c'){
      ck(Array.isArray(t[2]) && t[2].length>=2 && t[3]>=0 && t[3]<t[2].length, tag+' c-structure');
      ck(new Set(t[2]).size===t[2].length, tag+' c-labels unique', JSON.stringify(t[2]));
    }

    // build integrity: choices well-formed, exactly one correct, correct label = answer
    for(let r=0;r<30;r++){
      const q=wbBuild(t);
      ck(q.choices.length>=2, tag+' built choices');
      ck(q.choices.filter(c=>c.ok).length===1, tag+' one correct');
      ck(new Set(q.choices.map(c=>c.h)).size===q.choices.length, tag+' unique labels', JSON.stringify(q.choices.map(c=>c.h)));
      ck(!/NaN|undefined|Infinity/.test(q.qHTML+q.choices.map(c=>c.h).join()), tag+' no NaN');
      if(type==='e'){ ck(q.choices.find(c=>c.ok).h===String(evalExpr(t[2])), tag+' correct label matches'); }
      if(type==='b'||type==='s'){ ck(q.choices.find(c=>c.ok).h===String(t[2]), tag+' correct label matches'); }
      ck(GENS[q.topic]!==undefined, tag+' topic valid', q.topic);
      ck(typeof q.tip==='string' && q.tip.length>0, tag+' has tip');
    }
  });
});
console.log('workbook problems verified:', total);
// BOOKS must cover every lesson exactly once
const covered=[].concat(...BOOKS.map(b=>b.lessons));
ck(covered.length===WB.length && new Set(covered).size===WB.length && Math.max(...covered)===WB.length-1, 'BOOKS cover all lessons exactly once', JSON.stringify(covered));
BOOKS.forEach((b,i)=>{ ck(bookQs(i).length===b.lessons.reduce((a,li)=>a+WB[li].qs.length,0), 'bookQs count '+i); ck(bookTopics(i).length>0,'bookTopics '+i); });
const ids=new Set(); let dup=false;
BOOKS.forEach((b,i)=>bookQs(i).forEach(o=>{ if(ids.has(o.id)) dup=true; ids.add(o.id); }));
ck(!dup && ids.size===total, 'workbook problem ids unique', ids.size+' vs '+total);
WB.forEach((l,i)=>{ const tps=wbTopics(i); ck(tps.length>0, l.n+' topics'); });
console.log(fails===0?'ALL WORKBOOK TESTS PASSED':fails+' FAILURES');
process.exit(fails?1:0);
