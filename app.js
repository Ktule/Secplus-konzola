(function(){
'use strict';

/* ===================== STORAGE ===================== */
const STORAGE_KEY = 'secplus_progress_v1';

function loadProgress(){
  let p = null;
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) p = JSON.parse(raw);
  }catch(e){}
  if(!p) p = {};
  // migracija: nova polja na postojecim profilima
  if(!p.cardStats) p.cardStats = {};
  if(!p.quizStats) p.quizStats = {};
  if(!p.scenStats) p.scenStats = {};          // id -> {seen, correct, last, fsrs}
  if(!p.dailyActivity) p.dailyActivity = {};  // 'YYYY-MM-DD' -> {cards, quiz, scen}
  if(!p.examHistory) p.examHistory = [];      // [{date, correct, total, pct, durationSec, passed}]
  if(!Array.isArray(p.reported)) p.reported = [];
  if(!p.quizMode) p.quizMode = 'scen';
  if(typeof p.streak !== 'number') p.streak = 0;
  if(p.lastVisit === undefined) p.lastVisit = null;
  return p;
}
function saveProgress(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress)); }catch(e){}
}

const state = {
  progress: loadProgress(),
  view: 'home',
  flash: { queue: [], idx: 0, flipped: false },
  quiz: { queue: [], idx: 0, score: 0, answered: false, mode: 'terms' }
};
state.quiz.mode = state.progress.quizMode;

function todayKey(d){
  const dt = d ? new Date(d) : new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}
function recordActivity(type, n){
  const k = todayKey();
  const a = state.progress.dailyActivity[k] || (state.progress.dailyActivity[k] = {});
  a[type] = (a[type] || 0) + (n || 1);
}

/* ===================== STREAK ===================== */
function updateStreak(){
  const today = new Date().toDateString();
  const last = state.progress.lastVisit;
  if(last !== today){
    const y = new Date(Date.now() - 86400000).toDateString();
    state.progress.streak = (last === y) ? (state.progress.streak||0) + 1 : 1;
    state.progress.lastVisit = today;
    saveProgress();
  }
  document.getElementById('streakPill').textContent = (state.progress.streak||0) + ' dana niz';
}

/* ===================== UTIL ===================== */
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}
function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function pctColor(p){ return p>=80 ? 'var(--green)' : p>=60 ? 'var(--amber)' : 'var(--red)'; }
function domainName(id){ const d = OBJ.domains.find(x=>x.id===id); return d ? d.name : ''; }
function domainOfObj(o){ return parseInt(String(o).split('.')[0], 10); }

/* ===================== FSRS (pojednostavljen) ===================== */
// Ocjene: 1=again, 2=hard, 3=good, 4=easy
const FSRS = {
  initStability: {1: 0.5, 2: 1.2, 3: 2.5, 4: 6.0},
  initDifficulty: {1: 8.0, 2: 6.5, 3: 5.0, 4: 3.5},
  stabilityFactor: {2: 1.2, 3: 2.5, 4: 4.0},
  forgetFactor: 0.2,
  schedule(st, rating, nowMs){
    const now = nowMs || Date.now();
    const ONE_DAY = 86400000;
    if(!st || st.reps === 0){
      const s = this.initStability[rating];
      return { s, d: this.initDifficulty[rating], reps: 1, lapses: rating === 1 ? 1 : 0, lastReview: now, due: now + s * ONE_DAY };
    }
    let { s, d, reps, lapses } = st;
    reps += 1;
    d = Math.max(1, Math.min(10, d + (3 - rating) * 0.6));
    let newS;
    if(rating === 1){
      newS = Math.max(0.2, s * this.forgetFactor);
      lapses += 1;
    } else {
      const daysSince = (now - st.lastReview) / ONE_DAY;
      const elapsedRatio = Math.min(daysSince / s, 5);
      const difficultyPenalty = 1 - (d - 5) * 0.05;
      newS = s * (1 + this.stabilityFactor[rating] * difficultyPenalty * Math.exp(-elapsedRatio * 0.5));
    }
    newS = Math.min(newS, 365);
    return { s: newS, d, reps, lapses, lastReview: now, due: now + newS * ONE_DAY };
  },
  isDue(st, nowMs){ return !st || (nowMs || Date.now()) >= st.due; }
};
function formatInterval(days){
  if(days < 1) return Math.round(days*24) + 'h';
  if(days < 30) return Math.round(days) + 'd';
  if(days < 365) return Math.round(days/30) + 'mj';
  return Math.round(days/365) + 'g';
}

