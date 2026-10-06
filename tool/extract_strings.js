const fs=require('fs'),acorn=require('acorn'),walk=require('acorn-walk');
const src=fs.readFileSync(process.argv[2],'utf8');
const ast=acorn.parse(src,{ecmaVersion:'latest',locations:true});
const INLINE=new Set(['b','strong','i','em','br']);
const ENT={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&nbsp;':' ','&middot;':'·','&rarr;':'→','&larr;':'←','&hellip;':'…','&times;':'×','&ndash;':'–','&mdash;':'—'};
const dec=t=>t.replace(/&#(\d+);/g,(m,n)=>String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi,(m,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&[a-z]+;|&#\d+;/gi,m=>ENT[m]??m);
const norm=t=>t.replace(/\s+/g,' ').trim();
const hasWords=t=>/[A-Za-z]{2,}/.test(t.replace(/\{\d+\}/g,'').replace(/<[^>]+>/g,''));
const out=new Map();
const NOEXTRACT=new Set(['Taal / Language','Nederlands','English']);
function add(key,ctx,kind,line,exprs){
  key=norm(key); if(!key||!hasWords(key)||looksCode(key.replace(/\{\d+\}/g,'X').replace(/<\/?(b|strong|i|em|br)>/g,'')))return;
  // renumber placeholders in order
  let i=0;const map={};key=key.replace(/\{(\d+)\}/g,(m,n)=>{if(!(n in map))map[n]=i++;return '{'+map[n]+'}';});
  if(/^\{\d+\}$/.test(key)||NOEXTRACT.has(key))return;
  const e=out.get(key)||{key,ctx:new Set(),kind,lines:[],n:0,plural:false};
  if(exprs&&Object.keys(map).some(n=>exprs[n]&&/['"]s['"]/.test(exprs[n])&&new RegExp('[a-z]\\{'+map[n]+'\\}').test(key)))e.plural=true;e.ctx.add(ctx);e.lines.push(line);e.n++;out.set(key,e);
}
// Visible text runs from an HTML-ish string with {n} markers for expressions.
function harvestHTML(h,ctx,line,exprs){
  // attributes
  h.replace(/\b(placeholder|aria-label|title|alt)="([^"]*)"/g,(m,a,v)=>{add(dec(v),ctx,'attr:'+a,line,exprs);return m;});
  // remove script-y attributes and tag internals, split on non-inline tags
  const tokens=h.split(/(<\/?[a-zA-Z][^>]*>)/);
  let run='';
  const flush=()=>{const r=run.replace(/^(\s|<br>)+|(\s|<br>)+$/g,'');add(r,ctx,'text',line,exprs);run='';};
  for(const t of tokens){
    const m=t.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
    if(m){ const tag=m[1].toLowerCase();
      if(INLINE.has(tag)) run+= tag==='br'?'<br>':(t.startsWith('</')?`</${tag}>`:`<${tag}>`);
      else flush();
    } else run+=dec(t);
  }
  flush();
}
const looksCode=v=>/^[a-z0-9_\-.:\/#]+$/.test(v)||/^[a-z]+[A-Z]\w*$/.test(v)||/^[a-z]{2}-[A-Z]{2}$/.test(v)||/^Bearer /.test(v)||/\w+\([^)]*\)/.test(v)&&!/ /.test(v.replace(/\([^)]*\)/,''))||/onclick=|render\(\)/.test(v)||/[{};=]|px\b|rgba|var\(|https?:|\.js\b|^\s*$/.test(v)||/^[A-Z0-9_]+$/.test(v);
const p0=anc=>anc[anc.length-2];
function fnName(anc){for(let i=anc.length-1;i>=0;i--){const a=anc[i];
  if(a.type==='FunctionDeclaration'&&a.id)return a.id.name;
  if(a.type==='VariableDeclarator'&&a.id.name)return a.id.name;
  if(a.type==='Property'&&a.key&&(a.key.name||a.key.value))return String(a.key.name||a.key.value);}return '(top)';}
// literals inside a coach prompt: argument of claude(...) or template containing JSON instructions
const promptRanges=[];
walk.fullAncestor(ast,(n,_,anc)=>{ if(n.type==='CallExpression'&&n.callee.name==='claude'){
  const f=[...anc].reverse().find(a=>/Function/.test(a.type)); if(f)promptRanges.push([f.start,f.end]); } });
walk.full(ast,n=>{ if(n.type==='FunctionDeclaration'&&n.id&&n.id.name==='claude')promptRanges.push([n.start,n.end]); });
walk.full(ast,n=>{ if(n.type==='VariableDeclarator'&&n.id.name&&/^(RULES|css|GA_ID|LEGAL_UPDATED|SETTINGS)$/.test(n.id.name)&&n.init)promptRanges.push([n.init.start,n.init.end]); });
const inPrompt=n=>promptRanges.some(([a,b])=>n.start>=a&&n.end<=b);
const consumed=new Set();
walk.fullAncestor(ast,(n,_,anc)=>{
  if(inPrompt(n))return;
  const ctx=fnName(anc);
  if(n.type==='BinaryExpression'&&n.operator==='+'&&!(anc[anc.length-2]&&anc[anc.length-2].type==='BinaryExpression'&&anc[anc.length-2].operator==='+')){
    const parts=[];(function fl(x){if(x.type==='BinaryExpression'&&x.operator==='+'){fl(x.left);fl(x.right);}else parts.push(x);})(n);
    const lits=parts.filter(p=>p.type==='Literal'&&typeof p.value==='string');
    const joined=parts.map(p=>p.type==='Literal'&&typeof p.value==='string'?p.value:' X ').join('');
    if(lits.some(l=>hasWords(l.value))&&!looksCode(dec(joined).replace(/\s+/g,' ').trim())&&/[A-Za-z]{2,} /.test(dec(joined).trim()+' ')&&!/^\s*X\s*$/.test(joined)){
      let k=0;const s=parts.map(p=>p.type==='Literal'&&typeof p.value==='string'?p.value:`{${k++}}`).join('');
      const ex=parts.filter(p=>!(p.type==='Literal'&&typeof p.value==='string')).map(p=>src.slice(p.start,p.end));
      if(/<[a-z]/i.test(s))harvestHTML(s,ctx,n.loc.start.line,ex);else add(dec(s),ctx,'concat',n.loc.start.line,ex);
      lits.forEach(l=>consumed.add(l.start));
    }
  }
});
walk.fullAncestor(ast,(n,_,anc)=>{
  if(inPrompt(n))return;
  const ctx=fnName(anc);
  if(n.type==='Literal'&&typeof n.value==='string'&&!consumed.has(n.start)){
    const v=n.value;
    if(/<[a-z]/i.test(v)){harvestHTML(v,ctx,n.loc.start.line);return;}
    if(looksCode(v.trim())||!hasWords(v))return;
    if(p0(anc)&&p0(anc).type==='NewExpression')return;
    // skip object keys and comparison operands
    const p=anc[anc.length-2];
    if(p&&p.type==='Property'&&p.key===n)return;
    if(p&&p.type==='BinaryExpression'&&/^[=!]==?$/.test(p.operator))return;
    if(p&&p.type==='CallExpression'&&p.callee.property&&/^(getElementById|querySelector|querySelectorAll|getItem|setItem|removeItem|addEventListener|setAttribute|indexOf|includes|startsWith|split|join|replace|test)$/.test(p.callee.property.name))return;
    if(p&&p.type==='ImportDeclaration')return;
    add(dec(v),ctx,'literal',n.loc.start.line);
  }
  if(n.type==='TemplateLiteral'){
    let s='';n.quasis.forEach((q,i)=>{s+=q.value.cooked;if(i<n.expressions.length)s+=`{${i}}`;});
    const ex=n.expressions.map(e=>src.slice(e.start,e.end));
    if(/<[a-z]/i.test(s))harvestHTML(s,ctx,n.loc.start.line,ex);
    else if(hasWords(s))add(dec(s),ctx,'template',n.loc.start.line,ex);
  }
});
const arr=[...out.values()].map(e=>({key:e.key,ctx:[...e.ctx].join(', '),kind:e.kind,n:e.n,line:e.lines[0],plural:e.plural})).sort((a,b)=>a.line-b.line);
fs.writeFileSync(process.argv[3],JSON.stringify(arr,null,1));
console.log(arr.length,'strings;', 'prompt ranges',promptRanges.length);
