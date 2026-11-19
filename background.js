// Service worker: owns the capture loop so it keeps running after the popup closes.

import {DEFAULT_SETTINGS,DEFAULT_STATE,KEYS} from './shared.js';
import {putShot,clearShots,putMeta,getMeta} from './db.js';
import {detectPageRect,detectScanicCrop} from './detect.js';
import {pcSelectArea,pcShowArea,pcPickElement,pcClickButton,pcSyntheticKey,pcFindPdfPage} from './injected.js';

const CAPTURE_GAP=600;   // captureVisibleTab is limited to ~2 calls per second
const sleep=ms => new Promise(r => setTimeout(r,ms));

/* ---------------------------------------------------------------- storage */

async function getState() {
  const {state}=await chrome.storage.local.get('state');
  return {...DEFAULT_STATE,...state};
}
async function getSettings() {
  const {settings}=await chrome.storage.local.get('settings');
  return {...DEFAULT_SETTINGS,...settings};
}
async function getRect() {
  const {rect}=await chrome.storage.local.get('rect');
  return rect||null;
}

// All state changes go through one queue so popup commands and the loop never clobber each other.
let chain=Promise.resolve();
function patch(p) {
  chain=chain.catch(() => { }).then(async () => {
    const cur=await getState();
    const next={...cur,...(typeof p==='function'? p(cur):p)};
    await chrome.storage.local.set({state: next});
    updateBadge(next);
    return next;
  });
  return chain;
}

function updateBadge(s) {
  const map={
    running: ['#0f766e',String(s.count)],
    paused: ['#b45309','II'],
    done: ['#15803d','✓'],
    stopped: ['#15803d',s.count? String(s.count):''],
    error: ['#b91c1c','!'],
    idle: ['#0f766e','']
  };
  const [color,text]=map[s.status]||map.idle;
  chrome.action.setBadgeBackgroundColor({color});
  chrome.action.setBadgeText({text});
}

async function flashBadge(text) {
  chrome.action.setBadgeBackgroundColor({color: '#0f766e'});
  chrome.action.setBadgeText({text});
  setTimeout(async () => updateBadge(await getState()),3000);
}

/* ------------------------------------------------------------------- icon */

function drawIcons() {
  const out={};
  for(const size of [16,32,48,128]) {
    const c=new OffscreenCanvas(size,size);
    const g=c.getContext('2d');
    const r=size*0.22;
    g.fillStyle='#0f766e';
    g.beginPath();
    g.roundRect(0,0,size,size,r);
    g.fill();
    g.strokeStyle='#fff';
    g.lineWidth=Math.max(1.5,size*0.09);
    g.lineCap='round';
    const a=size*0.24,b=size*0.76,l=size*0.17;
    for(const [x,y,dx,dy] of [[a,a,1,1],[b,a,-1,1],[a,b,1,-1],[b,b,-1,-1]]) {
      g.beginPath();
      g.moveTo(x+dx*l,y); g.lineTo(x,y); g.lineTo(x,y+dy*l);
      g.stroke();
    }
    g.fillStyle='#fff';
    g.fillRect(size*0.38,size*0.38,size*0.24,size*0.24);
    out[size]=g.getImageData(0,0,size,size);
  }
  chrome.action.setIcon({imageData: out});
}
try {drawIcons();} catch(e) {console.warn('icon',e);}

/* ----------------------------------------------------------- tab helpers */

function fatal(msg) {const e=new Error(msg); e.fatal=true; return e;}

async function assertTab(s) {
  let tab;
  try {tab=await chrome.tabs.get(s.tabId);} catch {throw fatal('The captured tab was closed.');}
  if(!tab.active) throw new Error('The captured tab is not in the foreground. Switch back to it and press Resume.');
}

/* -------------------------------------------------------------- capturing */

let lastCaptureAt=0;
const attached=new Set();     // tabs with the debugger attached
let cdpFailures=0;            // consecutive failures of high-resolution capture

async function captureCrop(s,rect) {
  for(let attempt=0;;attempt++) {
    try {
      const settings=await getSettings();
      const region=await captureRegion(s,rect,settings);
      // Change detection works on a CSS-pixel-sized grayscale copy, whatever the capture resolution.
      const sig=signature(region.canvas,Math.max(1,Math.round(rect.w)),Math.max(1,Math.round(rect.h)));
      return {...region,sig};
    }
    catch(e) {
      if(attempt>=3||e.fatal) throw e;
      console.warn('capture failed, retrying:',e);
      await sleep(700);
      await assertTab(s);
    }
  }
}