/* ===================== STUDY GUIDE DOMAINS (kartice) ===================== */
const domainOrder = [];
(function(){ const s = new Set(); CARDS.forEach(c=>{ if(!s.has(c.domain)){ s.add(c.domain); domainOrder.push(c.domain); } }); })();
function domainCards(name){ return CARDS.filter(c=>c.domain===name); }
function domainMastery(name){
  const cards = domainCards(name);
  if(!cards.length) return 0;
  let total = 0;
  cards.forEach(c=>{ const st = state.progress.cardStats[c.id]; if(st && st.fsrs) total += Math.min(1, st.fsrs.s / 21); });
  return total / cards.length;
}
function orderCardsForSession(cards, limit){
  const now = Date.now();
  const due = [], fresh = [], rest = [];
  cards.forEach(c=>{
    const st = state.progress.cardStats[c.id];
    if(!st || !st.fsrs) fresh.push(c);
    else if(FSRS.isDue(st.fsrs, now)) due.push({c, over: now - st.fsrs.due});
    else rest.push(c);
  });
  due.sort((a,b)=>b.over-a.over);
  return [...due.map(x=>x.c), ...shuffle(fresh), ...shuffle(rest)].slice(0, limit);
}
function getDueCards(limit){
  const now = Date.now();
  const due = [], fresh = [];
  CARDS.forEach(c=>{
    const st = state.progress.cardStats[c.id];
    if(!st || !st.fsrs) fresh.push(c);
    else if(FSRS.isDue(st.fsrs, now)) due.push({c, over: now - st.fsrs.due});
  });
  due.sort((a,b)=>b.over-a.over);
  const result = due.slice(0, limit).map(x=>x.c);
  if(result.length < limit) result.push(...shuffle(fresh).slice(0, limit - result.length));
  return result;
}
function cardsForObjective(o, limit){
  const sections = Object.keys(OBJ.sections).filter(s=>OBJ.sections[s].includes(o));
  const cards = CARDS.filter(c=>sections.includes(c.domain));
  return orderCardsForSession(cards, limit || 20);
}

function renderDomainMap(){
  const el = document.getElementById('domainMap');
  el.innerHTML = '';
  const now = Date.now();
  domainOrder.forEach((name, i)=>{
    const cards = domainCards(name);
    const mastery = domainMastery(name);
    let dueCount = 0;
    cards.forEach(c=>{ const st = state.progress.cardStats[c.id]; if(!st || !st.fsrs || FSRS.isDue(st.fsrs, now)) dueCount++; });
    const objs = (OBJ.sections[name] || []).join(', ');
    const tile = document.createElement('button');
    tile.className = 'domain-tile' + (mastery >= 0.8 ? ' mastered' : '');
    tile.innerHTML = `
      <div class="idx">D${String(i+1).padStart(2,'0')}${objs ? ' · ' + escapeHtml(objs) : ''}</div>
      <div class="name">${escapeHtml(name)}</div>
      <div class="meta">${cards.length} pojmova · <span class="due-count">${dueCount} za pregled</span></div>
      <div class="bar"><div class="bar-fill" style="width:${Math.round(mastery*100)}%"></div></div>`;
    tile.addEventListener('click', ()=>{
      const session = orderCardsForSession(cards, 30);
      openFlashSession(session.length ? session : shuffle(cards.slice()).slice(0,15));
    });
    el.appendChild(tile);
  });
}

/* ===================== NAVIGATION ===================== */
function showView(v){
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  const navMap = {'exam-home':'exam-home', 'exam-review':'exam-home', 'exam':'exam-home'};
  const navKey = navMap[v] || v;
  document.querySelectorAll('.navbtn').forEach(b=>b.classList.toggle('active', b.dataset.view === navKey));
  document.body.classList.toggle('in-exam', v === 'exam');
  state.view = v;
  window.scrollTo(0,0); document.body.scrollTop = 0; document.documentElement.scrollTop = 0;
  if(v === 'home'){ renderDomainMap(); updateHomeStats(); }
  if(v === 'stats') renderStats();
  if(v === 'exam-home') renderExamHome();
}

document.querySelectorAll('.navbtn').forEach(b=>{
  b.addEventListener('click', ()=>{
    const v = b.dataset.view;
    if(v === 'flash' && (state.flash.queue.length === 0 || state.flash.idx >= state.flash.queue.length)){ openFlashSession(getDueCards(20)); return; }
    if(v === 'quiz' && (state.quiz.queue.length === 0 || state.quiz.idx >= state.quiz.queue.length)){ openQuizSession(state.quiz.mode); return; }
    showView(v);
  });
});
document.getElementById('flashBack').addEventListener('click', ()=>showView('home'));
document.getElementById('quizBack').addEventListener('click', ()=>showView('home'));
document.getElementById('resultHome').addEventListener('click', ()=>showView('home'));

/* ===================== FLASHCARDS ===================== */
function openFlashSession(cards){
  if(!cards || !cards.length) cards = getDueCards(20);
  state.flash.queue = shuffle(cards.slice());
  state.flash.idx = 0;
  state.flash.flipped = false;
  showView('flash');
  renderFlash();
}
document.getElementById('btnQuickFlash').addEventListener('click', ()=>openFlashSession(getDueCards(20)));

