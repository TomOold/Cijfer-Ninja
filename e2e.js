const { chromium }=require('playwright');
const http=require('http'); const fs=require('fs'); const path=require('path');
const { webcrypto }=require('crypto'); if(!global.crypto) global.crypto=webcrypto;
const fn=require('./functions/api/player.js');
const KV={ store:new Map(), async get(k){ return this.store.has(k)?this.store.get(k):null; }, async put(k,v){ this.store.set(k,v); } };
const MIME={'.html':'text/html','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.gif':'image/gif','.txt':'text/plain'};
http.createServer(async (req,res)=>{
  const url=req.url.split('?')[0];
  if(url.startsWith('/api/player') && req.method==='POST'){
    let body=''; req.on('data',c=>body+=c); req.on('end', async ()=>{
      const r=await fn.onRequestPost({ request:{json:async()=>JSON.parse(body||'{}')}, env:{NINJA_KV:KV} });
      res.writeHead(r.status,{'content-type':'application/json'}); res.end(await r.text());
    }); return;
  }
  // deterministic characters.json for tests (independent of the live file)
  if(url==='/characters.json'){ res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({costPerCharacter:200, characters:['Character1.jpg','Character2.jpg','Character3.jpg']})); return; }
  // serve real static files (characters.json, images/*)
  let rel=url==='/'?'/index.html':decodeURIComponent(url);
  const fp=path.join(__dirname, rel);
  if(fp.startsWith(__dirname) && fs.existsSync(fp) && fs.statSync(fp).isFile()){
    res.writeHead(200,{'content-type':MIME[path.extname(fp)]||'application/octet-stream'});
    res.end(fs.readFileSync(fp)); return;
  }
  res.writeHead(200,{'content-type':'text/html'});
  res.end(fs.readFileSync(path.join(__dirname,'index.html')));
}).listen(8099);

