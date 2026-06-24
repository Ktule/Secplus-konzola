(function(){
'use strict';

/* ===================== STORAGE ===================== */
const STORAGE_KEY = 'secplus_progress_v1';

function loadProgress(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return {
    cardStats: {},   // id -> {seen, again, ok, easy, lastRate, due}
    quizStats: {},   // id -> {seen, correct}
    streak: 0,
    lastVisit: null
  };
}
function saveProgress(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress)); }catch(e){}
}

const state = {
  progress: loadProgress(),
  view: 'home',
  flash: { queue: [], idx: 0, flipped: false },
  quiz: { queue: [], idx: 0, score: 0, answered: false }
};

/* ===================== STREAK ===================== */
function updateStreak(){
  const today = new Date().toDateString();
  const last = state.progress.lastVisit;
  if(last === today) { /* already counted */ }
  else{
    const y = new Date(Date.now() - 86400000).toDateString();
    if(last === y) state.progress.streak = (state.progress.streak||0) + 1;
    else state.progress.streak = 1;
    state.progress.lastVisit = today;
    saveProgress();
  }
  document.getElementById('streakPill').textContent = (state.progress.streak||0) + ' dana niz';
}

/* ===================== DOMAINS ===================== */
const domainOrder = [];
const seen = new Set();
CARDS.forEach(c=>{ if(!seen.has(c.domain)){ seen.add(c.domain); domainOrder.push(c.domain); } });

function domainCards(name){ return CARDS.filter(c=>c.domain===name); }
function domainQuiz(name){ return QUIZ.filter(q=>q.domain===name); }

function domainMastery(name){
  const cards = domainCards(name);
  if(!cards.length) return 0;
  let totalScore = 0;
  cards.forEach(c=>{
    const st = state.progress.cardStats[c.id];
    if(st && st.fsrs){
      // svladanost: stability ≥ 21 dan = 100%, linearno do tamo
      totalScore += Math.min(1, st.fsrs.s / 21);
    }
  });
  return totalScore / cards.length;
}