function renderFlash(){
  const {queue, idx} = state.flash;
  const total = queue.length;
  document.getElementById('flashCounter').textContent = `${Math.min(idx+1,total)}/${total}`;
  document.getElementById('flashProgress').style.width = (total ? (idx/total*100) : 0) + '%';
  if(idx >= total){ finishFlashSession(); return; }
  const c = queue[idx];
  document.getElementById('flashDomainFront').textContent = c.domain;
  document.getElementById('flashDomainBack').textContent = c.domain;
  document.getElementById('flashTerm').textContent = c.term;
  document.getElementById('flashTermBack').textContent = c.term;
  document.getElementById('flashDef').textContent = c.definition;
  const extraEl = document.getElementById('flashExtra');
  if(c.extra && c.extra.length){
    extraEl.style.display = '';
    extraEl.innerHTML = c.extra.map(x=>`<li>${escapeHtml(x)}</li>`).join('');
  } else { extraEl.style.display = 'none'; extraEl.innerHTML = ''; }
  document.getElementById('flashcard').classList.remove('flipped');
  state.flash.flipped = false;
  document.getElementById('rateRow').classList.remove('show');
  document.getElementById('tapHint').style.display = '';
  const cs = state.progress.cardStats[c.id];
  const cur = cs ? cs.fsrs : null;
  const now = Date.now();
  ['again','hard','ok','easy'].forEach((r, i)=>{
    const btn = document.querySelector(`.rate-btn[data-rate="${r}"] .rate-interval`);
    if(btn) btn.textContent = formatInterval(FSRS.schedule(cur, i+1, now).s);
  });
}
document.getElementById('flashcard').addEventListener('click', ()=>{
  state.flash.flipped = !state.flash.flipped;
  document.getElementById('flashcard').classList.toggle('flipped', state.flash.flipped);
  document.getElementById('rateRow').classList.toggle('show', state.flash.flipped);
  document.getElementById('tapHint').style.display = state.flash.flipped ? 'none' : '';
});
document.getElementById('rateRow').addEventListener('click', (e)=>{
  const btn = e.target.closest('.rate-btn');
  if(!btn || !state.flash.flipped) return;
  const rate = btn.dataset.rate;
  const rating = {again:1, hard:2, ok:3, easy:4}[rate] || 3;
  const c = state.flash.queue[state.flash.idx];
  const st = state.progress.cardStats[c.id] || {seen:0, fsrs:null};
  st.seen = (st.seen||0) + 1;
  st[rate] = (st[rate] || 0) + 1;
  st.lastRate = rate;
  st.fsrs = FSRS.schedule(st.fsrs, rating);
  state.progress.cardStats[c.id] = st;
  recordActivity('cards');
  saveProgress();
  state.flash.idx += 1;
  renderFlash();
});
function finishFlashSession(){
  const total = state.flash.queue.length;
  const easy = state.flash.queue.filter(c=>{ const st = state.progress.cardStats[c.id]; return st && (st.lastRate === 'easy' || st.lastRate === 'ok'); }).length;
  showResult({
    pct: total ? Math.round(easy/total*100) : 0,
    title: 'Sesija kartica završena',
    sub: `${easy} od ${total} označenih kao Dobro ili Znam. Slabe točke se vraćaju prema rasporedu.`,
    retryAction: ()=>openFlashSession(getDueCards(20))
  });
}

/* ===================== SCENARIO SELECTION ===================== */
const SCEN_BY_ID = {};
SCEN.forEach(q=>{ SCEN_BY_ID[q.id] = q; });

function pickScenQuestions(n, pool){
  const now = Date.now();
  const src = pool || SCEN;
  const wrongDue = [], unseen = [], dueOk = [], rest = [];
  src.forEach(q=>{
    const st = state.progress.scenStats[q.id];
    if(!st) unseen.push(q);
    else if(st.last === false && FSRS.isDue(st.fsrs, now)) wrongDue.push({q, over: now - st.fsrs.due});
    else if(FSRS.isDue(st.fsrs, now)) dueOk.push(q);
    else rest.push({q, due: st.fsrs ? st.fsrs.due : 0});
  });
  wrongDue.sort((a,b)=>b.over-a.over);
  rest.sort((a,b)=>a.due-b.due);
  const list = [...wrongDue.map(x=>x.q), ...shuffle(unseen), ...shuffle(dueOk), ...rest.map(x=>x.q)];
  return shuffle(list.slice(0, n));
}
function recordScen(q, ok){
  const st = state.progress.scenStats[q.id] || {seen:0, correct:0, last:null, fsrs:null};
  st.seen += 1;
  if(ok) st.correct += 1;
  st.last = ok;
  st.fsrs = FSRS.schedule(st.fsrs, ok ? 3 : 1);
  state.progress.scenStats[q.id] = st;
}
function isReported(id){ return state.progress.reported.includes(id); }
function toggleReport(id){
  const r = state.progress.reported;
  const i = r.indexOf(id);
  if(i >= 0) r.splice(i,1); else r.push(id);
  saveProgress();
  return i < 0;
}

/* ===================== QUIZ (pojmovi + scenariji) ===================== */
function openQuizSession(mode){
  mode = mode || state.quiz.mode;
  state.quiz.mode = mode;
  state.progress.quizMode = mode;
  saveProgress();
  state.quiz.queue = mode === 'scen' ? pickScenQuestions(15) : shuffle(QUIZ.slice()).slice(0,15);
  state.quiz.idx = 0;
  state.quiz.score = 0;
  state.quiz.answered = false;
  document.querySelectorAll('#quizSegment .seg-btn').forEach(b=>b.classList.toggle('active', b.dataset.mode === mode));
  showView('quiz');
  renderQuiz();
}
document.getElementById('btnQuickQuiz').addEventListener('click', ()=>openQuizSession('terms'));
document.getElementById('btnQuickScen').addEventListener('click', ()=>openQuizSession('scen'));
document.getElementById('quizSegment').addEventListener('click', (e)=>{
  const b = e.target.closest('.seg-btn');
  if(!b || b.dataset.mode === state.quiz.mode) return;
  openQuizSession(b.dataset.mode);
});

const LETTERS = ['A','B','C','D'];