const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  await wait(300);
  const browser=await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  let fails=0;
  const ck=(c,m,x)=>{ if(!c){ fails++; console.log('FAIL:',m,x||''); } };
  const ctx=await browser.newContext({ viewport:{width:480,height:900} });
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push('PAGEERR '+e.message));
  await p.goto('http://localhost:8099/'); await wait(500);

  await p.fill('#nameInp','Nova'); await p.fill('#pinInp','2017');
  await p.click('#btnLogin'); await wait(2300);

  // characters.json loaded -> 3 image skins available in shop
  const skins=await p.evaluate(()=>({img:IMG_SKINS.length, cost:CHAR_COST, first:IMG_SKINS[0]&&IMG_SKINS[0].name}));
  ck(skins.img===3 && skins.cost===200 && skins.first==='Character1','characters.json loaded', JSON.stringify(skins));

  // workbooks are all unlocked, none locked; challenge hidden until books done
  const pathState=await p.evaluate(()=>({n:document.querySelectorAll('.lvl').length, locked:document.querySelectorAll('.lvl.locked').length, next:document.querySelectorAll('.lvl.next').length, open:document.querySelectorAll('.lvl.open').length}));
  ck(pathState.n===3 && pathState.locked===0 && pathState.next===1 && pathState.open===2,'all 3 workbooks unlocked, no locks', JSON.stringify(pathState));

  // ---- Workbook level 1: mastery + solved tracking + hint ----
  await p.click('.lvl.next',{force:true}); await wait(2000);
  await p.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); }); await wait(200);
  const dj=async(pg)=>{ await pg.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); }); };
  const clickRight=async()=>{ await dj(p); const i=await p.evaluate(()=>S.current.choices.findIndex(c=>c.ok)); await p.click('.ans:nth-child('+(i+1)+')'); };
  const clickWrong=async()=>{ await dj(p); const i=await p.evaluate(()=>S.current.choices.findIndex((c,j)=>!c.ok && !document.querySelectorAll('.ans')[j].disabled)); await p.click('.ans:nth-child('+(i+1)+')'); };

  const t1=await p.evaluate(()=>S.current.topic);
  await clickRight(); await wait(1250);
  const mast1=await p.evaluate(()=>({m:S.progress.mastery, solved:S.progress.solved}));
  ck(mast1.m[t1]===6,'mastery +6 on clean solve', JSON.stringify(mast1.m));
  ck(mast1.solved['W1L0Q0']===1,'solved id recorded', JSON.stringify(mast1.solved));
  // first solve of the session grants a +10 welcome bonus
  await wait(700);
  const firstBonus=await p.evaluate(()=>({flag:S.sessionFirstDone, coins:S.coins, hud:$('hudCoins').textContent}));
  ck(firstBonus.flag===true && firstBonus.coins>=11,'first problem of session grants +10 bonus', JSON.stringify(firstBonus));
  ck(String(firstBonus.coins)===firstBonus.hud,'HUD coin counter reflects coins', JSON.stringify(firstBonus));

  // hint on q2: mastery should NOT rise, score should not rise
  const t2=await p.evaluate(()=>S.current.topic);
  const before=await p.evaluate(()=>({m:S.progress.mastery[S.current.topic]||0, score:S.score}));
  await p.click('#btnHint'); await wait(300);
  ck(await p.evaluate(()=>S.hintUsed===true && $('tipbar').classList.contains('on')),'hint reveals tip');
  await clickRight(); await wait(1250);
  const after=await p.evaluate((tt)=>({m:S.progress.mastery[tt]||0, score:S.score}), t2);
  ck(after.m===before.m,'hint => no mastery gain', 'before '+before.m+' after '+after.m+' topic '+t2);
  // (score may differ only by 0; check no increase)
  ck(after.score===before.score,'hint => score did not increase', String(after.score-before.score));

  // wrong answer lowers mastery a little
  const t3=await p.evaluate(()=>S.current.topic);
  const m3b=await p.evaluate(()=>S.progress.mastery[S.current.topic]||0);
  await clickWrong(); await wait(700);
  const m3a=await p.evaluate((tt)=>S.progress.mastery[tt]||0, t3);
  ck(m3a===Math.max(0,m3b-2),'wrong => mastery -2', 'before '+m3b+' after '+m3a);
  await clickRight(); await wait(1300);

  // leave mid-level (story exit shows a summary), then go home and re-enter -> resumes
  await p.click('#btnBack'); await wait(700);
  ck(await p.evaluate(()=>$('results').classList.contains('on')),'story exit shows summary');
  await p.click('#btnHome'); await wait(600);
  const posBefore=await p.evaluate(()=>Object.keys(S.progress.solved).length);
  await p.click('.lvl.next',{force:true}); await wait(2000);
  await p.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); }); await wait(200);
  const resume=await p.evaluate(()=>({start:S.levelStart, pos:S.levelPos}));
  ck(resume.start>0 && resume.pos===resume.start,'level resumes past solved problems', JSON.stringify(resume)+' solvedCount '+posBefore);
  await p.screenshot({path:'x1-resume.png'});

  // ---- dramatic boss: finish the level ----
  for(let k=0;k<60;k++){
    await p.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); });
    const st=await p.evaluate(()=>({pos:S.levelPos,len:S.levelLen,boss:S.bossMode,busy:S.answered||$('overlay').classList.contains('on')||$('tutor').classList.contains('on')}));
    if(st.pos>=st.len) break;
    if(st.busy){ await wait(400); continue; }
    await clickRight(); await wait(1050);
  }
  await wait(600);
  // during the boss warning the danger element flashes
  const dangerSeen=await p.evaluate(()=>$('danger').classList.contains('flash'));
  await p.screenshot({path:'x2-bosswarn.png'});
  ck(dangerSeen===true,'dramatic danger flash on boss', String(dangerSeen));
  const bossWarn=await p.evaluate(()=>$('overlay').textContent);
  ck(/WARNING|serious|careful/i.test(bossWarn),'boss warning text shown', bossWarn.slice(0,60));
  // beat the boss
  for(let k=0;k<14;k++){
    await p.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); });
    const done=await p.evaluate(()=>$('results').classList.contains('on'));
    if(done) break;
    const busy=await p.evaluate(()=>S.answered||$('overlay').classList.contains('on')||!$('game').classList.contains('on'));
    if(busy){ await wait(600); continue; }
    await clickRight(); await wait(1100);
  }
  await wait(3500);
  ck(await p.evaluate(()=>!!S.progress.story['B1']),'level 1 completed & recorded');

  await p.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); });
  // ---- shop: buy an image character for 200 ----
  await p.click('#btnHome'); await wait(400);
  await p.evaluate(()=>{ S.coins=500; renderHome(); });
  await p.click('#btnShop'); await wait(400);
  await p.screenshot({path:'x3-shop.png'});
  const imgItems=await p.evaluate(()=>[...document.querySelectorAll('.sItem .skinImg')].length);
  ck(imgItems===3,'shop shows 3 image characters', String(imgItems));
  // click the first image character (index 8 = after 8 emoji)
  await p.evaluate(()=>{ const items=document.querySelectorAll('.sItem'); items[8].click(); });
  await wait(400);
  const bought=await p.evaluate(()=>({owned:S.owned.includes('img:Character1.jpg'), skin:S.skin, coins:S.coins}));
  ck(bought.owned && bought.skin==='img:Character1.jpg' && bought.coins===300,'bought character for 200', JSON.stringify(bought));
  // shop categories exist
  ck(await p.evaluate(()=>document.querySelectorAll('.shopTab').length===3),'shop has 3 category tabs');

  // Power-Ups tab: buy a free hint + a 50/50 + a coin boost
  await p.evaluate(()=>{ S.coins=1000; renderShop('powerups'); });
  await wait(200);
  await p.screenshot({path:'x5-powerups.png'});
  const puCount=await p.evaluate(()=>document.querySelectorAll('#shopGrid .sItem').length);
  ck(puCount===4,'powerups tab shows 4 items', String(puCount));
  await p.evaluate(()=>{ document.querySelectorAll('#shopGrid .sItem')[0].click(); }); await wait(150); // freehint x5
  await p.evaluate(()=>{ document.querySelectorAll('#shopGrid .sItem')[1].click(); }); await wait(150); // fiftyfifty x5
  await p.evaluate(()=>{ document.querySelectorAll('#shopGrid .sItem')[2].click(); }); await wait(150); // coinsx2 x3
  const inv=await p.evaluate(()=>S.inventory);
  ck(inv.freehint===5 && inv.fiftyfifty===5 && inv.coinsx2===3,'bought 3 powerup bundles (5/5/3 charges)', JSON.stringify(inv));

  // Effects tab: buy the glow aura and equip it
  await p.evaluate(()=>renderShop('effects')); await wait(150);
  await p.evaluate(()=>{ const items=[...document.querySelectorAll('#shopGrid .sItem')]; items[1].click(); }); await wait(200); // glow
  ck(await p.evaluate(()=>S.effect==='glow' && S.ownedEffects.includes('glow')),'bought+equipped glow aura');
  ck(await p.evaluate(()=>$('homeAvatar')&&true), 'home avatar exists');

  await p.click('#btnShopBack'); await wait(300);
  ck(await p.evaluate(()=>!!document.querySelector('#homeAvatar .skinImg')),'home avatar is the image');
  ck(await p.evaluate(()=>$('homeAvatar').className.indexOf('fx-glow')>=0),'aura applied to home avatar');
  await p.screenshot({path:'x4-home-img.png'});

  // ---- start a run: coin boost auto-consumes, free hint has no penalty, 50/50 removes two ----
  await p.evaluate(()=>{ startRun(WORLDS[0]); });
  await wait(600);
  ck(await p.evaluate(()=>S.coinMult===2 && S.inventory.coinsx2===2 && $('coinBoost').classList.contains('on')),'2x coin boost consumed at run start (3->2 charges)');
  // free hint: no mastery penalty
  const fhTopic=await p.evaluate(()=>S.current.topic);
  const fhBefore=await p.evaluate(()=>S.progress.mastery[S.current.topic]||0);
  await p.click('#btnHint'); await wait(200);
  ck(await p.evaluate(()=>S.hintFree===true && S.inventory.freehint===4),'free hint consumed, marked free (5->4 charges)');
  { const i=await p.evaluate(()=>S.current.choices.findIndex(c=>c.ok)); await p.click('.ans:nth-child('+(i+1)+')'); }
  await wait(1200);
  const fhAfter=await p.evaluate((tt)=>S.progress.mastery[tt]||0, fhTopic);
  ck(fhAfter===fhBefore+6,'free hint => full mastery gain (no penalty)', 'before '+fhBefore+' after '+fhAfter);
  // 50/50 removes two wrong options
  await p.evaluate(()=>{ const t=$('powerTray').querySelector('.powBtn'); if(t) t.click(); }); await wait(200);
  const disabled=await p.evaluate(()=>[...document.querySelectorAll('.ans')].filter(b=>b.disabled).length);
  ck(disabled===2 && await p.evaluate(()=>S.inventory.fiftyfifty===4),'50/50 removed two answers (5->4 charges)', String(disabled));
  await p.screenshot({path:'x6-fifty.png'});
  await p.evaluate(()=>{ $('btnBack').click(); }); await wait(400);
  await p.evaluate(()=>{ if($('results').classList.contains('on')) $('btnHome').click(); }); await wait(400);
  await wait(1500);

  // ---- parent view: skill levels + strengths/weaknesses ----
  const ctx2=await browser.newContext({ viewport:{width:480,height:1200} });
  const p2=await ctx2.newPage();
  p2.on('pageerror',e=>errs.push('PAGEERR2 '+e.message));
  await p2.goto('http://localhost:8099/'); await wait(400);
  await p2.click('#btnParentMode'); await wait(200);
  await p2.fill('#nameInp','Nova'); await p2.fill('#pinInp','2017');
  await p2.click('#btnLogin'); await wait(1000);
  const dash=await p2.evaluate(()=>$('parentBody').textContent);
  ck(/Belt progress/.test(dash) && /(White|Yellow|Orange|Green|Blue|Black) Belt/.test(dash),'parent belt panel', dash.slice(0,140));
  ck(/Workbook/.test(dash),'parent workbook card present');
  await p2.screenshot({path:'x5-parent.png', fullPage:true});

  // ---- tutorial comprehension gate (fresh context = clean state) ----
  const ctx3=await browser.newContext({ viewport:{width:480,height:900} });
  const p3=await ctx3.newPage();
  p3.on('pageerror',e=>errs.push('PAGEERR3 '+e.message));
  await p3.goto('http://localhost:8099/'); await wait(400);
  await p3.fill('#nameInp','Tux'); await p3.fill('#pinInp','3333'); await p3.click('#btnLogin'); await wait(1600);
  await p3.evaluate(()=>startLevel(0)); await wait(300);
  await p3.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); });
  const cw3=async()=>{ await p3.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); }); const i=await p3.evaluate(()=>[...document.querySelectorAll('.ans')].findIndex(b=>!b.disabled && !S.current.choices[[...document.querySelectorAll('.ans')].indexOf(b)].ok)); await p3.click('.ans:nth-child('+(i+1)+')'); };
  let fresh3=false;
  for(let k=0;k<30;k++){ if(await p3.evaluate(()=>S.current&&!S.answered&&!$('overlay').classList.contains('on')&&document.querySelectorAll('.ans:not([disabled])').length>=3)){ fresh3=true; break; } await wait(300); }
  ck(fresh3,'fresh question ready in isolated level');
  await cw3(); await wait(600);
  await cw3(); await wait(1600);
  ck(await p3.evaluate(()=>$('tutor').classList.contains('on')),'tutorial appears after 2 wrongs');
  ck(await p3.evaluate(()=>$('btnTutorGo').style.display==='none'),'continue LOCKED before comprehension check');
  await p3.screenshot({path:'x7-tutorcheck.png'});
  await p3.evaluate(()=>{ const w=[...document.querySelectorAll('#checkChoices .ckBtn')].find(b=>b.dataset.ok==='0'); if(w) w.click(); }); await wait(300);
  ck(await p3.evaluate(()=>$('btnTutorGo').style.display==='none'),'still LOCKED after a wrong check answer');
  await p3.evaluate(()=>{ const c=[...document.querySelectorAll('#checkChoices .ckBtn')].find(b=>b.dataset.ok==='1'); c.click(); }); await wait(300);
  ck(await p3.evaluate(()=>$('btnTutorGo').style.display!=='none'),'continue UNLOCKS after correct check');

  // ---- "I need help" flag: hidden until he tries, records for parent, advances ----
  const ctx4=await browser.newContext({ viewport:{width:480,height:900} });
  const p4=await ctx4.newPage();
  p4.on('pageerror',e=>errs.push('PAGEERR4 '+e.message));
  await p4.goto('http://localhost:8099/'); await wait(400);
  await p4.fill('#nameInp','Rex'); await p4.fill('#pinInp','4444'); await p4.click('#btnLogin'); await wait(1700);
  await p4.evaluate(()=>startLevel(0)); await wait(400);
  await p4.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); }); await wait(200);
  const cw4=async()=>{ await p4.evaluate(()=>{ if($('journey').classList.contains('on')) dismissJourney(); }); const i=await p4.evaluate(()=>[...document.querySelectorAll('.ans')].findIndex(b=>!b.disabled && !S.current.choices[[...document.querySelectorAll('.ans')].indexOf(b)].ok)); await p4.click('.ans:nth-child('+(i+1)+')'); };
  // need-help hidden before any attempt
  ck(await p4.evaluate(()=>$('btnNeedHelp').classList.contains('hidden')),'need-help hidden before trying');
  await cw4(); await wait(600);
  ck(await p4.evaluate(()=>!$('btnNeedHelp').classList.contains('hidden')),'need-help appears after a wrong try');
  await p4.screenshot({path:'x8-needhelp.png'});
  const posB=await p4.evaluate(()=>S.levelPos);
  const nhBefore=await p4.evaluate(()=>({m:S.progress.mastery[S.current.topic]||0, streak:(S.streak=5)}));
  await p4.click('#btnNeedHelp'); await wait(400);
  const flagged=await p4.evaluate(()=>({n:S.progress.needHelp.length, adv:S.levelPos, first:S.progress.needHelp[0], streak:S.streak}));
  ck(flagged.n===1 && flagged.first.topic && flagged.first.q && flagged.adv===posB+1,'flag recorded + advances', JSON.stringify(flagged));
  ck(flagged.streak===5,'need-help does NOT reset streak (no penalty)', 'streak='+flagged.streak);
  // rich capture: the wrong answer he tried, the tip, full question, correct answer, level+question
  const rec=await p4.evaluate(()=>S.progress.needHelp[0]);
  ck(Array.isArray(rec.picks) && rec.picks.length>=1,'flag captures the answer(s) he tried', JSON.stringify(rec.picks));
  ck(typeof rec.qHTML==='string' && rec.qHTML.length>0,'flag captures full question html');
  ck(typeof rec.correct==='string' && rec.correct.length>0,'flag captures the correct answer', rec.correct);
  ck(typeof rec.qNum==='number' && rec.qNum>0,'flag captures which question number', String(rec.qNum));

  // ---- expert difficulty: mastered skill -> tier 4 in the arena ----
  await p4.evaluate(()=>{ S.progress.mastery={ops:90}; show('home'); startRun(WORLDS[0]); }); // Blast Ops, Expert
  await wait(700);
  ck(await p4.evaluate(()=>tierNow()===4),'expert skill drives tier 4 in arena', String(await p4.evaluate(()=>tierNow())));
  ck(await p4.evaluate(()=>/Expert|²|³/.test($('qcard').innerHTML) || S.current.topic==='ops'),'expert question rendered');
  // parent sees the flagged question
  const p5=await (await browser.newContext({viewport:{width:480,height:1300}})).newPage();
  await p5.goto('http://localhost:8099/'); await wait(400);
  await p5.click('#btnParentMode'); await wait(200);
  await p5.fill('#nameInp','Rex'); await p5.fill('#pinInp','4444'); await p5.click('#btnLogin'); await wait(900);
  const dash4=await p5.evaluate(()=>$('parentBody').textContent);
  ck(/Wants help with/.test(dash4),'parent sees need-help list', dash4.slice(0,80));
  ck(/Where he needs help vs where he's strong/.test(dash4),'parent sees topic snapshot');
  // expand the first flagged item -> detail with his attempt + correct answer renders
  ck(await p5.evaluate(()=>document.querySelectorAll('#parentBody .helpItem').length>0),'flagged items are expandable rows');
  await p5.evaluate(()=>document.querySelector('#parentBody .helpItem').click()); await wait(200);
  ck(await p5.evaluate(()=>{ const it=document.querySelector('#parentBody .helpItem'); return it.classList.contains('open') && it.querySelector('.pick.good')!==null && it.querySelector('.pick.bad')!==null; }),'expanded flag shows his try + correct answer');
  await p5.screenshot({path:'x9-parent-help.png', fullPage:true});

  // ---- monsters & boss battle ----
  const ctx6=await browser.newContext({ viewport:{width:480,height:900} });
  const p6=await ctx6.newPage();
  p6.on('pageerror',e=>errs.push('PAGEERR6 '+e.message));
  await p6.goto('http://localhost:8099/'); await wait(400);
  await p6.fill('#nameInp','Zap'); await p6.fill('#pinInp','5555'); await p6.click('#btnLogin'); await wait(1700);
  await p6.evaluate(()=>startRun(WORLDS[0])); await wait(700);
  const cr6=async()=>{ const i=await p6.evaluate(()=>S.current.choices.findIndex(c=>c.ok)); await p6.click('.ans:nth-child('+(i+1)+')'); };
  ck(await p6.evaluate(()=>$('battleBar').classList.contains('on') && S.foeType==='monster' && S.foeHP===3),'monster spawns at full HP');
  await cr6(); await wait(1150);
  ck(await p6.evaluate(()=>S.foeHP===2),'correct answer damages the monster', String(await p6.evaluate(()=>S.foeHP)));
  await p6.screenshot({path:'xA-monster.png'});
  // kill it: two more correct -> a new monster spawns
  await cr6(); await wait(1150); await cr6(); await wait(1200);
  ck(await p6.evaluate(()=>S.monsterKills>=1 && S.foeHP===3),'monster dies and next one spawns', JSON.stringify(await p6.evaluate(()=>({k:S.monsterKills,hp:S.foeHP}))));

  // boss heals on a wrong answer
  await p6.evaluate(()=>{ S.correctCount=S.nextBossAt; nextQuestion(); }); await wait(3000); // trigger boss intro
  ck(await p6.evaluate(()=>S.bossMode===true && S.foeType==='boss'),'boss battle begins', JSON.stringify(await p6.evaluate(()=>({b:S.bossMode,t:S.foeType}))));
  const bhp=await p6.evaluate(()=>S.foeHP);
  const wi=await p6.evaluate(()=>S.current.choices.findIndex(c=>!c.ok));
  await p6.click('.ans:nth-child('+(wi+1)+')'); await wait(500);
  ck(await p6.evaluate(()=>S.foeHP)>bhp,'wrong answer HEALS the boss', 'was '+bhp+' now '+await p6.evaluate(()=>S.foeHP));
  ck(await p6.evaluate(()=>$('arenaTint').classList.contains('on')),'boss fight tints the arena');
  await p6.screenshot({path:'xB-bossheal.png'});

  // ---- battle immersion: shield, charge telegraph, charged hit, rage ----
  const ctx6b=await browser.newContext({ viewport:{width:480,height:900} });
  const p6b=await ctx6b.newPage();
  p6b.on('pageerror',e=>errs.push('PAGEERR6b '+e.message));
  await p6b.goto('http://localhost:8099/'); await wait(400);
  await p6b.fill('#nameInp','Blip'); await p6b.fill('#pinInp','6161'); await p6b.click('#btnLogin'); await wait(1700);
  await p6b.evaluate(()=>startRun(WORLDS[0])); await wait(700);
  ck(await p6b.evaluate(()=>S.shield===3 && document.querySelectorAll('#shieldHearts .shHeart').length===3),'player starts with a 3-heart shield');
  // force the foe to a charged state and confirm it telegraphs
  await p6b.evaluate(()=>{ S.foeFresh=false; S.foeCharge=99; foeChargeTick(); });
  ck(await p6b.evaluate(()=>S.foeCharged && $('battleBar').classList.contains('charged') && $('foeTele').classList.contains('on')),'foe telegraphs its charged attack');
  await p6b.screenshot({path:'xD-charged.png'});
  // a charged hit cracks a shield heart but touches NOTHING else
  const preHit=await p6b.evaluate(()=>({score:S.score, streak:(S.streak=4), m:JSON.stringify(S.progress.mastery)}));
  await p6b.evaluate(()=>foeAttack()); await wait(650);
  ck(await p6b.evaluate(()=>S.shield===2),'charged hit cracks exactly one shield heart', 'shield='+await p6b.evaluate(()=>S.shield));
  ck(await p6b.evaluate(()=>S.score===0 && S.streak===4 && !$('battleBar').classList.contains('charged')),'shield hit never touches score/streak, and clears the charge');
  // rage state kicks in when the foe is nearly beaten
  await p6b.evaluate(()=>{ S.foeHP=1; renderFoe(); });
  ck(await p6b.evaluate(()=>$('foeSprite').classList.contains('rage') && $('battleBar').classList.contains('rage')),'low-HP foe enters rage state');
  // beating a foe patches one shield heart back
  await p6b.evaluate(()=>{ S.shield=1; foeDie(()=>{}); });
  ck(await p6b.evaluate(()=>S.shield===2),'defeating a foe restores one shield heart');

  // ---- Free Play power-up: buys charges, home button appears, minigame runs ----
  const ctx7=await browser.newContext({ viewport:{width:480,height:1000} });
  const p7=await ctx7.newPage();
  p7.on('pageerror',e=>errs.push('PAGEERR7 '+e.message));
  await p7.goto('http://localhost:8099/'); await wait(400);
  await p7.fill('#nameInp','Dot'); await p7.fill('#pinInp','7777'); await p7.click('#btnLogin'); await wait(1700);
  await p7.evaluate(()=>{ S.coins=1000; S.inventory.freeplay=1; renderHome(); });
  ck(await p7.evaluate(()=>$('btnFreePlay').style.display!=='none'),'free play button shows when owned');
  await p7.evaluate(()=>fpStart()); await wait(500);
  ck(await p7.evaluate(()=>$('freeplay').classList.contains('on') && FP.left>0 && FP.lives===3),'minigame launches with pellets + 3 lives', JSON.stringify(await p7.evaluate(()=>({left:FP.left,lives:FP.lives}))));
  ck(await p7.evaluate(()=>S.inventory.freeplay===0),'free play charge consumed on launch');
  // munch: drive right a few ticks, score should rise, no JS errors
  await p7.evaluate(()=>fpSetDir('right')); await wait(700);
  ck(await p7.evaluate(()=>FP.score>0),'munching dots raises score', 'score='+await p7.evaluate(()=>FP.score));
  await p7.screenshot({path:'xC-freeplay.png'});
  await p7.evaluate(()=>fpQuit()); await wait(200);
  ck(await p7.evaluate(()=>!$('freeplay').classList.contains('on') && FP.timer===null),'free play quits cleanly');

  console.log(errs.length?('JS ERRORS:\n'+errs.join('\n')):'NO JS ERRORS');
  console.log(fails===0?'ALL E2E PASSED':fails+' E2E FAILURES');
  await browser.close();
  process.exit(fails?1:0);
})();
