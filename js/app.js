// ═══════════════════════════════════
// CONSTANTEN
// ═══════════════════════════════════
const AC  = ['Aandelen','Crypto','Grondstoffen','Obligaties','Cash','Alternatief','Vastgoed','ETF/Fonds'];
const ACC = ['#4d8fff','#f0b429','#00d4a0','#a78bfa','#8b8fa8','#ff5b6b','#fb923c','#34d399'];
const PC  = ['#4d8fff','#00d4a0','#f0b429','#ff5b6b','#a78bfa','#fb923c','#34d399','#f472b6','#38bdf8','#facc15'];

// Crypto: ticker → CoinGecko ID
const CGMAP = {
  'BTC':'bitcoin','ETH':'ethereum','BNB':'binancecoin','XRP':'ripple',
  'ADA':'cardano','SOL':'solana','DOT':'polkadot','DOGE':'dogecoin',
  'MATIC':'matic-network','LINK':'chainlink','LTC':'litecoin','AVAX':'avalanche-2',
  'BTC-EUR':'bitcoin','ETH-EUR':'ethereum','SOL-EUR':'solana','BNB-EUR':'binancecoin',
  'XRP-EUR':'ripple','ADA-EUR':'cardano',
};

// ═══════════════════════════════════
// CONFIG
// ═══════════════════════════════════
let CFG = {};
try { CFG = JSON.parse(localStorage.getItem('ptx_cfg')||'{}'); } catch(e){}
function saveCFG(){ localStorage.setItem('ptx_cfg',JSON.stringify(CFG)); }
if(!CFG.server){ CFG.server='https://arbo-invest-tracker.onrender.com'; saveCFG(); }


// ═══════════════════════════════════
// STATE
// ═══════════════════════════════════
let portfolios, activeId, prices, assetCls, assetTgt, dividends;

// ── Handmatige posities (cash + alternatief) ─────────────────────
let manualPositions = { cash: [], alts: [] };
let manualModalType = 'cash';
let manualEditId = null;

function loadManual(){
  try{
    manualPositions = JSON.parse(localStorage.getItem('ptx_manual')||'{"cash":[],"alts":[]}');
    if(!manualPositions.cash) manualPositions.cash = [];
    if(!manualPositions.alts) manualPositions.alts = [];
  }catch(e){ manualPositions = {cash:[],alts:[]}; }
}

function saveManual(){
  localStorage.setItem('ptx_manual', JSON.stringify(manualPositions));
  updateCashPayOptions();
}

function loadState(){
  try{
    portfolios = JSON.parse(localStorage.getItem('ptx_pf')||'null');
    if(!portfolios){
      const old = localStorage.getItem('ptx_v2');
      portfolios = [{id:'default',name:'Mijn Portefeuille',transactions:old?JSON.parse(old):[],created:Date.now()}];
    }
    activeId  = localStorage.getItem('ptx_act')||portfolios[0].id;
    if(!portfolios.find(p=>p.id===activeId)) activeId=portfolios[0].id;
    prices    = JSON.parse(localStorage.getItem('ptx_px')||'{}');
    assetCls  = JSON.parse(localStorage.getItem('ptx_ac')||'{}');
    assetTgt  = JSON.parse(localStorage.getItem('ptx_at')||'{}');
    dividends = JSON.parse(localStorage.getItem('ptx_dv')||'[]');
    loadManual();
  }catch(e){
    portfolios=[{id:'default',name:'Mijn Portefeuille',transactions:[],created:Date.now()}];
    activeId='default'; prices={}; assetCls={}; assetTgt={}; dividends=[];
  }
}
loadState();

function pf(){ return portfolios.find(p=>p.id===activeId)||portfolios[0]; }
function txs(){ return pf().transactions||[]; }
function myDivs(){ return dividends.filter(d=>!d.pfId||d.pfId===activeId); }

function saveLocal(){
  localStorage.setItem('ptx_pf',  JSON.stringify(portfolios));
  localStorage.setItem('ptx_act', activeId);
  localStorage.setItem('ptx_px',  JSON.stringify(prices));
  localStorage.setItem('ptx_ac',  JSON.stringify(assetCls));
  localStorage.setItem('ptx_at',  JSON.stringify(assetTgt));
  localStorage.setItem('ptx_dv',  JSON.stringify(dividends));
}

let SB_OK = false;

// ═══════════════════════════════════════════════════════════════════════
// SUPABASE DATASYNC — pull na login, push na elke wijziging
// ═══════════════════════════════════════════════════════════════════════

// UUID-patroon om Supabase UUIDs te herkennen (vs. frontend IDs zoals 'manual_123')
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Gedeelde logica voor manual positions sync (gebruikt door pushToSupabase + _pushManualOnly)
async function _syncManualToSupabase(uid){
  const bRow = (m, type) => ({
    user_id:uid, type, name:m.name, value:m.value,
    subcat:m.subcat||null, note:m.note||null,
    ...(_UUID_RE.test(m.id) ? {id:m.id} : {}),
  });
  const cashRows = (manualPositions.cash||[]).map(m=>bRow(m,'cash'));
  const altsRows = (manualPositions.alts||[]).map(m=>bRow(m,'alts'));
  const toUpsert = [...cashRows,...altsRows].filter(r=>r.id);
  const toInsert = [...cashRows,...altsRows].filter(r=>!r.id);
  const keepIds  = toUpsert.map(r=>r.id);
  // Verwijder enkel items die niet meer in memory staan — geen delete-all!
  if(keepIds.length){
    await _sb.from('manual_positions').delete().eq('user_id',uid).not('id','in',`(${keepIds.join(',')})`);
  } else if(!toInsert.length){
    await _sb.from('manual_positions').delete().eq('user_id',uid);
  }
  if(toUpsert.length) await _sb.from('manual_positions').upsert(toUpsert,{onConflict:'id'});
  if(toInsert.length){
    const {data:ins} = await _sb.from('manual_positions').insert(toInsert).select('id,type');
    if(ins){
      // Update lokale IDs met Supabase UUIDs zodat volgende push kan upserten
      const newCash = (manualPositions.cash||[]).filter(m=>!_UUID_RE.test(m.id));
      const newAlts = (manualPositions.alts||[]).filter(m=>!_UUID_RE.test(m.id));
      let ci=0, ai=0;
      ins.forEach(r=>{
        if(r.type==='cash' && newCash[ci]){ newCash[ci].id=r.id; ci++; }
        else if(r.type==='alts' && newAlts[ai]){ newAlts[ai].id=r.id; ai++; }
      });
      saveManual();
    }
  }
}

// Gerichte push van alleen manual positions (snel, wordt direct awaited na opslaan)
async function _pushManualOnly(){
  if(!SB_OK) return;
  try{
    const {data:{session}} = await _sb.auth.getSession();
    if(!session?.user) return;
    await _syncManualToSupabase(session.user.id);
  }catch(e){ console.warn('Manual sync fout:',e); showToast('⚠️ Sync mislukt — data lokaal opgeslagen'); }
}

async function pullFromSupabase(){
  const dot = document.getElementById('sb-dot');
  const lbl = document.getElementById('sb-label');
  // Bewaar lokale staat vóór pull — veiligheidsnet als Supabase leeg is door onderbroken push
  const _localManual = { cash:[...(manualPositions.cash||[])], alts:[...(manualPositions.alts||[])] };
  try{
    // getSession leest lokale opslag — geen extra networkverzoek nodig
    const { data:{ session } } = await _sb.auth.getSession();
    if(!session?.user){
      if(lbl) lbl.textContent = 'Supabase: geen actieve sessie';
      return;
    }

    const [pfRes, txRes, divRes, manRes, wlRes, acRes] = await Promise.all([
      _sb.from('portfolios').select('*').order('created_at'),
      _sb.from('transactions').select('*').order('date'),
      _sb.from('dividends').select('*').order('date'),
      _sb.from('manual_positions').select('*'),
      _sb.from('watchlist').select('*').order('added_at'),
      _sb.from('asset_config').select('*'),
    ]);

    if(pfRes.error){
      console.warn('Supabase pull fout (portfolios):', pfRes.error);
      if(dot) dot.className = 'sb-dot err';
      if(lbl) lbl.textContent = 'Supabase fout: ' + pfRes.error.message;
      return;
    }

    const pfData = pfRes.data || [];
    const txData = txRes.data || [];

    // Eerste login: Supabase is leeg → migreer bestaande localStorage-data naar cloud
    if(pfData.length === 0){
      SB_OK = true;
      await pushToSupabase();
      if(dot) dot.className = 'sb-dot ok';
      if(lbl) lbl.textContent = 'Supabase: verbonden ✓';
      return;
    }

    // Normaal geval: Supabase heeft data → overschrijf lokale state volledig
    portfolios = pfData.map(p =>({
      id: p.id,
      name: p.name,
      created: new Date(p.created_at).getTime(),
      transactions: txData
        .filter(tx => tx.portfolio_id === p.id)
        .map(tx =>({
          type: tx.type,
          ticker: tx.ticker,
          name: tx.name || tx.ticker,
          qty: parseFloat(tx.qty),
          price: parseFloat(tx.price),
          fee: parseFloat(tx.fee||0),
          date: tx.date,
        }))
    }));
    if(!portfolios.find(p => p.id === activeId)) activeId = portfolios[0].id;

    if(!divRes.error && divRes.data){
      dividends = divRes.data.map(d =>({
        id:     d.id,
        ticker: d.ticker,
        amount: parseFloat(d.amount),
        date:   d.date,
        desc:   d.description||'',
        pfId:   d.portfolio_id||null,
      }));
    }

    if(!manRes.error && manRes.data){
      if(manRes.data.length > 0){
        // Supabase heeft data → gebruik als bron van waarheid
        manualPositions = { cash:[], alts:[] };
        manRes.data.forEach(m =>{
          const item = {
            id: m.id,
            name: m.name,
            value: parseFloat(m.value),
            subcat: m.subcat||'',
            note: m.note||'',
            updated: m.updated_at ? new Date(m.updated_at).toLocaleDateString('nl-BE') : '—',
          };
          if(m.type==='cash') manualPositions.cash.push(item);
          else manualPositions.alts.push(item);
        });
      } else if(_localManual.cash.length > 0 || _localManual.alts.length > 0){
        // Supabase is leeg maar lokale cache heeft data → bescherm lokale data
        // Kan gebeuren als een push werd onderbroken door een refresh
        manualPositions = _localManual;
      }
      // (anders: beide leeg → manualPositions blijft { cash:[], alts:[] })
    }

    if(!wlRes.error && wlRes.data){
      watchlist = wlRes.data.map(w =>({
        ticker: w.ticker,
        name: w.name||w.ticker,
        addedAt: w.added_at,
      }));
    }

    if(!acRes.error && acRes.data){
      assetCls = {}; assetTgt = {};
      acRes.data.forEach(a =>{
        if(a.asset_class) assetCls[a.ticker] = a.asset_class;
        if(a.target_weight) assetTgt[a.ticker] = parseFloat(a.target_weight);
      });
    }

    saveLocal(); saveManual(); saveWatchlist();

    SB_OK = true;
    if(dot) dot.className = 'sb-dot ok';
    if(lbl) lbl.textContent = 'Supabase: verbonden ✓';

    // Als lokale data beschermd werd (Supabase was leeg) → hersync naar Supabase
    const _restoredManual = manualPositions === _localManual;
    if(_restoredManual) setTimeout(()=>_pushManualOnly(), 1000);

  }catch(e){
    console.warn('pullFromSupabase fout:', e);
    if(dot) dot.className = 'sb-dot err';
    if(lbl) lbl.textContent = 'Supabase fout: ' + (e.message || 'onbekend');
  }
}

async function pushToSupabase(){
  if(!SB_OK) return;
  try{
    const { data:{ session } } = await _sb.auth.getSession();
    if(!session?.user) return;
    const uid = session.user.id;

    // 1. Portefeuilles upserten (op id)
    await _sb.from('portfolios').upsert(
      portfolios.map(p =>({
        id: p.id, user_id: uid, name: p.name,
        created_at: new Date(p.created||Date.now()).toISOString(),
      })),
      { onConflict:'id' }
    );

    // 2. Transacties: verwijder alles → herplaatsen (geen stabiele frontend-IDs)
    await _sb.from('transactions').delete().eq('user_id', uid);
    const allTx = portfolios.flatMap(p =>
      (p.transactions||[]).map(tx =>({
        user_id: uid, portfolio_id: p.id,
        type: tx.type, ticker: tx.ticker, name: tx.name||tx.ticker,
        qty: tx.qty, price: tx.price, fee: tx.fee||0, date: tx.date,
      }))
    );
    if(allTx.length) await _sb.from('transactions').insert(allTx);

    // 3. Dividenden: verwijder alles → herplaatsen
    await _sb.from('dividends').delete().eq('user_id', uid);
    const allDivs = dividends.map(d =>({
      user_id: uid, portfolio_id: d.pfId||null,
      ticker: d.ticker, amount: d.amount, date: d.date, description: d.desc||'',
    }));
    if(allDivs.length) await _sb.from('dividends').insert(allDivs);

    // 4. Handmatige posities
    await _syncManualToSupabase(uid);

    // 5. Watchlist: verwijder alles → herplaatsen
    await _sb.from('watchlist').delete().eq('user_id', uid);
    const allWL = watchlist.map(w =>({ user_id:uid, ticker:w.ticker, name:w.name||w.ticker }));
    if(allWL.length) await _sb.from('watchlist').insert(allWL);

    // 6. Asset configuratie: verwijder alles → herplaatsen
    await _sb.from('asset_config').delete().eq('user_id', uid);
    const allAC = Object.entries(assetCls).map(([ticker, cls]) =>({
      user_id:uid, ticker, asset_class:cls, target_weight:assetTgt[ticker]||0,
    }));
    if(allAC.length) await _sb.from('asset_config').insert(allAC);

  }catch(e){
    console.warn('pushToSupabase fout:', e);
    showToast('⚠️ Sync mislukt — data lokaal opgeslagen');
  }
}

// ═══════════════════════════════════
// PRIJS OPHALEN
// ═══════════════════════════════════
// ═══════════════════════════════════════════
// SERVER API — alle koersen via eigen server
// ═══════════════════════════════════════════

