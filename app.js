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
  let masteredCount = 0;
  cards.forEach(c=>{
    const st = state.progress.cardStats[c.id];
    if(st && st.lastRate === 'easy') masteredCount++;
  });
  return masteredCount / cards.length;
}

function renderDomainMap(){
  const el = document.getElementById('domainMap');
  el.innerHTML = '';
  domainOrder.forEach((name, i)=>{
    const cards = domainCards(name);
    const mastery = domainMastery(name);
    const tile = document.createElement('button');
    tile.className = 'domain-tile' + (mastery >= 0.8 ? ' mastered' : '');
    tile.innerHTML = `
      <div class="idx">D${String(i+1).padStart(2,'0')}</div>
      <div class="name">${escapeHtml(name)}</div>
      <div class="meta">${cards.length} pojmova</div>
      <div class="bar"><div class="bar-fill" style="width:${Math.round(mastery*100)}%"></div></div>
    `;
    tile.addEventListener('click', ()=>{
      openFlashSession(domainCards(name));
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

function weakestCards(n){
  // prioritiziraj kartice koje nisu vidjene ili su ocijenjene 'again'
  const withScore = CARDS.map(c=>{
    const st = state.progress.cardStats[c.id];
    let score = 0;
    if(!st) score = 100; // never seen -> high priority
    else if(st.lastRate === 'again') score = 90;
    else if(st.lastRate === 'ok') score = 50;
    else score = 5; // easy
    return {c, score: score + Math.random()*10};
  });
  withScore.sort((a,b)=>b.score-a.score);
  return withScore.slice(0,n).map(x=>x.c);
}

/* ===================== FLASHCARDS ===================== */
function openFlashSession(cards){
  if(!cards.length) cards = weakestCards(20);
  state.flash.queue = shuffle(cards.slice());
  state.flash.idx = 0;
  state.flash.flipped = false;
  showView('flash');
  renderFlash();
}

document.getElementById('btnQuickFlash').addEventListener('click', ()=>{
  openFlashSession(weakestCards(20));
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
  const c = state.flash.queue[state.flash.idx];
  const st = state.progress.cardStats[c.id] || {seen:0, again:0, ok:0, easy:0};
  st.seen += 1;
  st[rate === 'again' ? 'again' : rate === 'ok' ? 'ok' : 'easy'] += 1;
  st.lastRate = rate;
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
    retryAction: ()=>openFlashSession(weakestCards(20))
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

/* ===================== INIT ===================== */
updateStreak();
renderDomainMap();

/* Service worker registration */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
})();