function renderDomainMap(){
  const el = document.getElementById('domainMap');
  el.innerHTML = '';
  const now = Date.now();
  domainOrder.forEach((name, i)=>{
    const cards = domainCards(name);
    const mastery = domainMastery(name);
    let dueCount = 0;
    cards.forEach(c=>{
      const st = state.progress.cardStats[c.id];
      if(!st || !st.fsrs || FSRS.isDue(st.fsrs, now)) dueCount++;
    });
    const tile = document.createElement('button');
    tile.className = 'domain-tile' + (mastery >= 0.8 ? ' mastered' : '');
    tile.innerHTML = `
      <div class="idx">D${String(i+1).padStart(2,'0')}</div>
      <div class="name">${escapeHtml(name)}</div>
      <div class="meta">${cards.length} pojmova · <span class="due-count">${dueCount} za pregled</span></div>
      <div class="bar"><div class="bar-fill" style="width:${Math.round(mastery*100)}%"></div></div>
    `;
    tile.addEventListener('click', ()=>{
      // u domeni: prioritetno dospjele, pa nove
      const domainDue = [];
      const domainFresh = [];
      cards.forEach(c=>{
        const st = state.progress.cardStats[c.id];
        if(!st || !st.fsrs) domainFresh.push(c);
        else if(FSRS.isDue(st.fsrs, now)) domainDue.push(c);
      });
      const session = [...domainDue, ...shuffle(domainFresh)].slice(0, 30);
      if(session.length === 0){
        // sve svladano za sada — ponudi nasumicni izbor
        openFlashSession(shuffle(cards.slice()).slice(0,15));
      } else {
        openFlashSession(session);
      }
    });
    el.appendChild(tile);
  });
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ===================== NAVIGATION ===================== */
function showView(v){
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.querySelectorAll('.navbtn').forEach(b=>{
    b.classList.toggle('active', b.dataset.view === v);
  });
  state.view = v;
  if(v === 'home'){
    renderDomainMap();
    updateHomeStats();
  }
}

document.querySelectorAll('.navbtn').forEach(b=>{
  b.addEventListener('click', ()=>{
    const v = b.dataset.view;
    if(v === 'flash' && state.flash.queue.length === 0) openFlashSession(weakestCards(20));
    if(v === 'quiz' && state.quiz.queue.length === 0) openQuizSession(shuffle(QUIZ.slice()).slice(0,15));
    showView(v);
  });
});

document.getElementById('flashBack').addEventListener('click', ()=>showView('home'));
document.getElementById('quizBack').addEventListener('click', ()=>showView('home'));
document.getElementById('resultHome').addEventListener('click', ()=>showView('home'));

/* ===================== UTIL ===================== */
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

/* ===================== FSRS (pojednostavljen) ===================== */
// Implementacija inspirirana FSRS-4: stability + difficulty model.
// Ocjene: 1=again, 2=hard, 3=good, 4=easy
const FSRS = {
  // početni stability po prvoj ocjeni (u danima)
  initStability: {1: 0.5, 2: 1.2, 3: 2.5, 4: 6.0},
  // početni difficulty (1-10), niži = lakše
  initDifficulty: {1: 8.0, 2: 6.5, 3: 5.0, 4: 3.5},
  // retention target — koliko želimo da pamtimo (0.9 = 90%)
  retention: 0.9,
  // faktori za novi stability nakon uspješnog odgovora
  stabilityFactor: {2: 1.2, 3: 2.5, 4: 4.0},
  // faktor smanjenja stability nakon "again"
  forgetFactor: 0.2,

  schedule(state, rating, nowMs){
    // state: {s, d, reps, lapses, due, lastReview} ili null
    const now = nowMs || Date.now();
    const ONE_DAY = 86400000;

    if(!state || state.reps === 0){
      // prvi put
      const s = this.initStability[rating];
      const d = this.initDifficulty[rating];
      return {
        s, d,
        reps: 1,
        lapses: rating === 1 ? 1 : 0,
        lastReview: now,
        due: now + s * ONE_DAY
      };
    }

    let { s, d, reps, lapses } = state;
    reps += 1;

    // difficulty update — povećava se za teže ocjene, smanjuje za lakše
    const deltaD = (3 - rating) * 0.6;
    d = Math.max(1, Math.min(10, d + deltaD));

    let newS;
    if(rating === 1){
      // zaboravljeno: stability se naglo smanjuje
      newS = Math.max(0.2, s * this.forgetFactor);
      lapses += 1;
    } else {
      // uspješno: stability raste ovisno o trenutnoj retenciji i ocjeni
      const daysSince = (now - state.lastReview) / ONE_DAY;
      const elapsedRatio = Math.min(daysSince / s, 5);
      // teže pamtljive kartice (visok d) sporije rastu u stability
      const difficultyPenalty = 1 - (d - 5) * 0.05;
      const factor = this.stabilityFactor[rating] * difficultyPenalty;
      newS = s * (1 + factor * Math.exp(-elapsedRatio * 0.5));
    }

    // ograniči maksimalni interval na 365 dana
    newS = Math.min(newS, 365);

    return {
      s: newS,
      d,
      reps,
      lapses,
      lastReview: now,
      due: now + newS * ONE_DAY
    };
  },

  isDue(state, nowMs){
    if(!state) return true;
    return (nowMs || Date.now()) >= state.due;
  }
};

function getDueCards(limit){
  // 1) dospjele kartice (najprije najduže preopterećene)
  // 2) nove kartice ako ima slobodnog prostora
  const now = Date.now();
  const due = [];
  const fresh = [];
  CARDS.forEach(c=>{
    const st = state.progress.cardStats[c.id];
    if(!st || !st.fsrs){
      fresh.push(c);
    } else if(FSRS.isDue(st.fsrs, now)){
      due.push({c, overdue: now - st.fsrs.due});
    }
  });
  // dospjele sortiraj po tome koliko su zakašnjele
  due.sort((a,b)=>b.overdue - a.overdue);
  shuffle(fresh);
  const result = due.slice(0, limit).map(x=>x.c);
  if(result.length < limit){
    result.push(...fresh.slice(0, limit - result.length));
  }
  return result;
}

function formatInterval(days){
  if(days < 1) return Math.round(days*24) + 'h';
  if(days < 30) return Math.round(days) + 'd';
  if(days < 365) return Math.round(days/30) + 'mj';
  return Math.round(days/365) + 'g';
}

/* ===================== FLASHCARDS ===================== */
function openFlashSession(cards){
  if(!cards.length) cards = getDueCards(20);
  state.flash.queue = shuffle(cards.slice());
  state.flash.idx = 0;
  state.flash.flipped = false;
  showView('flash');
  renderFlash();
}

document.getElementById('btnQuickFlash').addEventListener('click', ()=>{
  openFlashSession(getDueCards(20));
});

function renderFlash(){
  const {queue, idx} = state.flash;
  const total = queue.length;
  document.getElementById('flashCounter').textContent = `${Math.min(idx+1,total)}/${total}`;
  document.getElementById('flashProgress').style.width = (total? (idx/total*100):0) + '%';

  if(idx >= total){
    finishFlashSession();
    return;
  }
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
  } else {
    extraEl.style.display = 'none';
    extraEl.innerHTML = '';
  }
  const card = document.getElementById('flashcard');
  card.classList.remove('flipped');
  state.flash.flipped = false;
  document.getElementById('rateRow').classList.remove('show');
  document.getElementById('tapHint').style.display = '';

  // predviđeni intervali za svaki gumb (FSRS preview)
  const cardStat = state.progress.cardStats[c.id];
  const currentFsrs = cardStat ? cardStat.fsrs : null;
  const now = Date.now();
  [1,2,3,4].forEach(r=>{
    const preview = FSRS.schedule(currentFsrs, r, now);
    const days = preview.s;
    const btn = document.querySelector(`.rate-btn[data-rate="${['again','hard','ok','easy'][r-1]}"]`);
    if(btn){
      const sub = btn.querySelector('.rate-interval');
      if(sub) sub.textContent = formatInterval(days);
    }
  });
}