async function captureRegion(s,rect,settings) {
  const want=Math.round(Math.min(4,Math.max(1,Number(settings.captureScale)||1)));
  if(want>1&&chrome.debugger&&cdpFailures<2) {
    try {
      const r=await grabHighRes(s,rect,want);
      cdpFailures=0;
      return r;
    } catch(e) {
      cdpFailures++;
      attached.delete(s.tabId);
      console.warn('High-resolution capture failed:',e);
      if(cdpFailures>=2) await patch({message: 'High-resolution capture is unavailable, using standard resolution.'});
      else throw e;
    }
  } else if(want>1&&!chrome.debugger&&!captureRegion.warned) {
    captureRegion.warned=true;
    await patch({message: 'Grant the debugger permission for high-resolution capture. Using standard resolution.'});
  }
  return grabNative(s,rect);
}

// Standard capture: whatever pixel density the screen has (often 1x).
async function grabNative(s,rect) {
  const wait=CAPTURE_GAP-(Date.now()-lastCaptureAt);
  if(wait>0) await sleep(wait);
  let dataUrl;
  for(let attempt=0;;attempt++) {
    try {
      lastCaptureAt=Date.now();
      dataUrl=await chrome.tabs.captureVisibleTab(s.windowId,{format: 'png'});
      break;
    } catch(e) {
      if(/MAX_CAPTURE|quota/i.test(e.message)&&attempt<5) {await sleep(700); continue;}
      throw e;
    }
  }
  const bmp=await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scaleX=bmp.width/rect.vw,scaleY=bmp.height/rect.vh;
  const sx=Math.min(bmp.width-1,Math.max(0,Math.round(rect.x*scaleX)));
  const sy=Math.min(bmp.height-1,Math.max(0,Math.round(rect.y*scaleY)));
  const sw=Math.max(1,Math.min(bmp.width-sx,Math.round(rect.w*scaleX)));
  const sh=Math.max(1,Math.min(bmp.height-sy,Math.round(rect.h*scaleY)));
  const canvas=new OffscreenCanvas(sw,sh);
  canvas.getContext('2d',{alpha: false}).drawImage(bmp,sx,sy,sw,sh,0,0,sw,sh);
  bmp.close();
  return {canvas,w: sw,h: sh,scale: scaleX};
}

// High-resolution capture: the browser renders just the clipped region at N times the scale while
// taking the screenshot (like zooming in for one frame). The live page is NOT touched: no layout
// change, no zoom, no changed coordinates. Text and vector graphics come out genuinely sharper;
// bitmap content (e.g. a pdf.js canvas) can only be as sharp as the viewer drew it.
async function grabHighRes(s,rect,scale) {
  const target={tabId: s.tabId};
  const send=(method,params) => chrome.debugger.sendCommand(target,method,params);
  if(!attached.has(s.tabId)) {
    try {await chrome.debugger.attach(target,'1.3');} catch { /* may already be attached by us */}
    attached.add(s.tabId);
  }
  const m=await send('Page.getLayoutMetrics',{});
  const v=m.cssVisualViewport||m.visualViewport||{};
  const res=await send('Page.captureScreenshot',{
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {x: (v.pageX||0)+rect.x,y: (v.pageY||0)+rect.y,width: rect.w,height: rect.h,scale}
  });
  const bmp=await createImageBitmap(await (await fetch('data:image/png;base64,'+res.data)).blob());
  const canvas=new OffscreenCanvas(bmp.width,bmp.height);
  canvas.getContext('2d',{alpha: false}).drawImage(bmp,0,0);
  const out={canvas,w: bmp.width,h: bmp.height,scale: bmp.width/rect.w};
  bmp.close();
  lastCaptureAt=Date.now();
  return out;
}

function signature(source,sw,sh) {
  // Grayscale copy at a fixed (CSS-pixel) size: small text changes on a mostly white page are still
  // detected, and the cost does not grow with the capture resolution.
  const c=new OffscreenCanvas(sw,sh);
  const g=c.getContext('2d',{willReadFrequently: true});
  g.drawImage(source,0,0,sw,sh);
  const d=g.getImageData(0,0,sw,sh).data;
  const sig=new Uint8Array(sw*sh);
  for(let i=0,j=0;j<sig.length;i+=4,j++) {
    sig[j]=(d[i]*299+d[i+1]*587+d[i+2]*114)/1000;
  }
  return sig;
}