function getServerUrl(){
  const url = (CFG.server||'').replace(/\/$/, '').trim();
  // Valideer: alleen https://, geen lokale adressen in productie
  if(!url) return '';
  try{
    const u = new URL(url);
    if(u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    // Blokkeer localhost/interne adressen behalve voor dev
    const host = u.hostname.toLowerCase();
    const isLocal = host==='localhost'||host==='127.0.0.1'||host.startsWith('192.168.')||host.startsWith('10.')||host.endsWith('.local');
    if(isLocal && location.hostname !== 'localhost') return '';
    return url;
  } catch(e){ return ''; }
}

// Rate limiting: max 30 server calls per 60 seconden
const _rlCalls = [];
function _checkRateLimit(){
  const now = Date.now();
  while(_rlCalls.length && _rlCalls[0] < now - 60000) _rlCalls.shift();
  if(_rlCalls.length >= 30) return false;
  _rlCalls.push(now); return true;
}

async function serverFetch(path, options={}){
  const url = getServerUrl();
  if(!url) return null;
  if(!_checkRateLimit()){ console.warn('Rate limit bereikt'); return null; }
  try{
    const {_timeout=15000, ...fetchOpts} = options;
    const headers = {'Content-Type':'application/json', ...(fetchOpts.headers||{})};
    // Stuur Supabase sessie-token mee voor server-side identificatie
    try{
      const { data:{ session } } = await _sb.auth.getSession();
      if(session?.access_token) headers['Authorization'] = 'Bearer ' + session.access_token;
    }catch(_){}
    const r = await fetch(url+path, {
      ...fetchOpts,
      headers,
      signal: AbortSignal.timeout(_timeout)
    });
    if(!r.ok) return null;
    return r.json();
  }catch(e){
    console.warn('serverFetch fout:', e.message);
    return null;
  }
}

// Haal meerdere koersen op van server in één call
async function fetchPricesFromServer(tickers){
  const data = await serverFetch('/prices', {
    method:'POST',
    body: JSON.stringify({tickers})
  });
  return data || {};
}

// Historische data voor grafiek
async function fetchHistoryFromServer(ticker, period='max'){
  const data = await serverFetch(`/history/${encodeURIComponent(ticker)}?period=${period}`, {_timeout:45000});
  if(!data||!data.data) return null;
  const res = {};
  data.data.forEach(d=>res[d.date]=d.close);
  return res;
}

// Laad historische koersen voor alle posities; cache in localStorage (TTL 23 uur)
async function loadHistPrices(){
  if(!getServerUrl()) return;
  _loadHistCache();
  const tickers = [...new Set(txs().map(t=>t.ticker))];
  if(!tickers.length) return;
  const missing = tickers.filter(t=>!histPrices[t] && !CGMAP[t?.toUpperCase()]);
  if(!missing.length){ histPricesLoaded=true; return; }
  await Promise.all(missing.map(async ticker=>{
    try{
      const raw = await fetchHistoryFromServer(ticker, 'max');
      if(raw) histPrices[ticker]=raw;
    } catch(e){ console.warn('Hist laden mislukt voor', ticker, e); }
  }));
  histPricesLoaded=true;
  _saveHistCache();
  renderLine(); // herteken grafiek met echte historische koersen
}

async function loadBenchmark(){
  const sym = document.getElementById('bench-sym')?.value?.trim() || 'IWDA.AS';
  // Laad historische koersen voor posities + benchmark parallel
  await Promise.all([
    loadHistPrices(),
    (async()=>{
      if(!sym || !getServerUrl()){ benchHistory=null; return; }
      try{
        const raw = await fetchHistoryFromServer(sym, '5y');
        if(!raw){ benchHistory=null; return; }
        const entries = Object.entries(raw).sort((a,b)=>a[0].localeCompare(b[0]));
        benchHistory = { labels: entries.map(e=>e[0]), vals: entries.map(e=>e[1]) };
      } catch(e){ console.warn('Benchmark laden mislukt:', e); benchHistory=null; }
    })()
  ]);
  renderLine();
}

// CoinGecko blijft gratis voor crypto (geen server nodig)
async function fetchCoinGecko(ticker){
  const id=CGMAP[ticker.toUpperCase()];
  if(!id) return null;
  try{
    const r=await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=eur&include_24hr_change=true`,{signal:AbortSignal.timeout(8000)});
    if(!r.ok) return null;
    const d=await r.json();
    if(!d[id]||!d[id].eur) return null;
    return {price:d[id].eur,chg:0,chgP:d[id].eur_24h_change||0,source:'CoinGecko'};
  }catch(e){ return null; }
}


async function syncPrices(){
  const positions=getPositions();
  if(!positions.length){ showToast('Geen posities om te verversen.'); return; }
  const btn=document.getElementById('sync-btn');
  const ico=document.getElementById('sync-ico');
  btn.classList.add('syncing'); ico.classList.add('spin');
  let ok=0, fail=0;

  // Splits crypto (CoinGecko) en de rest (server)
  const cryptoPos  = positions.filter(p=>CGMAP[p.ticker.toUpperCase()]);
  const serverPos  = positions.filter(p=>!CGMAP[p.ticker.toUpperCase()]);

  // Crypto via CoinGecko
  for(const p of cryptoPos){
    const q = await fetchCoinGecko(p.ticker);
    if(q){ prices[p.ticker]={price:q.price,chg:q.chg,chgP:q.chgP,source:q.source,ts:Date.now()}; ok++; }
    else fail++;
  }

  // Aandelen/ETFs — altijd via eigen server (FMP/yfinance aan serverkant)
  if(serverPos.length){
    if(getServerUrl()){
      const tickers = serverPos.map(p=>p.ticker);
      const data = await fetchPricesFromServer(tickers);
      for(const p of serverPos){
        const q = data[p.ticker];
        if(q){ prices[p.ticker]={price:q.price,chg:q.change,chgP:q.changePercent,source:q.source,ts:Date.now()}; ok++; }
        else fail++;
      }
    } else { fail+=serverPos.length; }
  }

  prices['_ts']=Date.now();
  saveLocal();
  const now=new Date().toLocaleTimeString('nl-BE',{hour:'2-digit',minute:'2-digit'});
  document.getElementById('last-sync').textContent='Bijgewerkt: '+now;
  const badge=document.getElementById('live-badge');
  badge.className='badge '+(fail===0?'live':'stale');
  badge.innerHTML=`<span class="pulse"></span>${fail===0?'Live':'Gedeeltelijk'} · ${now}`;
  btn.classList.remove('syncing'); ico.classList.remove('spin');
  showToast(`${ok} ticker${ok!==1?'s':''} bijgewerkt${fail?' · '+fail+' mislukt':''}`);
  renderAll();
  if(SB_OK) pushToSupabase();
}

// ═══════════════════════════════════
// NAVIGATIE
// ═══════════════════════════════════
let selectedRange='MAX';
let pieChart=null,lineChart=null,apChart=null,abChart=null,dbChart=null,dyChart=null;
let benchHistory=null;
let histPrices={};        // { ticker: { 'YYYY-MM-DD': closePrice } }
let histPricesLoaded=false;

// ── Hist-prijs localStorage-cache (TTL 23 uur) ───────────────────────
const _HIST_CACHE_KEY='arbo_hist';
const _HIST_TTL=23*3600*1000;
function _loadHistCache(){
  try{
    const raw=localStorage.getItem(_HIST_CACHE_KEY); if(!raw) return;
    const {d,ts}=JSON.parse(raw);
    if(Date.now()-ts>_HIST_TTL){ localStorage.removeItem(_HIST_CACHE_KEY); return; }
    Object.assign(histPrices,d);
  }catch(e){}
}
function _saveHistCache(){
  try{ localStorage.setItem(_HIST_CACHE_KEY,JSON.stringify({d:histPrices,ts:Date.now()})); }catch(e){}
}

function goTo(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  const map={dashboard:0,assets:1,dividends:2,transactions:3,cash:4,portfolios:5,watchlist:6};
  document.querySelectorAll('.ni')[map[id]].classList.add('active');
  const sub=document.getElementById('pf-sub');
  if(sub) sub.textContent=portfolios.length>1?pf().name:'Overzicht van je portefeuille';
  if(id==='dashboard')    renderAll();
  if(id==='assets')       renderAssets();
  if(id==='dividends')    renderDivPage();
  if(id==='transactions') renderTxList();
  if(id==='portfolios')   renderPfPage();
  if(id==='cash')         renderManualPage();
  if(id==='watchlist')    renderWatchlist();
  if(id==='transactions'){ updateCashPayOptions(); }
}

// ═══════════════════════════════════
// POSITIES & KOSTENBASIS (CORRECT)
// ═══════════════════════════════════
function getPositions(){
  const pos={};
  [...txs()].sort((a,b)=>a.date.localeCompare(b.date)).forEach(tx=>{
    if(!pos[tx.ticker]) pos[tx.ticker]={ticker:tx.ticker,name:tx.name||tx.ticker,qty:0,costBasis:0,totalFees:0};
    if(tx.type==='BUY'){
      // Kostenbasis = aankoopprijs × aantal + transactiekosten
      pos[tx.ticker].qty       += tx.qty;
      pos[tx.ticker].costBasis += tx.qty * tx.price + (tx.fee||0);
      pos[tx.ticker].totalFees += tx.fee||0;
    } else if(tx.type==='SELL'){
      // Bij verkoop: verminder kostenbasis proportioneel (FIFO-benadering)
      const avgCostPerUnit = pos[tx.ticker].qty ? pos[tx.ticker].costBasis / pos[tx.ticker].qty : 0;
      pos[tx.ticker].qty       -= tx.qty;
      pos[tx.ticker].costBasis -= tx.qty * avgCostPerUnit;
      if(pos[tx.ticker].qty < 0.000001) { pos[tx.ticker].qty=0; pos[tx.ticker].costBasis=0; }
    }
  });
  return Object.values(pos).filter(p=>p.qty>0.000001);
}

function lp(t){ return prices[t]?.price||null; }
function avgCostPerUnit(p){ return p.qty>0 ? p.costBasis/p.qty : 0; }

// ═══════════════════════════════════
// PORTFOLIO HISTORIEK
// ═══════════════════════════════════
function getPortfolioHistory(){
  const sorted=[...txs()].sort((a,b)=>a.date.localeCompare(b.date));
  if(!sorted.length) return [];
  const first=new Date(sorted[0].date);
  const today=new Date(); today.setHours(0,0,0,0);
  const days=[];
  for(let d=new Date(first);d<=today;d.setDate(d.getDate()+1))
    days.push(new Date(d).toISOString().slice(0,10));
  const txByDate={};
  sorted.forEach(tx=>{ if(!txByDate[tx.date]) txByDate[tx.date]=[]; txByDate[tx.date].push(tx); });
  const pos={};
  const hist=[];
  for(const day of days){
    if(txByDate[day]) txByDate[day].forEach(tx=>{
      if(!pos[tx.ticker]) pos[tx.ticker]={qty:0,lastPrice:tx.price};
      if(tx.type==='BUY'){ pos[tx.ticker].qty+=tx.qty; pos[tx.ticker].lastPrice=tx.price; }
      else pos[tx.ticker].qty=Math.max(0,pos[tx.ticker].qty-tx.qty);
    });
    let val=0;
    const isToday=day===days[days.length-1];
    Object.entries(pos).forEach(([t,v])=>{
      let price=null;
      // 1) Gebruik echte historische koers als die geladen is
      if(histPrices[t]){
        // Zoek de dichtstbijzijnde dag (op of voor 'day')
        const hp=histPrices[t];
        if(hp[day]) price=hp[day];
        else{
          // Kijk max 5 handelsdagen terug (weekend/feestdag)
          for(let back=1;back<=5&&!price;back++){
            const d2=new Date(day); d2.setDate(d2.getDate()-back);
            const ds=d2.toISOString().slice(0,10);
            if(hp[ds]) price=hp[ds];
          }
        }
      }
      // 2) Vandaag: gebruik live prijs
      if(!price && isToday && prices[t]) price=prices[t].price;
      // 3) Fallback: aankoopprijs (zodat er altijd een waarde is)
      if(!price) price=v.lastPrice;
      val+=v.qty*price;
    });
    if(val>0) hist.push({date:day,value:parseFloat(val.toFixed(2))});
  }
  return hist;
}

function filterHist(hist){
  if(!hist.length||selectedRange==='MAX') return hist;
  const today=new Date(); today.setHours(0,0,0,0);
  const first=new Date(hist[0].date);
  const cuts={'1W':7,'1M':30,'6M':182,'1Y':365};
  let cut;
  if(cuts[selectedRange]){ cut=new Date(today); cut.setDate(today.getDate()-cuts[selectedRange]); }
  else if(selectedRange==='YTD') cut=new Date(today.getFullYear(),0,1);
  else cut=first;
  if(cut<first) cut=first;
  return hist.filter(h=>h.date>=cut.toISOString().slice(0,10));
}

// ═══════════════════════════════════
// FORMAT
// ═══════════════════════════════════
// ── XSS escape — gebruik altijd voor user data in innerHTML ──
function esc(str){
  if(str===null||str===undefined) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#x27;');
}

function fmt(n){ return '€'+parseFloat(n||0).toLocaleString('nl-BE',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtPct(n){ return (n>=0?'+':'')+parseFloat(n||0).toFixed(2)+'%'; }
function fmtS(n){
  const v=parseFloat(n||0);
  if(Math.abs(v)>=1e6) return '€'+(v/1e6).toFixed(2)+'M';
  if(Math.abs(v)>=1e3) return '€'+(v/1e3).toFixed(1)+'K';
  return fmt(v);
}

// ═══════════════════════════════════
// METRICS (correct kostenbasis)
// ═══════════════════════════════════
function getTotalManualValue(){
  const c = (manualPositions.cash||[]).reduce((s,i)=>s+i.value,0);
  const a = (manualPositions.alts||[]).reduce((s,i)=>s+i.value,0);
  return c + a;
}

function renderMetrics(positions){
  let tv=0, totalInvested=0, totalFees=0;
  // CORRECTIE: cash/alts tellen MEE in vermogen maar NIET in winst/kostenbasis
  // Enkel beleggingen (aandelen, ETF, crypto) tellen voor P&L
  const cashTotal = (manualPositions.cash||[]).reduce((s,i)=>s+i.value,0);
  const altsTotal = (manualPositions.alts||[]).reduce((s,i)=>s+i.value,0);
  tv += cashTotal + altsTotal; // vermogen ja
  // cashTotal/altsTotal worden NIET opgeteld bij totalInvested → geen invloed op winst
  positions.forEach(p=>{
    const currency = tickerCurrency(p.ticker);
    const rawPrice = lp(p.ticker)??avgCostPerUnit(p);
    const price    = toEurSafe(rawPrice, p.ticker); // correcte EUR conversie incl. GBp
    // Aankoopprijs was in EUR (gebruiker voert in EUR in), geen conversie nodig
    tv            += p.qty*price;
    totalInvested += p.costBasis;
    totalFees     += p.totalFees||0;
  });
  const pnl=tv-cashTotal-altsTotal-totalInvested; // cash eruit voor P&L
  const pct=totalInvested?pnl/totalInvested*100:0;
  const divTot=myDivs().reduce((s,d)=>s+d.amount,0);
  const divYld=totalInvested?divTot/totalInvested*100:0;
  const feePct=totalInvested?totalFees/totalInvested*100:0;
  document.getElementById('m-total').textContent=fmt(tv);
  document.getElementById('m-total-chg').textContent='';
  document.getElementById('m-cost').textContent=totalFees>0?fmt(totalFees):'€0,00';
  const cp=document.getElementById('m-cost-pct');
  if(cp) cp.textContent=feePct>0?'-'+feePct.toFixed(3)+'% van investering':'Geen kosten geregistreerd';
  document.getElementById('m-pnl').textContent=fmt(pnl);
  const pe=document.getElementById('m-pct'); pe.textContent=fmtPct(pct); pe.className='chg '+(pnl>=0?'pos':'neg');
  document.getElementById('m-div').textContent=fmt(divTot);
  document.getElementById('m-divy').textContent=divYld.toFixed(2)+'% yield on cost';
  // Totaal rendement = P&L + dividenden
  const totRet = pnl + divTot;
  const totRetPct = totalInvested ? totRet/totalInvested*100 : 0;
  const tr = document.getElementById('m-totalret');
  const trp = document.getElementById('m-totalret-pct');
  if(tr) tr.textContent = fmt(totRet);
  if(trp){ trp.textContent = fmtPct(totRetPct); trp.className = 'chg '+(totRet>=0?'pos':'neg'); }
  const yoc = document.getElementById('m-yoc');
  if(yoc) yoc.textContent = totalInvested ? fmtPct(totRet/totalInvested*100) : '0%';
}

// ═══════════════════════════════════
// PIE CHART
// ═══════════════════════════════════
function renderPie(positions){
  const ctx=document.getElementById('pie-c').getContext('2d');
  const labels=[],vals=[],colors=[];
  let total=0;
  positions.forEach((p,i)=>{
    const price=toEurSafe(lp(p.ticker)??avgCostPerUnit(p), p.ticker), mv=p.qty*price;
    labels.push(p.ticker); vals.push(parseFloat(mv.toFixed(2))); colors.push(PC[i%PC.length]); total+=mv;
  });
  // Voeg cash toe als groep
  const cashTotal = (manualPositions.cash||[]).reduce((s,i)=>s+i.value,0);
  if(cashTotal>0){ labels.push('Cash'); vals.push(parseFloat(cashTotal.toFixed(2))); colors.push('#4d8fff'); total+=cashTotal; }
  // Voeg alternatieve investeringen toe als groep
  const altsTotal = (manualPositions.alts||[]).reduce((s,i)=>s+i.value,0);
  if(altsTotal>0){ labels.push('Alternatief'); vals.push(parseFloat(altsTotal.toFixed(2))); colors.push('#f0b429'); total+=altsTotal; }
  document.getElementById('dc-t').textContent=fmt(total);
  if(pieChart) pieChart.destroy();
  if(!positions.length){ document.getElementById('pie-leg').innerHTML='<span style="color:var(--text3)">Geen posities</span>'; return; }
  pieChart=new Chart(ctx,{type:'doughnut',
    data:{labels,datasets:[{data:vals,backgroundColor:colors,borderWidth:2,borderColor:'#111318',hoverBorderWidth:3}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'62%',
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+c.label+': '+fmt(c.raw)+' ('+(c.raw/total*100).toFixed(1)+'%)'}}}}
  });
  document.getElementById('pie-leg').innerHTML=labels.map((l,i)=>
    `<span><span class="ld" style="background:${colors[i]}"></span>${l} ${(vals[i]/total*100).toFixed(1)}%</span>`).join('');
}

// ═══════════════════════════════════
// LINE CHART — beide geïndexeerd op 100
// ═══════════════════════════════════
function buildRangeBtns(){
  const el=document.getElementById('rrow'); el.innerHTML='';
  ['1W','1M','6M','1Y','YTD','MAX'].forEach(r=>{
    const b=document.createElement('button');
    b.className='rp'+(r===selectedRange?' active':''); b.textContent=r;
    b.onclick=()=>{ selectedRange=r; buildRangeBtns(); renderLine(); };
    el.appendChild(b);
  });
}

function renderLine(){
  const hist=getPortfolioHistory();
  const filt=filterHist(hist);
  const showB=document.getElementById('bench-on')?.checked;
  const ctx=document.getElementById('line-c').getContext('2d');
  if(lineChart) lineChart.destroy();
  const legEl=document.getElementById('line-leg');
  legEl.innerHTML='';
  // Toon laad-indicator als historische koersen nog worden opgehaald
  if(!histPricesLoaded && getServerUrl()){
    legEl.innerHTML='<span style="color:var(--text2);font-size:11px">⏳ Historische koersen laden…</span>';
  }
  if(!filt.length) return;

  const labels=filt.map(h=>h.date);
  const portVals=filt.map(h=>h.value); // absolute € waarde
  const portStart=portVals[0]||1;

  const up=portVals[portVals.length-1]>=portStart;
  const portColor=up?'#00d4a0':'#ff5b6b';
  const portFill=up?'rgba(0,212,160,0.07)':'rgba(255,91,107,0.07)';

  const datasets=[{
    label:'Portefeuille',
    data:portVals,
    borderColor:portColor, backgroundColor:portFill,
    borderWidth:2, pointRadius:0, fill:true, tension:0.3
  }];

  let hasBench=false;
  if(showB && benchHistory){
    const s=labels[0], e=labels[labels.length-1];
    const bFiltered=benchHistory.labels
      .map((l,i)=>({l,v:benchHistory.vals[i]}))
      .filter(x=>x.l>=s&&x.l<=e);
    if(bFiltered.length){
      // Normaliseer benchmark zodat hij op dezelfde startwaarde begint als de portefeuille
      // Dit toont "wat zou €X in IWDA nu waard zijn?"
      const bBase=bFiltered[0].v||1;
      const bMap={};
      bFiltered.forEach(x=>bMap[x.l]=parseFloat(((x.v/bBase)*portStart).toFixed(2)));
      datasets.push({
        label:document.getElementById('bench-sym').value||'Benchmark',
        data:labels.map(d=>bMap[d]??null), spanGaps:true,
        borderColor:'#a78bfa', backgroundColor:'transparent',
        borderWidth:1.8, borderDash:[5,4], pointRadius:0, fill:false, tension:0.3
      });
      hasBench=true;
    }
  }

  const bSym=document.getElementById('bench-sym')?.value||'Benchmark';
  // legEl already declared above
  legEl.innerHTML=
    `<span><span class="ld" style="background:${portColor}"></span>Portefeuille (€)</span>`
    +(hasBench?`<span><span class="ld" style="background:#a78bfa;border-radius:0"></span>${bSym} (zelfde startwaarde)</span>`:'');

  lineChart=new Chart(ctx,{type:'line',data:{labels,datasets},
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{
          label:c=>' '+c.dataset.label+': '+fmt(c.raw)
        }}
      },
      scales:{
        x:{ticks:{maxTicksLimit:7,color:'#555870',font:{size:10}},grid:{color:'rgba(255,255,255,0.04)'},border:{display:false}},
        y:{ticks:{color:'#555870',font:{size:10},callback:v=>fmtS(v)},grid:{color:'rgba(255,255,255,0.04)'},border:{display:false}}
      }
    }
  });
}

// ═══════════════════════════════════
// POSITIETABEL
// ═══════════════════════════════════
function renderPosTable(positions){
  const el=document.getElementById('pos-tbl');
  if(!positions.length){ el.innerHTML='<div class="empty">Geen open posities. Voeg een transactie toe.</div>'; return; }
  const rows=positions.map(p=>{
    const acu=avgCostPerUnit(p);
    const _pCur=tickerCurrency(p.ticker);
    const livePr=lp(p.ticker);
    const livePrEur = livePr ? toEurSafe(livePr, p.ticker) : null;
    const price=livePrEur??acu; // gebruik EUR prijs (na USD->EUR conversie)
    const mv=p.qty*price;
    // P&L = marktwaarde (EUR) - kostenbasis (EUR)
    const pnl=mv-p.costBasis;
    const pct=p.costBasis?pnl/p.costBasis*100:0;
    const chgP=prices[p.ticker]?.chgP;
    const src=prices[p.ticker]?.source||'';
    const divT=myDivs().filter(d=>d.ticker===p.ticker).reduce((s,d)=>s+d.amount,0);
    const totRet=pnl+divT;
    const totPct=p.costBasis?totRet/p.costBasis*100:0;

    // Toon prijs in EUR (na conversie), met valuta-indicatie als niet EUR
    const dispPrice = livePrEur ?? null;
    const currLabel = (_pCur && _pCur !== 'EUR') ? ` <span style="font-size:9px;color:var(--text3)">${_pCur}→EUR</span>` : '';
    const priceCell=dispPrice
      ?`${fmt(dispPrice)}${currLabel}<span class="src">${src}</span>${chgP!=null?`<br><span style="font-size:11px;color:${chgP>=0?'var(--green)':'var(--red)'}">${chgP>=0?'+':''}${chgP.toFixed(2)}% vandaag</span>`:''}`
      :`<span style="color:var(--text3);font-size:11px">⟳ laden...</span>`;

    // Toon aankoopwaarde (=costBasis=totaal betaald) en prijs per eenheid apart
    // acu = gem. aankoopprijs PER EENHEID (costBasis / qty)
    return `<tr>
      <td style="font-family:'DM Mono',monospace;font-weight:500">${esc(p.ticker)}</td>
      <td style="color:var(--text2);font-size:12px">${esc(p.name)}</td>
      <td class="num">${p.qty.toLocaleString('nl-BE',{maximumFractionDigits:8})}</td>
      <td class="num">${fmt(acu)}<br><span style="font-size:10px;color:var(--text3)">per stuk</span></td>
      <td class="num">${fmt(p.costBasis)}</td>
      <td class="num">${priceCell}</td>
      <td class="num">${fmt(mv)}</td>
      <td class="${pnl>=0?'pos':'neg'}">${fmt(pnl)}<br><span style="font-size:11px">${fmtPct(pct)}</span></td>
      <td class="pos">${divT>0?fmt(divT):'—'}</td>
      <td class="${totRet>=0?'pos':'neg'}">${fmtPct(totPct)}</td>
    </tr>`;
  }).join('');
  el.innerHTML=`<table><thead><tr>
    <th>Ticker</th><th>Naam</th><th style="text-align:right">Aantal</th>
    <th style="text-align:right">Gem. aankoopprijs</th>
    <th style="text-align:right">Aankoopwaarde</th>
    <th style="text-align:right">Live prijs</th>
    <th style="text-align:right">Marktwaarde</th>
    <th style="text-align:right">P&L</th>
    <th style="text-align:right">Dividend</th>
    <th style="text-align:right">Totaal rendement</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

// ═══════════════════════════════════
// ASSET KLASSEN
// ═══════════════════════════════════
function renderAssets(){
  const positions=getPositions();
  const cats={}; let total=0;
  positions.forEach(p=>{
    const price=lp(p.ticker)??avgCostPerUnit(p), mv=p.qty*price;
    const cat=assetCls[p.ticker]||'Niet ingesteld';
    cats[cat]=(cats[cat]||0)+mv; total+=mv;
  });
  const arr=Object.entries(cats).sort((a,b)=>b[1]-a[1]);
  document.getElementById('ap-t').textContent=fmt(total);
  const colors=arr.map(([c])=>ACC[AC.indexOf(c)%ACC.length]||'#8b8fa8');

  const ctx1=document.getElementById('ap-c').getContext('2d');
  if(apChart) apChart.destroy();
  apChart=new Chart(ctx1,{type:'doughnut',
    data:{labels:arr.map(a=>a[0]),datasets:[{data:arr.map(a=>parseFloat(a[1].toFixed(2))),backgroundColor:colors,borderWidth:2,borderColor:'#111318'}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'62%',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+c.label+': '+fmt(c.raw)+' ('+(c.raw/total*100).toFixed(1)+'%)'}}}}
  });
  document.getElementById('ap-leg').innerHTML=arr.map(([cat,val],i)=>
    `<span><span class="ld" style="background:${colors[i]}"></span>${cat} ${(val/total*100).toFixed(1)}%</span>`).join('');

  const ctx2=document.getElementById('ab-c').getContext('2d');
  if(abChart) abChart.destroy();
  abChart=new Chart(ctx2,{type:'bar',
    data:{labels:arr.map(a=>a[0]),datasets:[{data:arr.map(a=>parseFloat(a[1].toFixed(2))),backgroundColor:colors,borderRadius:4,borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+fmt(c.raw)}}},
      scales:{x:{ticks:{color:'#555870',font:{size:10},callback:v=>fmtS(v)},grid:{color:'rgba(255,255,255,0.04)'},border:{display:false}},
        y:{ticks:{color:'#8b8fa8',font:{size:11}},grid:{display:false},border:{display:false}}}}
  });

  const el=document.getElementById('asset-tbl');
  if(!positions.length){ el.innerHTML='<div class="empty">Geen posities.</div>'; return; }

  // ── Allocatie & doelgewichten ────────────────────────────────────
  let html='<div class="alloc-section-title">Allocatie & rebalancering</div>';
  const relevantCats = AC.filter(cat => cats[cat]||assetTgt[cat]);
  if(cats['Niet ingesteld']) relevantCats.push('Niet ingesteld');

  relevantCats.forEach(cat=>{
    const idx   = AC.indexOf(cat);
    const color = idx>=0 ? ACC[idx%ACC.length] : '#8b8fa8';
    const cur   = total>0 ? (cats[cat]||0)/total*100 : 0;
    const tgt   = parseFloat(assetTgt[cat]||0);
    const hasTgt= tgt>0;
    const diff  = cur-tgt;
    const val   = cats[cat]||0;

    // Badge: groen (ok), goud (te veel), rood (te weinig), of waarschuwing
    let badgeClass='', badgeText='';
    if(cat==='Niet ingesteld'){
      badgeClass='warn'; badgeText='⚠ Wijs categorie toe';
    } else if(hasTgt){
      if(Math.abs(diff)<1){ badgeClass='ok'; badgeText='✓ op doel'; }
      else if(diff>0){ badgeClass='over'; badgeText='+'+diff.toFixed(1)+'% te veel'; }
      else { badgeClass='under'; badgeText=diff.toFixed(1)+'% te weinig'; }
    }

    // Rebalanceer-hint (alleen als doel ingesteld en afwijking ≥ 0.5%)
    let hintHtml='';
    if(hasTgt && total>0 && Math.abs(diff)>=0.5){
      const delta = (tgt/100*total) - val;
      const action= delta>0?'Koop':'Verkoop';
      const cls   = delta>0?'buy':'sell';
      hintHtml=`<div class="alloc-hint ${cls}">${action} ${fmt(Math.abs(delta))} om doel te bereiken</div>`;
    } else if(hasTgt && Math.abs(diff)<1){
      hintHtml=`<div class="alloc-hint ok">Geen actie nodig</div>`;
    }

    html+=`<div class="alloc-row">
      <div class="alloc-head">
        <span class="alloc-dot" style="background:${color}"></span>
        <span class="alloc-name">${cat}</span>
        <span class="alloc-pct">${cur.toFixed(1)}%</span>
        ${badgeText?`<span class="alloc-badge ${badgeClass}">${badgeText}</span>`:''}
        <span class="alloc-tgt-lbl">Doel %</span>
        <input type="number" min="0" max="100" step="1" value="${tgt||''}" placeholder="–"
          class="alloc-input" data-action="set-tgt" data-cat="${cat}">
        <span class="alloc-val">${val>0?fmt(val):''}</span>
      </div>
      <div class="alloc-bar-wrap">
        <div class="alloc-bar-cur" style="width:${Math.min(100,cur).toFixed(1)}%;background:${color}"></div>
        ${hasTgt?`<div class="alloc-bar-tgt" style="left:${Math.min(99.5,tgt).toFixed(1)}%"></div>`:''}
      </div>
      ${hintHtml}
    </div>`;
  });

  if(!relevantCats.length){
    html+='<div class="empty" style="padding:20px 0">Wijs categorieën toe aan posities om doelgewichten in te stellen.</div>';
  }

  // ── Categorie per positie ────────────────────────────────────────
  html+='<div class="alloc-section-title" style="margin-top:8px">Categorie per positie</div>';
  positions.forEach(p=>{
    const sel=assetCls[p.ticker]||'';
    const opts=['',...AC].map(c=>`<option value="${c}" ${c===sel?'selected':''}>${c||'— Kies categorie —'}</option>`).join('');
    html+=`<div class="txr">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-family:'DM Mono',monospace;font-weight:500;min-width:70px">${p.ticker}</span>
        <span style="color:var(--text2);font-size:12px">${p.name}</span>
      </div>
      <select data-action="set-ac" data-ticker="${p.ticker}"
        style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:5px 8px;color:var(--text);font-size:12px;font-family:'DM Sans',sans-serif;outline:none;min-width:155px">
        ${opts}
      </select>
    </div>`;
  });
  el.innerHTML=html;
}