function renderQuiz(){
  const {queue, idx, mode} = state.quiz;
  const total = queue.length;
  document.getElementById('quizCounter').textContent = `${Math.min(idx+1,total)}/${total}`;
  document.getElementById('quizProgress').style.width = (total ? (idx/total*100) : 0) + '%';
  document.getElementById('quizScore').textContent = state.quiz.score;
  if(idx >= total){ finishQuizSession(); return; }
  const q = queue[idx];
  state.quiz.answered = false;
  const isScen = mode === 'scen';
  document.getElementById('quizDomainTag').textContent = isScen ? `${q.o} · ${domainName(q.d)}` : q.domain;
  document.getElementById('quizQuestion').textContent = isScen ? q.q : q.question;
  document.getElementById('quizQuestion').classList.toggle('scen', isScen);
  const list = document.getElementById('optionList');
  list.innerHTML = '';
  const opts = isScen ? q.a : q.options;
  opts.forEach((opt, i)=>{
    const b = document.createElement('button');
    b.className = 'option';
    const text = (typeof opt === 'string') ? opt : opt.text;
    b.innerHTML = `<span class="letter">${LETTERS[i]}</span><div class="opt-body"><span class="opt-text">${escapeHtml(text)}</span><span class="opt-note"></span></div>`;
    b.addEventListener('click', ()=>answerQuiz(i));
    list.appendChild(b);
  });
  document.getElementById('quizNext').classList.remove('show');
  document.getElementById('quizDomainNote').style.display = 'none';
  document.getElementById('quizExplain').style.display = 'none';
}

function answerQuiz(sel){
  if(state.quiz.answered) return;
  state.quiz.answered = true;
  const q = state.quiz.queue[state.quiz.idx];
  const isScen = state.quiz.mode === 'scen';
  const correctIdx = isScen ? q.c : q.correct;
  const ok = sel === correctIdx;

  if(isScen){
    recordScen(q, ok);
    recordActivity('scen');
  } else {
    const st = state.progress.quizStats[q.id] || {seen:0, correct:0};
    st.seen += 1; if(ok) st.correct += 1;
    state.progress.quizStats[q.id] = st;
    recordActivity('quiz');
  }
  saveProgress();
  if(ok) state.quiz.score += 1;
  document.getElementById('quizScore').textContent = state.quiz.score;

  document.querySelectorAll('#optionList .option').forEach((el, i)=>{
    el.disabled = true;
    const note = el.querySelector('.opt-note');
    if(i === correctIdx){
      el.classList.add('correct');
      if(!isScen && note) note.textContent = '✓ točna definicija pojma „' + q.term + '"';
    } else if(i === sel){
      el.classList.add('wrong');
      const bt = !isScen && typeof q.options[i] === 'object' ? q.options[i].belongsTo : null;
      if(note) note.textContent = bt ? '✗ ovo je definicija pojma „' + bt + '"' : (isScen ? '' : '✗ netočno');
    } else {
      el.classList.add('answered-dim');
      const bt = !isScen && typeof q.options[i] === 'object' ? q.options[i].belongsTo : null;
      if(note && bt) note.textContent = 'definicija pojma „' + bt + '"';
    }
  });

  if(isScen){
    document.getElementById('quizExplainText').textContent = q.e;
    document.getElementById('quizExplainMeta').textContent = `Objective ${q.o}: ${OBJ.objectives[q.o]} · ${domainName(q.d)}`;
    const rb = document.getElementById('quizReport');
    rb.classList.toggle('active', isReported(q.id));
    rb.textContent = isReported(q.id) ? '⚑ Prijavljeno' : '⚐ Prijavi pitanje';
    rb.onclick = ()=>{
      const on = toggleReport(q.id);
      rb.classList.toggle('active', on);
      rb.textContent = on ? '⚑ Prijavljeno' : '⚐ Prijavi pitanje';
    };
    document.getElementById('quizExplain').style.display = '';
  } else {
    const dn = document.getElementById('quizDomainNote');
    dn.textContent = 'Domena: ' + q.domain;
    dn.style.display = '';
  }
  document.getElementById('quizNext').classList.add('show');
}
document.getElementById('quizNext').addEventListener('click', ()=>{
  state.quiz.idx += 1;
  renderQuiz();
});
function finishQuizSession(){
  const total = state.quiz.queue.length, score = state.quiz.score;
  const mode = state.quiz.mode;
  showResult({
    pct: total ? Math.round(score/total*100) : 0,
    title: mode === 'scen' ? 'Kviz scenariji završen' : 'Kviz pojmovi završen',
    sub: `${score} od ${total} točnih odgovora.` + (mode === 'scen' ? ' Pogrešno odgovorena pitanja vraćaju se u sljedećim kvizovima.' : ''),
    retryAction: ()=>openQuizSession(mode)
  });
}

/* ===================== EXAM ===================== */
const EXAM = {
  TOTAL_Q: 90,
  TIME_MIN: 90,
  PASS_CORRECT: 80,              // najvise 10 pogresnih
  DIST: {1:11, 2:20, 3:16, 4:25, 5:18}   // sluzbene tezine 12/22/18/28/20 posto
};
const exam = { questions: [], answers: {}, flagged: new Set(), current: 0, startedAt: 0, endsAt: 0, tickHandle: null, reviewFilter: 'all' };