document.getElementById('flashcard').addEventListener('click', ()=>{
  const card = document.getElementById('flashcard');
  state.flash.flipped = !state.flash.flipped;
  card.classList.toggle('flipped', state.flash.flipped);
  document.getElementById('rateRow').classList.toggle('show', state.flash.flipped);
  document.getElementById('tapHint').style.display = state.flash.flipped ? 'none' : '';
});

document.getElementById('rateRow').addEventListener('click', (e)=>{
  const btn = e.target.closest('.rate-btn');
  if(!btn) return;
  const rate = btn.dataset.rate;
  const ratingMap = {again:1, hard:2, ok:3, easy:4};
  const rating = ratingMap[rate] || 3;
  const c = state.flash.queue[state.flash.idx];
  const st = state.progress.cardStats[c.id] || {seen:0, again:0, hard:0, ok:0, easy:0, fsrs:null};
  st.seen += 1;
  st[rate] = (st[rate] || 0) + 1;
  st.lastRate = rate;
  st.fsrs = FSRS.schedule(st.fsrs, rating);
  state.progress.cardStats[c.id] = st;
  saveProgress();

  state.flash.idx += 1;
  renderFlash();
});

function finishFlashSession(){
  const total = state.flash.queue.length;
  const easyCount = state.flash.queue.filter(c=>{
    const st = state.progress.cardStats[c.id];
    return st && st.lastRate === 'easy';
  }).length;
  const pct = total ? Math.round(easyCount/total*100) : 0;
  showResult({
    pct,
    title: 'Sesija kartica završena',
    sub: `${easyCount} od ${total} oznacenih kao poznato. Slabe točke se ponovo prikazuju prioritetno.`,
    retryAction: ()=>openFlashSession(getDueCards(20))
  });
}

/* ===================== QUIZ ===================== */
function openQuizSession(questions){
  state.quiz.queue = questions;
  state.quiz.idx = 0;
  state.quiz.score = 0;
  state.quiz.answered = false;
  showView('quiz');
  renderQuiz();
}

document.getElementById('btnQuickQuiz').addEventListener('click', ()=>{
  openQuizSession(shuffle(QUIZ.slice()).slice(0,15));
});