function setAC(t,v){ if(v) assetCls[t]=v; else delete assetCls[t]; saveLocal(); if(SB_OK) pushToSupabase(); renderAssets(); showToast(t+' → '+(v||'Verwijderd')); }
function setTgt(c,v){ const n=parseFloat(v)||0; if(n>0) assetTgt[c]=n; else delete assetTgt[c]; saveLocal(); if(SB_OK) pushToSupabase(); }

// ═══════════════════════════════════
// DIVIDENDEN
// ═══════════════════════════════════
function addDiv(){
  const tick=document.getElementById('d-tick').value.trim().toUpperCase();
  const amt=parseFloat(document.getElementById('d-amt').value);
  const date=document.getElementById('d-date').value;
  const desc=document.getElementById('d-desc').value.trim();
  const msg=document.getElementById('d-msg');
  if(!tick||!amt||!date){ msg.className='msg err'; msg.textContent='Vul ticker, bedrag en datum in.'; return; }
  dividends.push({id:Date.now(),ticker:tick,amount:amt,date,desc,pfId:activeId});
  dividends.sort((a,b)=>a.date.localeCompare(b.date));
  saveLocal(); if(SB_OK) pushToSupabase();
  msg.className='msg ok'; msg.textContent='✓ Toegevoegd';
  ['d-tick','d-amt','d-desc'].forEach(id=>document.getElementById(id).value='');
  setTimeout(()=>msg.textContent='',3000);
  renderDivPage(); renderMetrics(getPositions()); renderPosTable(getPositions());
}

function delDiv(id){
  if(!confirm('Dividend verwijderen?')) return;
  dividends=dividends.filter(d=>String(d.id)!==String(id));
  saveLocal(); if(SB_OK) pushToSupabase(); renderDivPage(); renderMetrics(getPositions());
}

function renderDivPage(){
  const divs=myDivs();
  const tc=getPositions().reduce((s,p)=>s+p.costBasis,0);
  const tot=divs.reduce((s,d)=>s+d.amount,0);
  const yr=new Date().getFullYear();
  document.getElementById('dv-tot').textContent=fmt(tot);
  document.getElementById('dv-yr').textContent=fmt(divs.filter(d=>d.date.startsWith(yr)).reduce((s,d)=>s+d.amount,0));
  document.getElementById('dv-yoc').textContent=(tc?tot/tc*100:0).toFixed(2)+'%';

  const byT={}; divs.forEach(d=>byT[d.ticker]=(byT[d.ticker]||0)+d.amount);
  const tkArr=Object.entries(byT).sort((a,b)=>b[1]-a[1]);
  const ctx1=document.getElementById('db-c').getContext('2d');
  if(dbChart) dbChart.destroy();
  if(tkArr.length) dbChart=new Chart(ctx1,{type:'bar',
    data:{labels:tkArr.map(x=>x[0]),datasets:[{data:tkArr.map(x=>parseFloat(x[1].toFixed(2))),backgroundColor:PC,borderRadius:4,borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+fmt(c.raw)}}},
      scales:{x:{ticks:{color:'#8b8fa8',font:{size:11}},grid:{display:false},border:{display:false}},
        y:{ticks:{color:'#555870',font:{size:10},callback:v=>fmt(v)},grid:{color:'rgba(255,255,255,0.04)'},border:{display:false}}}}
  });

  const byY={}; divs.forEach(d=>{ const y=d.date.slice(0,4); byY[y]=(byY[y]||0)+d.amount; });
  const yrArr=Object.entries(byY).sort((a,b)=>a[0].localeCompare(b[0]));
  const ctx2=document.getElementById('dy-c').getContext('2d');
  if(dyChart) dyChart.destroy();
  if(yrArr.length) dyChart=new Chart(ctx2,{type:'bar',
    data:{labels:yrArr.map(x=>x[0]),datasets:[{data:yrArr.map(x=>parseFloat(x[1].toFixed(2))),backgroundColor:'#f0b429',borderRadius:4,borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+fmt(c.raw)}}},
      scales:{x:{ticks:{color:'#8b8fa8',font:{size:11}},grid:{display:false},border:{display:false}},
        y:{ticks:{color:'#555870',font:{size:10},callback:v=>fmt(v)},grid:{color:'rgba(255,255,255,0.04)'},border:{display:false}}}}
  });

  const el=document.getElementById('div-list');
  if(!divs.length){ el.innerHTML='<div class="empty">Nog geen dividenden geregistreerd.</div>'; return; }
  el.innerHTML=[...divs].reverse().map(d=>`
    <div class="txr">
      <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
        <span class="tag div">DIV</span>
        <span style="font-family:'DM Mono',monospace;font-weight:500">${d.ticker}</span>
        <span style="color:var(--text2);font-size:12px">${d.desc||''}</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px;font-size:12px;color:var(--text2);flex-shrink:0">
        <span style="font-family:'DM Mono',monospace;color:var(--gold)">${fmt(d.amount)}</span>
        <span>${d.date}</span>
        <button class="btn-d" data-action="del-div" data-id="${d.id}">✕</button>
      </div>
    </div>`).join('');
}

// ═══════════════════════════════════
// TRANSACTIES
// ═══════════════════════════════════