function renderExamHome(){
  document.getElementById('examDist').innerHTML = OBJ.domains.map(d=>
    `<div class="exam-dist-row"><span>${d.id}. ${escapeHtml(d.name)}</span><span class="n">${EXAM.DIST[d.id]} · ${d.weight}%</span></div>`
  ).join('');
  const hist = state.progress.examHistory.slice(-5).reverse();
  document.getElementById('examHomeHistory').innerHTML = hist.length ? hist.map(examHistoryRow).join('')
    : `<div class="stats-empty">Još nema odrađenih ispita.</div>`;
}
function examHistoryRow(h){
  const d = new Date(h.date);
  const ds = String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + d.getFullYear() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  const passed = h.passed !== undefined ? h.passed : h.correct >= EXAM.PASS_CORRECT;
  return `<div class="exam-history-row">
    <div><div class="ehdate">${ds}</div><div class="ehdate">${h.correct}/${h.total} · ${Math.floor((h.durationSec||0)/60)} min</div></div>
    <div class="ehscore ${passed?'pass':'fail'}">${h.pct}% ${passed?'PROŠAO':'PAO'}</div>
  </div>`;
}

document.getElementById('btnExamHome').addEventListener('click', ()=>showView('exam-home'));
document.getElementById('examStart').addEventListener('click', ()=>{
  showModal({
    title: 'Pokreni ispit',
    text: '90 pitanja, 90 minuta. Odgovori se ne prikazuju do predaje. Možeš se kretati naprijed i natrag, označiti pitanja za pregled i predati prije isteka vremena. Prolaz: najmanje 80 točnih.',
    confirmLabel: 'Pokreni',
    confirmClass: 'amber',
    onConfirm: startExam
  });
});

function pickExamQuestions(){
  const out = [];
  OBJ.domains.forEach(d=>{
    const pool = SCEN.filter(q=>q.d === d.id).map(q=>{
      const st = state.progress.scenStats[q.id];
      return {q, k: (st ? st.seen : 0) + Math.random()};
    });
    pool.sort((a,b)=>a.k-b.k);
    out.push(...pool.slice(0, EXAM.DIST[d.id]).map(x=>x.q));
  });
  return shuffle(out);
}
function startExam(){
  exam.questions = pickExamQuestions();
  exam.answers = {};
  exam.flagged = new Set();
  exam.current = 0;
  exam.startedAt = Date.now();
  exam.endsAt = exam.startedAt + EXAM.TIME_MIN * 60000;
  showView('exam');
  renderExamQuestion();
  renderJumpbar();
  startExamTimer();
}
function startExamTimer(){
  stopExamTimer();
  const tick = ()=>{
    const rem = exam.endsAt - Date.now();
    const el = document.getElementById('examTimer');
    if(rem <= 0){ el.textContent = '00:00'; stopExamTimer(); submitExam(true); return; }
    const t = Math.floor(rem/1000);
    el.textContent = String(Math.floor(t/60)).padStart(2,'0') + ':' + String(t%60).padStart(2,'0');
    el.classList.toggle('warning', rem < 5*60000);
  };
  tick();
  exam.tickHandle = setInterval(tick, 1000);
}
function stopExamTimer(){ if(exam.tickHandle){ clearInterval(exam.tickHandle); exam.tickHandle = null; } }

function renderExamQuestion(){
  const q = exam.questions[exam.current];
  if(!q) return;
  document.getElementById('examCounter').textContent = `${exam.current+1}/${exam.questions.length}`;
  document.getElementById('examProgress').style.width = ((exam.current+1)/exam.questions.length*100) + '%';
  document.getElementById('examDomainTag').textContent = domainName(q.d);
  document.getElementById('examQuestion').textContent = q.q;
  const list = document.getElementById('examOptionList');
  list.innerHTML = '';
  const selected = exam.answers[exam.current];
  q.a.forEach((text, i)=>{
    const b = document.createElement('button');
    b.className = 'option' + (selected === i ? ' selected' : '');
    b.innerHTML = `<span class="letter">${LETTERS[i]}</span><div class="opt-body"><span class="opt-text">${escapeHtml(text)}</span></div>`;
    b.addEventListener('click', ()=>{ exam.answers[exam.current] = i; renderExamQuestion(); renderJumpbar(); });
    list.appendChild(b);
  });
  document.getElementById('examPrev').disabled = exam.current === 0;
  document.getElementById('examNext').disabled = exam.current === exam.questions.length - 1;
  const fb = document.getElementById('examFlag');
  fb.classList.toggle('active', exam.flagged.has(exam.current));
  fb.textContent = exam.flagged.has(exam.current) ? '⚑ označeno' : '⚑ označi';
}
function renderJumpbar(){
  const bar = document.getElementById('examJumpbar');
  bar.innerHTML = '';
  exam.questions.forEach((_, i)=>{
    const dot = document.createElement('button');
    let cls = 'jump-dot';
    if(exam.answers[i] !== undefined) cls += ' answered';
    if(exam.flagged.has(i)) cls += ' flagged';
    if(i === exam.current) cls += ' current';
    dot.className = cls;
    dot.textContent = i+1;
    dot.addEventListener('click', ()=>{ exam.current = i; renderExamQuestion(); renderJumpbar(); });
    bar.appendChild(dot);
  });
}
document.getElementById('examPrev').addEventListener('click', ()=>{ if(exam.current > 0){ exam.current--; renderExamQuestion(); renderJumpbar(); } });
document.getElementById('examNext').addEventListener('click', ()=>{ if(exam.current < exam.questions.length-1){ exam.current++; renderExamQuestion(); renderJumpbar(); } });
document.getElementById('examFlag').addEventListener('click', ()=>{
  if(exam.flagged.has(exam.current)) exam.flagged.delete(exam.current); else exam.flagged.add(exam.current);
  renderExamQuestion(); renderJumpbar();
});
document.getElementById('examBack').addEventListener('click', ()=>{
  showModal({
    title: 'Prekinuti ispit?',
    text: 'Odgovori iz ovog ispita neće se spremiti ni bodovati.',
    confirmLabel: 'Prekini',
    confirmClass: '',
    onConfirm: ()=>{ stopExamTimer(); showView('exam-home'); }
  });
});
document.getElementById('examSubmit').addEventListener('click', ()=>{
  const un = exam.questions.length - Object.keys(exam.answers).length;
  showModal({
    title: 'Predaja ispita',
    text: un > 0 ? `Neodgovorenih pitanja: ${un}. Računaju se kao pogrešna. Predati ispit?` : 'Svi odgovori su uneseni. Predati ispit?',
    confirmLabel: 'Predaj',
    confirmClass: 'amber',
    onConfirm: ()=>submitExam(false)
  });
});