// Fraction of pixels that differ noticeably (different size counts as fully different).
function diffRatio(a,b) {
  if(!a||!b||a.length!==b.length) return 1;
  let n=0;
  for(let i=0;i<a.length;i++) if(Math.abs(a[i]-b[i])>20) n++;
  return n/a.length;
}

/* ------------------------------------------------- page boundary detection */

// Crops the captured region to the page itself. Runs once per accepted page, so sizes stay stable.
// 1) pdf.js viewers: read the page element's exact position from the DOM.
// 2) Other snapshots: Scanic detects and extracts a document; color analysis is the fallback.
async function cropToPage(c,s,rect) {
  let box=null;

  try {
    const res=await chrome.scripting.executeScript({target: {tabId: s.tabId,allFrames: true},func: pcFindPdfPage});
    let best=null;
    for(const r of res) if(r.result&&(!best||r.result.vis>best.vis)) best=r.result;
    if(best) {
      const x0=Math.max(best.x,rect.x),y0=Math.max(best.y,rect.y);
      const x1=Math.min(best.x+best.w,rect.x+rect.w),y1=Math.min(best.y+best.h,rect.y+rect.h);
      if(x1-x0>20&&y1-y0>20) box={x: (x0-rect.x)*c.scale,y: (y0-rect.y)*c.scale,w: (x1-x0)*c.scale,h: (y1-y0)*c.scale};
    }
  } catch(e) {console.warn('DOM page lookup failed',e);}

  if(!box) {
    try {
      const crop=await detectScanicCrop(c.canvas);
      if(crop) return crop;
    } catch(e) {console.warn('Scanic detection failed, using color analysis:',e);}

    const k=Math.min(1,800/Math.max(c.w,c.h));
    const sw=Math.max(1,Math.round(c.w*k)),sh=Math.max(1,Math.round(c.h*k));
    const small=new OffscreenCanvas(sw,sh);
    const g=small.getContext('2d',{willReadFrequently: true});
    g.drawImage(c.canvas,0,0,sw,sh);
    const r=detectPageRect(g.getImageData(0,0,sw,sh).data,sw,sh);
    if(r) box={x: r.x/k,y: r.y/k,w: r.w/k,h: r.h/k};
  }
  if(!box) return c.canvas;

  const bx=Math.max(0,Math.round(box.x)),by=Math.max(0,Math.round(box.y));
  const bw=Math.min(c.w-bx,Math.round(box.w)),bh=Math.min(c.h-by,Math.round(box.h));
  if(bw<c.w*0.1||bh<c.h*0.1) return c.canvas;                       // implausible
  if(bw>=c.w*0.985&&bh>=c.h*0.985) return c.canvas;                 // already the whole area
  const out=new OffscreenCanvas(bw,bh);
  out.getContext('2d',{alpha: false}).drawImage(c.canvas,bx,by,bw,bh,0,0,bw,bh);
  return out;
}

async function accept(c,s,rect,settings) {
  let canvas=c.canvas;
  if(settings.autoDetect||rect.auto) {
    try {canvas=await cropToPage(c,s,rect);} catch(e) {console.warn('page detection failed',e);}
  }
  const blob=await canvas.convertToBlob({type: 'image/png'});
  await putShot({blob,w: canvas.width,h: canvas.height,scale: c.scale,t: Date.now()});
  await putMeta('lastSig',c.sig);   // lets a restarted worker keep comparing against the right page
  await patch(st => ({count: st.count+1,phase: 'needNav',message: `Captured page ${st.count+1}.`}));
}

/* ------------------------------------------------------------- navigation */

async function trustedKey(tabId,spec) {
  const target={tabId};
  if(!attached.has(tabId)) {
    try {await chrome.debugger.attach(target,'1.3');} catch { /* may already be attached */}
    attached.add(tabId);
  }
  const base={key: spec.key,code: spec.code,windowsVirtualKeyCode: spec.vk,nativeVirtualKeyCode: spec.vk};
  await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type: 'rawKeyDown',...base});
  await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type: 'keyUp',...base});
}

async function detachDebugger(tabId) {
  if(tabId==null) return;
  attached.delete(tabId);
  if(!chrome.debugger) return;
  try {await chrome.debugger.detach({tabId});} catch { /* not attached */}
}