// ═══════════════════════════════════════════
// INGEBOUWDE TICKER DATABASE
// 300+ populaire tickers — werkt altijd offline
// s=symbol, n=naam, e=beurs
// ═══════════════════════════════════════════
const TICKER_DB = [
  // ══════════════════════════════════
  // US AANDELEN — MEGA CAP
  // ══════════════════════════════════
  {s:'AAPL',n:'Apple Inc.',e:'NASDAQ'},
  {s:'MSFT',n:'Microsoft Corp.',e:'NASDAQ'},
  {s:'NVDA',n:'NVIDIA Corp.',e:'NASDAQ'},
  {s:'GOOGL',n:'Alphabet Inc. A',e:'NASDAQ'},
  {s:'GOOG',n:'Alphabet Inc. C',e:'NASDAQ'},
  {s:'AMZN',n:'Amazon.com Inc.',e:'NASDAQ'},
  {s:'META',n:'Meta Platforms',e:'NASDAQ'},
  {s:'TSLA',n:'Tesla Inc.',e:'NASDAQ'},
  {s:'BRK.B',n:'Berkshire Hathaway B',e:'NYSE'},
  {s:'BRK.A',n:'Berkshire Hathaway A',e:'NYSE'},
  {s:'LLY',n:'Eli Lilly & Co.',e:'NYSE'},
  {s:'AVGO',n:'Broadcom Inc.',e:'NASDAQ'},
  {s:'JPM',n:'JPMorgan Chase & Co.',e:'NYSE'},
  {s:'V',n:'Visa Inc.',e:'NYSE'},
  {s:'UNH',n:'UnitedHealth Group',e:'NYSE'},
  {s:'XOM',n:'Exxon Mobil Corp.',e:'NYSE'},
  {s:'MA',n:'Mastercard Inc.',e:'NYSE'},
  {s:'COST',n:'Costco Wholesale',e:'NASDAQ'},
  {s:'PG',n:'Procter & Gamble',e:'NYSE'},
  {s:'JNJ',n:'Johnson & Johnson',e:'NYSE'},
  {s:'HD',n:'Home Depot Inc.',e:'NYSE'},
  {s:'ABBV',n:'AbbVie Inc.',e:'NYSE'},
  {s:'MRK',n:'Merck & Co.',e:'NYSE'},
  {s:'CVX',n:'Chevron Corp.',e:'NYSE'},
  {s:'CRM',n:'Salesforce Inc.',e:'NYSE'},
  {s:'BAC',n:'Bank of America',e:'NYSE'},
  {s:'AMD',n:'Advanced Micro Devices',e:'NASDAQ'},
  {s:'ORCL',n:'Oracle Corp.',e:'NYSE'},
  {s:'KO',n:'Coca-Cola Co.',e:'NYSE'},
  {s:'PEP',n:'PepsiCo Inc.',e:'NASDAQ'},
  {s:'ACN',n:'Accenture PLC',e:'NYSE'},
  {s:'TMO',n:'Thermo Fisher Scientific',e:'NYSE'},
  {s:'ADBE',n:'Adobe Inc.',e:'NASDAQ'},
  {s:'NFLX',n:'Netflix Inc.',e:'NASDAQ'},
  {s:'WMT',n:'Walmart Inc.',e:'NYSE'},
  {s:'TXN',n:'Texas Instruments',e:'NASDAQ'},
  {s:'INTC',n:'Intel Corp.',e:'NASDAQ'},
  {s:'QCOM',n:'Qualcomm Inc.',e:'NASDAQ'},
  {s:'IBM',n:'IBM Corp.',e:'NYSE'},
  {s:'GS',n:'Goldman Sachs',e:'NYSE'},
  {s:'MS',n:'Morgan Stanley',e:'NYSE'},
  {s:'WFC',n:'Wells Fargo & Co.',e:'NYSE'},
  {s:'C',n:'Citigroup Inc.',e:'NYSE'},
  {s:'BLK',n:'BlackRock Inc.',e:'NYSE'},
  {s:'SPGI',n:'S&P Global Inc.',e:'NYSE'},
  {s:'AXP',n:'American Express',e:'NYSE'},
  {s:'DE',n:'Deere & Company',e:'NYSE'},
  {s:'CAT',n:'Caterpillar Inc.',e:'NYSE'},
  {s:'MMM',n:'3M Co.',e:'NYSE'},
  {s:'GE',n:'General Electric',e:'NYSE'},
  {s:'BA',n:'Boeing Co.',e:'NYSE'},
  {s:'RTX',n:'Raytheon Technologies',e:'NYSE'},
  {s:'LMT',n:'Lockheed Martin',e:'NYSE'},
  {s:'NOC',n:'Northrop Grumman',e:'NYSE'},
  {s:'UPS',n:'United Parcel Service',e:'NYSE'},
  {s:'FDX',n:'FedEx Corp.',e:'NYSE'},
  {s:'DIS',n:'Walt Disney Co.',e:'NYSE'},
  {s:'CMCSA',n:'Comcast Corp.',e:'NASDAQ'},
  {s:'T',n:'AT&T Inc.',e:'NYSE'},
  {s:'VZ',n:'Verizon Communications',e:'NYSE'},
  {s:'TMUS',n:'T-Mobile US',e:'NASDAQ'},
  {s:'NKE',n:'Nike Inc.',e:'NYSE'},
  {s:'SBUX',n:'Starbucks Corp.',e:'NASDAQ'},
  {s:'MCD',n:"McDonald's Corp.",e:'NYSE'},
  {s:'YUM',n:'Yum! Brands',e:'NYSE'},
  {s:'CMG',n:'Chipotle Mexican Grill',e:'NYSE'},
  {s:'PM',n:'Philip Morris',e:'NYSE'},
  {s:'MO',n:'Altria Group',e:'NYSE'},
  {s:'PFE',n:'Pfizer Inc.',e:'NYSE'},
  {s:'MRNA',n:'Moderna Inc.',e:'NASDAQ'},
  {s:'BMY',n:'Bristol-Myers Squibb',e:'NYSE'},
  {s:'AMGN',n:'Amgen Inc.',e:'NASDAQ'},
  {s:'GILD',n:'Gilead Sciences',e:'NASDAQ'},
  {s:'ISRG',n:'Intuitive Surgical',e:'NASDAQ'},
  {s:'MDT',n:'Medtronic PLC',e:'NYSE'},
  {s:'SYK',n:'Stryker Corp.',e:'NYSE'},
  {s:'CVS',n:'CVS Health Corp.',e:'NYSE'},
  {s:'CI',n:'Cigna Group',e:'NYSE'},
  {s:'HUM',n:'Humana Inc.',e:'NYSE'},
  {s:'NEE',n:'NextEra Energy',e:'NYSE'},
  {s:'DUK',n:'Duke Energy Corp.',e:'NYSE'},
  {s:'SO',n:'Southern Co.',e:'NYSE'},
  {s:'D',n:'Dominion Energy',e:'NYSE'},
  {s:'AEP',n:'American Electric Power',e:'NASDAQ'},
  {s:'COP',n:'ConocoPhillips',e:'NYSE'},
  {s:'SLB',n:'Schlumberger Ltd.',e:'NYSE'},
  {s:'EOG',n:'EOG Resources',e:'NYSE'},
  {s:'PLD',n:'Prologis Inc.',e:'NYSE'},
  {s:'AMT',n:'American Tower Corp.',e:'NYSE'},
  {s:'CCI',n:'Crown Castle Inc.',e:'NYSE'},
  {s:'EQIX',n:'Equinix Inc.',e:'NASDAQ'},
  {s:'SPG',n:'Simon Property Group',e:'NYSE'},
  {s:'O',n:'Realty Income Corp.',e:'NYSE'},
  {s:'WELL',n:'Welltower Inc.',e:'NYSE'},
  {s:'PYPL',n:'PayPal Holdings',e:'NASDAQ'},
  {s:'SQ',n:'Block Inc.',e:'NYSE'},
  {s:'SHOP',n:'Shopify Inc.',e:'NYSE'},
  {s:'UBER',n:'Uber Technologies',e:'NYSE'},
  {s:'LYFT',n:'Lyft Inc.',e:'NASDAQ'},
  {s:'ABNB',n:'Airbnb Inc.',e:'NASDAQ'},
  {s:'SNOW',n:'Snowflake Inc.',e:'NYSE'},
  {s:'PLTR',n:'Palantir Technologies',e:'NYSE'},
  {s:'COIN',n:'Coinbase Global',e:'NASDAQ'},
  {s:'RIVN',n:'Rivian Automotive',e:'NASDAQ'},
  {s:'F',n:'Ford Motor Co.',e:'NYSE'},
  {s:'GM',n:'General Motors',e:'NYSE'},
  {s:'HOOD',n:'Robinhood Markets',e:'NASDAQ'},
  {s:'SOFI',n:'SoFi Technologies',e:'NASDAQ'},
  {s:'AFRM',n:'Affirm Holdings',e:'NASDAQ'},
  {s:'NET',n:'Cloudflare Inc.',e:'NYSE'},
  {s:'DDOG',n:'Datadog Inc.',e:'NASDAQ'},
  {s:'ZS',n:'Zscaler Inc.',e:'NASDAQ'},
  {s:'CRWD',n:'CrowdStrike Holdings',e:'NASDAQ'},
  {s:'PANW',n:'Palo Alto Networks',e:'NASDAQ'},
  {s:'FTNT',n:'Fortinet Inc.',e:'NASDAQ'},
  {s:'OKTA',n:'Okta Inc.',e:'NASDAQ'},
  {s:'TWLO',n:'Twilio Inc.',e:'NYSE'},
  {s:'ZM',n:'Zoom Video Communications',e:'NASDAQ'},
  {s:'DOCU',n:'DocuSign Inc.',e:'NASDAQ'},
  {s:'TEAM',n:'Atlassian Corp.',e:'NASDAQ'},
  {s:'WDAY',n:'Workday Inc.',e:'NASDAQ'},
  {s:'NOW',n:'ServiceNow Inc.',e:'NYSE'},
  {s:'HUBS',n:'HubSpot Inc.',e:'NYSE'},
  {s:'TTD',n:'Trade Desk Inc.',e:'NASDAQ'},
  {s:'APP',n:'AppLovin Corp.',e:'NASDAQ'},
  {s:'ARM',n:'Arm Holdings',e:'NASDAQ'},
  {s:'SMCI',n:'Super Micro Computer',e:'NASDAQ'},
  {s:'MU',n:'Micron Technology',e:'NASDAQ'},
  {s:'AMAT',n:'Applied Materials',e:'NASDAQ'},
  {s:'LRCX',n:'Lam Research',e:'NASDAQ'},
  {s:'KLAC',n:'KLA Corp.',e:'NASDAQ'},
  {s:'ASML',n:'ASML Holding (US)',e:'NASDAQ'},
  // ══════════════════════════════════
  // EURONEXT AMSTERDAM
  // ══════════════════════════════════
  {s:'ASML.AS',n:'ASML Holding',e:'AMS'},
  {s:'PHIA.AS',n:'Philips Electronics',e:'AMS'},
  {s:'HEIA.AS',n:'Heineken NV',e:'AMS'},
  {s:'INGA.AS',n:'ING Groep NV',e:'AMS'},
  {s:'ABN.AS',n:'ABN AMRO Bank',e:'AMS'},
  {s:'RAND.AS',n:'Randstad NV',e:'AMS'},
  {s:'NN.AS',n:'NN Group NV',e:'AMS'},
  {s:'AKZ.AS',n:'Akzo Nobel NV',e:'AMS'},
  {s:'WKL.AS',n:'Wolters Kluwer',e:'AMS'},
  {s:'AD.AS',n:'Ahold Delhaize',e:'AMS'},
  {s:'DSM.AS',n:'DSM-Firmenich',e:'AMS'},
  {s:'UMI.AS',n:'Umicore SA',e:'AMS'},
  {s:'URW.AS',n:'Unibail-Rodamco-Westfield',e:'AMS'},
  {s:'BESI.AS',n:'BE Semiconductor',e:'AMS'},
  {s:'TE.AS',n:'Technip Energies',e:'AMS'},
  {s:'IMCD.AS',n:'IMCD Group',e:'AMS'},
  {s:'LIGHT.AS',n:'Signify NV',e:'AMS'},
  {s:'AGN.AS',n:'Aegon NV',e:'AMS'},
  {s:'FLOWS.AS',n:'Fugro NV',e:'AMS'},
  {s:'TKWY.AS',n:'Just Eat Takeaway',e:'AMS'},
  {s:'ADYEN.AS',n:'Adyen NV',e:'AMS'},
  {s:'REN.AS',n:'RELX PLC',e:'AMS'},
  {s:'RDSA.AS',n:'Shell PLC',e:'AMS'},
  {s:'SHELL.AS',n:'Shell PLC',e:'AMS'},
  {s:'MT.AS',n:'ArcelorMittal',e:'AMS'},
  {s:'OCI.AS',n:'OCI NV',e:'AMS'},
  {s:'STLAM.AS',n:'Stellantis NV',e:'AMS'},
  // ══════════════════════════════════
  // EURONEXT BRUSSEL
  // ══════════════════════════════════
  {s:'ABI.BR',n:'AB InBev',e:'BRU'},
  {s:'SOLB.BR',n:'Solvay SA',e:'BRU'},
  {s:'UCB.BR',n:'UCB SA',e:'BRU'},
  {s:'KBC.BR',n:'KBC Group',e:'BRU'},
  {s:'ACKB.BR',n:'Ackermans & van Haaren',e:'BRU'},
  {s:'ARGX.BR',n:'argenx SE',e:'BRU'},
  {s:'COFB.BR',n:'Colruyt Group',e:'BRU'},
  {s:'GBLB.BR',n:'Groupe Bruxelles Lambert',e:'BRU'},
  {s:'PROXM.BR',n:'Proximus',e:'BRU'},
  {s:'WDP.BR',n:'Warehouses De Pauw',e:'BRU'},
  {s:'BPOST.BR',n:'bpost SA',e:'BRU'},
  {s:'LOTB.BR',n:'Lotus Bakeries',e:'BRU'},
  {s:'MELX.BR',n:'Melexis NV',e:'BRU'},
  {s:'ONTEX.BR',n:'Ontex Group',e:'BRU'},
  {s:'MELE.BR',n:'Melexis NV',e:'BRU'},
  {s:'BEFB.BR',n:'Befimmo SA',e:'BRU'},
  {s:'CARE.BR',n:'Care Property Invest',e:'BRU'},
  {s:'COMM.BR',n:'Compagnie du Bois Sauvage',e:'BRU'},
  {s:'EVS.BR',n:'EVS Broadcast Equipment',e:'BRU'},
  {s:'IEP.BR',n:'Iep Invest',e:'BRU'},
  {s:'QRF.BR',n:'Qrf City Retail',e:'BRU'},
  {s:'TINC.BR',n:'TINC Comm VA',e:'BRU'},
  {s:'VGP.BR',n:'VGP NV',e:'BRU'},
  {s:'XIOR.BR',n:'Xior Student Housing',e:'BRU'},
  // ══════════════════════════════════
  // XETRA (FRANKFURT/DUITSLAND)
  // ══════════════════════════════════
  {s:'SAP.DE',n:'SAP SE',e:'XETRA'},
  {s:'SIE.DE',n:'Siemens AG',e:'XETRA'},
  {s:'ALV.DE',n:'Allianz SE',e:'XETRA'},
  {s:'BMW.DE',n:'BMW AG',e:'XETRA'},
  {s:'MBG.DE',n:'Mercedes-Benz Group',e:'XETRA'},
  {s:'VOW3.DE',n:'Volkswagen AG (Vz)',e:'XETRA'},
  {s:'BAYN.DE',n:'Bayer AG',e:'XETRA'},
  {s:'BASF.DE',n:'BASF SE',e:'XETRA'},
  {s:'DTE.DE',n:'Deutsche Telekom',e:'XETRA'},
  {s:'DBK.DE',n:'Deutsche Bank',e:'XETRA'},
  {s:'MUV2.DE',n:'Munich Re',e:'XETRA'},
  {s:'DPW.DE',n:'Deutsche Post',e:'XETRA'},
  {s:'BAS.DE',n:'BASF SE',e:'XETRA'},
  {s:'RWE.DE',n:'RWE AG',e:'XETRA'},
  {s:'EOAN.DE',n:'E.ON SE',e:'XETRA'},
  {s:'IFX.DE',n:'Infineon Technologies',e:'XETRA'},
  {s:'HEN3.DE',n:'Henkel AG & Co.',e:'XETRA'},
  {s:'BEI.DE',n:'Beiersdorf AG',e:'XETRA'},
  {s:'ZAL.DE',n:'Zalando SE',e:'XETRA'},
  {s:'AIR.DE',n:'Airbus SE',e:'XETRA'},
  {s:'ADS.DE',n:'Adidas AG',e:'XETRA'},
  {s:'PUM.DE',n:'Puma SE',e:'XETRA'},
  {s:'DHER.DE',n:'Delivery Hero SE',e:'XETRA'},
  {s:'HFG.DE',n:'HelloFresh SE',e:'XETRA'},
  // ══════════════════════════════════
  // EURONEXT PARIJS
  // ══════════════════════════════════
  {s:'OR.PA',n:"L'Oreal SA",e:'PAR'},
  {s:'MC.PA',n:'LVMH',e:'PAR'},
  {s:'TTE.PA',n:'TotalEnergies SE',e:'PAR'},
  {s:'SAN.PA',n:'Sanofi SA',e:'PAR'},
  {s:'BNP.PA',n:'BNP Paribas',e:'PAR'},
  {s:'CS.PA',n:'AXA SA',e:'PAR'},
  {s:'AIR.PA',n:'Airbus SE',e:'PAR'},
  {s:'RI.PA',n:'Pernod Ricard',e:'PAR'},
  {s:'EL.PA',n:'EssilorLuxottica',e:'PAR'},
  {s:'VIE.PA',n:'Veolia Environnement',e:'PAR'},
  {s:'DG.PA',n:'Vinci SA',e:'PAR'},
  {s:'SGO.PA',n:'Compagnie de Saint-Gobain',e:'PAR'},
  {s:'RMS.PA',n:'Hermes International',e:'PAR'},
  {s:'CAP.PA',n:'Capgemini SE',e:'PAR'},
  {s:'GLE.PA',n:'Societe Generale',e:'PAR'},
  {s:'ACA.PA',n:'Credit Agricole',e:'PAR'},
  {s:'SU.PA',n:'Schneider Electric',e:'PAR'},
  {s:'ML.PA',n:'Michelin',e:'PAR'},
  // ══════════════════════════════════
  // LONDEN (LSE)
  // ══════════════════════════════════
  {s:'ULVR.L',n:'Unilever PLC',e:'LSE'},
  {s:'SHEL.L',n:'Shell PLC',e:'LSE'},
  {s:'BP.L',n:'BP PLC',e:'LSE'},
  {s:'GSK.L',n:'GSK PLC',e:'LSE'},
  {s:'AZN.L',n:'AstraZeneca PLC',e:'LSE'},
  {s:'HSBA.L',n:'HSBC Holdings',e:'LSE'},
  {s:'VOD.L',n:'Vodafone Group',e:'LSE'},
  {s:'LLOY.L',n:'Lloyds Banking Group',e:'LSE'},
  {s:'BARC.L',n:'Barclays PLC',e:'LSE'},
  {s:'NWG.L',n:'NatWest Group',e:'LSE'},
  {s:'RIO.L',n:'Rio Tinto Group',e:'LSE'},
  {s:'AAL.L',n:'Anglo American PLC',e:'LSE'},
  {s:'GLEN.L',n:'Glencore PLC',e:'LSE'},
  {s:'BT.A.L',n:'BT Group PLC',e:'LSE'},
  {s:'REL.L',n:'RELX PLC',e:'LSE'},
  {s:'EXPN.L',n:'Experian PLC',e:'LSE'},
  {s:'DGE.L',n:'Diageo PLC',e:'LSE'},
  {s:'CPG.L',n:'Compass Group PLC',e:'LSE'},
  {s:'TSCO.L',n:'Tesco PLC',e:'LSE'},
  {s:'MKS.L',n:'Marks and Spencer',e:'LSE'},
  // ══════════════════════════════════
  // OVERIGE EUROPESE BEURZEN
  // ══════════════════════════════════
  {s:'NOVO-B.CO',n:'Novo Nordisk B',e:'CPH'},
  {s:'MAERSK-B.CO',n:'AP Moller-Maersk B',e:'CPH'},
  {s:'NESN.SW',n:'Nestle SA',e:'SIX'},
  {s:'ROG.SW',n:'Roche Holding',e:'SIX'},
  {s:'NOVN.SW',n:'Novartis AG',e:'SIX'},
  {s:'UBSG.SW',n:'UBS Group AG',e:'SIX'},
  {s:'CSGN.SW',n:'Credit Suisse Group',e:'SIX'},
  {s:'ABBN.SW',n:'ABB Ltd.',e:'SIX'},
  {s:'ZURN.SW',n:'Zurich Insurance Group',e:'SIX'},
  {s:'LONN.SW',n:'Lonza Group',e:'SIX'},
  {s:'SIKA.SW',n:'Sika AG',e:'SIX'},
  // ══════════════════════════════════
  // POPULAIRE ETFs — WERELD
  // ══════════════════════════════════
  {s:'IWDA.AS',n:'iShares MSCI World ETF',e:'AMS'},
  {s:'EUNL.DE',n:'iShares Core MSCI World ETF',e:'XETRA'},
  {s:'IQQW.DE',n:'iShares MSCI World ETF',e:'XETRA'},
  {s:'VWCE.DE',n:'Vanguard FTSE All-World ETF',e:'XETRA'},
  {s:'VWRL.AS',n:'Vanguard FTSE All-World ETF',e:'AMS'},
  {s:'V3AA.AS',n:'Vanguard FTSE All-World ACC ETF',e:'AMS'},
  {s:'PHPM.AS',n:'WisdomTree Physical Precious Metals',e:'AMS'},
  {s:'COPM.AS',n:'WisdomTree Copper',e:'AMS'},
  {s:'VWCE.AS',n:'Vanguard FTSE All-World UCITS ETF',e:'AMS'},
  {s:'VAPX.AS',n:'Vanguard FTSE Developed Asia Pacific ETF',e:'AMS'},
  {s:'VFEM.AS',n:'Vanguard FTSE Emerging Markets ETF',e:'AMS'},
  {s:'VJPN.AS',n:'Vanguard FTSE Japan ETF',e:'AMS'},
  {s:'VUSA.AS',n:'Vanguard S&P 500 UCITS ETF',e:'AMS'},
  {s:'VNRT.AS',n:'Vanguard FTSE North America ETF',e:'AMS'},
  {s:'VEUR.AS',n:'Vanguard FTSE Developed Europe ETF',e:'AMS'},
  {s:'VMID.AS',n:'Vanguard FTSE 250 ETF',e:'AMS'},
  {s:'VHYL.AS',n:'Vanguard FTSE All-World High Dividend ETF',e:'AMS'},
  {s:'VAGF.AS',n:'Vanguard USD Corporate Bond ETF',e:'AMS'},
  {s:'VGOV.AS',n:'Vanguard UK Gilt ETF',e:'AMS'},
  {s:'SGLN.AS',n:'iShares Physical Gold ETC',e:'AMS'},
  {s:'SGLP.AS',n:'iShares Physical Gold ETC GBP',e:'AMS'},
  {s:'PHAU.AS',n:'WisdomTree Physical Gold',e:'AMS'},
  {s:'PHAG.AS',n:'WisdomTree Physical Silver',e:'AMS'},
  {s:'PHPD.AS',n:'WisdomTree Physical Palladium',e:'AMS'},
  {s:'PHPT.AS',n:'WisdomTree Physical Platinum',e:'AMS'},
  {s:'VZLD.AS',n:'WisdomTree Physical Silver',e:'AMS'},
  {s:'CSPX.AS',n:'iShares Core S&P 500 ETF',e:'AMS'},
  {s:'CSNDX.AS',n:'iShares Nasdaq-100 ETF',e:'AMS'},
  {s:'IMEU.AS',n:'iShares Core MSCI Europe ETF',e:'AMS'},
  {s:'EMIM.AS',n:'iShares Core MSCI EM IMI ETF',e:'AMS'},
  {s:'IEMM.AS',n:'iShares MSCI Emerging Markets ETF',e:'AMS'},
  {s:'IWDA.AS',n:'iShares Core MSCI World ETF',e:'AMS'},
  {s:'IWMO.AS',n:'iShares MSCI World Momentum ETF',e:'AMS'},
  {s:'IQQW.AS',n:'iShares MSCI World ETF',e:'AMS'},
  {s:'IUSQ.AS',n:'iShares MSCI ACWI ETF',e:'AMS'},
  {s:'DPYA.AS',n:'iShares Euro Dividend ETF',e:'AMS'},
  {s:'IEAA.AS',n:'iShares Euro Aggregate Bond ETF',e:'AMS'},
  {s:'AGGH.AS',n:'iShares Core Global Aggregate Bond ETF',e:'AMS'},
  {s:'IBTM.AS',n:'iShares USD Treasury Bond 7-10yr ETF',e:'AMS'},
  {s:'EQQQ.AS',n:'Invesco EQQQ Nasdaq-100 ETF',e:'AMS'},
  {s:'SPXS.AS',n:'SPDR S&P 500 ETF',e:'AMS'},
  {s:'SPWD.AS',n:'SPDR MSCI World ETF',e:'AMS'},
  {s:'ZPRV.AS',n:'SPDR MSCI USA Small Cap ETF',e:'AMS'},
  {s:'ZPRX.AS',n:'SPDR MSCI Europe Small Cap ETF',e:'AMS'},
  {s:'WSML.AS',n:'iShares MSCI World Small Cap ETF',e:'AMS'},
  {s:'IUSN.AS',n:'iShares MSCI World Small Cap ETF',e:'AMS'},
  {s:'QDVE.AS',n:'iShares S&P 500 Info Tech ETF',e:'AMS'},
  {s:'IUIT.AS',n:'iShares S&P 500 IT Sector ETF',e:'AMS'},
  {s:'HPRD.AS',n:'HSBC Physical Rhodium ETC',e:'AMS'},
  {s:'3HCL.AS',n:'WisdomTree Crude Oil 3x Leveraged',e:'AMS'},
  {s:'AEEM.AS',n:'Amundi MSCI Emerging Markets ETF',e:'AMS'},
  {s:'LCUI.AS',n:'Amundi S&P 500 ETF',e:'AMS'},
  {s:'CRB.AS',n:'iShares Commodities Select Strategy ETF',e:'AMS'},
  {s:'DBXW.AS',n:'Xtrackers MSCI World ETF',e:'AMS'},
  {s:'XDWD.DE',n:'Xtrackers MSCI World Swap ETF',e:'XETRA'},
  {s:'SPWD.AS',n:'SPDR MSCI World ETF',e:'AMS'},
  {s:'SWRD.AS',n:'SPDR MSCI World ETF USD',e:'AMS'},
  {s:'HMWO.L',n:'HSBC MSCI World ETF',e:'LSE'},
  // S&P 500 ETFs
  {s:'CSPX.AS',n:'iShares Core S&P 500 ETF',e:'AMS'},
  {s:'IUSA.AS',n:'iShares S&P 500 ETF',e:'AMS'},
  {s:'SXR8.DE',n:'iShares Core S&P 500 ETF',e:'XETRA'},
  {s:'XSPX.DE',n:'Xtrackers S&P 500 Swap ETF',e:'XETRA'},
  {s:'VUSA.AS',n:'Vanguard S&P 500 ETF',e:'AMS'},
  {s:'VUSD.AS',n:'Vanguard S&P 500 ETF USD',e:'AMS'},
  {s:'SPXS.DE',n:'SPDR S&P 500 ETF',e:'XETRA'},
  {s:'SPY',n:'SPDR S&P 500 ETF',e:'NYSE'},
  {s:'IVV',n:'iShares Core S&P 500 ETF',e:'NYSE'},
  {s:'VOO',n:'Vanguard S&P 500 ETF',e:'NYSE'},
  // Nasdaq ETFs
  {s:'EXXT.DE',n:'iShares Nasdaq-100 ETF',e:'XETRA'},
  {s:'NQSE.AS',n:'iShares Nasdaq-100 ETF',e:'AMS'},
  {s:'CSNDX.AS',n:'iShares Nasdaq-100 ETF',e:'AMS'},
  {s:'QQQ',n:'Invesco QQQ ETF',e:'NASDAQ'},
  {s:'QQQM',n:'Invesco Nasdaq-100 ETF',e:'NASDAQ'},
  // Opkomende markten ETFs
  {s:'EMIM.AS',n:'iShares Core MSCI EM IMI ETF',e:'AMS'},
  {s:'IEMM.AS',n:'iShares MSCI EM ETF',e:'AMS'},
  {s:'VFEM.AS',n:'Vanguard FTSE Emerging Markets ETF',e:'AMS'},
  {s:'VDEM.AS',n:'Vanguard FTSE Dev. World ETF',e:'AMS'},
  {s:'AEEM.AS',n:'Amundi MSCI Emerging Markets ETF',e:'AMS'},
  // Europa ETFs
  {s:'SXRV.DE',n:'iShares Core MSCI Europe ETF',e:'XETRA'},
  {s:'IMEU.AS',n:'iShares Core MSCI Europe ETF',e:'AMS'},
  {s:'MEUD.PA',n:'Lyxor Core MSCI Europe ETF',e:'PAR'},
  {s:'VEUR.AS',n:'Vanguard FTSE Developed Europe ETF',e:'AMS'},
  {s:'IEUR.AS',n:'iShares Core MSCI Europe ETF',e:'AMS'},
  // Technologie ETFs
  {s:'QDVE.DE',n:'iShares S&P 500 Info Tech ETF',e:'XETRA'},
  {s:'IITU.AS',n:'iShares S&P 500 Info Tech ETF',e:'AMS'},
  {s:'WCLD.AS',n:'WisdomTree Cloud Computing ETF',e:'AMS'},
  {s:'ETFM.AS',n:'iShares Automation & Robotics ETF',e:'AMS'},
  {s:'ESPO',n:'VanEck Esports & Gaming ETF',e:'NASDAQ'},
  // Dividend ETFs
  {s:'VHYL.AS',n:'Vanguard FTSE All-World High Div.',e:'AMS'},
  {s:'TDIV.AS',n:'VanEck Morningstar Dev Mrkt Div ETF',e:'AMS'},
  {s:'IDVY.AS',n:'iShares Euro Dividend ETF',e:'AMS'},
  {s:'EUdividend.AS',n:'SPDR S&P Euro Dividend Aristocrats',e:'AMS'},
  {s:'UDVD.AS',n:'SPDR S&P US Dividend Aristocrats',e:'AMS'},
  {s:'FGEQ.AS',n:'Fidelity Global Quality Income ETF',e:'AMS'},
  // Obligatie ETFs
  {s:'IEAA.AS',n:'iShares Euro Aggregate Bond ETF',e:'AMS'},
  {s:'AGGH.AS',n:'iShares Core Global Agg Bond ETF',e:'AMS'},
  {s:'PPFB.AS',n:'iShares Core Euro Corp Bond ETF',e:'AMS'},
  {s:'IBGS.AS',n:'iShares Euro Govt Bond 1-3yr ETF',e:'AMS'},
  {s:'IBTM.AS',n:'iShares USD Treasury Bond 7-10yr',e:'AMS'},
  {s:'SUAG.AS',n:'iShares USD Corp Bond ETF',e:'AMS'},
  {s:'TLT',n:'iShares 20+ Year Treasury Bond ETF',e:'NASDAQ'},
  {s:'BND',n:'Vanguard Total Bond Market ETF',e:'NYSE'},
  {s:'AGG',n:'iShares Core US Aggregate Bond ETF',e:'NYSE'},
  {s:'LQD',n:'iShares iBoxx Investment Grade ETF',e:'NYSE'},
  {s:'HYG',n:'iShares iBoxx High Yield Corp Bond',e:'NYSE'},
  // Goud & Grondstoffen ETFs
  {s:'PHAU.AS',n:'WisdomTree Physical Gold',e:'AMS'},
  {s:'SGLD.AS',n:'Invesco Physical Gold ETC',e:'AMS'},
  {s:'VZLD.AS',n:'WisdomTree Physical Silver',e:'AMS'},
  {s:'4GLD.DE',n:'Xetra-Gold ETC',e:'XETRA'},
  {s:'GZUR.SW',n:'ZKB Gold ETF',e:'SIX'},
  {s:'GLD',n:'SPDR Gold Shares ETF',e:'NYSE'},
  {s:'IAU',n:'iShares Gold Trust',e:'NYSE'},
  {s:'SLV',n:'iShares Silver Trust',e:'NYSE'},
  {s:'PDBC',n:'Invesco Optimum Yield Div. Comm.',e:'NASDAQ'},
  {s:'DJP',n:'iPath Bloomberg Commodity ETN',e:'NYSE'},
  {s:'GSG',n:'iShares S&P GSCI Commodity ETF',e:'NYSE'},
  {s:'USO',n:'United States Oil Fund ETF',e:'NYSE'},
  {s:'UNG',n:'United States Natural Gas Fund',e:'NYSE'},
  {s:'GLTR',n:'Aberdeen Physical PM Basket ETF',e:'NYSE'},
  // ESG ETFs
  {s:'ESGW.AS',n:'iShares MSCI World ESG Screened',e:'AMS'},
  {s:'SUSW.AS',n:'iShares MSCI World SRI ETF',e:'AMS'},
  {s:'MVGL.AS',n:'Amundi MSCI World SRI PAB ETF',e:'AMS'},
  {s:'IESW.AS',n:'iShares MSCI World SRI ETF',e:'AMS'},
  // Small Cap ETFs
  {s:'IUSN.DE',n:'iShares MSCI World Small Cap ETF',e:'XETRA'},
  {s:'WSML.AS',n:'iShares MSCI World Small Cap ETF',e:'AMS'},
  {s:'ZPRX.DE',n:'SPDR MSCI Europe Small Cap ETF',e:'XETRA'},
  {s:'IJR',n:'iShares Core S&P Small Cap ETF',e:'NYSE'},
  {s:'VB',n:'Vanguard Small-Cap ETF',e:'NYSE'},
  // Sector ETFs
  {s:'XLK',n:'Technology Select Sector SPDR ETF',e:'NYSE'},
  {s:'XLF',n:'Financial Select Sector SPDR ETF',e:'NYSE'},
  {s:'XLV',n:'Health Care Select Sector SPDR ETF',e:'NYSE'},
  {s:'XLE',n:'Energy Select Sector SPDR ETF',e:'NYSE'},
  {s:'XLI',n:'Industrial Select Sector SPDR ETF',e:'NYSE'},
  {s:'XLY',n:'Consumer Discret. Select Sector',e:'NYSE'},
  {s:'XLP',n:'Consumer Staples Select Sector',e:'NYSE'},
  {s:'XLU',n:'Utilities Select Sector SPDR ETF',e:'NYSE'},
  {s:'XLRE',n:'Real Estate Select Sector SPDR',e:'NYSE'},
  {s:'XLB',n:'Materials Select Sector SPDR ETF',e:'NYSE'},
  {s:'XLC',n:'Communication Services SPDR ETF',e:'NYSE'},
  // Vanguard populaire fondsen
  {s:'VTI',n:'Vanguard Total Stock Market ETF',e:'NYSE'},
  {s:'VEA',n:'Vanguard Developed Markets ETF',e:'NYSE'},
  {s:'VWO',n:'Vanguard Emerging Markets ETF',e:'NYSE'},
  {s:'VGK',n:'Vanguard FTSE Europe ETF',e:'NYSE'},
  {s:'VPL',n:'Vanguard FTSE Pacific ETF',e:'NYSE'},
  {s:'VT',n:'Vanguard Total World Stock ETF',e:'NYSE'},
  {s:'BNDX',n:'Vanguard Total Intl Bond ETF',e:'NASDAQ'},
  {s:'VXUS',n:'Vanguard Total Intl Stock ETF',e:'NASDAQ'},
  // ══════════════════════════════════
  // CRYPTO
  // ══════════════════════════════════
  {s:'BTC-EUR',n:'Bitcoin (EUR)',e:'Crypto'},
  {s:'ETH-EUR',n:'Ethereum (EUR)',e:'Crypto'},
  {s:'BNB-EUR',n:'BNB (EUR)',e:'Crypto'},
  {s:'SOL-EUR',n:'Solana (EUR)',e:'Crypto'},
  {s:'XRP-EUR',n:'Ripple (EUR)',e:'Crypto'},
  {s:'ADA-EUR',n:'Cardano (EUR)',e:'Crypto'},
  {s:'DOGE-EUR',n:'Dogecoin (EUR)',e:'Crypto'},
  {s:'DOT-EUR',n:'Polkadot (EUR)',e:'Crypto'},
  {s:'MATIC-EUR',n:'Polygon (EUR)',e:'Crypto'},
  {s:'LINK-EUR',n:'Chainlink (EUR)',e:'Crypto'},
  {s:'LTC-EUR',n:'Litecoin (EUR)',e:'Crypto'},
  {s:'AVAX-EUR',n:'Avalanche (EUR)',e:'Crypto'},
  {s:'UNI-EUR',n:'Uniswap (EUR)',e:'Crypto'},
  {s:'ATOM-EUR',n:'Cosmos (EUR)',e:'Crypto'},
  {s:'SHIB-EUR',n:'Shiba Inu (EUR)',e:'Crypto'},
  {s:'TRX-EUR',n:'Tron (EUR)',e:'Crypto'},
  {s:'NEAR-EUR',n:'NEAR Protocol (EUR)',e:'Crypto'},
  {s:'APT-EUR',n:'Aptos (EUR)',e:'Crypto'},
  {s:'OP-EUR',n:'Optimism (EUR)',e:'Crypto'},
  {s:'ARB-EUR',n:'Arbitrum (EUR)',e:'Crypto'},
  {s:'BTC-USD',n:'Bitcoin (USD)',e:'Crypto'},
  {s:'ETH-USD',n:'Ethereum (USD)',e:'Crypto'},
  {s:'SOL-USD',n:'Solana (USD)',e:'Crypto'},
  // ══════════════════════════════════
  // GRONDSTOFFEN (FUTURES)
  // ══════════════════════════════════
  {s:'GC=F',n:'Goud Futures',e:'CME'},
  {s:'SI=F',n:'Zilver Futures',e:'CME'},
  {s:'HG=F',n:'Koper Futures',e:'CME'},
  {s:'CL=F',n:'Ruwe Olie WTI Futures',e:'CME'},
  {s:'BZ=F',n:'Brent Olie Futures',e:'CME'},
  {s:'NG=F',n:'Aardgas Futures',e:'CME'},
  {s:'ZW=F',n:'Tarwe Futures',e:'CME'},
  {s:'ZC=F',n:'Mais Futures',e:'CME'},
  {s:'ZS=F',n:'Soja Futures',e:'CME'},
  {s:'PL=F',n:'Platina Futures',e:'CME'},
  {s:'PA=F',n:'Palladium Futures',e:'CME'},
];


