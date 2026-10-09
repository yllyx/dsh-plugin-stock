import fs from 'fs';
const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const target = list.find(t => (t.title || '').includes('中国长城') || t.url.includes('43120'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 10;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = ++mid;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === i) { ws.removeEventListener('message', h); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 150) };
  return r.result.value;
}
async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 60));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function clickText(text) {
  const r = await evalJS(`(function(){
    const els=[...document.querySelectorAll('div,span,button')].filter(function(e){
      if (text !== '板块') return e.getBoundingClientRect().width>0&&e.textContent.trim().includes(${JSON.stringify(text)});
      var r2=e.getBoundingClientRect();
      return r2.width>0&&r2.width<120&&r2.y>80&&e.textContent.trim()==='板块'&&(e.className||'').indexOf('dsh-stock-tab')<0;
    });
    if(!els.length) return JSON.stringify({none:true, sample:[...document.querySelectorAll('div,span,button')].filter(function(e){return e.getBoundingClientRect().width>0&&e.textContent.indexOf(${JSON.stringify(text)}.slice(0,2))>=0&&e.textContent.trim().length<12}).slice(0,12).map(function(e){return e.tagName+':'+e.textContent.trim().slice(0,10);})});
    els.sort(function(a,b){return a.getBoundingClientRect().width-b.getBoundingClientRect().width;});
    const e=els[0];
    const r=e.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), tag:e.tagName, cls:(e.className||'').slice(0,40)});
  })()`);
  if (!r) { console.log(text, ': null'); return false; }
  const p = typeof r === 'string' ? JSON.parse(r) : r;
  if (p.none) { console.log(text, ': NOT FOUND. samples:', JSON.stringify(p.sample)); return false; }
  console.log(text, '@', p.x, p.y, '<' + p.tag + ' ' + p.cls + '>');
  await realClick(p.x, p.y);
  return true;
}
await new Promise(r => { ws.onopen = r; });
// 1. 点 开盘啦
if (!(await clickText('开盘啦'))) process.exit(1);
await new Promise(r => setTimeout(r, 4000));
await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync('E:/zcode-projects/kanpan_spec/shots/e2e_kpl.png', Buffer.from(r.data, 'base64')));
const rr = await evalJS(`(function(){
  var NL = String.fromCharCode(10);
  var out = {cards:[], ticker:null, table:null};
  var cs = document.querySelectorAll('.kpl-plt-card');
  for (var i = 0; i < cs.length; i++) out.cards.push(cs[i].innerText.split(NL).join(' | ').slice(0, 50));
  var tk = document.querySelector('.kpl-tk-wrap');
  if (tk) out.ticker = tk.innerText.split(NL).join(' | ').slice(0, 120);
  var tb = document.querySelector('.kpl-plt-table');
  if (tb) out.table = tb.innerText.split(NL).join(' | ').slice(0, 160);
  return JSON.stringify(out);
})()`);
console.log('RENDER:', JSON.stringify(r3).slice(0, 700));
process.exit(0);