function renderQuiz(){
  const {queue, idx} = state.quiz;
  const total = queue.length;
  document.getElementById('quizCounter').textContent = `${Math.min(idx+1,total)}/${total}`;
  document.getElementById('quizProgress').style.width = (total? (idx/total*100):0) + '%';
  document.getElementById('quizScore').textContent = state.quiz.score;

  if(idx >= total){
    finishQuizSession();
    return;
  }
  const q = queue[idx];
  state.quiz.answered = false;
  document.getElementById('quizDomainTag').textContent = q.domain;
  document.getElementById('quizQuestion').textContent = q.question;
  const list = document.getElementById('optionList');
  list.innerHTML = '';
  const letters = ['A','B','C','D'];
  q.options.forEach((opt, i)=>{
    const b = document.createElement('button');
    b.className = 'option';
    const text = (typeof opt === 'string') ? opt : opt.text;
    b.innerHTML = `<span class="letter">${letters[i]}</span><div class="opt-body"><span class="opt-text">${escapeHtml(text)}</span><span class="opt-note"></span></div>`;
    b.addEventListener('click', ()=>answerQuiz(i));
    list.appendChild(b);
  });
  document.getElementById('quizNext').classList.remove('show');
  const domNote = document.getElementById('quizDomainNote');
  if(domNote) domNote.style.display = 'none';
}

function answerQuiz(selectedIdx){
  if(state.quiz.answered) return;
  state.quiz.answered = true;
  const q = state.quiz.queue[state.quiz.idx];
  const correct = selectedIdx === q.correct;

  const st = state.progress.quizStats[q.id] || {seen:0, correct:0};
  st.seen += 1;
  if(correct) st.correct += 1;
  state.progress.quizStats[q.id] = st;
  saveProgress();

  if(correct) state.quiz.score += 1;
  document.getElementById('quizScore').textContent = state.quiz.score;

  const opts = document.querySelectorAll('#optionList .option');
  opts.forEach((el, i)=>{
    el.disabled = true;
    const opt = q.options[i];
    const belongsTo = (typeof opt === 'object') ? opt.belongsTo : null;
    const note = el.querySelector('.opt-note');
    if(i === q.correct){
      el.classList.add('correct');
      if(note) note.textContent = '✓ točna definicija pojma „' + q.term + '"';
    } else if(i === selectedIdx){
      el.classList.add('wrong');
      if(note && belongsTo) note.textContent = '✗ ovo je definicija pojma „' + belongsTo + '"';
      else if(note) note.textContent = '✗ netočno';
    } else {
      el.classList.add('answered-dim');
      if(note && belongsTo) note.textContent = 'definicija pojma „' + belongsTo + '"';
    }
  });

  // oznaka domene ispod opcija
  const domNote = document.getElementById('quizDomainNote');
  if(domNote){
    domNote.textContent = 'Domena: ' + q.domain;
    domNote.style.display = '';
  }
  document.getElementById('quizNext').classList.add('show');
}

document.getElementById('quizNext').addEventListener('click', ()=>{
  state.quiz.idx += 1;
  renderQuiz();
});

function finishQuizSession(){
  const total = state.quiz.queue.length;
  const score = state.quiz.score;
  const pct = total ? Math.round(score/total*100) : 0;
  showResult({
    pct,
    title: 'Kviz završen',
    sub: `${score} od ${total} točnih odgovora.`,
    retryAction: ()=>openQuizSession(shuffle(QUIZ.slice()).slice(0,15))
  });
}

/* ===================== EXAM MODE ===================== */
const EXAM = {
  TOTAL_Q: 90,
  TIME_MIN: 90,
  PASS_PCT: 75   // Security+ je 750/900 ≈ 83%, ali ovo je vježba pa 75% kao indikator
};

const exam = {
  questions: [],
  answers: {},     // qIdx -> selectedOptionIdx
  flagged: new Set(),
  current: 0,
  startedAt: 0,
  endsAt: 0,
  tickHandle: null,
  reviewFilter: 'all'
};