// ═══════════════════════════════════════════
// TICKER ZOEKEN
// ═══════════════════════════════════════════
let searchTimer = null;
let selectedSymbol = null;

function searchTicker(query){
  var dd = document.getElementById('search-dropdown');
  clearTimeout(searchTimer);
  if(!query || query.length < 2){ dd.style.display='none'; return; }

  // Zoek eerst lokaal in ingebouwde lijst
  var q = query.toUpperCase();
  var local = TICKER_DB.filter(function(t){
    return t.s.toUpperCase().indexOf(q) === 0 ||
           t.n.toUpperCase().indexOf(q) === 0;
  }).slice(0, 12);

  dd.style.display = 'block';

  if(local.length > 0){
    // Toon lokale resultaten direct
    showSearchResults(dd, local);
    // Probeer ook server op achtergrond voor meer resultaten
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ fetchServerSearch(query, dd); }, 800);
  } else {
    // Geen lokale resultaten — zoek via server
    dd.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:var(--text3)">Zoeken...</div>';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ fetchServerSearch(query, dd); }, 400);
  }
}

function showSearchResults(dd, items){
  dd.innerHTML = '';
  items.forEach(function(item){
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border)';
    var sym = item.s || item.symbol || '';
    var name = item.n || item.name || '';
    var exch = item.e || item.exchange || '';
    row.innerHTML =
      '<span style="font-family:DM Mono,monospace;font-weight:500;font-size:13px;min-width:90px;color:var(--text)">' + esc(sym) + '</span>' +
      '<span style="font-size:12px;color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(name) + '</span>' +
      '<span style="font-size:10px;color:var(--text3);background:var(--bg3);padding:2px 7px;border-radius:4px;flex-shrink:0">' + esc(exch) + '</span>';
    row.addEventListener('mouseover', function(){ this.style.background='var(--bg3)'; });
    row.addEventListener('mouseout',  function(){ this.style.background=''; });
    row.addEventListener('click', function(){ pickTicker(sym, name, exch); });
    dd.appendChild(row);
  });
}

