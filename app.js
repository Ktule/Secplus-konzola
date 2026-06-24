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