function submitExam(timeUp){
  stopExamTimer();
  let correct = 0;
  const byDomain = {}, byObj = {};
  exam.questions.forEach((q, i)=>{
    const sel = exam.answers[i];
    const ok = sel === q.c;
    if(ok) correct++;
    (byDomain[q.d] = byDomain[q.d] || {correct:0, total:0}).total++;
    (byObj[q.o] = byObj[q.o] || {correct:0, total:0}).total++;
    if(ok){ byDomain[q.d].correct++; byObj[q.o].correct++; }
    recordScen(q, ok);
  });
  const total = exam.questions.length;
  const wrong = total - correct;
  const pct = Math.round(correct/total*100);
  const passed = correct >= EXAM.PASS_CORRECT;
  const elapsedSec = Math.min(EXAM.TIME_MIN*60, Math.floor((Date.now() - exam.startedAt)/1000));
  state.progress.examHistory.push({date: Date.now(), correct, total, pct, durationSec: elapsedSec, passed});
  if(state.progress.examHistory.length > 50) state.progress.examHistory = state.progress.examHistory.slice(-50);
  recordActivity('scen', Object.keys(exam.answers).length);
  saveProgress();

  const breakdown = OBJ.domains.map(d=>{
    const s = byDomain[d.id] || {correct:0,total:0};
    const dp = s.total ? Math.round(s.correct/s.total*100) : 0;
    return `<div class="exam-domain-row">
      <span class="dn">${d.id}. ${escapeHtml(d.name)}</span>
      <span class="dbar"><span class="dbar-fill" style="width:${dp}%; background:${pctColor(dp)}"></span></span>
      <span class="dscore">${s.correct}/${s.total}</span>
    </div>`;
  }).join('');
  const mm = Math.floor(elapsedSec/60), ss = elapsedSec%60;
  document.getElementById('examSummary').innerHTML = `
    <div class="exam-summary-row"><span class="label">Rezultat</span><span class="val ${passed?'pass':'fail'}">${correct}/${total} · ${pct}%</span></div>
    <div class="exam-summary-row"><span class="label">Pogrešnih</span><span class="val ${passed?'pass':'fail'}">${wrong} (dopušteno 10)</span></div>
    <div class="exam-summary-row"><span class="label">Status</span><span class="val ${passed?'pass':'fail'}">${passed?'PROŠAO':'PAO'}</span></div>
    <div class="exam-summary-row"><span class="label">Vrijeme</span><span class="val">${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}${timeUp?' (isteklo)':''}</span></div>
    <div class="exam-summary-row"><span class="label">Označeno za pregled</span><span class="val">${exam.flagged.size}</span></div>
    <div class="exam-domain-breakdown">${breakdown}</div>`;

  const weak = Object.entries(byObj).filter(([,s])=>s.correct < s.total)
    .sort((a,b)=>(a[1].correct/a[1].total)-(b[1].correct/b[1].total) || (b[1].total-b[1].correct)-(a[1].total-a[1].correct)).slice(0,6);
  const weakEl = document.getElementById('examWeak');
  if(weak.length){
    weakEl.innerHTML = `<div class="weak-box"><div class="wt">Ciljevi s pogreškama, otvori kartice</div><div class="stats-domain-list">${
      weak.map(([o,s])=>objRow(o, s.correct, s.total)).join('')}</div></div>`;
    bindObjRows(weakEl);
  } else weakEl.innerHTML = '';

  exam.reviewFilter = 'all';
  document.querySelectorAll('.exam-filter-btn').forEach(b=>b.classList.toggle('active', b.dataset.filter==='all'));
  renderExamReview();
  showView('exam-review');
}

function objRow(o, correct, total){
  const p = total ? Math.round(correct/total*100) : 0;
  return `<button class="stats-row obj-row" data-obj="${o}">
    <span class="sdn">${o} ${escapeHtml(OBJ.objectives[o])}<small>${correct}/${total} točno · kartice →</small></span>
    <span class="sdbar"><span class="sdbar-fill" style="width:${p}%; background:${pctColor(p)}"></span></span>
    <span class="sdpct" style="color:${pctColor(p)}">${p}%</span>
  </button>`;
}
function bindObjRows(root){
  root.querySelectorAll('.obj-row').forEach(b=>b.addEventListener('click', ()=>openFlashSession(cardsForObjective(b.dataset.obj, 20))));
}