function fetchServerSearch(query, dd){
  var serverUrl = getServerUrl();
  if(!serverUrl) return;
  fetch(serverUrl + '/search?q=' + encodeURIComponent(query), {
    signal: AbortSignal.timeout(30000)
  })
  .then(function(r){ if(!r.ok) return null; return r.json(); })
  .then(function(items){
    if(!items || !Array.isArray(items) || items.length === 0) return;
    showSearchResults(dd, items);
  })
  .catch(function(){});
}


function pickTicker(symbol, name, exchange){
  document.getElementById('tx-tick').value = symbol;
  document.getElementById('tx-name').value = name;
  document.getElementById('search-dropdown').style.display = 'none';
  selectedSymbol = symbol;
  document.getElementById('tx-qty').focus();
}

function hideSearchResults(){
  setTimeout(function(){ document.getElementById('search-dropdown').style.display='none'; }, 200);
}

// ── Dividend ticker zoekfunctie ─────────────────────────────────────
let _divSearchTimer;
function searchDivTicker(query){
  const dd = document.getElementById('div-search-dropdown');
  clearTimeout(_divSearchTimer);
  if(!query || query.length < 2){ dd.style.display='none'; return; }
  const q = query.toUpperCase();
  const local = TICKER_DB.filter(t =>
    t.s.toUpperCase().indexOf(q) === 0 || t.n.toUpperCase().indexOf(q) === 0
  ).slice(0, 10);
  dd.style.display = 'block';
  if(local.length > 0){
    _showDivResults(dd, local);
    _divSearchTimer = setTimeout(() => _fetchDivSearch(query, dd), 800);
  } else {
    dd.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:var(--text3)">Zoeken...</div>';
    _divSearchTimer = setTimeout(() => _fetchDivSearch(query, dd), 400);
  }
}

function _showDivResults(dd, items){
  dd.innerHTML = '';
  items.forEach(function(item){
    const sym = item.s || item.symbol || '';
    const name = item.n || item.name || '';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border)';
    row.innerHTML = '<span style="font-family:DM Mono,monospace;font-weight:500;font-size:13px;min-width:90px;color:var(--text)">' + esc(sym) + '</span>' +
      '<span style="font-size:12px;color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(name) + '</span>';
    row.addEventListener('mouseover', function(){ this.style.background='var(--bg3)'; });
    row.addEventListener('mouseout',  function(){ this.style.background=''; });
    row.addEventListener('click', function(){ pickDivTicker(sym); });
    dd.appendChild(row);
  });
}

function _fetchDivSearch(query, dd){
  const serverUrl = getServerUrl();
  if(!serverUrl) return;
  fetch(serverUrl + '/search?q=' + encodeURIComponent(query), { signal: AbortSignal.timeout(10000) })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(items){ if(items && items.length) _showDivResults(dd, items); })
    .catch(function(){});
}

function pickDivTicker(sym){
  document.getElementById('d-tick').value = sym;
  document.getElementById('div-search-dropdown').style.display = 'none';
}


// Prijsmodus: 'unit' = per stuk, 'total' = totale aankoopwaarde
let _priceMode = 'unit';

function togglePriceMode(){
  _priceMode = _priceMode === 'unit' ? 'total' : 'unit';
  document.getElementById('price-mode-lbl').textContent = _priceMode === 'unit' ? '(per stuk)' : '(totaal)';
  document.getElementById('tx-price').placeholder = _priceMode === 'unit' ? '150.00' : '1558.74';
  updatePriceHint();
}

function updatePriceHint(){
  const hint = document.getElementById('price-hint');
  if(!hint) return;
  const qty = parseFloat(document.getElementById('tx-qty').value)||0;
  const price = parseFloat(document.getElementById('tx-price').value)||0;
  if(!qty || !price){ hint.textContent=''; return; }
  if(_priceMode === 'total'){
    const perUnit = price / qty;
    hint.textContent = `= ${perUnit.toLocaleString('nl-BE',{minimumFractionDigits:2,maximumFractionDigits:6})} per stuk`;
  } else {
    const total = qty * price;
    hint.textContent = `= ${total.toLocaleString('nl-BE',{minimumFractionDigits:2,maximumFractionDigits:2})} totaal`;
  }
}

function addTx(){
  const type=document.getElementById('tx-type').value;
  const tick=document.getElementById('tx-tick').value.trim().toUpperCase();
  const name=document.getElementById('tx-name').value.trim();
  const qty=parseFloat(document.getElementById('tx-qty').value);
  const rawPrice=parseFloat(document.getElementById('tx-price').value);
  // Als totale modus: bereken prijs per stuk
  const price = _priceMode === 'total' ? rawPrice / qty : rawPrice;
  const fee=parseFloat(document.getElementById('tx-fee').value)||0;
  const date=document.getElementById('tx-date').value;
  const msg=document.getElementById('tx-msg');
  // Input validatie: ticker alleen letters, cijfers, punt, koppelteken
  if(!tick || !/^[A-Z0-9.\-]{1,20}$/.test(tick)){
    msg.className='msg err'; msg.textContent='Ongeldige ticker (max 20 tekens, letters/cijfers/.-).'; return;
  }
  if(!qty||!price||!date){ msg.className='msg err'; msg.textContent='Vul alle verplichte velden in.'; return; }
  if(qty<=0||price<=0){ msg.className='msg err'; msg.textContent='Aantal en prijs moeten positief zijn.'; return; }
  const totalCost = qty*price+fee;
  // Cash betaling: verminder saldo van gekozen cashrekening
  const cashSrcIdx = document.getElementById('tx-cash-src')?.value;
  if(cashSrcIdx!=='' && cashSrcIdx!==undefined && cashSrcIdx!==null){
    const idx=parseInt(cashSrcIdx);
    const cashItems=manualPositions.cash||[];
    if(cashItems[idx]){
      if(cashItems[idx].value < totalCost){
        msg.className='msg err';
        msg.textContent=`Onvoldoende saldo op ${cashItems[idx].name} (${fmt(cashItems[idx].value)}).`;
        return;
      }
      cashItems[idx].value = parseFloat((cashItems[idx].value - totalCost).toFixed(2));
      saveManual();
    }
  }
  pf().transactions.push({type,ticker:tick,name,qty,price,fee,date});
  pf().transactions.sort((a,b)=>a.date.localeCompare(b.date));
  saveLocal(); if(SB_OK) pushToSupabase();
  msg.className='msg ok'; msg.textContent='✓ Toegevoegd';
  document.getElementById('tx-tick').value='';
  document.getElementById('tx-name').value='';
  document.getElementById('tx-qty').value='';
  document.getElementById('tx-price').value='';
  _priceMode = 'unit';
  document.getElementById('price-mode-lbl').textContent = '(per stuk)';
  document.getElementById('price-hint').textContent = '';
  selectedSymbol=null;
  document.getElementById('tx-fee').value='0';
  if(document.getElementById('tx-cash-src')) document.getElementById('tx-cash-src').value='';
  setTimeout(()=>msg.textContent='',3000);
  renderAll(); renderTxList();
}

function delTx(i){
  if(!confirm('Transactie verwijderen?')) return;
  pf().transactions.splice(i,1); saveLocal(); if(SB_OK) pushToSupabase(); renderAll(); renderTxList();
}

