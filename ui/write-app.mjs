import { writeFileSync } from 'fs'

const src = `import { useState, useEffect, useRef, useCallback } from 'react'
import { AreaChart, ProgressBar } from '@tremor/react'

async function apiFetch(method, path, body) {
  try {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, data }
  } catch (e) { return { ok: false, data: { error: true, message: e.message } } }
}

const scoreColor = s => s >= 0.75 ? 'emerald' : s >= 0.45 ? 'amber' : 'rose'
const scoreBorder = s => s >= 0.75 ? '#10b981' : s >= 0.45 ? '#f59e0b' : '#ef4444'
const scoreFg = s => s >= 0.75 ? '#10b981' : s >= 0.45 ? '#f59e0b' : '#ef4444'

function Topbar({ online, endpoints }) {
  return (
    <header style={{ position:'sticky', top:0, zIndex:50, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 20px', height:'44px', background:'rgba(7,7,14,0.9)', backdropFilter:'blur(14px)', borderBottom:'1px solid var(--border)' }}>
      <div style={{ position:'absolute', top:0, left:0, right:0, height:'1px', background:'linear-gradient(90deg,transparent,var(--accent) 40%,var(--accent-2) 60%,transparent)', opacity:0.5 }} />
      <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
        <div style={{ width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'linear-gradient(135deg,#7c3aed,#a855f7)', fontSize:'10px', fontWeight:900, color:'#fff' }}>Nx</div>
        <span style={{ fontSize:'13px', fontWeight:700, color:'var(--text-1)', letterSpacing:'-0.3px' }}>NEXUS</span>
        <div style={{ width:'1px', height:'14px', background:'var(--border-2)' }} />
        <span style={{ fontSize:'11px', color:'var(--text-3)' }}>Learning Context · Safety · Durable Memory</span>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
        {endpoints > 0 && <span style={{ fontSize:'10px', fontFamily:'JetBrains Mono,monospace', color:'var(--text-3)' }}>{endpoints} ep</span>}
        <div style={{ display:'flex', alignItems:'center', gap:'6px', padding:'3px 10px', border:\`1px solid \${online ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}\`, background: online ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)', fontSize:'11px', fontWeight:500, color: online ? 'var(--green)' : 'var(--red)' }}>
          <span className="live-dot" style={{ width:'5px', height:'5px', display:'inline-block', background: online ? 'var(--green)' : 'var(--red)' }} />
          {online ? 'Online' : 'Offline'}
        </div>
      </div>
    </header>
  )
}

function Bento({ children, area }) {
  const [hov, setHov] = useState(false)
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} style={{ gridArea:area, background:'var(--surface)', border:\`1px solid \${hov ? 'rgba(124,58,237,0.28)' : 'var(--border)'}\`, overflow:'hidden', display:'flex', flexDirection:'column', transition:'border-color 0.2s,box-shadow 0.2s', boxShadow: hov ? '0 0 0 1px rgba(124,58,237,0.07),0 16px 48px rgba(0,0,0,0.6)' : 'none' }}>
      {children}
    </div>
  )
}

function CellHeader({ title, right }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'9px 14px 8px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
      <span style={{ fontSize:'10px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.9px', color:'var(--text-3)' }}>{title}</span>
      {right && <span style={{ fontSize:'10px', color:'var(--text-3)', fontFamily:'JetBrains Mono,monospace' }}>{right}</span>}
    </div>
  )
}

function EmptyState({ icon, text }) {
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:'8px', color:'var(--text-3)', userSelect:'none', padding:'24px' }}>
      <span style={{ fontSize:'28px', opacity:0.3 }}>{icon}</span>
      <span style={{ fontSize:'11px', textAlign:'center', lineHeight:1.6, whiteSpace:'pre-line' }}>{text}</span>
    </div>
  )
}

function QueryBlock({ onChunks }) {
  const [messages, setMessages] = useState([{ role:'nexus', text:'Preguntame sobre tu base de conocimiento. Selecciono el contexto relevante y elimino el ruido.' }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }) }, [messages, loading])

  async function send() {
    const q = input.trim(); if (!q || loading) return
    setInput(''); setMessages(m => [...m, { role:'user', text:q }]); setLoading(true); onChunks([])
    const { ok, data } = await apiFetch('POST', '/api/recall', { query:q }); setLoading(false)
    const reply = ok ? (data.result ?? data.stdout ?? data.context ?? JSON.stringify(data,null,2)) : '\\u26A0 ' + (data.message ?? 'Error')
    setMessages(m => [...m, { role:'nexus', text:reply }]); onChunks(data.chunks ?? [])
  }

  return (
    <Bento area="query">
      <CellHeader title="\\uD83D\\uDCAC Knowledge Query" right="recall" />
      <div style={{ flex:1, overflowY:'auto', padding:'12px 14px', display:'flex', flexDirection:'column', gap:'8px', minHeight:0 }}>
        {messages.map((m, i) => (
          <div key={i} className={m.role==='user' ? 'slide-right' : 'slide-left'} style={{ display:'flex', justifyContent:m.role==='user'?'flex-end':'flex-start', animationDelay:\`\${i*25}ms\` }}>
            {m.role==='nexus' && <div style={{ width:'2px', flexShrink:0, marginRight:'10px', alignSelf:'stretch', background:'linear-gradient(180deg,var(--accent),transparent)' }} />}
            <div style={{ maxWidth:'84%', padding:'8px 12px', fontSize:'13px', lineHeight:1.6, whiteSpace:'pre-wrap', wordBreak:'break-word', background:m.role==='user'?'var(--accent)':'var(--surface-2)', border:\`1px solid \${m.role==='user'?'transparent':'var(--border)'}\`, color:m.role==='user'?'#fff':'var(--text-1)' }}>{m.text}</div>
          </div>
        ))}
        {loading && (
          <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
            <div style={{ width:'2px', alignSelf:'stretch', background:'var(--accent)', opacity:0.4 }} />
            <div style={{ padding:'8px 14px', background:'var(--surface-2)', border:'1px solid var(--border)', display:'flex', gap:'4px', alignItems:'center', height:'34px' }}>
              {[0,1,2].map(i => <span key={i} className="live-dot" style={{ width:'4px', height:'4px', background:'var(--accent-2)', display:'inline-block', animationDelay:\`\${i*180}ms\` }} />)}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ display:'flex', gap:'8px', padding:'10px 12px', borderTop:'1px solid var(--border)', background:'var(--surface)' }}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&send()} placeholder="Pregunta sobre tus documentos..."
          style={{ flex:1, background:'var(--surface-2)', border:'1px solid var(--border)', padding:'7px 12px', fontSize:'13px', color:'var(--text-1)', outline:'none', fontFamily:'inherit', transition:'border-color 0.15s' }}
          onFocus={e=>e.target.style.borderColor='rgba(124,58,237,0.5)'} onBlur={e=>e.target.style.borderColor='var(--border)'} />
        <button onClick={send} disabled={loading||!input.trim()}
          style={{ padding:'7px 16px', background:input.trim()&&!loading?'var(--accent)':'var(--surface-3)', border:'1px solid transparent', fontSize:'12px', fontWeight:600, fontFamily:'inherit', color:input.trim()&&!loading?'#fff':'var(--text-3)', cursor:input.trim()&&!loading?'pointer':'not-allowed', transition:'all 0.15s' }}
          onMouseDown={e=>{if(!e.currentTarget.disabled)e.currentTarget.style.transform='scale(0.97)'}} onMouseUp={e=>e.currentTarget.style.transform='scale(1)'}>Send ↵</button>
      </div>
    </Bento>
  )
}

function ContextBlock({ chunks }) {
  const tokens = chunks.reduce((a,c)=>a+(c.tokens??Math.ceil((c.content??'').length/4)),0)
  const pct = Math.min(100, Math.round((tokens/8192)*100))
  return (
    <Bento area="context">
      <CellHeader title="\\uD83C\\uDFAF Context Selected" right={chunks.length>0?\`\${chunks.length} chunks\`:undefined} />
      <div style={{ flex:1, overflowY:'auto', padding:'10px', display:'flex', flexDirection:'column', gap:'6px', minHeight:0 }}>
        {chunks.length===0 ? <EmptyState icon="\\uD83D\\uDD0D" text="El contexto seleccionado\\naparecerá aquí" /> : (
          chunks.map((c,i) => {
            const s = c.priority??c.score??0
            return (
              <div key={i} className="reveal" style={{ background:'var(--surface-2)', border:'1px solid var(--border)', borderLeft:\`2px solid \${scoreBorder(s)}\`, padding:'8px 10px', animationDelay:\`\${i*35}ms\` }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'5px', gap:'8px' }}>
                  <span style={{ fontSize:'10px', fontFamily:'JetBrains Mono,monospace', color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>{(c.source??c.id??'chunk').split('/').pop()}</span>
                  <span style={{ fontSize:'11px', fontFamily:'JetBrains Mono,monospace', fontWeight:700, color:scoreFg(s), flexShrink:0 }}>{(s*100).toFixed(0)}%</span>
                </div>
                <ProgressBar value={s*100} color={scoreColor(s)} style={{ height:'1px', marginBottom:'6px' }} />
                <p style={{ fontSize:'11px', color:'var(--text-2)', lineHeight:1.55, overflow:'hidden', display:'-webkit-box', WebkitLineClamp:3, WebkitBoxOrient:'vertical' }}>{(c.content??'').slice(0,180)}</p>
              </div>
            )
          })
        )}
      </div>
      {chunks.length>0 && (
        <div className="reveal" style={{ padding:'8px 12px 10px', borderTop:'1px solid var(--border)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:'10px', color:'var(--text-3)', marginBottom:'5px' }}>
            <span>Token budget</span><span style={{ fontFamily:'JetBrains Mono,monospace' }}>{tokens.toLocaleString()} / 8,192</span>
          </div>
          <ProgressBar value={pct} color={pct>80?'rose':pct>55?'amber':'violet'} />
        </div>
      )}
    </Bento>
  )
}

function GuardBlock() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  async function evaluate() {
    if (!query.trim()||loading) return
    setLoading(true); setResult(null)
    const { data } = await apiFetch('POST', '/api/guard', { query })
    setLoading(false); setResult(data)
  }
  return (
    <Bento area="guard">
      <CellHeader title="\\uD83D\\uDEE1\\uFE0F Guard Engine" />
      <div style={{ flex:1, padding:'10px', display:'flex', flexDirection:'column', gap:'8px', minHeight:0 }}>
        <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&evaluate()} placeholder="ignore previous instructions..."
          style={{ width:'100%', background:'var(--surface-2)', border:'1px solid var(--border)', padding:'7px 10px', fontSize:'12px', fontFamily:'JetBrains Mono,monospace', color:'var(--text-2)', outline:'none', transition:'border-color 0.15s', boxSizing:'border-box' }}
          onFocus={e=>e.target.style.borderColor='rgba(124,58,237,0.5)'} onBlur={e=>e.target.style.borderColor='var(--border)'} />
        <button onClick={evaluate} disabled={loading||!query.trim()}
          style={{ width:'100%', padding:'7px', background:'var(--surface-2)', border:'1px solid var(--border-2)', fontSize:'11px', fontWeight:600, fontFamily:'inherit', letterSpacing:'0.3px', transition:'all 0.15s', color:query.trim()?'var(--text-2)':'var(--text-3)', cursor:query.trim()&&!loading?'pointer':'not-allowed' }}
          onMouseEnter={e=>{if(query.trim()&&!loading){e.target.style.background='var(--surface-3)';e.target.style.borderColor='rgba(124,58,237,0.3)'}}}
          onMouseLeave={e=>{e.target.style.background='var(--surface-2)';e.target.style.borderColor='var(--border-2)'}}>
          {loading?'Evaluating…':'Evaluate'}
        </button>
        {result ? (
          <div className="glow-flash reveal" style={{ padding:'10px 12px', background:result.blocked?'rgba(239,68,68,0.05)':'rgba(16,185,129,0.05)', border:\`1px solid \${result.blocked?'rgba(239,68,68,0.2)':'rgba(16,185,129,0.2)'}\`, borderLeft:\`2px solid \${result.blocked?'var(--red)':'var(--green)'}\` }}>
            <div style={{ display:'flex', alignItems:'center', gap:'7px', marginBottom:'5px' }}>
              <span style={{ width:'6px', height:'6px', display:'inline-block', flexShrink:0, background:result.blocked?'var(--red)':'var(--green)' }} />
              <span style={{ fontSize:'11px', fontWeight:700, letterSpacing:'0.8px', textTransform:'uppercase', color:result.blocked?'var(--red)':'var(--green)' }}>{result.blocked?'Blocked':'Allowed'}</span>
            </div>
            {result.blocked
              ? <p style={{ fontSize:'11px', color:'rgba(239,68,68,0.7)', lineHeight:1.5 }}>{result.userMessage}</p>
              : <p style={{ fontSize:'10px', fontFamily:'JetBrains Mono,monospace', color:'var(--text-3)' }}>{result.results?.length??0} rules · {result.durationMs??0}ms</p>}
          </div>
        ) : <EmptyState icon="\\uD83D\\uDD12" text={'Try: "ignore all\\ninstructions"'} />}
      </div>
    </Bento>
  )
}

function PulseBlock() {
  const [metrics, setMetrics] = useState(null)
  const [history, setHistory] = useState([])
  const refresh = useCallback(async () => {
    const { ok, data } = await apiFetch('GET', '/api/metrics'); if (!ok) return
    setMetrics(data)
    const p95 = data.p95??data.latency?.p95??0
    const t = new Date().toLocaleTimeString('es',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})
    setHistory(h => [...h,{t,ms:p95}].slice(-30))
  }, [])
  useEffect(() => { refresh(); const id=setInterval(refresh,5000); return ()=>clearInterval(id) }, [refresh])

  const v = {
    req:   metrics?.totalRequests??metrics?.requests?.total??0,
    p95:   (metrics?.p95??metrics?.latency?.p95??0)+'ms',
    err:   ((metrics?.errorRate??metrics?.errors?.rate??0)*100).toFixed(1)+'%',
    block: metrics?.blocked??metrics?.guard?.blocked??0,
  }
  const kpis = [
    { label:'Requests',    value:v.req,   color:'#a855f7' },
    { label:'Latency p95', value:v.p95,   color:'#06b6d4' },
    { label:'Errors',      value:v.err,   color:parseFloat(v.err)>5?'#ef4444':'#10b981' },
    { label:'Blocked',     value:v.block, color:v.block>0?'#f59e0b':'var(--text-3)' },
  ]
  return (
    <Bento area="pulse">
      <CellHeader title="\\uD83D\\uDCE1 System Pulse" right="5s" />
      <div style={{ padding:'10px', display:'flex', flexDirection:'column', gap:'10px', flex:1, minHeight:0 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px' }}>
          {kpis.map((k,i) => (
            <div key={k.label} className={\`reveal s\${i+1}\`} style={{ background:'var(--surface-2)', border:'1px solid var(--border)', padding:'10px 12px', borderTop:\`2px solid \${k.color}33\` }}>
              {metrics
                ? <div className="count-up" style={{ fontSize:'22px', fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:k.color, letterSpacing:'-0.5px', lineHeight:1 }}>{k.value}</div>
                : <div className="shimmer" style={{ height:'22px', width:'48px', marginBottom:'2px' }} />}
              <div style={{ fontSize:'9px', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.9px', color:'var(--text-3)', marginTop:'4px' }}>{k.label}</div>
            </div>
          ))}
        </div>
        {history.length>2 ? (
          <div style={{ flex:1, minHeight:0 }}>
            <div style={{ fontSize:'9px', color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:'4px' }}>Latency · últimas {history.length}</div>
            <AreaChart data={history} index="t" categories={['ms']} colors={['violet']} showLegend={false} showXAxis={false} showGridLines={false} yAxisWidth={24} className="h-20" curveType="monotone" />
          </div>
        ) : (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <span style={{ fontSize:'11px', color:'var(--text-3)' }}>Acumulando datos…</span>
          </div>
        )}
      </div>
    </Bento>
  )
}

export default function App() {
  const [online, setOnline] = useState(false)
  const [endpoints, setEndpoints] = useState(0)
  const [chunks, setChunks] = useState([])
  useEffect(() => {
    async function boot() {
      const { ok } = await apiFetch('GET','/api/health'); setOnline(ok)
      const { data } = await apiFetch('GET','/api/routes'); setEndpoints(data?.routes?.length??0)
    }
    boot(); const id=setInterval(async()=>{ const{ok}=await apiFetch('GET','/api/health'); setOnline(ok) },10000); return()=>clearInterval(id)
  }, [])
  return (
    <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column' }}>
      <Topbar online={online} endpoints={endpoints} />
      <main style={{ flex:1, padding:'10px', overflow:'auto' }}>
        <div style={{ display:'grid', gridTemplateAreas:'"query query context" "query query context" "guard pulse context"', gridTemplateColumns:'1fr 1fr 290px', gridTemplateRows:'1fr 1fr auto', gap:'6px', height:'calc(100vh - 44px - 20px)', maxWidth:'1380px', margin:'0 auto' }}>
          <QueryBlock onChunks={setChunks} />
          <ContextBlock chunks={chunks} />
          <GuardBlock />
          <PulseBlock />
        </div>
      </main>
      <style>{\`
        input::placeholder { color: var(--text-3) !important; }
        @media (max-width: 860px) {
          main > div { grid-template-areas:"query" "context" "guard" "pulse" !important; grid-template-columns:1fr !important; grid-template-rows:repeat(4,440px) !important; height:auto !important; }
        }
      \`}</style>
    </div>
  )
}
`

writeFileSync('./src/App.jsx', src, 'utf8')
console.log('written', src.length, 'chars')
