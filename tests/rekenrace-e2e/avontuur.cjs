/* Run with a locally available Playwright: npm run test:rekenrace:browser.
   RR_URL can target the branch preview. Isolated browser profiles never change server data. */
const {chromium,firefox,webkit}=require('playwright');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
const URL=process.env.RR_URL||'http://127.0.0.1:8765/rekenrace/';
const SHOTS=process.env.RR_SHOTS||path.join(os.tmpdir(),'rekenrace-avontuur-shots');fs.mkdirSync(SHOTS,{recursive:true});
function installedOptions(type){
 if(fs.existsSync(type.executablePath()))return {};
 // Prefer Playwright's matching browser; an explicit local fallback also works offline.
 const root=process.env.PLAYWRIGHT_BROWSERS_PATH||path.join(os.homedir(),'Library/Caches/ms-playwright');
 if(!fs.existsSync(root))return {};
 const dirs=fs.readdirSync(root).filter(n=>n.startsWith(type.name()+'-')).sort((a,b)=>Number(b.split('-').pop())-Number(a.split('-').pop()));
 const suffix={chromium:'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',firefox:'firefox/Nightly.app/Contents/MacOS/firefox',webkit:'pw_run.sh'}[type.name()];
 const executable=dirs.map(d=>path.join(root,d,suffix)).find(p=>fs.existsSync(p));return executable?{executablePath:executable}:{};
}
const launched=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function phase(page,p){await page.waitForFunction(v=>RR.UI.state.run?.phase===v,p,{timeout:20000});await sleep(390);}
async function createPlayer(page,name='Lotte',grade=4,hero='egel'){
 await page.getByRole('button',{name:'Kies je speler',exact:true}).click();await page.getByLabel('Hoe heet je?').fill(name);
 await page.locator('[name=grade]').selectOption(String(grade));await page.locator(`[name=hero][value=${hero}]`).check({force:true});
 await page.getByRole('button',{name:/Klaar voor vertrek/}).click();
}
async function begin(page,ch='Dorpsronde'){
 if(!await page.locator('#dialog[open] .chapter-card').count())await page.getByRole('button',{name:'Kies een tocht',exact:false}).click();
 await page.getByRole('button',{name:new RegExp('^'+ch+' ')}).click();await phase(page,'intro');await page.getByRole('button',{name:/We gaan op pad/}).click();await phase(page,'driving');
}
async function navigate(page){await page.getByRole('button',{name:/Bekijk de kaart/}).click();await page.locator('.map-stop.active').click();await phase(page,RRCompleteTarget(await page.evaluate(()=>RR.UI.state.run.stops)));}
function RRCompleteTarget(stops){return stops===3?'complete':'conversation';}
function solve(text){const m=text.match(/^(\d+) ([+−×:]) (\d+) = \?$/);assert.ok(m,text);const a=+m[1],b=+m[3];return ({'+':()=>a+b,'−':()=>a-b,'×':()=>a*b,':':()=>a/b})[m[2]]();}
async function typeAnswer(page,value){for(const digit of String(value))await page.locator(`[data-digit="${digit}"]`).click();await page.getByRole('button',{name:'Nakijken',exact:true}).click();}
async function playTrip(page,{shot=false,reload=false}={}){
 for(let stop=0;stop<3;stop++){
  await navigate(page);await page.getByRole('button',{name:'Samen rekenen',exact:true}).click();await phase(page,'question');
  for(let q=0;q<3;q++){
   const correct=solve(await page.locator('#question').innerText());
   if(stop===0&&q===0){
    const before=await page.locator('#world').evaluate(c=>c.toDataURL());await page.keyboard.press('ArrowUp');await sleep(300);assert.equal(await page.locator('#world').evaluate(c=>c.toDataURL()),before,'The world must be completely frozen while calculating');
    await typeAnswer(page,correct+100);assert.equal(await page.evaluate(()=>RR.UI.state.run.attempt),1);await sleep(400);assert.match(await page.locator('#feedback').innerText(),/Nog niet helemaal/);
   }
   if(q===1){await page.locator('#question').focus();await page.keyboard.type(String(correct));await page.keyboard.press('Enter');}else await typeAnswer(page,correct);await phase(page,'explanation');
   if(shot&&stop===0&&q===0)await page.screenshot({path:path.join(SHOTS,'rekenstop.png')});
   if(reload&&stop===0&&q===0){
    const stats=await page.evaluate(()=>RR.UI.store.profiles.kindStats().reduce((n,s)=>n+s.total,0));await page.reload();await page.getByRole('button',{name:/Kies een tocht/}).click();await page.getByRole('button',{name:'Verder met je tocht',exact:true}).click();await phase(page,'explanation');
    assert.equal(await page.evaluate(()=>RR.UI.store.profiles.kindStats().reduce((n,s)=>n+s.total,0)),stats,'Reload must not count the answer twice');
   }
   await page.locator('[data-action=next-phase]').click();await phase(page,q===2?'stopDone':'question');
  }
  await page.getByRole('button',{name:/Doorrijden/}).click();await phase(page,'driving');
 }
 await navigate(page);assert.equal(await page.evaluate(()=>RR.UI.state.run.index),9);assert.equal(await page.evaluate(()=>RR.UI.state.run.outcomes.length),9);
 await page.getByRole('button',{name:'Stoppen',exact:true}).click();await page.locator('#stopped:not([hidden])').waitFor();
}
async function layout(page){const bad=await page.evaluate(()=>{
 const out=[];if(document.documentElement.scrollWidth>innerWidth+1)out.push('horizontal overflow');
 const d=document.querySelector('dialog[open]');if(d&&d.getBoundingClientRect().height>innerHeight-10)out.push('dialog exceeds viewport');
 return out;
 });assert.deepEqual(bad,[]);}
