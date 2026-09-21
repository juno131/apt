/* 국토교통부 실거래가 → 지역 지수·갈아타기 신호 계산 (Node 20+)
   깃허브 Actions가 매일 실행합니다. 직접 고치실 필요는 없어요. 설정은 config.json 에서. */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const KEY = (process.env.MOLIT_KEY || '').trim();
const BASE = process.env.MOLIT_BASE || 'https://apis.data.go.kr/1613000';
const URL_TRADE = `${BASE}/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev`;
const URL_RENT = `${BASE}/RTMSDataSvcAptRent/getRTMSDataSvcAptRent`;
const STORE = path.join(ROOT, 'data', 'monthly.json');
const OUT = path.join(ROOT, 'docs', 'data.json');
const ROWS = 1000, CONCURRENCY = 2, REFRESH_MONTHS = 4;   // 국토부 서버가 막지 않도록 천천히
const BATCH_PAUSE = 400, TRIES = 4, 연속실패_한도 = 5;

if (!KEY) { console.error('인증키가 없습니다. 깃허브 Secrets 에 MOLIT_KEY 를 넣어 주세요.'); process.exit(1); }

/* ---------- 작은 도구들 ---------- */
const pad2 = n => String(n).padStart(2, '0');
const nowKST = () => new Date(Date.now() + 9 * 3600 * 1000);
const curYm = () => { const d = nowKST(); return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}`; };
const monthsBack = n => { let [y, m] = [ +curYm().slice(0, 4), +curYm().slice(4) ], out = [];
  for (let i = 0; i < n; i++) { out.unshift(`${y}${pad2(m)}`); if (--m === 0) { m = 12; y--; } } return out; };
const prevYm = ym => { let y = +ym.slice(0, 4), m = +ym.slice(4) - 1; if (m === 0) { m = 12; y--; } return `${y}${pad2(m)}`; };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const eok = v => v == null ? null : Math.round(v / 100) / 100;          // 만원 → 억
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const r2 = v => v == null ? null : Math.round(v * 100) / 100;
const norm = s => String(s || '').replace(/[\s()（）[\]{}·.,\-_]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 국토부 API ---------- */
const keyParam = KEY.includes('%') ? KEY : encodeURIComponent(KEY);
function parseXml(text, http) {
  const tag = t => { const m = text.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? m[1].trim() : null; };
  const auth = tag('returnAuthMsg');
  const head = text.slice(0, 600);
  if (/PER_SECOND/i.test(head) || http === 429) return { retry: true, msg: '요청이 너무 빠름' };
  if (auth || /SERVICE_KEY|LIMITED_NUMBER|SERVICE_ACCESS_DENIED|NO_OPENAPI|Unauthorized/i.test(head) || http === 401 || http === 403)
    return { fatal: true, msg: auth || head.slice(0, 200) };
  const code = tag('resultCode');
  if (code === null) return { retry: true, msg: `응답 형식이 다름 (HTTP ${http})` };
  if (!/^0+$/.test(code)) return { retry: true, msg: `${code} ${tag('resultMsg') || ''}` };
  const items = [];
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const o = {};
    for (const f of m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)) o[f[1]] = f[2].replace(/&amp;/g, '&').trim();
    items.push(o);
  }
  return { total: parseInt(tag('totalCount') || '0', 10) || 0, items };
}
async function apiPage(kind, code, ym, page) {
  const url = `${kind === 'trade' ? URL_TRADE : URL_RENT}?serviceKey=${keyParam}&LAWD_CD=${code}&DEAL_YMD=${ym}&pageNo=${page}&numOfRows=${ROWS}`;
  let 마지막 = '';
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    let res, text;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'apt-monitor/1.0', Accept: 'application/xml' } });
      text = await res.text();
    } catch (e) { 마지막 = '연결 실패: ' + e.message; await sleep(1500 * attempt); continue; }
    const p = parseXml(text, res.status);
    if (p.fatal) throw new Error(`국토부 응답 오류: ${p.msg}\n→ 인증키(MOLIT_KEY)와 두 자료(매매·전월세) 활용신청을 확인하세요.`);
    if (!p.retry) return p;
    마지막 = `HTTP ${res.status} · ${String(text).replace(/\s+/g, ' ').slice(0, 120)}`;
    await sleep(1500 * attempt);
  }
  const err = new Error(`${kind === 'trade' ? '매매' : '전월세'} ${code} ${ym} 실패 — ${마지막}`);
  err.건너뛰기 = true;
  throw err;
}
async function fetchMonth(codes, ym) {
  const jobs = [];
  for (const code of codes) for (const kind of ['trade', 'rent']) jobs.push({ kind, code, ym });
  const out = { trade: [], rent: [] };
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    if (i) await sleep(BATCH_PAUSE);
    await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async j => {
      let page = 1, total = Infinity;
      while ((page - 1) * ROWS < total) {
        const p = await apiPage(j.kind, j.code, j.ym, page);
        total = p.total;
        for (const it of p.items) {
          const row = {
            code: j.code, umd: (it.umdNm || '').trim(), apt: (it.aptNm || '').trim(),
            area: parseFloat(it.excluUseAr) || 0, floor: (it.floor || '').trim(),
            day: +(it.dealDay || 0) || 0
          };
          if (j.kind === 'trade') {
            row.price = parseFloat(String(it.dealAmount || '').replace(/[,\s]/g, '')) || 0;
            if (String(it.cdealType || '').trim()) continue;                     // 해제(취소)된 거래 제외
            out.trade.push(row);
          } else {
            row.price = parseFloat(String(it.deposit || '').replace(/[,\s]/g, '')) || 0;
            if (parseFloat(String(it.monthlyRent || '0').replace(/[,\s]/g, '')) > 0) continue;   // 월세 제외
            out.rent.push(row);
          }
        }
        page++;
        if (page > 30) break;
      }
    }));
  }
  return out;
}

/* ---------- 설정 해석 ---------- */
const AREA = CFG.지역_전용면적 || [80, 90];
const REGIONS = (() => {
  const map = new Map();
  for (const r of CFG.지역) {
    if (!map.has(r.이름)) map.set(r.이름, { 이름: r.이름, parts: [] });
    map.get(r.이름).parts.push({ code: String(r.코드), dongs: r.동 || [], ex: r.제외 || [] });
  }
  return [...map.values()];
})();
const CODES = [...new Set([...REGIONS.flatMap(g => g.parts.map(p => p.code)), String(CFG.내집.시군구코드), String(CFG.목표.시군구코드)])];
const inRegion = (row, g) => g.parts.some(p => p.code === row.code &&
  (!p.dongs.length || p.dongs.includes(row.umd)) && !p.ex.includes(row.umd));
const inArea = (row, [lo, hi]) => row.area >= lo && row.area <= hi;
const hitComplex = (row, c) => row.code === String(c.시군구코드) && (!c.동 || row.umd === c.동) &&
  norm(row.apt).includes(norm(c.단지명)) && inArea(row, c.전용면적);
const SIG = JSON.stringify({ AREA, REGIONS, 내집: CFG.내집, 목표: CFG.목표 });

/* ---------- 한 달 집계 ---------- */
function aggregate(data, ym) {
  const o = { 지역: {}, 내집: null, 목표: null };
  for (const g of REGIONS) {
    const sales = data.trade.filter(r => inRegion(r, g) && inArea(r, AREA));
    const rents = data.rent.filter(r => inRegion(r, g) && inArea(r, AREA));
    const byApt = {};
    for (const r of sales) (byApt[r.apt] = byApt[r.apt] || []).push(r.price);
    const 단지 = {};
    for (const [apt, ps] of Object.entries(byApt)) 단지[apt] = [Math.round(median(ps)), ps.length];
    o.지역[g.이름] = { 건수: sales.length, 중위: sales.length ? Math.round(median(sales.map(r => r.price))) : null,
      전세중위: rents.length ? Math.round(median(rents.map(r => r.price))) : null, 단지 };
  }
  for (const [key, c] of [['내집', CFG.내집], ['목표', CFG.목표]]) {
    const s = data.trade.filter(r => hitComplex(r, c)), j = data.rent.filter(r => hitComplex(r, c));
    o[key] = {
      매매: s.map(r => ({ 일: r.day, 면적: r.area, 가격: r.price, 층: r.floor, 단지: r.apt })),
      전세: j.map(r => ({ 일: r.day, 면적: r.area, 가격: r.price, 층: r.floor })),
      후보: {}
    };
    if (!s.length && !j.length) {                       // 못 찾았을 때 같은 동 단지 목록(이름 확인용)
      for (const r of [...data.trade, ...data.rent])
        if (r.code === String(c.시군구코드) && (!c.동 || r.umd === c.동)) o[key].후보[r.apt] = (o[key].후보[r.apt] || 0) + 1;
    }
  }
  return o;
}

/* ---------- 지수 계산 (같은 단지의 변화율만 연결) ---------- */
function buildIndex(store, months, regionName, topN) {
  const monthly = ym => store.월[ym]?.지역?.[regionName] || null;
  // 대표 단지: 최근 3년 거래 건수 상위 N개
  const cnt = {};
  for (const ym of months.slice(-36)) {
    const m = monthly(ym); if (!m) continue;
    for (const [apt, [, c]] of Object.entries(m.단지 || {})) cnt[apt] = (cnt[apt] || 0) + c;
  }
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([apt]) => apt);
  // 단지별 3개월 평균 가격
  const p = (ym, apt) => {
    const vals = [];
    let y = ym;
    for (let k = 0; k < 3; k++) { const m = monthly(y); const v = m?.단지?.[apt]?.[0]; if (v) vals.push(v); y = prevYm(y); }
    return vals.length ? mean(vals) : null;
  };
  const idx = [], med = [], deals = [];
  let level = 100;
  months.forEach((ym, i) => {
    if (i > 0) {
      const prev = months[i - 1];
      const pick = names => names.map(a => { const a1 = p(ym, a), a0 = p(prev, a); return (a1 && a0) ? a1 / a0 : null; })
        .filter(v => v != null);
      let ratios = pick(top);
      if (ratios.length < 2) ratios = pick(Object.keys(cnt));      // 대표 단지에 거래가 없으면 전체 단지로
      const f = median(ratios);
      if (f) level *= f;
    }
    const m = monthly(ym);
    idx.push(m ? r1(level) : null);
    // 지역 전체 중위값(3개월 평균)
    const ms = [];
    let y = ym;
    for (let k = 0; k < 3; k++) { const mm = monthly(y); if (mm?.중위) ms.push(mm.중위); y = prevYm(y); }
    med.push(ms.length ? r2(eok(mean(ms))) : null);
    deals.push(m ? m.건수 : null);
  });
  const lastM = monthly(months.at(-1));
  const 전세가율 = lastM?.중위 && lastM?.전세중위 ? r1(lastM.전세중위 / lastM.중위 * 100) : null;
  // 대표 단지별 가격 시리즈(억) — "키맞추기" 화면에서 단지 두 개를 골라 비교할 때 씁니다
  const 단지시리즈 = {};
  for (const apt of top) 단지시리즈[apt] = months.map(ym => { const v = p(ym, apt); return v ? r2(eok(v)) : null; });
  return { 지수: idx, 중위: med, 거래량: deals, 대표단지: top, 전세가율, 단지시리즈 };
}
function rollingComplex(store, months, key, n = 3) {
  return months.map(ym => {
    const vals = [];
    let y = ym;
    for (let k = 0; k < n; k++) { (store.월[y]?.[key]?.매매 || []).forEach(t => vals.push(t.가격)); y = prevYm(y); }
    return r2(eok(median(vals)));
  });
}
function rollingJeonse(store, months, key, n = 3) {
  return months.map(ym => {
    const vals = [];
    let y = ym;
    for (let k = 0; k < n; k++) { (store.월[y]?.[key]?.전세 || []).forEach(t => vals.push(t.가격)); y = prevYm(y); }
    return r2(eok(median(vals)));
  });
}

/* ---------- 메인 ---------- */
const months = monthsBack((CFG.과거자료_년 || 5) * 12);
let store = { 기준: SIG, 월: {} };
if (fs.existsSync(STORE)) {
  try { const s = JSON.parse(fs.readFileSync(STORE, 'utf8')); if (s.기준 === SIG) store = s; else console.log('설정이 바뀌어 과거 자료를 다시 받습니다.'); }
  catch { console.log('저장 파일을 읽지 못해 새로 받습니다.'); }
}
const need = months.filter(ym => !store.월[ym]).concat(months.slice(-REFRESH_MONTHS));
const todo = [...new Set(need)].sort().reverse();      // 최근 달부터 (중간에 멈춰도 최신 자료는 남도록)
console.log(`받을 달: ${todo.length}개월 (지역코드 ${CODES.length}개)`);
let done = 0, 연속실패 = 0;
const 실패 = [];
for (const ym of todo) {
  try {
    const data = await fetchMonth(CODES, ym);
    store.월[ym] = aggregate(data, ym);
    done++; 연속실패 = 0;
  } catch (e) {
    if (!e.건너뛰기) throw e;                       // 인증키 문제 등은 바로 멈춤
    실패.push(ym); 연속실패++;
    console.log(`  ⚠ ${ym} 건너뜀 — ${e.message}`);
    if (연속실패 >= 연속실패_한도) {
      console.log(`\n국토부 서버가 계속 막고 있어 여기서 멈춥니다. 받은 곳까지 저장하고, 다음 실행 때 이어서 받습니다.`);
      break;
    }
  }
  if ((done + 실패.length) % 6 === 0 || done + 실패.length === todo.length) {
    console.log(`  ${done + 실패.length}/${todo.length} 진행 (받음 ${done}, 건너뜀 ${실패.length})`);
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(store));   // 중간 저장
  }
}
if (실패.length) {
  console.log(`\n⚠ ${실패.length}개월을 받지 못했습니다: ${실패.join(', ')}`);
  console.log('   국토부 서버가 잠시 막은 것일 수 있습니다. 다음 실행 때 자동으로 다시 받습니다.');
}
if (!Object.keys(store.월).length) {
  throw new Error('자료를 한 달도 받지 못했습니다. 국토부 서버가 막고 있을 수 있으니 30분~1시간 뒤 다시 실행해 보세요.');
}
for (const ym of Object.keys(store.월)) if (!months.includes(ym)) delete store.월[ym];   // 기간 밖은 정리
fs.mkdirSync(path.dirname(STORE), { recursive: true });
fs.writeFileSync(STORE, JSON.stringify(store));

/* ----- 출력 만들기 ----- */
const shown = months.filter(ym => store.월[ym]);
const L = (() => { let i = shown.length - 1; if (i > 0 && shown[i] === curYm()) i--; return i; })();   // 이번 달은 신고가 덜 돼서 제외
const regions = REGIONS.map(g => {
  const b = buildIndex(store, shown, g.이름, CFG.대표단지_수 || 5);
  const chg = k => (L - k >= 0 && b.지수[L] && b.지수[L - k]) ? r1((b.지수[L] / b.지수[L - k] - 1) * 100) : null;
  return { 이름: g.이름, ...b, 변화: { m1: chg(1), m3: chg(3), m6: chg(6), m12: chg(12) },
    현재지수: b.지수[L], 현재중위: b.중위[L], 최근거래량: b.거래량[L] };
});
const R = Object.fromEntries(regions.map(r => [r.이름, r]));
const sideIdx = names => shown.map((_, i) => {
  const a = names.map(n => R[n]?.지수[i]).filter(v => v != null);
  return a.length === names.length ? mean(a) : null;
});
const S = CFG.신호 || {};
const mineNames = (S.내쪽 || []).filter(n => R[n]), tgtNames = (S.목표쪽 || []).filter(n => R[n]);
const mineIdx = sideIdx(mineNames), tgtIdx = sideIdx(tgtNames);
const ratio = shown.map((_, i) => (mineIdx[i] && tgtIdx[i]) ? r2(mineIdx[i] / tgtIdx[i] * 100) / 100 : null);
const chgOf = (s, k) => (L - k >= 0 && s[L] && s[L - k]) ? r1((s[L] / s[L - k] - 1) * 100) : null;
const position = s => {
  const v = s.slice(0, L + 1).filter(x => x != null);
  if (v.length < 6 || s[L] == null) return null;
  const mn = Math.min(...v), mx = Math.max(...v);
  if ((mx - mn) / ((mx + mn) / 2) < 0.04) return 50;             // 거의 안 움직였으면 '변화 없음'
  return Math.round((s[L] - mn) / (mx - mn) * 100);
};
const m3 = chgOf(mineIdx, 3), t3 = chgOf(tgtIdx, 3);
const m6 = chgOf(mineIdx, 6), t6 = chgOf(tgtIdx, 6), m12 = chgOf(mineIdx, 12), t12 = chgOf(tgtIdx, 12);
const gap3 = (m3 != null && t3 != null) ? r1(m3 - t3) : null;
const gap6 = (m6 != null && t6 != null) ? r1(m6 - t6) : null, gap12 = (m12 != null && t12 != null) ? r1(m12 - t12) : null;
const posR = position(ratio);

/* 전환 조짐: 그동안(6개월)과 요즘(3개월)을 견줘 흐름이 바뀌는지 봅니다 */
const sign = v => (v > 0 ? '+' : '') + v + '%';
let 전환 = '변화 없음', 전환설명 = '';
const 수치 = (gap3 != null) ? `3개월: ${mineNames.join('·')} ${sign(m3)} vs ${tgtNames.join('·')} ${sign(t3)}` : '';
if (gap3 != null && gap6 != null) {
  const 요즘_내쪽 = gap3 >= 1, 요즘_목표 = gap3 <= -1, 그동안_목표 = gap6 <= -1, 그동안_내쪽 = gap6 >= 1;
  const 추세 = gap3 - gap6 / 2;      // 6개월은 기간이 2배라, 속도가 같으면 gap3 ≈ gap6/2 입니다
  if (요즘_내쪽 && !그동안_내쪽) { 전환 = '전환 시작'; 전환설명 = `요즘은 내 쪽이 더 오르기 시작했습니다 (${수치})`; }
  else if (요즘_내쪽 && 추세 < -1) { 전환 = '우위 약해짐'; 전환설명 = `내 쪽이 아직 앞서지만 속도가 줄고 있습니다 (${수치})`; }
  else if (요즘_내쪽) { 전환 = '내 쪽 우위'; 전환설명 = `내 쪽이 계속 더 오르고 있습니다 (${수치})`; }
  else if (요즘_목표 && !그동안_목표) { 전환 = '역전됨'; 전환설명 = `요즘은 목표 쪽이 더 오릅니다 (${수치})`; }
  else if (요즘_목표 && 추세 >= 1) { 전환 = '좁혀지는 중'; 전환설명 = `목표 쪽이 앞서지만 격차가 줄고 있습니다 (${수치})`; }
  else if (요즘_목표) { 전환 = '벌어지는 중'; 전환설명 = `목표 쪽이 더 빠르게 앞서가는 중입니다 (${수치})`; }
  else { 전환 = '비슷'; 전환설명 = `요즘은 두 곳이 비슷하게 움직입니다 (${수치})`; }
}
let 등급 = '🟡', 문구 = '지켜보기';
if (posR == null || gap6 == null) { 등급 = '⚪'; 문구 = '자료가 더 쌓여야 판단할 수 있습니다'; }
else if ((posR >= 70 && gap6 >= 1) || (posR >= 50 && gap6 >= 5)) { 등급 = '🟢'; 문구 = '갈아타기 좋은 구간'; }
else if (posR <= 30 && gap6 <= -1) { 등급 = '🔴'; 문구 = '불리한 구간'; }
if (등급 !== '⚪') 문구 += ' — ' + (전환설명 || '아직 뚜렷한 차이가 없습니다');

const mineS = rollingComplex(store, shown, '내집'), tgtS = rollingComplex(store, shown, '목표');
const recent = key => {
  const out = [];
  for (const ym of [...shown].reverse()) {
    const m = store.월[ym]?.[key]; if (!m) continue;
    for (const t of m.매매) out.push({ 날짜: `${ym.slice(2, 4)}.${ym.slice(4)}.${pad2(t.일)}`, 구분: '매매', 가격: r2(eok(t.가격)), 면적: t.면적, 층: t.층 });
    for (const t of m.전세) out.push({ 날짜: `${ym.slice(2, 4)}.${ym.slice(4)}.${pad2(t.일)}`, 구분: '전세', 가격: r2(eok(t.가격)), 면적: t.면적, 층: t.층 });
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
};
const cand = key => Object.entries(store.월[shown.at(-1)]?.[key]?.후보 || {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);
const 내집가 = mineS[L], 목표가 = tgtS[L];
const 가격차 = (내집가 != null && 목표가 != null) ? r2(목표가 - 내집가) : null;
const 부대비용 = 목표가 != null ? r2(목표가 * (CFG.부대비용_비율 || 5) / 100) : null;
const 단지비 = shown.map((_, i) => (mineS[i] && tgtS[i]) ? r2(mineS[i] / tgtS[i] * 100) / 100 : null);

const out = {
  갱신: nowKST().toISOString().slice(0, 16).replace('T', ' ') + ' (한국시간)',
  기준월: shown[L], 기간: [shown[0], shown.at(-1)], 라벨: shown.map(ym => `${ym.slice(2, 4)}.${ym.slice(4)}`),
  면적: AREA, 부대비용_비율: CFG.부대비용_비율 || 5,
  신호: { 등급, 문구, 전환, 전환설명, 내쪽: mineNames.join('·'), 목표쪽: tgtNames.join('·'),
    내쪽목록: mineNames, 목표쪽목록: tgtNames, 선도목록: (S.선도 || []).filter(n => R[n]),
    m3, t3, gap3, m6, t6, gap6, m12, t12, gap12,
    비율: ratio, 비율현재: ratio[L], 위치: posR, 단지비, 단지비현재: 단지비[L], 단지비위치: position(단지비),
    선도: (S.선도 || []).filter(n => R[n]).map(n => ({ 이름: n, m6: R[n].변화.m6 })) },
  지역: regions.map(r => ({ 이름: r.이름, 지수: r.지수, 중위: r.중위, 거래량: r.거래량, 대표단지: r.대표단지,
    대표단지시리즈: r.단지시리즈, 변화: r.변화, 현재중위: r.현재중위, 전세가율: r.전세가율, 최근거래량: r.최근거래량 })),
  두단지: {
    내집: { 이름: CFG.내집.이름, 가격: 내집가, 시리즈: mineS, 최근: recent('내집'), 후보: cand('내집'), 면적: CFG.내집.전용면적 },
    목표: { 이름: CFG.목표.이름, 가격: 목표가, 시리즈: tgtS, 최근: recent('목표'), 후보: cand('목표'), 면적: CFG.목표.전용면적 },
    전세: { 내집: rollingJeonse(store, shown, '내집')[L], 목표: rollingJeonse(store, shown, '목표')[L] },
    가격차, 부대비용, 필요자금: (가격차 != null && 부대비용 != null) ? r2(가격차 + 부대비용) : null,
    가격차시리즈: shown.map((_, i) => (mineS[i] != null && tgtS[i] != null) ? r2(tgtS[i] - mineS[i]) : null)
  }
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`완료: ${shown.length}개월 · 기준 ${shown[L]} · 신호 ${등급} · 전환 ${전환}`);

/* ---------- 신호가 바뀌면 알림 (깃허브가 이슈 등록 메일을 보내 줍니다) ---------- */
const STATE = path.join(ROOT, 'data', 'state.json');
let before = {};
try { before = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { before = {}; }
fs.writeFileSync(STATE, JSON.stringify({ 등급, 전환, 기준월: shown[L] }));

let 제목 = null;
if (before.등급 !== undefined) {                                   // 처음 실행은 알리지 않음
  if (등급 === '🟢' && before.등급 !== '🟢') 제목 = '🟢 갈아타기 구간에 들어왔습니다';
  else if (전환 === '전환 시작' && before.전환 !== '전환 시작') 제목 = '🔄 흐름이 바뀌기 시작했습니다';
  else if (등급 === '🔴' && before.등급 !== '🔴') 제목 = '🔴 지금은 갈아타기 불리한 구간입니다';
}
const TOKEN = process.env.GITHUB_TOKEN, REPO = process.env.GITHUB_REPOSITORY;
if (제목 && TOKEN && REPO) {
  const body = [
    `**${문구}**`, '',
    `| 기간 | ${mineNames.join('·')} | ${tgtNames.join('·')} | 차이 |`,
    '|---|---|---|---|',
    `| 3개월 | ${m3}% | ${t3}% | ${gap3}%p |`,
    `| 6개월 | ${m6}% | ${t6}% | ${gap6}%p |`,
    `| 12개월 | ${m12}% | ${t12}% | ${gap12}%p |`, '',
    `가격 비율 위치: ${posR} / 100 (100에 가까울수록 갈아타기 유리)`,
    `${CFG.내집.이름} ${내집가}억 · ${CFG.목표.이름} ${목표가}억 · 필요 자금 ${out.두단지.필요자금}억`, '',
    `기준: ${shown[L].slice(0, 4)}년 ${+shown[L].slice(4)}월 거래까지`
  ].join('\n');
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `${제목} (${shown[L].slice(2, 4)}년 ${+shown[L].slice(4)}월 기준)`, body })
    });
    console.log(res.ok ? `알림을 보냈습니다: ${제목}` : `알림 실패 (${res.status})`);
  } catch (e) { console.log('알림 실패: ' + e.message); }
} else if (제목) {
  console.log(`알림 대상이지만 토큰이 없어 건너뜁니다: ${제목}`);
}
