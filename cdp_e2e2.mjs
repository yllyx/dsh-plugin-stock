import fs from 'fs';
const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const target = list.find(t => t.url.includes('43120'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function evalJS(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) return { __error: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300) };
  return r.result.value;
}
await new Promise(r => { ws.onopen = r; });
// 1. 正确基址的页面上下文请求
const r1 = await evalJS(`fetch('http://127.0.0.1:8765/api/kpl/index-cards').then(r=>r.json()).then(d=>JSON.stringify(d)).catch(e=>'FETCH-ERR:'+e.message)`, true);
console.log('[index-cards from page]:', String(r1).slice(0, 300));
// 2. 点股票监控 tab
const r3 = await evalJS(`(function(){
  const els=[...document.querySelectorAll('div,span,button')];
  const tab=els.find(e=>e.textContent.trim()==='📈股票监控' && e.offsetParent);
  if(tab){tab.click();return 'clicked '+tab.tagName;}
  const t2=els.find(e=>e.textContent.trim().includes('股票监控') && e.offsetParent);
  if(t2){t2.click();return 'clicked(fuzzy) '+t2.tagName;}
  return 'not found';
})()`);
console.log('[click 股票监控]:', String(r3).slice(0, 120));
await new Promise(r => setTimeout(r, 4000));
// 3. 点开盘啦 tab
const r4 = await evalJS(`(function(){
  const els=[...document.querySelectorAll('div,span,button')];
  const tab=els.filter(e=>e.textContent.trim()==='开盘啦'&&e.offsetParent).pop();
  if(tab){tab.click();return 'clicked';}
  return 'not found; sample: '+els.filter(e=>e.offsetParent&&/^(择时|情绪风格|板块|持仓仓位|预警|选股|舆情联动|通达信|系统)$/.test(e.textContent.trim())).map(e=>e.textContent.trim()).join(',');
})()`);
console.log('[click 开盘啦]:', String(r4).slice(0, 250));
await new Promise(r => setTimeout(r, 3000));
// 4. 点板块子 tab
const r5 = await evalJS(`(function(){
  const els=[...document.querySelectorAll('div,span,button')];
  const tab=els.filter(e=>e.textContent.trim()==='板块'&&e.offsetParent).pop();
  if(tab){tab.click();return 'clicked';}
  return 'not found';
})()`);
console.log('[click 板块]:', String(r5).slice(0, 120));
await new Promise(r => setTimeout(r, 6000));
// 5. 读渲染
const r6 = await evalJS(`(function(){
  const out={};
  document.querySelectorAll('.kpl-plt-card').forEach(function(c,i){
    out['card'+i]=c.innerText.replace(/\n/g,' | ').slice(0,80);
  });
  const tk=document.querySelector('.kpl-tk-wrap');
  out.ticker=tk?tk.innerText.replace(/\n/g,' | ').slice(0,150):'(no ticker)';
  const tbl=document.querySelector('.kpl-plt-table');
  out.table=tbl?tbl.innerText.replace(/\n/g,' | ').slice(0,200):'(no table)';
  out.cardsCount=document.querySelectorAll('.kpl-plt-card').length;
  return JSON.stringify(out);
})()`);
console.log('[rendered]:', String(r6).slice(0, 1000));
ws.close();
process.exit(0);
