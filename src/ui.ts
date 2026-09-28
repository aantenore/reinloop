/** Single-file web console served by `reinloop serve`: pick an agent, run it, watch events stream. */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>reinloop console</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#0f766e;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#2dd4bf;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center}
header b{font-size:15px}header input{margin-left:auto;width:220px}
main{display:grid;grid-template-columns:260px 1fr;min-height:calc(100vh - 50px)}
aside{border-right:1px solid var(--line);padding:8px;overflow:auto}
.m{padding:8px 10px;border-radius:8px;cursor:pointer}.m:hover,.m.on{background:var(--card);outline:1px solid var(--line)}
.m small{display:block;color:var(--muted)}.k{font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:.04em}
section{padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0}
textarea,input{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}
textarea{width:100%;min-height:90px;resize:vertical}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
button{font:inherit;padding:8px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--bg);cursor:pointer}
button:disabled{opacity:.5}
#out{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;min-height:120px;overflow-wrap:anywhere}
#log{font:12px/1.5 ui-monospace,monospace;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.e{color:var(--err)}
@media (max-width:720px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}header input{width:140px}}
</style></head><body>
<header><b>reinloop</b><span id="sel" style="color:var(--muted)"></span><input id="tok" placeholder="API token (if required)" type="password"></header>
<main><aside id="list"></aside>
<section>
<textarea id="in" placeholder="Describe the task…"></textarea>
<div class="row"><button id="go">Run</button><label><input type="checkbox" id="cont"> continue conversation</label><span id="st" style="color:var(--muted)"></span></div>
<div id="out"></div><div id="log"></div>
</section></main>
<script>
const $=id=>document.getElementById(id);let current=null,runId=null;
const hdr=()=>{const t=$('tok').value.trim();return t?{authorization:'Bearer '+t}:{}};
function line(text,cls){const d=document.createElement('div');d.textContent=text;if(cls)d.className=cls;$('log').append(d)}
async function load(){
  const r=await fetch('/v1/agents',{headers:hdr()});
  if(!r.ok){$('list').textContent=r.status===401?'Enter the API token above.':'Error '+r.status;return}
  $('list').replaceChildren(...(await r.json()).map(m=>{
    const d=document.createElement('div');d.className='m';
    const k=document.createElement('div');k.className='k';k.textContent=m.kind+(m.pattern?' · '+m.pattern:'');
    const n=document.createElement('div');n.textContent=m.name;
    const s=document.createElement('small');s.textContent=m.description||(m.tools||[]).join(', ');
    d.append(k,n,s);d.onclick=()=>{document.querySelectorAll('.m').forEach(x=>x.classList.remove('on'));d.classList.add('on');current=m.name;runId=null;$('sel').textContent=m.name};
    return d}));
  document.querySelector('.m')?.click();
}
$('tok').onchange=load;
$('go').onclick=async()=>{
  if(!current)return;$('go').disabled=true;$('out').textContent='';$('log').textContent='';$('st').textContent='running…';
  const body={input:$('in').value};if($('cont').checked&&runId)body.runId=runId;
  try{
    const r=await fetch('/v1/agents/'+encodeURIComponent(current)+'/runs',{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream',...hdr()},body:JSON.stringify(body)});
    if(!r.ok){line((await r.json()).error,'e');return}
    const reader=r.body.pipeThrough(new TextDecoderStream()).getReader();let buf='';
    for(;;){const {value,done}=await reader.read();if(done)break;buf+=value;let i;
      while((i=buf.indexOf('\\n\\n'))>=0){const chunk=buf.slice(0,i);buf=buf.slice(i+2);
        const data=chunk.split('\\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6)).join('\\n');if(!data)continue;
        const ev=JSON.parse(data);const sub=ev.parentRunId?'  ↳ ':'';
        if(ev.type==='text_delta'&&!ev.parentRunId)$('out').textContent+=ev.data.text;
        else if(ev.type==='tool_start')line(sub+'• '+ev.data.name+' '+JSON.stringify(ev.data.args).slice(0,160));
        else if(ev.type==='tool_result'&&ev.data.isError)line(sub+'✕ '+ev.data.name+': '+ev.data.content.slice(0,200),'e');
        else if(ev.type==='tool_decision'&&!ev.data.allowed)line(sub+'denied '+ev.data.name+': '+ev.data.reason,'e');
        else if(ev.type==='run_start'&&ev.parentRunId)line(sub+'start '+ev.data.agent);
        else if(ev.type==='run_end'&&!ev.parentRunId){runId=ev.runId;if(!$('out').textContent)$('out').textContent=ev.data.output||'';
          $('st').textContent=ev.data.status+(ev.data.reason?' ('+ev.data.reason+')':'')+' · '+ev.data.turns+' turns · '+(ev.data.usage.inputTokens+ev.data.usage.outputTokens)+' tokens'+(ev.data.costUsd?' · $'+ev.data.costUsd.toFixed(4):'')}}}
  }catch(e){line(String(e),'e')}finally{$('go').disabled=false}
};
load();
</script></body></html>`;