async function testBrowser(type,opts={}){
 const browser=await type.launch({headless:!(type.name()==='firefox'&&process.env.RR_FIREFOX_HEADED==='1'),timeout:30000,...installedOptions(type)}),ctx=await browser.newContext({viewport:opts.viewport||{width:1280,height:800},hasTouch:!!opts.touch,reducedMotion:opts.reduced?'reduce':'no-preference'});
 launched.push(browser);const page=await ctx.newPage(),errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(new global.URL(URL).origin)&&!r.url().startsWith('data:'))external.push(r.url());});
 await page.goto(URL);await page.locator('#loading[hidden]').waitFor({state:'attached'});await layout(page);
 if(opts.shot)await page.screenshot({path:path.join(SHOTS,'welkom.png')});
 await createPlayer(page,type.name()==='chromium'?'Lotte':'Sam',opts.grade||4,opts.hero||'egel');await begin(page,opts.chapter||'Dorpsronde');
 const before=await page.evaluate(()=>RR.UI.state.run.position.slice());
 // Exercise a real held direction and release, rather than moving the game state in tests.
 const up=page.locator('[data-drive=up]'),box=await up.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await sleep(250);await page.mouse.up();
 const after=await page.evaluate(()=>RR.UI.state.run.position.slice());assert.notDeepEqual(after,before);await sleep(150);assert.deepEqual(await page.evaluate(()=>RR.UI.state.run.position.slice()),after,'Releasing must stop the car');
 await page.getByRole('button',{name:'Terug naar de weg',exact:true}).click();
 await layout(page);if(opts.shot)await page.screenshot({path:path.join(SHOTS,'dorpsronde.png')});
 if(opts.touch){
  const point=await page.evaluate(()=>RR.UI.state.scene.screen([760,800])),canvas=await page.locator('#world').boundingBox();
  await page.touchscreen.tap(canvas.x+point.x,canvas.y+point.y);await sleep(300);assert.ok(await page.evaluate(()=>RR.UI.state.route.length>0||RR.World.distance(RR.UI.state.run.position,[760,800])<5));
  await page.getByRole('button',{name:'Terug naar de weg',exact:true}).click();
 }
 await playTrip(page,{shot:opts.shot,reload:opts.reload});await layout(page);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('PASS',type.name(),opts.chapter||'Dorpsronde','nine sums, movement, no external requests, saved progress');
 await ctx.close();await browser.close();
}
async function smallLayouts(){
 const browser=await chromium.launch({headless:true,...installedOptions(chromium)});launched.push(browser);
 for(const viewport of [{width:390,height:844},{width:768,height:1024},{width:1024,height:600},{width:1280,height:720}]){
  const ctx=await browser.newContext({viewport,hasTouch:true}),page=await ctx.newPage();await page.goto(URL);await page.locator('#loading[hidden]').waitFor({state:'attached'});await layout(page);await createPlayer(page);await page.getByRole('button',{name:'Sluiten',exact:true}).click();await page.getByRole('button',{name:'Je autootje',exact:true}).click();await page.locator('#garage-form [name=hero][value=pad]').check({force:true});await page.locator('#garage-form [name=car][value=gold]').check();await page.getByRole('button',{name:'Bewaren',exact:true}).click();assert.equal(await page.evaluate(()=>RR.UI.store.current().hero),'pad');assert.equal(await page.evaluate(()=>RR.UI.store.pref().car),'gold');await begin(page);await layout(page);
  await page.getByRole('button',{name:'Bekijk de kaart',exact:false}).click();await layout(page);await page.getByRole('button',{name:'Sluiten',exact:true}).click();
  await page.screenshot({path:path.join(SHOTS,`formaat-${viewport.width}x${viewport.height}.png`)});await ctx.close();console.log('PASS layout',viewport.width,viewport.height);
 }
 const ctx=await browser.newContext(),page=await ctx.newPage();await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError')}}));await page.goto(URL);await page.locator('#storage-warning:not([hidden])').waitFor();await createPlayer(page);await begin(page);assert.equal(await page.evaluate(()=>RR.UI.store.status().persistent),false);console.log('PASS blocked storage, can still play');await ctx.close();await browser.close();
}
(async()=>{const selected=(process.env.RR_BROWSERS||'chromium,firefox,webkit,layouts').split(',');if(selected.includes('chromium'))await testBrowser(chromium,{shot:true,reload:true});if(selected.includes('firefox'))await testBrowser(firefox,{chapter:'Molenpolder',hero:'eekhoorn',grade:5,reduced:true});if(selected.includes('webkit'))await testBrowser(webkit,{chapter:'Havenrit',hero:'uil',grade:5,touch:true,viewport:{width:1024,height:768}});if(selected.includes('layouts'))await smallLayouts();console.log('Screenshots:',SHOTS);})().catch(async e=>{console.error(e);await Promise.allSettled(launched.map(b=>b.close()));process.exitCode=1;});