function renderExamReview(){
  const list = document.getElementById('examReviewList');
  list.innerHTML = '';
  exam.questions.forEach((q, i)=>{
    const sel = exam.answers[i];
    const ok = sel === q.c;
    const skipped = sel === undefined;
    const flagged = exam.flagged.has(i);
    if(exam.reviewFilter === 'wrong' && ok) return;
    if(exam.reviewFilter === 'flagged' && !flagged) return;
    if(exam.reviewFilter === 'skipped' && !skipped) return;
    let yours;
    if(skipped) yours = `<div class="review-line skipped"><span class="lbl">Tvoj odgovor:</span><span class="ans">(neodgovoreno)</span></div>`;
    else yours = `<div class="review-line ${ok?'your-correct':'your-wrong'}"><span class="lbl">Tvoj odgovor:</span><span class="ans">${LETTERS[sel]} · ${escapeHtml(q.a[sel])}</span></div>`;
    const item = document.createElement('div');
    item.className = `exam-review-item ${ok?'correct':skipped?'skipped':'wrong'}`;
    item.innerHTML = `
      <div class="review-num">Pitanje ${i+1} · ${q.id}${flagged?'<span class="flag">⚑ označeno</span>':''}</div>
      <div class="review-q">${escapeHtml(q.q)}</div>
      ${yours}
      ${ok ? '' : `<div class="review-line correct"><span class="lbl">Točan odgovor:</span><span class="ans">${LETTERS[q.c]} · ${escapeHtml(q.a[q.c])}</span></div>`}
      <div class="review-expl">${escapeHtml(q.e)}</div>
      <div class="review-domain">${q.o} ${escapeHtml(OBJ.objectives[q.o])}</div>
      <button class="report-btn ${isReported(q.id)?'active':''}" data-id="${q.id}">${isReported(q.id)?'⚑ Prijavljeno':'⚐ Prijavi pitanje'}</button>`;
    list.appendChild(item);
  });
  list.querySelectorAll('.report-btn').forEach(b=>b.addEventListener('click', ()=>{
    const on = toggleReport(b.dataset.id);
    b.classList.toggle('active', on);
    b.textContent = on ? '⚑ Prijavljeno' : '⚐ Prijavi pitanje';
  }));
  if(!list.children.length) list.innerHTML = `<div class="stats-empty">Nema pitanja u ovoj kategoriji.</div>`;
}
document.getElementById('examFilter').addEventListener('click', (e)=>{
  const b = e.target.closest('.exam-filter-btn');
  if(!b) return;
  exam.reviewFilter = b.dataset.filter;
  document.querySelectorAll('.exam-filter-btn').forEach(x=>x.classList.toggle('active', x===b));
  renderExamReview();
});
document.getElementById('examReviewBack').addEventListener('click', ()=>showView('exam-home'));

/* ===================== STATS ===================== */
function renderStats(){
  const now = Date.now();
  let mastered = 0, inProg = 0, untouched = 0;
  CARDS.forEach(c=>{
    const st = state.progress.cardStats[c.id];
    if(!st || !st.fsrs) untouched++; else if(st.fsrs.s >= 21) mastered++; else inProg++;
  });
  document.getElementById('statsCards').innerHTML = `
    <div class="stat-box"><div class="num green">${mastered}</div><div class="lbl">svladano</div></div>
    <div class="stat-box"><div class="num amber">${inProg}</div><div class="lbl">u tijeku</div></div>
    <div class="stat-box"><div class="num dim">${untouched}</div><div class="lbl">nedirnuto</div></div>`;

  // scenariji po domenama: tocnost zadnjeg odgovora na vidjena pitanja
  const dom = {}, obj = {};
  SCEN.forEach(q=>{
    const st = state.progress.scenStats[q.id];
    const D = dom[q.d] = dom[q.d] || {seen:0, ok:0, total:0};
    D.total++;
    if(st){
      D.seen++; if(st.last) D.ok++;
      const O = obj[q.o] = obj[q.o] || {seen:0, ok:0};
      O.seen++; if(st.last) O.ok++;
    }
  });
  document.getElementById('statsDomains').innerHTML = OBJ.domains.map(d=>{
    const s = dom[d.id];
    const p = s.seen ? Math.round(s.ok/s.seen*100) : 0;
    const col = s.seen ? pctColor(p) : 'var(--text-faint)';
    return `<div class="stats-row">
      <span class="sdn">${d.id}. ${escapeHtml(d.name)}<small>${s.seen}/${s.total} viđeno</small></span>
      <span class="sdbar"><span class="sdbar-fill" style="width:${p}%; background:${col}"></span></span>
      <span class="sdpct" style="color:${col}">${s.seen ? p+'%' : '·'}</span>
    </div>`;
  }).join('');

  const weak = Object.entries(obj).filter(([,s])=>s.seen >= 2)
    .sort((a,b)=>(a[1].ok/a[1].seen)-(b[1].ok/b[1].seen)).slice(0,8);
  const wEl = document.getElementById('statsObjectives');
  if(weak.length){
    wEl.innerHTML = weak.map(([o,s])=>objRow(o, s.ok, s.seen)).join('');
    bindObjRows(wEl);
  } else wEl.innerHTML = `<div class="stats-empty">Potrebna su barem dva odgovorena pitanja po cilju.</div>`;

  const days = [];
  for(let i=29;i>=0;i--){
    const k = todayKey(now - i*86400000);
    const a = state.progress.dailyActivity[k] || {};
    days.push({k, t:(a.cards||0)+(a.quiz||0)+(a.scen||0)});
  }
  const max = Math.max(1, ...days.map(d=>d.t));
  document.getElementById('activityChart').innerHTML = days.map(d=>
    `<div class="activity-bar" title="${d.k}: ${d.t}"><div class="abar ${d.t?'':'empty'}" style="height:${d.t ? Math.max(4, d.t/max*100) : 0}%"></div></div>`).join('');

  const hist = state.progress.examHistory.slice().reverse();
  document.getElementById('examHistoryList').innerHTML = hist.length ? hist.map(examHistoryRow).join('')
    : `<div class="stats-empty">Još nema odrađenih ispita.</div>`;

  renderReported();
}