async function navigate(s,settings) {
  if(settings.nav==='button') {
    if(!settings.selector) throw new Error('No Next-page button selector is set.');
    const res=await chrome.scripting.executeScript({
      target: {tabId: s.tabId,allFrames: true},
      func: pcClickButton,
      args: [settings.selector]
    });
    if(res.some(r => r.result&&r.result.ok)) return {ok: true};
    const disabled=res.some(r => r.result&&r.result.reason==='disabled');
    return {ok: false,reason: disabled? 'The Next button is disabled: last page reached.':'The Next button was not found: last page reached.'};
  }

  const spec=KEYS[settings.nav]||KEYS.ArrowRight;
  if(settings.trustedKeys&&chrome.debugger) {
    try {await trustedKey(s.tabId,spec); return {ok: true};}
    catch(e) {
      console.warn('Trusted keys failed, falling back to synthetic events:',e);
      attached.delete(s.tabId);
      await chrome.storage.local.set({settings: {...settings,trustedKeys: false}});
    }
  }
  await chrome.scripting.executeScript({
    target: {tabId: s.tabId},
    func: pcSyntheticKey,
    args: [spec.key,spec.code,spec.vk]
  });
  return {ok: true};
}

/* -------------------------------------------------------------- main loop */

let looping=false;
let keepAlive=null;
const startKeepAlive=() => {if(!keepAlive) keepAlive=setInterval(() => chrome.runtime.getPlatformInfo(),20000);};
const stopKeepAlive=() => {clearInterval(keepAlive); keepAlive=null;};

async function waitForChange(rect,settings,lastSig) {
  const changeT=settings.sensitivity/100;
  const stableT=changeT/3;
  const t0=Date.now();
  await sleep(settings.delay);
  let prev=null;
  while(Date.now()-t0<settings.delay+settings.maxWait) {
    const cur=await getState();
    if(cur.status!=='running') return 'aborted';
    await assertTab(cur);
    const c=await captureCrop(cur,rect);
    if(diffRatio(c.sig,lastSig)>changeT) {
      if(prev&&diffRatio(c.sig,prev.sig)<=stableT) return c;   // changed and settled
      prev=c;
    } else {
      prev=null;
    }
  }
  return prev; // changed but still animating, or null if nothing changed
}

async function runLoop() {
  if(looping) return;
  looping=true;
  startKeepAlive();
  let lastSig=null;
  let noChange=0;
  try {
    for(;;) {
      const s=await getState();
      if(s.status!=='running') break;
      const settings=await getSettings();
      const rect=await getRect();
      if(!rect) throw fatal('No capture area selected.');
      await assertTab(s);

      if(!lastSig&&s.count>0) {
        lastSig=(await getMeta('lastSig'))||null;
      }

      if(s.count===0) {
        // First page: wait until the view has stopped changing (e.g. re-rendering after a resolution change).
        let c=await captureCrop(s,rect);
        for(let i=0;i<4;i++) {
          await sleep(600);
          const c2=await captureCrop(s,rect);
          const stable=diffRatio(c.sig,c2.sig)<=settings.sensitivity/300;
          c=c2;
          if(stable) break;
        }
        await accept(c,s,rect,settings);
        lastSig=c.sig;
        continue;
      }

      if(s.count>=settings.maxPages) {
        await finish('done',`Reached the page limit (${settings.maxPages}).`);
        break;
      }

      if(s.phase==='needNav') {
        const r=await navigate(s,settings);
        if(!r.ok) {await finish('done',r.reason); break;}
        await patch({phase: 'waiting',message: 'Waiting for the page to update…'});
      }

      const res=await waitForChange(rect,settings,lastSig);
      if(res==='aborted') break;
      if(!res) {
        if(noChange<settings.retries) {
          noChange++;
          await patch({phase: 'needNav',message: `No change yet, trying again (${noChange}/${settings.retries})…`});
          continue;
        }
        await finish('done',s.count===1
          ? 'The area did not change after navigating. Try trusted key events, another key, or a Next-page button.'
          :'No further change detected: last page reached.');
        break;
      }
      await accept(res,s,rect,settings);
      lastSig=res.sig;
      noChange=0;
    }
  } catch(e) {
    console.error(e);
    const msg=e&&e.message? e.message:String(e);
    const isFatal=e&&e.fatal;
    const s=await getState();
    await patch(st => st.status==='running'
      ? {status: isFatal? 'error':'paused',message: isFatal? msg:`Paused: ${msg}`}
      :{});
    if(isFatal) await detachDebugger(s.tabId);
  } finally {
    looping=false;
    stopKeepAlive();
  }
}