document.getElementById('btnExamMode').addEventListener('click', ()=>{
  showModal({
    title: 'Pokreni test',
    text: '90 pitanja, 90 minuta. Odgovori se ne provjeravaju do kraja. Možeš se kretati naprijed-natrag, označavati pitanja za pregled i predati prije isteka vremena.',
    confirmLabel: 'Pokreni',
    confirmClass: 'amber',
    onConfirm: startExam
  });
});

function startExam(){
  exam.questions = shuffle(QUIZ.slice()).slice(0, EXAM.TOTAL_Q);
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
    const remainingMs = exam.endsAt - Date.now();
    if(remainingMs <= 0){
      document.getElementById('examTimer').textContent = '00:00';
      stopExamTimer();
      submitExam(true);
      return;
    }
    const totalSec = Math.floor(remainingMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const el = document.getElementById('examTimer');
    el.textContent = String(min).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
    el.classList.toggle('warning', remainingMs < 5 * 60000);
  };
  tick();
  exam.tickHandle = setInterval(tick, 1000);
}
function stopExamTimer(){
  if(exam.tickHandle){
    clearInterval(exam.tickHandle);
    exam.tickHandle = null;
  }
}

function renderExamQuestion(){
  const q = exam.questions[exam.current];
  if(!q) return;
  document.getElementById('examCounter').textContent = `${exam.current+1}/${exam.questions.length}`;
  document.getElementById('examProgress').style.width = ((exam.current+1)/exam.questions.length*100) + '%';
  document.getElementById('examDomainTag').textContent = q.domain;
  document.getElementById('examQuestion').textContent = q.question;

  const list = document.getElementById('examOptionList');
  list.innerHTML = '';
  const letters = ['A','B','C','D'];
  const selected = exam.answers[exam.current];
  q.options.forEach((opt, i)=>{
    const text = (typeof opt === 'string') ? opt : opt.text;
    const b = document.createElement('button');
    b.className = 'option' + (selected === i ? ' selected' : '');
    b.innerHTML = `<span class="letter">${letters[i]}</span><div class="opt-body"><span class="opt-text">${escapeHtml(text)}</span></div>`;
    b.addEventListener('click', ()=>{
      exam.answers[exam.current] = i;
      renderExamQuestion();
      renderJumpbar();
    });
    list.appendChild(b);
  });

  document.getElementById('examPrev').disabled = (exam.current === 0);
  document.getElementById('examNext').disabled = (exam.current === exam.questions.length - 1);
  const flagBtn = document.getElementById('examFlag');
  flagBtn.classList.toggle('active', exam.flagged.has(exam.current));
  flagBtn.textContent = exam.flagged.has(exam.current) ? '⚑ označeno' : '⚑ označi';
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
    dot.addEventListener('click', ()=>{
      exam.current = i;
      renderExamQuestion();
      renderJumpbar();
    });
    bar.appendChild(dot);
  });
}

document.getElementById('examPrev').addEventListener('click', ()=>{
  if(exam.current > 0){ exam.current--; renderExamQuestion(); renderJumpbar(); }
});
document.getElementById('examNext').addEventListener('click', ()=>{
  if(exam.current < exam.questions.length - 1){ exam.current++; renderExamQuestion(); renderJumpbar(); }
});
document.getElementById('examFlag').addEventListener('click', ()=>{
  if(exam.flagged.has(exam.current)) exam.flagged.delete(exam.current);
  else exam.flagged.add(exam.current);
  renderExamQuestion();
  renderJumpbar();
});

document.getElementById('examBack').addEventListener('click', ()=>{
  showModal({
    title: 'Prekinuti test?',
    text: 'Trenutni odgovori se neće spremiti. Test se može ponoviti s novim nasumičnim pitanjima.',
    confirmLabel: 'Prekini',
    confirmClass: '',
    onConfirm: ()=>{
      stopExamTimer();
      showView('home');
    }
  });
});

document.getElementById('examSubmit').addEventListener('click', ()=>{
  const unanswered = exam.questions.length - Object.keys(exam.answers).length;
  const msg = unanswered > 0
    ? `Neodgovorenih pitanja: ${unanswered}. Predati test?`
    : 'Svi odgovori su uneseni. Predati test?';
  showModal({
    title: 'Predaja testa',
    text: msg,
    confirmLabel: 'Predaj',
    confirmClass: 'amber',
    onConfirm: ()=>submitExam(false)
  });
});