function renderReported(){
  const box = document.getElementById('reportedBox');
  const ids = state.progress.reported.filter(id=>SCEN_BY_ID[id]);
  if(!ids.length){ box.innerHTML = `<div class="stats-empty">Nema prijavljenih pitanja.</div>`; return; }
  const text = ids.map(id=>{ const q = SCEN_BY_ID[id]; return `${id} | ${q.o} | ${q.q.slice(0,90)}`; }).join('\n');
  box.innerHTML = `<div class="weak-box">
    <div class="wt">${ids.length} prijavljeno, pošalji popis na ispravak</div>
    <textarea class="reported-text" id="reportedText" readonly>${escapeHtml(text)}</textarea>
    <div style="display:flex; gap:8px; margin-top:10px;">
      <button class="btn-primary" id="reportedCopy">Kopiraj popis</button>
      <button class="btn-secondary" id="reportedClear">Očisti</button>
    </div></div>`;
  document.getElementById('reportedCopy').addEventListener('click', ()=>{
    const ta = document.getElementById('reportedText');
    const done = ()=>{ document.getElementById('reportedCopy').textContent = 'Kopirano'; };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(ta.value).then(done, ()=>{ ta.select(); try{ document.execCommand('copy'); done(); }catch(e){} });
    } else { ta.select(); try{ document.execCommand('copy'); done(); }catch(e){} }
  });
  document.getElementById('reportedClear').addEventListener('click', ()=>{
    showModal({ title:'Očistiti prijave?', text:'Popis prijavljenih pitanja bit će obrisan s ovog uređaja.', confirmLabel:'Očisti', confirmClass:'', onConfirm: ()=>{ state.progress.reported = []; saveProgress(); renderReported(); } });
  });
}

/* ===================== MODAL ===================== */
function showModal({title, text, confirmLabel, confirmClass, onConfirm}){
  const bd = document.getElementById('modalBackdrop');
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').textContent = text;
  const ok = document.getElementById('modalOk');
  ok.textContent = confirmLabel || 'Potvrdi';
  ok.className = 'btn-primary modal-confirm' + (confirmClass ? ' '+confirmClass : '');
  bd.style.display = '';
  const nav = document.querySelector('.bottomnav');
  if(nav) nav.style.visibility = 'hidden';
  const close = ()=>{ bd.style.display = 'none'; if(nav) nav.style.visibility = ''; };
  const newOk = ok.cloneNode(true);
  ok.parentNode.replaceChild(newOk, ok);
  newOk.addEventListener('click', ()=>{ close(); onConfirm && onConfirm(); });
  const cancel = document.getElementById('modalCancel');
  const newCancel = cancel.cloneNode(true);
  cancel.parentNode.replaceChild(newCancel, cancel);
  newCancel.addEventListener('click', close);
}

/* ===================== RESULT ===================== */
function showResult({pct, title, sub, retryAction}){
  showView('result');
  document.getElementById('resultPct').textContent = pct + '%';
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('resultSub').textContent = sub;
  const C = 389.6;
  const arc = document.getElementById('resultArc');
  arc.style.transition = 'none';
  arc.style.strokeDashoffset = C;
  requestAnimationFrame(()=>{ arc.style.transition = 'stroke-dashoffset .8s ease'; arc.style.strokeDashoffset = C - C*pct/100; });
  arc.style.stroke = pct >= 80 ? '#3FB950' : pct >= 60 ? '#F5A623' : '#E5484D';
  const rb = document.getElementById('resultRetry');
  const nrb = rb.cloneNode(true);
  rb.parentNode.replaceChild(nrb, rb);
  nrb.addEventListener('click', retryAction);
}

function updateHomeStats(){
  const now = Date.now();
  let due = 0, fresh = 0;
  CARDS.forEach(c=>{ const st = state.progress.cardStats[c.id]; if(!st || !st.fsrs) fresh++; else if(FSRS.isDue(st.fsrs, now)) due++; });
  const desc = document.getElementById('quickFlashDesc');
  if(due > 0) desc.textContent = `${due} kartica za pregled, ${fresh} novih`;
  else if(fresh > 0) desc.textContent = `Sve pregledano za danas, ${fresh} novih`;
  else desc.textContent = 'Sve kartice viđene, ponovi po želji';

  let wrongDue = 0, unseen = 0;
  SCEN.forEach(q=>{ const st = state.progress.scenStats[q.id]; if(!st) unseen++; else if(st.last === false && FSRS.isDue(st.fsrs, now)) wrongDue++; });
  const sd = document.getElementById('quickScenDesc');
  sd.textContent = wrongDue ? `${wrongDue} za ponavljanje, ${unseen} novih` : `${unseen} novih od ${SCEN.length}, s objašnjenjem`;
}

/* ===================== INIT ===================== */
updateStreak();
renderDomainMap();
updateHomeStats();

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
}
})();