function renderTxList(){
  const el=document.getElementById('tx-list'), t=txs();
  if(!t.length){ el.innerHTML='<div class="empty">Geen transacties.</div>'; return; }
  el.innerHTML=[...t].reverse().map((tx,ri)=>{
    const i=t.length-1-ri;
    return `<div class="txr">
      <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
        <span class="tag ${esc(tx.type.toLowerCase())}">${esc(tx.type)}</span>
        <span style="font-family:'DM Mono',monospace;font-weight:500">${esc(tx.ticker)}</span>
        <span style="color:var(--text2);font-size:12px;overflow:hidden;text-overflow:ellipsis">${esc(tx.name||'')}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text2);flex-shrink:0">
        <span style="font-family:'DM Mono',monospace">${tx.qty.toLocaleString('nl-BE',{maximumFractionDigits:6})} × ${fmt(tx.price)}${tx.fee?` + ${fmt(tx.fee)} kst`:''}</span>
        <span style="min-width:88px;text-align:right">${tx.date}</span>
        <button class="btn-d" data-action="del-tx" data-idx="${i}">✕</button>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════
// PORTEFEUILLES — met modal (geen prompt)
// ═══════════════════════════════════
let pfModalMode='new', pfModalTargetId=null;

function openPfModal(mode='new', id=null, currentName=''){
  pfModalMode=mode; pfModalTargetId=id;
  const title=document.getElementById('pf-modal-title');
  const sub=document.getElementById('pf-modal-sub');
  const nameEl=document.getElementById('pf-modal-name');
  const confirm=document.getElementById('pf-modal-confirm');
  if(mode==='new'){
    title.textContent='Nieuwe portefeuille';
    sub.textContent='Kies een naam voor je portefeuille.';
    nameEl.value='';
    confirm.textContent='Aanmaken';
  } else {
    title.textContent='Hernoemen';
    sub.textContent='Voer een nieuwe naam in.';
    nameEl.value=currentName;
    confirm.textContent='Opslaan';
  }
  document.getElementById('pf-modal').classList.add('open');
  setTimeout(()=>nameEl.focus(),100);
}

function closePfModal(){ document.getElementById('pf-modal').classList.remove('open'); }
document.getElementById('pf-modal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closePfModal(); });
document.getElementById('pf-modal-name').addEventListener('keydown',e=>{ if(e.key==='Enter') confirmPfModal(); });

function confirmPfModal(){
  const name=document.getElementById('pf-modal-name').value.trim();
  if(!name){ document.getElementById('pf-modal-name').style.borderColor='var(--red)'; return; }
  document.getElementById('pf-modal-name').style.borderColor='';
  if(pfModalMode==='new'){
    const id='pf_'+Date.now();
    portfolios.push({id,name,transactions:[],created:Date.now()});
    showToast('Portefeuille "'+name+'" aangemaakt');
  } else {
    const p=portfolios.find(x=>x.id===pfModalTargetId);
    if(p){ p.name=name; showToast('Hernoemd naar "'+name+'"'); }
  }
  saveLocal(); if(SB_OK) pushToSupabase();
  closePfModal(); renderPfPage();
}

function switchPf(id){
  activeId=id; saveLocal(); renderAll(); renderTxList(); goTo('dashboard');
  showToast('Portefeuille: '+pf().name);
}

function delPf(id){
  if(portfolios.length<=1){ showToast('Minimaal één portefeuille vereist.'); return; }
  const p=portfolios.find(x=>x.id===id);
  if(!confirm(`Portefeuille "${p.name}" en alle transacties verwijderen?`)) return;
  portfolios=portfolios.filter(x=>x.id!==id);
  if(activeId===id) activeId=portfolios[0].id;
  saveLocal(); if(SB_OK) pushToSupabase(); renderPfPage(); renderAll();
}

// ═══════════════════════════════════════════
// HANDMATIGE POSITIES (CASH + ALTERNATIEF)
// ═══════════════════════════════════════════

function renderManualPage(){
  const positions = getPositions();
  const grandTotal = positions.reduce((s,p)=>s+(p.qty*(lp(p.ticker)||avgCostPerUnit(p))),0) + getTotalManualValue();

  // Cash
  const cashItems = manualPositions.cash||[];
  const cashTotal = cashItems.reduce((s,i)=>s+i.value,0);
  const el_ct = document.getElementById('cash-total');
  if(el_ct) el_ct.textContent = fmt(cashTotal);

  // Alternatief
  const altsItems = manualPositions.alts||[];
  const altsTotal = altsItems.reduce((s,i)=>s+i.value,0);
  const el_at = document.getElementById('alts-total');
  if(el_at) el_at.textContent = fmt(altsTotal);

  // Gecombineerd
  const el_mc = document.getElementById('manual-combined');
  if(el_mc) el_mc.textContent = fmt(cashTotal + altsTotal);

  // % van vermogen
  const el_pct = document.getElementById('cash-pct');
  if(el_pct) el_pct.textContent = grandTotal ? ((cashTotal+altsTotal)/grandTotal*100).toFixed(1)+'%' : '0%';

  // Render cash lijst
  const cashList = document.getElementById('cash-list');
  if(cashList) cashList.innerHTML = renderManualList(cashItems, 'cash');

  // Render alts lijst
  const altsList = document.getElementById('alts-list');
  if(altsList) altsList.innerHTML = renderManualList(altsItems, 'alts');
}

function renderManualList(items, type){
  if(!items.length) return '<div class="empty">Nog geen posities. Klik op "+ Toevoegen".</div>';
  return items.map(item => `
    <div class="manual-item">
      <div style="flex:1;min-width:0">
        <div class="mi-name">${item.name}</div>
        ${item.subcat ? `<div style="font-size:11px;color:var(--blue)">${item.subcat}</div>` : ''}
        ${item.note ? `<div style="font-size:11px;color:var(--text3);font-style:italic">"${item.note}"</div>` : ''}
        <div style="font-size:10px;color:var(--text3);margin-top:3px">Bijgewerkt: ${item.updated||'—'}</div>
      </div>
      <div class="mi-val" style="margin:0 16px;font-size:15px">${fmt(item.value)}</div>
      <div class="mi-acts">
        <button class="edit-btn" data-action="edit-manual" data-type="${type}" data-id="${item.id}">✎ Bewerken</button>
        <button class="del-btn" data-action="del-manual" data-type="${type}" data-id="${item.id}">✕</button>
      </div>
    </div>`).join('');
}

function openManualModal(type, editId=null){
  manualModalType = type;
  manualEditId = editId;
  const isCash = type === 'cash';
  const title = document.getElementById('manual-modal-title');
  const sub   = document.getElementById('manual-modal-sub');
  const nameEl  = document.getElementById('manual-name');
  const valueEl = document.getElementById('manual-value');
  const subcatEl = document.getElementById('manual-subcat');
  const noteEl  = document.getElementById('manual-note');
  const errEl   = document.getElementById('manual-err');

  title.textContent = editId
    ? (isCash ? 'Cashpositie bewerken' : 'Investering bewerken')
    : (isCash ? 'Cashpositie toevoegen' : 'Alternatieve investering toevoegen');
  sub.textContent = isCash
    ? 'Voeg een spaarrekening, zichtrekening of cashreserve toe.'
    : 'Voeg een collectible, kunstwerk, horloge of andere alternatieve investering toe.';

  document.getElementById('manual-subcat').placeholder = isCash
    ? 'bv. Zichtrekening / Spaarrekening / Noodbuffer'
    : 'bv. Pokémon / Horloge / Kunst / Whisky';

  errEl.textContent = '';

  if(editId){
    const item = (manualPositions[type]||[]).find(i=>i.id===editId);
    if(item){
      nameEl.value  = item.name;
      valueEl.value = item.value;
      subcatEl.value = item.subcat||'';
      noteEl.value  = item.note||'';
    }
  } else {
    nameEl.value=''; valueEl.value=''; subcatEl.value=''; noteEl.value='';
  }

  document.getElementById('manual-modal').classList.add('open');
  setTimeout(()=>nameEl.focus(), 100);
}

function closeManualModal(){
  document.getElementById('manual-modal').classList.remove('open');
}

document.getElementById('manual-modal').addEventListener('click', e=>{
  if(e.target===e.currentTarget) closeManualModal();
});

async function confirmManualModal(){
  const name  = document.getElementById('manual-name').value.trim();
  const value = parseFloat(document.getElementById('manual-value').value);
  const subcat = document.getElementById('manual-subcat').value.trim();
  const note  = document.getElementById('manual-note').value.trim();
  const errEl = document.getElementById('manual-err');

  if(!name){ errEl.textContent='Vul een naam in.'; return; }
  if(isNaN(value)||value<0){ errEl.textContent='Vul een geldig bedrag in.'; return; }

  const now = new Date().toLocaleDateString('nl-BE');

  if(manualEditId){
    const items = manualPositions[manualModalType]||[];
    const idx = items.findIndex(i=>i.id===manualEditId);
    if(idx>=0){
      items[idx] = {...items[idx], name, value, subcat, note, updated:now};
    }
  } else {
    if(!manualPositions[manualModalType]) manualPositions[manualModalType]=[];
    manualPositions[manualModalType].push({
      id: 'manual_'+Date.now(),
      name, value, subcat, note,
      updated: now,
    });
  }

  saveManual();
  closeManualModal();
  renderManualPage(manualModalType);
  renderAll();
  showToast((manualModalType==='cash'?'Cash':'Investering')+' opgeslagen ✓');
  await _pushManualOnly(); // awaited: data staat zeker in Supabase voor refresh
}

async function deleteManualItem(type, id){
  if(!confirm('Positie verwijderen?')) return;
  manualPositions[type] = (manualPositions[type]||[]).filter(i=>String(i.id)!==String(id));
  saveManual();
  renderManualPage(type);
  renderAll();
  await _pushManualOnly();
}

function renderPfPage(){
  document.getElementById('pf-cards').innerHTML=portfolios.map(p=>{
    const isAct=p.id===activeId;
    const pos={}; let tv=0,tc=0;
    p.transactions.forEach(tx=>{
      if(!pos[tx.ticker]) pos[tx.ticker]={qty:0,costBasis:0};
      if(tx.type==='BUY'){ pos[tx.ticker].qty+=tx.qty; pos[tx.ticker].costBasis+=tx.qty*tx.price+(tx.fee||0); }
      else{ const acu=pos[tx.ticker].qty?pos[tx.ticker].costBasis/pos[tx.ticker].qty:0; pos[tx.ticker].qty-=tx.qty; pos[tx.ticker].costBasis-=tx.qty*acu; }
    });
    Object.entries(pos).forEach(([t,v])=>{
      if(v.qty>0){ const pr=prices[t]?.price||(v.costBasis/v.qty); tv+=v.qty*pr; tc+=v.costBasis; }
    });
    const pnl=tv-tc, pct=tc?pnl/tc*100:0;
    return `<div class="card" style="${isAct?'border-color:rgba(77,143,255,.35)':''}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div>
          <div style="font-size:15px;font-weight:500;margin-bottom:3px">${p.name}
            ${isAct?'<span style="font-size:10px;color:var(--blue);background:var(--blueBg);padding:2px 6px;border-radius:4px;font-family:\'DM Mono\',monospace;margin-left:6px">ACTIEF</span>':''}
          </div>
          <div style="font-size:12px;color:var(--text3)">${p.transactions.length} transactie${p.transactions.length!==1?'s':''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:500">${fmtS(tv)}</div>
          <div style="font-size:12px;color:${pnl>=0?'var(--green)':'var(--red)'};font-family:'DM Mono',monospace">${fmtPct(pct)}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        ${!isAct?`<button class="btn btn-p btn-sm" data-action="switch-pf" data-id="${p.id}">Activeer</button>`:''}
        <button class="btn btn-o btn-sm" data-action="rename-pf" data-id="${p.id}" data-name="${p.name.replace(/"/g,'&quot;')}">Hernoemen</button>
        ${portfolios.length>1?`<button class="btn-d" data-action="del-pf" data-id="${p.id}">Verwijderen</button>`:''}
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════
// INSTELLINGEN
// ═══════════════════════════════════
function openApiModal(){
  document.getElementById('cfg-server').value=CFG.server||'';
  if(document.getElementById('cfg-fmp')) document.getElementById('cfg-fmp').value=CFG.fmp||'';
  document.getElementById('cfg-fh').value=CFG.finnhub||'';
  document.getElementById('cfg-status').textContent='';
  document.getElementById('api-modal').classList.add('open');
}
function closeApiModal(){ document.getElementById('api-modal').classList.remove('open'); }
document.getElementById('api-modal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeApiModal(); });

async function saveConfig(){
  CFG.server=document.getElementById('cfg-server').value.trim().replace(/\/$/,'');
  if(document.getElementById('cfg-fmp')) CFG.fmp=document.getElementById('cfg-fmp').value.trim();
  CFG.finnhub=document.getElementById('cfg-fh').value.trim();
  saveCFG();
  const btn=document.getElementById('api-btn');
  btn.className='api-btn ok';
  btn.textContent='✓ Instellingen';
  document.getElementById('cfg-status').textContent='Opgeslagen ✓';
  document.getElementById('cfg-status').style.color='var(--green)';
  closeApiModal();
  showToast('Instellingen opgeslagen ✓');
  if(getPositions().length) syncPrices();
}

// ═══════════════════════════════════
// EXPORT
// ═══════════════════════════════════
function openExportModal(){ document.getElementById('exp-modal').classList.add('open'); }
function closeExpModal(){ document.getElementById('exp-modal').classList.remove('open'); }
document.getElementById('exp-modal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeExpModal(); });

function dlCSV(fn,rows){
  const csv=rows.map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
  a.download=fn; a.click(); showToast(fn+' gedownload'); closeExpModal();
}

function doExport(type){
  const d=new Date().toISOString().slice(0,10);
  if(type==='tx') dlCSV(`transacties_${d}.csv`,[['Type','Ticker','Naam','Aantal','Prijs (€)','Kosten (€)','Totaal (€)','Datum'],...txs().map(t=>[t.type,t.ticker,t.name||'',t.qty,t.price,t.fee||0,parseFloat((t.qty*t.price+(t.fee||0)).toFixed(2)),t.date])]);
  else if(type==='div') dlCSV(`dividenden_${d}.csv`,[['Ticker','Bedrag (€)','Datum','Omschrijving'],...myDivs().map(d=>[d.ticker,d.amount,d.date,d.desc||''])]);
  else if(type==='pos'){
    const pos=getPositions();
    dlCSV(`posities_${d}.csv`,[['Ticker','Naam','Aantal','Gem.aankoopprijs','Kostenbasis','Live prijs','Marktwaarde','P&L','P&L%','Dividend'],...pos.map(p=>{
      const acu=avgCostPerUnit(p),livePr=lp(p.ticker)??acu,mv=p.qty*livePr,pnl=mv-p.costBasis,pct=p.costBasis?pnl/p.costBasis*100:0;
      const div=myDivs().filter(d=>d.ticker===p.ticker).reduce((s,d)=>s+d.amount,0);
      return [p.ticker,p.name,p.qty.toFixed(6),acu.toFixed(4),p.costBasis.toFixed(2),livePr.toFixed(4),mv.toFixed(2),pnl.toFixed(2),pct.toFixed(2),div.toFixed(2)];
    })]);
  } else {
    const data={portfolios,dividends,assetCls,assetTgt,exported:new Date().toISOString()};
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    a.download=`portfolio_backup_${d}.json`; a.click(); showToast('Backup gedownload'); closeExpModal();
  }
}

// ═══════════════════════════════════
// TOAST
// ═══════════════════════════════════
let toastT;
function showToast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),3000); }

// ═══════════════════════════════════
// RENDER ALL
// ═══════════════════════════════════
// ═══════════════════════════════════════════
// WISSELKOERSEN (USD → EUR live)
// ═══════════════════════════════════════════
let fxRates = {}; // { 'USD': 0.92, ... }

async function loadFxRates(){
  try{
    // Haal alle major valuta op tegenover EUR
    const r = await fetch('https://api.frankfurter.app/latest?to=EUR', {signal: AbortSignal.timeout(8000)});
    if(!r.ok) throw new Error('fx fail');
    const d = await r.json();
    // d.rates = { USD: 1.08, GBP: 0.86, ... } (rates zijn base→EUR omgekeerd)
    // frankfurter geeft "amount of base per 1 EUR"
    // We willen: hoeveel EUR voor 1 USD/GBP/...
    // Correcte formule: als base=EUR en rates={USD:1.08} → 1 EUR = 1.08 USD → 1 USD = 1/1.08 EUR
    const base = d.base; // = 'EUR'
    Object.entries(d.rates||{}).forEach(([cur, rate])=>{
      fxRates[cur] = 1 / rate; // omrekenen: 1 vreemde munt = ? EUR
    });
    fxRates['EUR'] = 1;
  } catch(e){
    // Fallback vaste koersen
    fxRates = { USD:0.924, GBP:1.168, CHF:1.064, GBP:1.168, JPY:0.0062, CAD:0.678, AUD:0.601, EUR:1 };
  }
}

function toEur(amount, currency){
  if(!currency || currency==='EUR') return amount;
  const cur = currency.toUpperCase();
  if(fxRates[cur] !== undefined) return amount * fxRates[cur];
  // Fallback
  if(cur==='USD') return amount * (fxRates['USD']||0.924);
  if(cur==='GBP') return amount * (fxRates['GBP']||1.168);
  if(cur==='GBp') return amount * (fxRates['GBP']||1.168) / 100; // pence
  return amount; // onbekende valuta: toon ongewijzigd
}

// Haal valuta op uit prices object
function tickerCurrency(ticker){
  const cur = prices[ticker]?.currency || 'EUR';
  return cur;
}

function toEurSafe(amount, ticker){
  const cur = tickerCurrency(ticker);
  // London Stock Exchange noteert in pence (GBp = 1/100 GBP)
  if(cur === 'GBp') return (amount / 100) * (fxRates['GBP']||1.168);
  return toEur(amount, cur);
}

// ═══════════════════════════════════════════
// CASH BETALING BIJ TRANSACTIE
// ═══════════════════════════════════════════
function updateCashPayOptions(){
  const wrap = document.getElementById('cash-pay-wrap');
  const sel  = document.getElementById('tx-cash-src');
  if(!wrap||!sel) return;
  const cashItems = manualPositions.cash||[];
  if(!cashItems.length){ wrap.style.display='none'; return; }
  wrap.style.display='';
  sel.innerHTML = '<option value="">— Geen —</option>' +
    cashItems.map((c,i)=>`<option value="${i}">${c.name} (${fmt(c.value)})</option>`).join('');
}

// ═══════════════════════════════════════════
// WATCHLIST
// ═══════════════════════════════════════════
let watchlist = [];
let wlSelectedSymbol = null;

function loadWatchlist(){
  try{ watchlist = JSON.parse(localStorage.getItem('ptx_watchlist')||'[]'); }
  catch(e){ watchlist=[]; }
}

function saveWatchlist(){
  localStorage.setItem('ptx_watchlist', JSON.stringify(watchlist));
}

async function searchTickerWL(q){
  const dd = document.getElementById('wl-dropdown');
  if(!q||q.length<1){ dd.style.display='none'; return; }
  // Hergebruik bestaande searchTicker logica via server
  const url = getServerUrl();
  if(!url){ dd.style.display='none'; return; }
  try{
    const r = await serverFetch(`/search?q=${encodeURIComponent(q)}`);
    if(!r||!r.length){ dd.style.display='none'; return; }
    dd.style.display='block';
    dd.innerHTML = r.slice(0,8).map(item=>`
      <div class="wl-dd-item" data-action="select-wl" data-symbol="${item.symbol}" data-name="${(item.name||'').replace(/"/g,'&quot;')}"
        style="padding:8px 12px;cursor:pointer;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border)">
        <span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--blue);min-width:70px">${item.symbol}</span>
        <span style="font-size:12px;color:var(--text2)">${item.name||''}</span>
      </div>`).join('');
  } catch(e){ dd.style.display='none'; }
}

function selectWLTicker(sym, name){
  wlSelectedSymbol = sym;
  document.getElementById('wl-tick').value = sym;
  document.getElementById('wl-name').value = name;
  document.getElementById('wl-dropdown').style.display='none';
}

function addToWatchlist(){
  const sym  = (wlSelectedSymbol||document.getElementById('wl-tick').value.trim().toUpperCase());
  const name = document.getElementById('wl-name').value.trim()||sym;
  const msg  = document.getElementById('wl-msg');
  // Input validatie: ticker mag alleen letters, cijfers, punt, koppelteken
  if(!sym || !/^[A-Z0-9.\-]{1,20}$/.test(sym)){
    msg.className='msg err'; msg.textContent='Ongeldige ticker.'; return;
  }
  if(watchlist.find(w=>w.ticker===sym)){
    msg.className='msg err'; msg.textContent='Staat al op je watchlist.'; return;
  }
  watchlist.push({ticker:sym, name, addedAt: new Date().toISOString()});
  saveWatchlist();
  document.getElementById('wl-tick').value='';
  document.getElementById('wl-name').value='';
  wlSelectedSymbol=null;
  msg.className='msg ok'; msg.textContent='✓ Toegevoegd';
  setTimeout(()=>msg.textContent='',3000);
  renderWatchlist();
  // Haal meteen koers op
  syncPricesForTickers([sym]);
}

function removeFromWatchlist(ticker){
  watchlist = watchlist.filter(w=>w.ticker!==ticker);
  saveWatchlist();
  renderWatchlist();
}

async function syncPricesForTickers(tickers){
  if(!tickers.length||!getServerUrl()) return;
  try{
    const r = await serverFetch('/prices', {method:'POST', body:JSON.stringify({tickers})});
    if(r) Object.assign(prices, r);
    renderWatchlist();
  } catch(e){}
}

function renderWatchlist(){
  const el = document.getElementById('wl-list');
  if(!el) return;
  if(!watchlist.length){ el.innerHTML='<div class="empty">Nog niets op je watchlist.</div>'; return; }
  el.innerHTML = watchlist.map(w=>{
    const p = prices[w.ticker];
    const priceStr = p ? fmt(p.price) : '—';
    const chgStr   = p ? (p.changePercent>=0?'+':'')+p.changePercent.toFixed(2)+'%' : '';
    const chgClass = p ? (p.changePercent>=0?'pos':'neg') : '';
    return `<div class="txr">
      <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
        <span style="font-family:'DM Mono',monospace;font-weight:500;color:var(--blue);min-width:80px">${w.ticker}</span>
        <span style="color:var(--text2);font-size:12px">${w.name}</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-shrink:0">
        <span style="font-family:'DM Mono',monospace;font-size:13px">${priceStr}</span>
        <span class="chg ${chgClass}" style="font-size:12px;min-width:60px;text-align:right">${chgStr}</span>
        <button data-action="wl-to-tx" data-ticker="${w.ticker}" data-name="${w.name.replace(/"/g,'&quot;')}"
          style="padding:4px 8px;background:var(--blueBg);border:1px solid rgba(77,143,255,.3);border-radius:var(--r);color:var(--blue);font-size:11px;cursor:pointer">
          + Kopen
        </button>
        <button class="btn-d" data-action="remove-wl" data-ticker="${w.ticker}">✕</button>
      </div>
    </div>`;
  }).join('');
}

function addWLToTx(ticker, name){
  goTo('transactions');
  document.getElementById('tx-tick').value=ticker;
  document.getElementById('tx-name').value=name;
}

function renderAll(){
  const pos=getPositions();
  renderMetrics(pos); renderPie(pos); renderLine(); renderPosTable(pos);
}

// ═══════════════════════════════════
// INIT
// ═══════════════════════════════════
document.getElementById('tx-date').valueAsDate=new Date();
document.getElementById('d-date').valueAsDate=new Date();

// Knop kleur op basis van opgeslagen config
if(CFG.av||CFG.finnhub){
  const btn=document.getElementById('api-btn');
  btn.className='api-btn ok'; btn.textContent='✓ Instellingen';
}

// Auto-refresh elke 2 uur
const REFRESH_INTERVAL = 2 * 60 * 60 * 1000;

// Maak server wakker (gratis Render slaapt na inactiviteit)
async function wakeUpServer(){
  var url = getServerUrl();
  if(!url) return;
  try{
    // Stuur een ping zonder auth — enkel om server wakker te maken
    await fetch(url + '/', {signal: AbortSignal.timeout(40000)});
  }catch(e){}
}

function shouldRefresh(){
  const lastTs = prices['_ts']||0;
  return (Date.now()-lastTs) > REFRESH_INTERVAL;
}


// ═══════════════════════════════════════════
// LOGIN / LOGOUT
// ═══════════════════════════════════════════

// ══════════════════════════════════════════════════════
// AUTH — volledig herschreven, simpel en betrouwbaar
// ══════════════════════════════════════════════════════

const SB_URL = 'https://yeefriejjohwvhtxgika.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InllZWZyaWVqam9od3ZodHhnaWthIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MTUwMjksImV4cCI6MjA4OTk5MTAyOX0.5Aq5kDiH9pdW77XI1ViW6pEBOcvRKxUMLDQjjk2r_DY';

// Één globale Supabase client
const _sb = supabase.createClient(SB_URL, SB_KEY);

// ── UI ────────────────────────────────────────
function showTab(tab){
  const isLogin = tab === 'login';
  document.getElementById('form-login').style.display = isLogin ? 'flex' : 'none';
  document.getElementById('form-register').style.display = isLogin ? 'none' : 'flex';
  document.getElementById('tab-login').style.borderBottomColor = isLogin ? 'var(--blue)' : 'transparent';
  document.getElementById('tab-login').style.color = isLogin ? 'var(--text)' : 'var(--text2)';
  document.getElementById('tab-register').style.borderBottomColor = isLogin ? 'transparent' : 'var(--blue)';
  document.getElementById('tab-register').style.color = isLogin ? 'var(--text2)' : 'var(--text)';
}

// Oud alias
function switchAuthTab(tab){ showTab(tab); }
function getSB(){ return _sb; }

function _showAuth(){
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('main-app').style.display = 'none';
  // Reset login knop als die vast zit
  const btn = document.getElementById('login-btn');
  if(btn){ btn.textContent = 'Inloggen'; btn.disabled = false; }
}

function _showApp(email){
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';
  const el = document.getElementById('logged-in-as');
  if(el) el.textContent = email || '';
}

function showAuthScreen(){ _showAuth(); }
function showLoginScreen(){ _showAuth(); }
function showMainApp(email){ _showApp(email); }

// ── Oogknop wachtwoord ───────────────────────
function togglePassVis(inputId, btn){
  const inp = document.getElementById(inputId);
  if(inp.type === 'password'){
    inp.type = 'text';
    btn.textContent = '🙈';
  } else {
    inp.type = 'password';
    btn.textContent = '👁';
  }
}

// ── Wachtwoord resetten ───────────────────────
async function doResetPassword(){
  const email = (document.getElementById('login-email').value||'').trim().toLowerCase();
  const errEl = document.getElementById('login-err');
  if(!email){
    errEl.style.color = 'var(--red)';
    errEl.textContent = 'Vul eerst je e-mailadres in hierboven.';
    return;
  }
  errEl.style.color = 'var(--text2)';
  errEl.textContent = 'Bezig...';
  try{
    await _sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.href
    });
    errEl.style.color = 'var(--green)';
    errEl.textContent = '✓ Reset-link verstuurd naar ' + email + ' — check je inbox.';
    setTimeout(()=>{ errEl.textContent=''; }, 8000);
  } catch(e){
    errEl.style.color = 'var(--red)';
    errEl.textContent = 'Fout: ' + e.message;
  }
}