function submitExam(timeUp){
  stopExamTimer();
  // izračunaj rezultate
  let correct = 0;
  const byDomain = {};
  exam.questions.forEach((q, i)=>{
    const sel = exam.answers[i];
    const isCorrect = sel === q.correct;
    if(isCorrect) correct++;
    if(!byDomain[q.domain]) byDomain[q.domain] = {correct:0, total:0};
    byDomain[q.domain].total++;
    if(isCorrect) byDomain[q.domain].correct++;
  });
  const total = exam.questions.length;
  const pct = Math.round(correct/total*100);
  const passed = pct >= EXAM.PASS_PCT;
  const elapsedSec = Math.floor((Date.now() - exam.startedAt) / 1000);
  const elapsedMin = Math.floor(elapsedSec/60);
  const elapsedRest = elapsedSec % 60;

  // popuni summary
  const summary = document.getElementById('examSummary');
  const breakdown = Object.entries(byDomain)
    .sort((a,b)=> (a[1].correct/a[1].total) - (b[1].correct/b[1].total))
    .map(([dom, s])=>{
      const dp = Math.round(s.correct/s.total*100);
      return `<div class="exam-domain-row">
        <span class="dn">${escapeHtml(dom)}</span>
        <span class="dbar"><span class="dbar-fill" style="width:${dp}%; background:${dp>=75?'var(--green)':dp>=50?'var(--amber)':'var(--red)'}"></span></span>
        <span class="dscore">${s.correct}/${s.total}</span>
      </div>`;
    }).join('');

  summary.innerHTML = `
    <div class="exam-summary-row">
      <span class="label">Rezultat</span>
      <span class="val ${passed?'pass':'fail'}">${correct}/${total} · ${pct}%</span>
    </div>
    <div class="exam-summary-row">
      <span class="label">Status</span>
      <span class="val ${passed?'pass':'fail'}">${passed?'PROŠAO':'PAO'} (prag ${EXAM.PASS_PCT}%)</span>
    </div>
    <div class="exam-summary-row">
      <span class="label">Vrijeme</span>
      <span class="val">${String(elapsedMin).padStart(2,'0')}:${String(elapsedRest).padStart(2,'0')}${timeUp?' (isteklo)':''}</span>
    </div>
    <div class="exam-summary-row">
      <span class="label">Označeno za pregled</span>
      <span class="val">${exam.flagged.size}</span>
    </div>
    <div class="exam-domain-breakdown">${breakdown}</div>
  `;

  exam.reviewFilter = 'all';
  document.querySelectorAll('.exam-filter-btn').forEach(b=>b.classList.toggle('active', b.dataset.filter==='all'));
  renderExamReview();
  showView('exam-review');
}