async function finish(status,message) {
  const s=await patch({status,message});
  await detachDebugger(s.tabId);
  if(s.count>0) await openExport();
}

async function openExport() {
  const url=chrome.runtime.getURL('export.html');
  const tabs=await chrome.tabs.query({url});
  if(tabs.length) {
    await chrome.tabs.update(tabs[0].id,{active: true});
    await chrome.windows.update(tabs[0].windowId,{focused: true});
  } else {
    await chrome.tabs.create({url});
  }
}

/* --------------------------------------------------------------- commands */

async function startCapture(tabId,windowId) {
  let rect=await getRect();
  const settings=await getSettings();
  if(settings.nav==='button'&&!settings.selector) throw new Error('Pick or enter the Next-page button first.');

  const [inj]=await chrome.scripting.executeScript({
    target: {tabId},
    func: () => ({w: window.innerWidth,h: window.innerHeight})
  });
  const vp=inj.result;
  if(!rect||rect.auto) {
    // No area chosen: search the whole visible page and crop to the page automatically.
    rect={x: 0,y: 0,w: vp.w,h: vp.h,vw: vp.w,vh: vp.h,auto: true};
    await chrome.storage.local.set({rect});
  } else if(Math.abs(vp.w-rect.vw)>2||Math.abs(vp.h-rect.vh)>2) {
    throw new Error(`The window size changed since you selected the area (${rect.vw}×${rect.vh} → ${vp.w}×${vp.h}). Select the area again, or press Auto.`);
  }

  await clearShots();
  await patch({status: 'running',count: 0,phase: 'needNav',message: 'Starting…',tabId,windowId});
  runLoop();
}

async function handle(msg,sender) {
  switch(msg.type||msg.cmd) {
    /* from the popup */
    case 'selectArea':
      await chrome.scripting.executeScript({target: {tabId: msg.tabId},func: pcSelectArea});
      return {};
    case 'showArea': {
      const rect=await getRect();
      if(rect) await chrome.scripting.executeScript({target: {tabId: msg.tabId},func: pcShowArea,args: [rect]});
      return {};
    }
    case 'pickButton':
      await chrome.scripting.executeScript({target: {tabId: msg.tabId},func: pcPickElement});
      return {};
    case 'start':
      await startCapture(msg.tabId,msg.windowId);
      return {};
    case 'pause': {
      await patch(st => st.status==='running'? {status: 'paused',message: 'Paused.'}:{});
      return {};
    }
    case 'resume':
      await patch(st => st.status==='paused'
        ? {status: 'running',message: 'Resumed.',tabId: msg.tabId??st.tabId,windowId: msg.windowId??st.windowId}
        :{});
      runLoop();
      return {};
    case 'stop': {
      const s=await patch(st => ['running','paused'].includes(st.status)
        ? {status: 'stopped',message: 'Stopped.'}:{});
      await detachDebugger(s.tabId);
      if(s.count>0) await openExport();
      return {};
    }
    case 'reset': {
      const s=await patch({status: 'idle',count: 0,phase: 'needNav',message: ''});
      await detachDebugger(s.tabId);
      await clearShots();
      return {};
    }
    case 'openPdf':
      await openExport();
      return {};

    /* from injected page scripts */
    case 'areaSelected':
      if(!sender.tab) return {};
      await chrome.storage.local.set({rect: msg.rect});
      flashBadge('OK');
      return {};
    case 'buttonPicked': {
      if(!sender.tab) return {};
      const settings=await getSettings();
      await chrome.storage.local.set({settings: {...settings,nav: 'button',selector: msg.selector}});
      flashBadge('OK');
      return {};
    }
    case 'selectionCancelled':
      return {};
    default:
      return {};
  }
}

chrome.runtime.onMessage.addListener((msg,sender,sendResponse) => {
  handle(msg,sender)
    .then(r => sendResponse({ok: true,...r}))
    .catch(e => sendResponse({ok: false,error: e&&e.message? e.message:String(e)}));
  return true;
});

// If the worker was restarted mid-run, carry on automatically from the saved state.
(async () => {
  const {settings}=await chrome.storage.local.get('settings');
  if(settings&&(settings.v||0)<3) {
    await chrome.storage.local.set({settings: {...settings,v: 3,captureScale: 3,autoDetect: true,delay: settings.delay||1000}});
  }
  const s=await getState();
  if(s.status==='running'&&!looping) runLoop();
})();
