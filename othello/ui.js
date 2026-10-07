/* ===========================================================================
   Othello UI — DOM wiring, turn flow, AI scheduling, review, settings.
   =========================================================================== */
(function () {
  'use strict';

  var O = window.Othello;
  var BLACK = O.BLACK;
  var WHITE = O.WHITE;

  var AI_DELAY = 520;
  var AI_THINK = 300;

  /* ---------- element refs ---------- */

  var el = {
    board: document.getElementById('board'),
    boardFrame: document.getElementById('boardFrame'),
    status: document.getElementById('status'),
    countBlack: document.getElementById('countBlack'),
    countWhite: document.getElementById('countWhite'),
    blackName: document.getElementById('blackName'),
    scoreBlack: document.getElementById('scoreBlack'),
    scoreWhite: document.getElementById('scoreWhite'),
    whiteName: document.getElementById('whiteName'),
    undo: document.getElementById('undoBtn'),
    fresh: document.getElementById('newBtn'),
    sound: document.getElementById('soundBtn'),
    level: document.getElementById('levelSelect'),
    colorRow: document.getElementById('colorRow'),
    modes: [].slice.call(document.querySelectorAll('[data-mode]')),
    footnote: document.getElementById('footnote'),
    toast: document.getElementById('toast'),
    overlay: document.getElementById('overlay'),
    again: document.getElementById('againBtn'),
    reviewBtn: document.getElementById('reviewBtn'),
    resultTitle: document.getElementById('resultTitle'),
    resultText: document.getElementById('resultText'),
    resultScore: document.getElementById('resultScore'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsSheet: document.getElementById('settingsSheet'),
    sheetClose: document.getElementById('sheetClose'),
    themeSelect: document.getElementById('themeSelect'),
    soundToggle: document.getElementById('soundToggle'),
    statsReset: document.getElementById('statsReset'),
    statWin: document.getElementById('statWin'),
    statLoss: document.getElementById('statLoss'),
    statDraw: document.getElementById('statDraw'),
    statRate: document.getElementById('statRate'),
    kifuBtn: document.getElementById('kifuBtn'),
    kifuDrawer: document.getElementById('kifuDrawer'),
    kifuClose: document.getElementById('kifuClose'),
    kifuList: document.getElementById('kifuList'),
    reviewBar: document.getElementById('reviewBar'),
    reviewPrev: document.getElementById('reviewPrev'),
    reviewNext: document.getElementById('reviewNext'),
    reviewLive: document.getElementById('reviewLive'),
    reviewInfo: document.getElementById('reviewInfo')
  };

  /* ---------- board cells ---------- */

  var cells = new Array(64);

  function buildCells() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 64; i++) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.i = String(i);
      cell.dataset.v = '0';
      cell.setAttribute('aria-label', O.coord(i));
      cell.appendChild(document.createElement('span')).className = 'disc';
      frag.appendChild(cell);
      cells[i] = cell;
    }
    el.board.appendChild(frag);
  }

  /* ---------- persistent state ---------- */

  var SETTINGS_KEY = 'othello.settings';
  var STATS_KEY = 'othello.stats';

  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }

  var settings = loadJSON(SETTINGS_KEY, {
    mode: 'ai',
    level: 'normal',
    humanColor: BLACK,
    theme: 'midnight',
    sound: true
  });

  var stats = loadJSON(STATS_KEY, { win: 0, loss: 0, draw: 0 });

  /* guard against corrupted / legacy stored values */
  if (settings.mode !== 'ai' && settings.mode !== 'pvp') settings.mode = 'ai';
  if (settings.level !== 'easy' && settings.level !== 'normal' && settings.level !== 'hard') settings.level = 'normal';
  if (settings.humanColor !== BLACK && settings.humanColor !== WHITE) settings.humanColor = BLACK;

  /* ---------- game state ---------- */

  var board = O.createBoard();
  var turn = BLACK;
  var timeline = [{ board: board.slice(), turn: turn }];
  var cursor = 0;
  var mode = settings.mode || 'ai';
  var level = settings.level || 'normal';
  var humanColor = settings.humanColor || BLACK;
  var over = false;
  var busy = false;
  var thinking = false;
  var soundOn = settings.sound !== false;
  var moveHint = [];
  var reviewing = false;

  var aiTimer = null;
  var toastTimer = null;

  /* ---------- helpers ---------- */

  function playerName(player) {
    if (mode === 'ai' && player !== humanColor) return 'CPU';
    return player === BLACK ? '黒' : '白';
  }

  function isCpuTurn() {
    return mode === 'ai' && turn !== humanColor;
  }

  function sheetOpen() {
    return el.settingsSheet.hidden === false || el.kifuDrawer.hidden === false;
  }

  function isHumanTurn() {
    /* While a sheet/drawer is open the board behind it must not accept moves. */
    return !over && !isCpuTurn() && !reviewing && !sheetOpen();
  }

  function currentBoard() {
    return timeline[cursor].board;
  }

  function currentTurn() {
    return timeline[cursor].turn;
  }

  /* ---------- sound ---------- */

  var audioCtx = null;
  var noiseBuffer = null;

  function getNoiseBuffer() {
    if (noiseBuffer) return noiseBuffer;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      var len = audioCtx.sampleRate * 0.08;
      noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      var data = noiseBuffer.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return noiseBuffer;
    } catch (e) { return null; }
  }

  function beep(kind) {
    if (!soundOn) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;

      if (kind === 'place') {
        /* stone click: filtered noise burst + low thud */
        var noise = audioCtx.createBufferSource();
        noise.buffer = getNoiseBuffer();
        var bp = audioCtx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 800;
        bp.Q.value = 1.2;
        var ng = audioCtx.createGain();
        ng.gain.setValueAtTime(0.22, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        noise.connect(bp).connect(ng).connect(audioCtx.destination);
        noise.start(t);
        noise.stop(t + 0.08);

        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(180, t);
        osc.frequency.exponentialRampToValueAtTime(90, t + 0.08);
        gain.gain.setValueAtTime(0.14, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.1);
      } else if (kind === 'flip') {
        var osc2 = audioCtx.createOscillator();
        var gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(500, t);
        osc2.frequency.exponentialRampToValueAtTime(750, t + 0.06);
        gain2.gain.setValueAtTime(0.08, t);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc2.connect(gain2).connect(audioCtx.destination);
        osc2.start(t);
        osc2.stop(t + 0.09);
      } else if (kind === 'win') {
        var notes = [523, 659, 784];
        for (var n = 0; n < notes.length; n++) {
          var o = audioCtx.createOscillator();
          var g = audioCtx.createGain();
          o.type = 'triangle';
          o.frequency.value = notes[n];
          g.gain.setValueAtTime(0.12, t + n * 0.12);
          g.gain.exponentialRampToValueAtTime(0.001, t + n * 0.12 + 0.18);
          o.connect(g).connect(audioCtx.destination);
          o.start(t + n * 0.12);
          o.stop(t + n * 0.12 + 0.2);
        }
      } else if (kind === 'lose') {
        var notes2 = [392, 330, 262];
        for (var n2 = 0; n2 < notes2.length; n2++) {
          var o2 = audioCtx.createOscillator();
          var g2 = audioCtx.createGain();
          o2.type = 'triangle';
          o2.frequency.value = notes2[n2];
          g2.gain.setValueAtTime(0.1, t + n2 * 0.14);
          g2.gain.exponentialRampToValueAtTime(0.001, t + n2 * 0.14 + 0.2);
          o2.connect(g2).connect(audioCtx.destination);
          o2.start(t + n2 * 0.14);
          o2.stop(t + n2 * 0.14 + 0.22);
        }
      }
    } catch (e) { /* audio is a nicety */ }
  }

  /* light touch feedback where supported (no-op on desktop / iOS Safari) */
  function haptic(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) { /* not permitted */ }
  }

  /* ---------- rendering ---------- */

  function render(anim) {
    var b = currentBoard();
    var t = currentTurn();
    moveHint = over ? [] : O.getMoves(b, t);
    var hintSet = {};
    for (var h = 0; h < moveHint.length; h++) hintSet[moveHint[h].i] = true;
    var showHints = isHumanTurn();
    var marker = lastPlaced();

    for (var i = 0; i < 64; i++) {
      var cell = cells[i];
      cell.dataset.v = String(b[i]);
      cell.setAttribute('aria-label', O.coord(i) + '、' +
        (b[i] === BLACK ? '黒' : b[i] === WHITE ? '白' : '空き'));
      if (showHints && hintSet[i]) cell.classList.add('hint');
      else cell.classList.remove('hint');
      cell.classList.remove('pop', 'flip', 'last');
      if (i === marker) cell.classList.add('last');
      /* aria-disabled (not disabled) keeps keyboard focus on the board
         across turns, so arrow-key play never loses its place. */
      cell.setAttribute('aria-disabled', String(!isHumanTurn()));
    }

    if (anim) {
      void el.board.offsetWidth;
      if (anim.placed != null) {
        cells[anim.placed].classList.add('pop');
      }
      /* stagger flips by distance from the placed disc */
      var sorted = anim.flipped.slice().sort(function (a, b2) {
        var da = dist2(a, anim.placed);
        var db = dist2(b2, anim.placed);
        return da - db;
      });
      var n = sorted.length;
      for (var k = 0; k < n; k++) {
        var delay = n > 1 ? Math.min(k * 28, 160) : 0;
        cells[sorted[k]].style.setProperty('--flip-delay', delay + 'ms');
        cells[sorted[k]].classList.add('flip');
      }
    }

    var counts = O.countDiscs(b);
    el.countBlack.textContent = counts.black;
    el.countWhite.textContent = counts.white;
    el.scoreBlack.classList.toggle('active', !over && t === BLACK);
    el.scoreWhite.classList.toggle('active', !over && t === WHITE);

    el.undo.disabled = cursor === 0 || thinking;
    updateStatus();
    updateReviewBar();
    /* Keep an open move list in sync with the position (scroll preserved). */
    if (!el.kifuDrawer.hidden) buildKifu();
  }

  function dist2(a, b) {
    var ax = a % 8, ay = Math.floor(a / 8);
    var bx = b % 8, by = Math.floor(b / 8);
    var dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  }

  /* Index of the disc placed on the most recent move (skips pass entries),
     or -1 at the start of the game. */
  function lastPlaced() {
    for (var f = cursor; f > 0; f--) {
      var prev = timeline[f - 1].board;
      var cur = timeline[f].board;
      for (var i = 0; i < 64; i++) {
        if (prev[i] === 0 && cur[i] !== 0) return i;
      }
    }
    return -1;
  }

  function updateStatus() {
    var text;
    if (reviewing) text = 'レビュー中（' + cursor + '手目）';
    else if (over) text = 'ゲーム終了';
    else if (thinking) text = 'CPUが考え中…';
    else text = playerName(turn) + 'の番';
    el.status.textContent = text;
    el.status.classList.toggle('thinking', thinking);
  }

  function updateReviewBar() {
    if (reviewing) {
      el.reviewBar.hidden = false;
      el.reviewInfo.textContent = cursor + ' / ' + (timeline.length - 1) + ' 手';
      el.reviewPrev.disabled = cursor === 0;
      el.reviewNext.disabled = cursor >= timeline.length - 1;
    } else {
      el.reviewBar.hidden = true;
    }
  }

  var toastEl = el.toast;

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 1700);
  }

  /* ---------- move list (kifu) ---------- */

  function buildKifu() {
    var list = el.kifuList;
    var top = list.scrollTop;
    list.innerHTML = '';
    if (timeline.length <= 1) {
      var empty = document.createElement('li');
      empty.className = 'kifu-empty';
      empty.textContent = 'まだ指し手がありません';
      list.appendChild(empty);
      list.scrollTop = top;
      return;
    }
    for (var k = 1; k < timeline.length; k++) {
      var prev = timeline[k - 1];
      var cur = timeline[k];
      var move = findMove(prev.board, prev.turn, cur.board);
      var li = document.createElement('li');
      li.setAttribute('role', 'listitem');

      if (move) {
        var num = document.createElement('span');
        num.className = 'kifu-num';
        num.textContent = k;
        li.appendChild(num);

        var disc = document.createElement('span');
        disc.className = 'kifu-disc ' + (prev.turn === BLACK ? 'black' : 'white');
        li.appendChild(disc);

        var coord = document.createElement('span');
        coord.className = 'kifu-coord';
        coord.textContent = O.coord(move.i);
        li.appendChild(coord);

        var flips = document.createElement('span');
        flips.className = 'kifu-flips';
        flips.textContent = move.flips.length + '枚';
        li.appendChild(flips);
      } else {
        var pass = document.createElement('span');
        pass.className = 'kifu-pass';
        pass.textContent = k + ' パス';
        li.appendChild(pass);
      }

      if (k === cursor) li.classList.add('current');
      li.addEventListener('click', (function (idx) {
        return function () { jumpTo(idx); };
      })(k));
      list.appendChild(li);
    }
    list.scrollTop = top;
  }

  function findMove(before, player, after) {
    var moves = O.getMoves(before, player);
    for (var k = 0; k < moves.length; k++) {
      var applied = O.applyMove(before, moves[k], player);
      if (applied.join() === after.join()) return moves[k];
    }
    return null;
  }

  function openKifu() {
    el.kifuDrawer.hidden = false;
    render();
    var cur = el.kifuList.querySelector('.current');
    if (cur) el.kifuList.scrollTop = Math.max(0, cur.offsetTop - el.kifuList.clientHeight / 2);
    try { el.kifuClose.focus({ preventScroll: true }); } catch (e) { el.kifuClose.focus(); }
  }

  function closeKifu() {
    el.kifuDrawer.hidden = true;
    render();
    try { el.kifuBtn.focus({ preventScroll: true }); } catch (e) { el.kifuBtn.focus(); }
  }

  /* ---------- review ---------- */

  function jumpTo(idx) {
    if (idx < 0 || idx >= timeline.length) return;
    reviewing = idx < timeline.length - 1;
    cursor = idx;
    board = currentBoard();
    turn = currentTurn();
    over = reviewing ? false : (timeline.length - 1 === idx && isGameOver(board));
    busy = false;
    thinking = false;
    clearTimeout(aiTimer);
    aiTimer = null;
    /* Returning live to a finished game brings the result dialog back;
       staying in review keeps it out of the way. */
    el.overlay.hidden = reviewing;
    render();
    if (!reviewing && over) {
      try { el.again.focus({ preventScroll: true }); } catch (e) { el.again.focus(); }
    }
    if (!reviewing && !over && isCpuTurn()) scheduleCpu();
  }

  function isGameOver(b) {
    return O.getMoves(b, BLACK).length === 0 && O.getMoves(b, WHITE).length === 0;
  }

  function startReview() {
    if (timeline.length <= 1) return;
    reviewing = true;
    cursor = 0;
    board = currentBoard();
    turn = currentTurn();
    over = false;
    busy = false;
    thinking = false;
    clearTimeout(aiTimer);
    aiTimer = null;
    el.overlay.hidden = true;
    render();
    /* reviewPrev is disabled at move 0 — focus the next-step button instead. */
    try { el.reviewNext.focus({ preventScroll: true }); } catch (e) { el.reviewNext.focus(); }
  }

  /* ---------- turn flow ---------- */

  function onCellClick(i) {
    if (!isHumanTurn()) return;
    var move = null;
    for (var k = 0; k < moveHint.length; k++) {
      if (moveHint[k].i === i) { move = moveHint[k]; break; }
    }
    if (!move) {
      showToast('ここには置けません');
      return;
    }
    playMove(move);
  }

  function playMove(move) {
    var player = turn;
    var newBoard = O.applyMove(board, move, player);
    var nextPlayer = O.other(player);

    /* truncate any "future" if we were reviewing */
    if (cursor < timeline.length - 1) {
      timeline = timeline.slice(0, cursor + 1);
    }

    timeline.push({ board: newBoard, turn: nextPlayer });
    cursor = timeline.length - 1;
    board = newBoard;
    turn = nextPlayer;
    busy = true;
    reviewing = false;
    render({ placed: move.i, flipped: move.flips });
    beep('place');
    haptic(12);
    if (move.flips.length) setTimeout(function () { beep('flip'); }, 90);

    clearTimeout(aiTimer);
    aiTimer = setTimeout(function () {
      aiTimer = null;
      busy = false;
      nextTurn();
    }, AI_DELAY);
  }

  function nextTurn() {
    if (over) return;

    if (moveHint.length === 0) {
      var oppMoves = O.getMoves(board, O.other(turn));
      if (oppMoves.length === 0) {
        endGame();
        return;
      }
      showToast(playerName(turn) + 'は置けないためパス');
      turn = O.other(turn);
      timeline.push({ board: board.slice(), turn: turn });
      cursor = timeline.length - 1;
    }

    render();

    if (isCpuTurn()) scheduleCpu();
  }

  function scheduleCpu() {
    thinking = true;
    busy = true;
    render();
    clearTimeout(aiTimer);
    aiTimer = setTimeout(function () {
      aiTimer = null;
      var move = O.chooseMove(board, turn, level);
      thinking = false;
      if (!move) { busy = false; nextTurn(); return; }
      playMove(move);
    }, AI_THINK);
  }

  function endGame() {
    over = true;
    busy = false;
    thinking = false;
    clearTimeout(aiTimer);
    aiTimer = null;
    render();

    var counts = O.countDiscs(board);
    var title;
    var text;
    if (counts.black === counts.white) {
      title = '引き分け';
      text = '接戦でしたね。';
    } else {
      var winner = counts.black > counts.white ? BLACK : WHITE;
      if (mode === 'ai') {
        var humanWon = winner === humanColor;
        title = humanWon ? 'あなたの勝ち！' : 'CPUの勝ち';
        text = humanWon ? 'お見事です。' : '次は負けません。';
      } else {
        title = (winner === BLACK ? '黒' : '白') + 'の勝ち！';
        text = 'おめでとうございます。';
      }
    }

    el.resultTitle.textContent = title;
    el.resultText.textContent = text;
    el.resultScore.innerHTML =
      '<span class="mini mini-black"></span>' + counts.black +
      '<span style="color:var(--muted);font-size:18px">対</span>' +
      counts.white + '<span class="mini mini-white"></span>';
    el.overlay.hidden = false;
    try { el.again.focus({ preventScroll: true }); } catch (e) { el.again.focus(); }

    /* update stats */
    if (mode === 'ai') {
      if (counts.black === counts.white) {
        stats.draw++;
        beep('flip');
      } else if ((counts.black > counts.white) === (humanColor === BLACK)) {
        stats.win++;
        beep('win');
      } else {
        stats.loss++;
        beep('lose');
      }
      saveJSON(STATS_KEY, stats);
      updateStats();
    } else {
      beep('win');
    }
  }

  /* ---------- controls ---------- */

  function clearTimers() {
    clearTimeout(aiTimer);
    aiTimer = null;
  }

  function newGame() {
    clearTimers();
    el.overlay.hidden = true;
    el.kifuDrawer.hidden = true;
    board = O.createBoard();
    turn = BLACK;
    timeline = [{ board: board.slice(), turn: turn }];
    cursor = 0;
    over = false;
    busy = false;
    thinking = false;
    reviewing = false;
    render();
    nextTurn();
    updateFootnote();
    /* The dialog held focus; it is now hidden, so hand focus to the board. */
    if (document.activeElement === el.again || document.activeElement === el.reviewBtn) {
      var firstHint = el.board.querySelector('.cell.hint');
      try { (firstHint || el.board).focus({ preventScroll: true }); }
      catch (e) { (firstHint || el.board).focus(); }
    }
  }

  function undo() {
    if (cursor === 0) return;
    clearTimers();
    el.overlay.hidden = true;
    el.kifuDrawer.hidden = true;
    over = false;
    busy = false;
    thinking = false;
    reviewing = false;

    /* PVP: rewind one ply. AI: rewind the human's last move plus any CPU
       reply after it, landing on the previous position where the human moves. */
    var steps = 1;
    if (mode === 'ai' && cursor > 0) {
      for (var c = cursor - 1; c >= 0; c--) {
        if (timeline[c].turn === humanColor) {
          steps = cursor - c;
          break;
        }
      }
    }
    cursor = Math.max(0, cursor - steps);
    board = currentBoard();
    turn = currentTurn();
    timeline = timeline.slice(0, cursor + 1);
    render();
    if (isCpuTurn()) scheduleCpu();
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    settings.mode = mode;
    saveJSON(SETTINGS_KEY, settings);
    syncModeUI();
    newGame();
    showToast(mode === 'ai' ? 'CPU戦を開始' : '2人対戦を開始');
  }

  var LEVEL_NAMES = { easy: 'やさしい', normal: 'ふつう', hard: 'むずかしい' };

  function setLevel(next) {
    if (next === level) return;
    level = next;
    settings.level = level;
    saveJSON(SETTINGS_KEY, settings);
    syncLevelUI();
    newGame();
    showToast('難易度：' + (LEVEL_NAMES[next] || next));
  }

  function setHumanColor(color) {
    if (color !== BLACK && color !== WHITE) return;
    if (color === humanColor) return;
    humanColor = color;
    settings.humanColor = humanColor;
    saveJSON(SETTINGS_KEY, settings);
    syncColorUI();
    newGame();
    showToast(humanColor === BLACK ? 'あなたは黒（先手）です' : 'あなたは白（後手）です');
  }

  function setTheme(theme) {
    settings.theme = theme;
    saveJSON(SETTINGS_KEY, settings);
    document.documentElement.setAttribute('data-theme', theme);
    el.themeSelect.value = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content',
        theme === 'classic' ? '#f0f2f5' : theme === 'wood' ? '#1a1208' : '#0e1116');
    }
  }

  function setSound(on) {
    soundOn = on;
    settings.sound = on;
    saveJSON(SETTINGS_KEY, settings);
    el.sound.textContent = on ? '🔊' : '🔇';
    el.sound.classList.toggle('off', !on);
    el.sound.setAttribute('aria-pressed', String(on));
    el.soundToggle.setAttribute('aria-checked', String(on));
    if (on) beep('flip');
  }

  function updateStats() {
    el.statWin.textContent = stats.win;
    el.statLoss.textContent = stats.loss;
    el.statDraw.textContent = stats.draw;
    var total = stats.win + stats.loss + stats.draw;
    if (total > 0) {
      var rate = Math.round((stats.win / total) * 100);
      el.statRate.textContent = '勝率 ' + rate + '%（' + total + '局）';
    } else {
      el.statRate.textContent = '勝率 —';
    }
  }

  function syncModeUI() {
    el.modes.forEach(function (btn) {
      btn.classList.toggle('selected', btn.dataset.mode === mode);
    });
    var aiOnly = mode !== 'ai';
    el.level.disabled = aiOnly;
    var levelBtns = document.querySelectorAll('[data-level]');
    for (var i = 0; i < levelBtns.length; i++) levelBtns[i].disabled = aiOnly;
    syncColorUI();
  }

  function syncLevelUI() {
    el.level.value = level;
    var btns = document.querySelectorAll('[data-level]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('selected', btns[i].dataset.level === level);
    }
  }

  function syncColorUI() {
    var btns = document.querySelectorAll('[data-color]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('selected', Number(btns[i].dataset.color) === humanColor);
    }
    el.colorRow.style.display = mode === 'ai' ? '' : 'none';
  }

  function updateFootnote() {
    if (mode === 'ai') {
      var c = humanColor === BLACK ? '黒（先手）' : '白（後手）';
      el.footnote.textContent = 'あなたは' + c + '、CPUは' + (humanColor === BLACK ? '白' : '黒') + 'です。白丸のマスが置ける場所です。';
    } else {
      el.footnote.textContent = '交互に1枚ずつ置きます。白丸のマスが置ける場所です。';
    }
    el.blackName.textContent = mode === 'ai' && humanColor === WHITE ? '黒（CPU）' : '黒';
    el.whiteName.textContent = mode === 'ai' && humanColor === BLACK ? '白（CPU）' : '白';
  }

  /* ---------- settings sheet ---------- */

  function openSettings() {
    el.settingsSheet.hidden = false;
    render();
    try { el.sheetClose.focus({ preventScroll: true }); } catch (e) { el.sheetClose.focus(); }
  }

  function closeSettings() {
    el.settingsSheet.hidden = true;
    render();
    try { el.settingsBtn.focus({ preventScroll: true }); } catch (e) { el.settingsBtn.focus(); }
  }

  /* ---------- keyboard navigation ---------- */

  function onKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
      return;
    }

    if (el.settingsSheet.hidden === false || el.kifuDrawer.hidden === false) {
      if (event.key === 'Escape') {
        closeSettings();
        closeKifu();
      }
      return;
    }

    if (!isHumanTurn()) return;

    var focused = document.activeElement;
    var idx = -1;
    if (focused && focused.classList && focused.classList.contains('cell')) {
      idx = Number(focused.dataset.i);
    }

    var col = idx >= 0 ? idx % 8 : -1;
    var row = idx >= 0 ? Math.floor(idx / 8) : -1;
    var next = -1;

    switch (event.key) {
      case 'ArrowLeft':  if (col > 0) next = idx - 1; break;
      case 'ArrowRight': if (col < 7) next = idx + 1; break;
      case 'ArrowUp':    if (row > 0) next = idx - 8; break;
      case 'ArrowDown':  if (row < 7) next = idx + 8; break;
      case 'Enter':
      case ' ':
        if (idx >= 0) {
          event.preventDefault();
          onCellClick(idx);
        }
        return;
      default: return;
    }

    if (next >= 0) {
      event.preventDefault();
      cells[next].focus();
    }
  }

  /* ---------- wiring ---------- */

  buildCells();

  el.board.addEventListener('click', function (event) {
    var cell = event.target.closest ? event.target.closest('.cell') : null;
    if (cell) onCellClick(Number(cell.dataset.i));
  });

  el.undo.addEventListener('click', undo);
  el.fresh.addEventListener('click', function () {
    /* Accidental taps must not wipe a game in progress. */
    if (cursor > 0 && !over && !confirm('対局を破棄して新しいゲームを始めますか？')) return;
    newGame();
  });
  el.again.addEventListener('click', newGame);
  el.reviewBtn.addEventListener('click', startReview);

  el.modes.forEach(function (btn) {
    btn.addEventListener('click', function () { setMode(btn.dataset.mode); });
  });

  el.level.addEventListener('change', function () {
    setLevel(el.level.value);
  });

  /* settings sheet controls */
  var levelBtns = document.querySelectorAll('[data-level]');
  for (var li = 0; li < levelBtns.length; li++) {
    levelBtns[li].addEventListener('click', function () {
      setLevel(this.dataset.level);
    });
  }

  var colorBtns = document.querySelectorAll('[data-color]');
  for (var ci = 0; ci < colorBtns.length; ci++) {
    colorBtns[ci].addEventListener('click', function () {
      setHumanColor(Number(this.dataset.color));
    });
  }

  el.themeSelect.addEventListener('change', function () {
    setTheme(el.themeSelect.value);
  });

  el.soundToggle.addEventListener('click', function () {
    setSound(!soundOn);
  });

  el.statsReset.addEventListener('click', function () {
    stats = { win: 0, loss: 0, draw: 0 };
    saveJSON(STATS_KEY, stats);
    updateStats();
    showToast('レコードをリセットしました');
  });

  el.settingsBtn.addEventListener('click', openSettings);
  el.sheetClose.addEventListener('click', closeSettings);

  el.sound.addEventListener('click', function () { setSound(!soundOn); });

  /* kifu drawer */
  el.kifuBtn.addEventListener('click', openKifu);
  el.kifuClose.addEventListener('click', closeKifu);

  /* review bar */
  el.reviewPrev.addEventListener('click', function () { jumpTo(cursor - 1); });
  el.reviewNext.addEventListener('click', function () { jumpTo(cursor + 1); });
  el.reviewLive.addEventListener('click', function () {
    jumpTo(timeline.length - 1);
    /* The review bar is now hidden; its focused button is gone. */
    if (!document.activeElement || document.activeElement === document.body ||
        el.reviewBar.contains(document.activeElement)) {
      var firstHint = el.board.querySelector('.cell.hint');
      try { (firstHint || el.board).focus({ preventScroll: true }); }
      catch (e) { (firstHint || el.board).focus(); }
    }
  });

  document.addEventListener('keydown', onKeyDown);

  /* ---------- init ---------- */

  setTheme(settings.theme || 'midnight');
  setSound(soundOn);
  syncLevelUI();
  syncModeUI();
  updateStats();
  newGame();
})();