function renderExamReview(){
  const list = document.getElementById('examReviewList');
  list.innerHTML = '';
  const letters = ['A','B','C','D'];
  exam.questions.forEach((q, i)=>{
    const sel = exam.answers[i];
    const isCorrect = sel === q.correct;
    const isSkipped = (sel === undefined);
    const isFlagged = exam.flagged.has(i);
    // filter
    if(exam.reviewFilter === 'wrong' && (isCorrect || isSkipped)) return;
    if(exam.reviewFilter === 'flagged' && !isFlagged) return;
    if(exam.reviewFilter === 'skipped' && !isSkipped) return;

    const correctOpt = q.options[q.correct];
    const correctText = (typeof correctOpt === 'string') ? correctOpt : correctOpt.text;
    let yourLine = '';
    if(isSkipped){
      yourLine = `<div class="review-line skipped"><span class="lbl">Tvoj odgovor:</span><span class="ans">(preskočeno)</span></div>`;
    } else if(isCorrect){
      yourLine = `<div class="review-line your-correct"><span class="lbl">Tvoj odgovor:</span><span class="ans">${letters[sel]} · ${escapeHtml(correctText)}</span></div>`;
    } else {
      const yourOpt = q.options[sel];
      const yourText = (typeof yourOpt === 'string') ? yourOpt : yourOpt.text;
      const belongsTo = (typeof yourOpt === 'object') ? yourOpt.belongsTo : null;
      yourLine = `<div class="review-line your-wrong"><span class="lbl">Tvoj odgovor:</span><span class="ans">${letters[sel]} · ${escapeHtml(yourText)}</span></div>`;
      if(belongsTo){
        yourLine += `<div class="review-line"><span class="lbl">↳</span><span>definicija pojma „${escapeHtml(belongsTo)}"</span></div>`;
      }
    }

    const cls = isCorrect ? 'correct' : isSkipped ? 'skipped' : 'wrong';
    const item = document.createElement('div');
    item.className = `exam-review-item ${cls}`;
    item.innerHTML = `
      <div class="review-num">Pitanje ${i+1}${isFlagged?'<span class="flag">⚑ označeno</span>':''}</div>
      <div class="review-q">${escapeHtml(q.question)}</div>
      ${yourLine}
      <div class="review-line correct"><span class="lbl">Točan odgovor:</span><span class="ans">${letters[q.correct]} · ${escapeHtml(correctText)}</span></div>
      <div class="review-domain">Domena: ${escapeHtml(q.domain)}</div>
    `;
    list.appendChild(item);
  });
  if(list.children.length === 0){
    list.innerHTML = `<div style="text-align:center; color:var(--text-faint); font-family:var(--mono); font-size:12px; padding:30px;">Nema pitanja u ovoj kategoriji.</div>`;
  }
}

document.getElementById('examFilter').addEventListener('click', (e)=>{
  const b = e.target.closest('.exam-filter-btn');
  if(!b) return;
  exam.reviewFilter = b.dataset.filter;
  document.querySelectorAll('.exam-filter-btn').forEach(x=>x.classList.toggle('active', x===b));
  renderExamReview();
});

document.getElementById('examReviewBack').addEventListener('click', ()=>showView('home'));

/* ===================== MODAL ===================== */
function showModal({title, text, confirmLabel, confirmClass, onConfirm}){
  const bd = document.getElementById('modalBackdrop');
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').textContent = text;
  const ok = document.getElementById('modalOk');
  ok.textContent = confirmLabel || 'Potvrdi';
  ok.className = 'btn-primary modal-confirm' + (confirmClass ? ' '+confirmClass : '');
  bd.style.display = '';
  const close = ()=>{ bd.style.display='none'; };
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
  const circumference = 389.6;
  const offset = circumference - (circumference * pct/100);
  const arc = document.getElementById('resultArc');
  arc.style.transition = 'none';
  arc.style.strokeDashoffset = circumference;
  requestAnimationFrame(()=>{
    arc.style.transition = 'stroke-dashoffset .8s ease';
    arc.style.strokeDashoffset = offset;
  });
  arc.style.stroke = pct >= 70 ? '#3FB950' : pct >= 40 ? '#F5A623' : '#E5484D';

  const retryBtn = document.getElementById('resultRetry');
  const newRetry = retryBtn.cloneNode(true);
  retryBtn.parentNode.replaceChild(newRetry, retryBtn);
  newRetry.addEventListener('click', retryAction);
  renderDomainMap();
}

function updateHomeStats(){
  const now = Date.now();
  let due = 0, fresh = 0;
  CARDS.forEach(c=>{
    const st = state.progress.cardStats[c.id];
    if(!st || !st.fsrs) fresh++;
    else if(FSRS.isDue(st.fsrs, now)) due++;
  });
  const desc = document.getElementById('quickFlashDesc');
  if(desc){
    if(due > 0) desc.textContent = `${due} kartica za pregled, ${fresh} novih`;
    else if(fresh > 0) desc.textContent = `Sve svladano za danas, ${fresh} novih za učenje`;
    else desc.textContent = `Sve kartice viđene, ponovi po želji`;
  }
}

/* ===================== INIT ===================== */
updateStreak();
renderDomainMap();
updateHomeStats();

/* Service worker registration */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
})();