// ── Inloggen ──────────────────────────────────
async function doLogin(){
  const email = (document.getElementById('login-email').value||'').trim().toLowerCase();
  const pass  = (document.getElementById('login-pass').value||'');
  const errEl = document.getElementById('login-err');
  const btn   = document.getElementById('login-btn');

  errEl.textContent = '';
  if(!email || !pass){ errEl.textContent = 'Vul e-mail en wachtwoord in.'; return; }

  btn.textContent = 'Bezig...'; btn.disabled = true;

  try{
    const { data, error } = await _sb.auth.signInWithPassword({ email, password: pass });

    btn.textContent = 'Inloggen'; btn.disabled = false;

    if(error){
      // Toon de volledige foutmelding zodat we weten wat er fout gaat
      errEl.style.color = 'var(--red)';
      errEl.textContent = error.message.includes('Invalid') ? 'E-mail of wachtwoord onjuist.'
                        : error.message.includes('confirm') ? 'E-mail nog niet bevestigd — check je inbox.'
                        : error.message.includes('rate') ? 'Te veel pogingen, wacht 1 minuut.'
                        : '⚠ ' + error.message;
      return;
    }

    if(data?.user){
      try{
        _showApp(data.user.email);
        localStorage.setItem('ptx_username', data.user.email);
        await initApp();
      } catch(initErr){
        // initApp crasht — toon fout op scherm
        errEl.style.color = 'orange';
        errEl.textContent = 'Login OK maar laadprobleem: ' + initErr.message;
        // Toon app toch
        _showApp(data.user.email);
      }
    } else {
      errEl.textContent = 'Geen gebruiker data ontvangen van Supabase.';
    }

  } catch(e){
    btn.textContent = 'Inloggen'; btn.disabled = false;
    errEl.style.color = 'var(--red)';
    errEl.textContent = 'Fout: ' + e.message;
  }
}

// ── Registreren ───────────────────────────────
async function doRegister(){
  const email = (document.getElementById('reg-email').value||'').trim().toLowerCase();
  const pass  = (document.getElementById('reg-pass').value||'');
  const pass2 = (document.getElementById('reg-pass2').value||'');
  const errEl = document.getElementById('reg-err');
  const okEl  = document.getElementById('reg-ok');
  const btn   = document.getElementById('reg-btn');

  errEl.textContent = ''; okEl.style.display = 'none';
  if(!email||!pass||!pass2){ errEl.textContent = 'Vul alle velden in.'; return; }
  if(pass.length < 8){ errEl.textContent = 'Wachtwoord min. 8 tekens.'; return; }
  if(pass !== pass2){ errEl.textContent = 'Wachtwoorden komen niet overeen.'; return; }

  btn.textContent = 'Bezig...'; btn.disabled = true;

  try{
    const { data, error } = await _sb.auth.signUp({ email, password: pass });

    btn.textContent = 'Account aanmaken'; btn.disabled = false;

    if(error){
      errEl.textContent = error.message.includes('already') ? 'Dit e-mail is al geregistreerd.' : error.message;
      return;
    }

    // Supabase confirm email staat UIT → meteen inloggen
    if(data?.user && data.user.identities?.length > 0){
      okEl.textContent = '✓ Account aangemaakt! Je wordt ingelogd...';
      okEl.style.display = 'block';
      setTimeout(async ()=>{
        const { data: d2, error: e2 } = await _sb.auth.signInWithPassword({ email, password: pass });
        if(!e2 && d2?.user){
          _showApp(d2.user.email);
          localStorage.setItem('ptx_username', d2.user.email);
          await initApp();
        }
      }, 1000);
    } else {
      okEl.textContent = '✓ Account aangemaakt! Check je inbox om te bevestigen.';
      okEl.style.display = 'block';
    }
  } catch(e){
    btn.textContent = 'Account aanmaken'; btn.disabled = false;
    errEl.textContent = 'Fout: ' + e.message;
  }
}

// ── Wachtwoord vergeten ───────────────────────
async function doForgotPassword(){
  const email = (document.getElementById('login-email').value||'').trim().toLowerCase();
  const errEl = document.getElementById('login-err');
  if(!email){ errEl.textContent = 'Vul eerst je e-mailadres in.'; return; }
  await _sb.auth.resetPasswordForEmail(email);
  errEl.style.color = 'var(--green)';
  errEl.textContent = '✓ Reset-link verstuurd naar ' + email;
  setTimeout(()=>{ errEl.style.color='var(--red)'; errEl.textContent=''; }, 5000);
}

// ── Uitloggen ─────────────────────────────────
async function doLogout(){
  // Eerst data syncen vóór sessie wordt afgesloten
  if(SB_OK) try{ await pushToSupabase(); }catch(e){}
  await _sb.auth.signOut();
  localStorage.removeItem('ptx_username');
  _showAuth();
}

// ── App initialiseren ─────────────────────────
async function startApp(email){
  localStorage.setItem('ptx_username', email);
  _showApp(email);
  try{
    await initApp();
  } catch(e){
    console.error('initApp fout bij startApp:', e);
  }
}

// ═══════════════════════════════════════════
// HOOFD-INIT
// ═══════════════════════════════════════════
async function initApp(){
  try{ loadState(); } catch(e){}
  try{ loadWatchlist(); } catch(e){}
  try{ buildRangeBtns(); } catch(e){}
  try{ await loadFxRates(); } catch(e){}
  // Haal data op uit Supabase (overschrijft localStorage-cache)
  try{ await pullFromSupabase(); } catch(e){ console.warn('Supabase pull mislukt, localStorage als fallback:', e); }
  try{ renderAll(); } catch(e){}
  try{ renderTxList(); } catch(e){}
  try{ updateCashPayOptions(); } catch(e){}
  try{
    if(shouldRefresh()){
      syncPrices();
      loadBenchmark();
    } else {
      const mins = Math.round((Date.now()-(prices['_ts']||0))/60000);
      const el = document.getElementById('last-sync');
      if(el) el.textContent = `Cache: ${mins} min geleden`;
      renderAll();
      loadBenchmark();
    }
  } catch(e){}
  try{
    if(window._refreshTimer) clearInterval(window._refreshTimer);
    window._refreshTimer = setInterval(()=>syncPrices(), REFRESH_INTERVAL);
  } catch(e){}
}

// ═══════════════════════════════════════════
// STATISCHE EVENT BINDINGS — vervangt alle inline onclick/onchange
// ═══════════════════════════════════════════
(function bindStaticHandlers(){
  // Auth tabs
  document.getElementById('tab-login').addEventListener('click', ()=>showTab('login'));
  document.getElementById('tab-register').addEventListener('click', ()=>showTab('register'));

  // Login
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-pass').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  document.getElementById('reset-pass-btn').addEventListener('click', doResetPassword);
  document.getElementById('toggle-login-pass').addEventListener('click', function(){ togglePassVis('login-pass', this); });

  // Registreren
  document.getElementById('reg-btn').addEventListener('click', doRegister);
  document.getElementById('reg-pass2').addEventListener('keydown', e=>{ if(e.key==='Enter') doRegister(); });
  document.getElementById('toggle-reg-pass').addEventListener('click', function(){ togglePassVis('reg-pass', this); });

  // Navigatie — event delegation op .nav
  document.querySelector('.nav').addEventListener('click', e=>{
    const ni = e.target.closest('[data-page]');
    if(ni) goTo(ni.dataset.page);
  });

  // Sidebar
  document.getElementById('sync-btn').addEventListener('click', syncPrices);
  document.getElementById('api-btn').addEventListener('click', openApiModal);
  document.getElementById('logout-btn').addEventListener('click', doLogout);

  // Dashboard
  document.getElementById('dash-export-btn').addEventListener('click', openExportModal);
  document.getElementById('bench-on').addEventListener('change', renderLine);
  document.getElementById('bench-sym').addEventListener('change', loadBenchmark);

  // Dividenden
  document.getElementById('add-div-btn').addEventListener('click', addDiv);
  document.getElementById('d-tick').addEventListener('input', e=>searchDivTicker(e.target.value));
  document.getElementById('d-tick').addEventListener('blur', ()=>setTimeout(()=>{ document.getElementById('div-search-dropdown').style.display='none'; }, 200));

  // Transacties
  document.getElementById('tx-export-btn').addEventListener('click', openExportModal);
  document.getElementById('tx-tick').addEventListener('input', e=>searchTicker(e.target.value));
  document.getElementById('tx-qty').addEventListener('input', updatePriceHint);
  document.getElementById('price-mode-lbl').addEventListener('click', togglePriceMode);
  document.getElementById('tx-price').addEventListener('input', updatePriceHint);
  document.getElementById('add-tx-btn').addEventListener('click', addTx);

  // Cash & Alternatief
  document.getElementById('add-cash-btn').addEventListener('click', ()=>openManualModal('cash'));
  document.getElementById('add-alts-btn').addEventListener('click', ()=>openManualModal('alts'));

  // Portefeuilles
  document.getElementById('new-pf-btn').addEventListener('click', ()=>openPfModal());

  // Watchlist
  document.getElementById('wl-tick').addEventListener('input', e=>searchTickerWL(e.target.value));
  document.getElementById('wl-tick').addEventListener('blur', ()=>setTimeout(()=>{ document.getElementById('wl-dropdown').style.display='none'; }, 200));
  document.getElementById('add-wl-btn').addEventListener('click', addToWatchlist);

  // Instellingen modal
  document.getElementById('close-api-modal').addEventListener('click', closeApiModal);
  document.getElementById('save-config-btn').addEventListener('click', saveConfig);

  // Portefeuille modal
  document.getElementById('close-pf-modal').addEventListener('click', closePfModal);
  document.getElementById('pf-modal-confirm').addEventListener('click', confirmPfModal);

  // Manuele positie modal
  document.getElementById('close-manual-modal').addEventListener('click', closeManualModal);
  document.getElementById('manual-confirm-btn').addEventListener('click', confirmManualModal);

  // Export modal
  document.getElementById('export-tx-btn').addEventListener('click', ()=>doExport('tx'));
  document.getElementById('export-div-btn').addEventListener('click', ()=>doExport('div'));
  document.getElementById('export-pos-btn').addEventListener('click', ()=>doExport('pos'));
  document.getElementById('export-json-btn').addEventListener('click', ()=>doExport('json'));
  document.getElementById('close-exp-modal').addEventListener('click', closeExpModal);
})();

// ═══════════════════════════════════════════
// DYNAMISCHE EVENT DELEGATION — vervangt inline onclick/onchange in gegenereerde HTML
// ═══════════════════════════════════════════
document.addEventListener('click', function(e){
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const a = el.dataset.action;
  if(a === 'del-div')      delDiv(el.dataset.id);
  else if(a === 'del-tx')  delTx(parseInt(el.dataset.idx));
  else if(a === 'switch-pf')   switchPf(el.dataset.id);
  else if(a === 'rename-pf')   openPfModal('rename', el.dataset.id, el.dataset.name);
  else if(a === 'del-pf')      delPf(el.dataset.id);
  else if(a === 'edit-manual') openManualModal(el.dataset.type, el.dataset.id);
  else if(a === 'del-manual')  deleteManualItem(el.dataset.type, el.dataset.id);
  else if(a === 'select-wl')   selectWLTicker(el.dataset.symbol, el.dataset.name);
  else if(a === 'wl-to-tx')    addWLToTx(el.dataset.ticker, el.dataset.name);
  else if(a === 'remove-wl')   removeFromWatchlist(el.dataset.ticker);
});

document.addEventListener('change', function(e){
  const el = e.target.closest('[data-action]');
  if(!el) return;
  if(el.dataset.action === 'set-tgt') setTgt(el.dataset.cat, el.value);
  else if(el.dataset.action === 'set-ac') setAC(el.dataset.ticker, el.value);
});

// ═══════════════════════════════════════════
// START — wacht op DOM + Supabase sessie
// ═══════════════════════════════════════════
window.addEventListener('load', async function(){
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'none';

  // Server wakker maken (Render free tier slaapt na inactiviteit)
  wakeUpServer();

  // Bestaande Supabase sessie controleren
  try{
    const { data } = await _sb.auth.getSession();
    if(data?.session?.user){
      await startApp(data.session.user.email);
      return;
    }
  } catch(e){}

  // Geen sessie → loginscherm tonen
  _showAuth();
});
