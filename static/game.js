// =============================================================================
// game.js — Yussuf client-side logic
// =============================================================================

const socket = io();

// ── State ─────────────────────────────────────────────────────────────────────
let myPlayerIndex  = null;
let myName         = '';
let isHost         = false;
let gameState      = null;
let isMyTurn       = false;
let heldCard       = null;
let lastHeldCard   = null;
let turnCompleted  = false;   // true after replace/discard — blocks Yussuf until next turn   // kept after heldCard clears, so stage-2 animation knows the card
let pendingEffect  = null;
let windowTimer    = null;
let scoreLimit     = 50;
let myReadyClicked = false;

// ── Animation queue (queued before state_update, flushed after DOM rebuild) ───
let animQueue    = [];
let swapAnimData = null;

function queueAnim(pi, slot, cls = 'slot-highlight') {
  animQueue.push({ pi, slot, cls });
}

function flushAnimQueue() {
  animQueue.forEach(({ pi, slot, cls }) => {
    const el = document.getElementById(`card-p${pi}-s${slot}`);
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 2700); // 900ms × 3
  });
  animQueue = [];
}

// ── FLIP swap animation ───────────────────────────────────────────────────────
function applyFlipSwap() {
  if (!swapAnimData) return;
  const { p1, s1, p2, s2, r1, r2 } = swapAnimData;
  swapAnimData = null;
  const newEl1 = document.getElementById(`card-p${p1}-s${s1}`);
  const newEl2 = document.getElementById(`card-p${p2}-s${s2}`);
  if (!newEl1 || !newEl2) return;
  const nr1 = newEl1.getBoundingClientRect();
  const nr2 = newEl2.getBoundingClientRect();
  const dx1 = r2.left - nr1.left, dy1 = r2.top - nr1.top;
  const dx2 = r1.left - nr2.left, dy2 = r1.top - nr2.top;
  [newEl1, newEl2].forEach(el => { el.style.transition = 'none'; el.style.zIndex = '80'; });
  newEl1.style.transform = `translate(${dx1}px,${dy1}px)`;
  newEl2.style.transform = `translate(${dx2}px,${dy2}px)`;
  void newEl1.offsetWidth; void newEl2.offsetWidth;
  // 0.42s × 3 = 1.26s
  newEl1.style.transition = newEl2.style.transition = 'transform 1.26s cubic-bezier(0.4,0,0.2,1)';
  newEl1.style.transform = newEl2.style.transform = '';
  setTimeout(() => {
    [newEl1, newEl2].forEach(el => { el.style.transition = ''; el.style.zIndex = ''; });
  }, 1300);
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const screenLobby    = document.getElementById('screen-lobby');
const screenPeek     = document.getElementById('screen-peek');
const screenGame     = document.getElementById('screen-game');
const nameInput      = document.getElementById('name-input');
const btnJoin        = document.getElementById('btn-join');
const btnStart       = document.getElementById('btn-start');
const scoreLimitRow  = document.getElementById('score-limit-row');
const scoreLimitSel  = document.getElementById('score-limit-select');
const scoreLimitView = document.getElementById('score-limit-view');
const lobbyList      = document.getElementById('lobby-player-list');
const lobbyWait      = document.getElementById('lobby-waiting-msg');
const peekRoundNum   = document.getElementById('peek-round-num');
const peekFace0      = document.getElementById('peek-face-0');
const peekFace1      = document.getElementById('peek-face-1');
const peekFace2      = document.getElementById('peek-face-2');
const peekFace3      = document.getElementById('peek-face-3');
const btnPeekReady   = document.getElementById('btn-peek-ready');
const peekWaitMsg    = document.getElementById('peek-wait-msg');
const roundNum       = document.getElementById('round-num');
const phaseBadge     = document.getElementById('phase-badge');
const scoreStrip     = document.getElementById('score-strip');
const opponentsArea  = document.getElementById('opponents-area');
const myGrid         = document.getElementById('my-grid');
const myNameEl       = document.getElementById('my-name');
const deckPile       = document.getElementById('deck-pile');
const deckCount      = document.getElementById('deck-count');
const discardTop     = document.getElementById('discard-top');
const actionBar      = document.getElementById('action-bar');
const heldArea       = document.getElementById('held-area');
const heldDisplay    = document.getElementById('held-card-display');
const btnYussuf      = document.getElementById('btn-yussuf');
// ── Yussuf button positioning (robust across screen transitions) ──────────────
// The pile-group may have zero size when the game screen has just become visible
// (e.g. after the peek screen on round 2). We retry via requestAnimationFrame
// until the layout settles, then apply the precise centre position.
function positionYussufButton(retriesLeft = 6) {
  if (!btnYussuf) return;
  const pileGroupEl = document.querySelector('.pile-group');
  const posAnchor   = pileGroupEl || document.getElementById('discard-pile');
  if (!posAnchor) return;
  const pr = posAnchor.getBoundingClientRect();
  if (pr.height < 10 && retriesLeft > 0) {
    // Layout not ready — retry on next frame
    requestAnimationFrame(() => positionYussufButton(retriesLeft - 1));
    return;
  }
  const centre = pr.top + pr.height / 2;
  btnYussuf.style.top       = centre + 'px';
  btnYussuf.style.transform = 'translateY(-50%)';
}

const btnDiscardHeld = document.getElementById('btn-discard-held');
const btnChatBubble  = document.getElementById('btn-chat-bubble');
const btnChatClose   = document.getElementById('btn-chat-close');
const chatPanel      = document.getElementById('chat-panel');
const chatLog        = document.getElementById('chat-log');
let   unreadCount    = 0;
const statusMsg      = document.getElementById('status-msg');
const actionHint     = document.getElementById('action-hint');
const actionHintText = document.getElementById('action-hint-text');
const btnActionCancel= document.getElementById('btn-action-cancel');
const windowBar      = document.getElementById('window-bar');
const windowFill     = document.getElementById('window-fill');
const roundEndOverlay= document.getElementById('round-end-overlay');
const overlayTitle   = document.getElementById('overlay-title');
const overlayScores  = document.getElementById('overlay-scores');
const overlayYussuf  = document.getElementById('overlay-yussuf-result');
const overlayElim    = document.getElementById('overlay-eliminated');
const btnNextRound   = document.getElementById('btn-next-round');
const overlayGameOver= document.getElementById('overlay-game-over');
const overlayWinner  = document.getElementById('overlay-winner');
const revealBoards   = document.getElementById('reveal-boards');
const rulesPanel     = document.getElementById('rules-panel');
const pauseOverlay   = document.getElementById('pause-overlay');
const pauseReason    = document.getElementById('pause-reason');
const pauseGif       = document.getElementById('pause-gif');
const btnPause       = document.getElementById('btn-pause');
const btnUnpause     = document.getElementById('btn-unpause');
const btnExitVote    = document.getElementById('btn-exit-vote');
const btnGameOverExit = document.getElementById('btn-game-over-exit');
const unpauseStatus  = document.getElementById('unpause-status');
const exitStatus     = document.getElementById('exit-status');
const btnPauseRules  = document.getElementById('btn-pause-rules');
const pauseRulesContent = document.getElementById('pause-rules-content');

// ── Pause GIFs (boomer-appropriate, free giphy links) ─────────────────────────
const PAUSE_GIFS = [
  'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif',   // coffee break
  'https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif',   // waiting
  'https://media.giphy.com/media/xT9IgG50Lg7rusUgXC/giphy.gif',  // intermission
  'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif',  // hold music
  'https://media.giphy.com/media/26FLdmIp6wJr91JAI/giphy.gif',   // pause button
];

// ── Toast ─────────────────────────────────────────────────────────────────────
const toastContainer = (() => {
  const el = document.createElement('div');
  el.id = 'toast-container';
  document.body.appendChild(el);
  return el;
})();

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type ? 'toast-' + type : ''}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Action hint ───────────────────────────────────────────────────────────────
function setActionHint(text) { actionHintText.textContent = text; actionHint.classList.remove('hidden'); }
function clearActionHint()   { actionHint.classList.add('hidden'); actionHintText.textContent = ''; }

// ── Card rendering ─────────────────────────────────────────────────────────────
// Renders a card to look like a classic poker deck:
//   - Two corners (top-left, bottom-right rotated) with rank + suit
//   - Numeric cards (2-10): pip pattern in middle matching the rank value
//   - Face cards (J/Q/K): large ornate letter with crown/decoration
//   - Ace: single large suit pip
//   - Joker: full-card stylised joker design
//
// To prevent old design flashing during re-render, we build the new structure
// in a DocumentFragment first and only swap into the DOM at the end.
// ── Card filename mapping ─────────────────────────────────────────────────────
// Maps a card object to its image filename in /static/cards/
// Uses the actual filenames from the PNG-cards-1.3 deck:
//   - Numerics:  "{rank}_of_{suit}.png"           (e.g. 7_of_hearts.png)
//   - Aces:       "ace_of_{suit}.png" (Hearts/Diamonds/Clubs)
//                 "ace_of_spades2.png"   (Spades has the special "2" suffix)
//   - Face cards: "{rank}_of_{suit}2.png"  (jack_of_hearts2.png, etc.)
//   - Jokers:    "joker_red.png" / "joker_black.png"
function cardImageFilename(card) {
  if (!card || card.hidden) return null;
  if (card.rank === 'Joker') {
    return card.suit === 'black' ? 'joker_black.png' : 'joker_red.png';
  }
  const suitLower = (card.suit || '').toLowerCase();
  const RANK_FILE = {
    'Ace':   'ace',
    'Jack':  'jack',
    'Queen': 'queen',
    'King':  'king',
  };
  const rankFile = RANK_FILE[card.rank] || card.rank.toLowerCase();
  // Aces of clubs/diamonds/hearts have no "2" suffix; ace of spades does.
  // Face cards (J/Q/K) all have a "2" suffix in this deck pack.
  let suffix = '';
  if (['Jack', 'Queen', 'King'].includes(card.rank)) suffix = '2';
  if (card.rank === 'Ace' && card.suit === 'Spades') suffix = '2';
  return `${rankFile}_of_${suitLower}${suffix}.png`;
}

// ── Preload all card images at startup ────────────────────────────────────────
// Called once when the page loads. Browser caches all 54 PNGs so renderCardFace
// can render any card instantly without a network round-trip (no empty-frame flash).
(function preloadCardImages() {
  const allFilenames = [];
  const SUITS_LOWER = ['hearts', 'diamonds', 'clubs', 'spades'];
  const RANKS = ['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'];
  for (const suit of SUITS_LOWER) {
    for (const rank of RANKS) {
      let suffix = '';
      if (['jack','queen','king'].includes(rank)) suffix = '2';
      if (rank === 'ace' && suit === 'spades') suffix = '2';
      allFilenames.push(`${rank}_of_${suit}${suffix}.png`);
    }
  }
  allFilenames.push('joker_red.png', 'joker_black.png');
  for (const f of allFilenames) {
    const img = new Image();
    img.src = `/static/cards/${f}`;
  }
})();

// ── Card rendering using image files ─────────────────────────────────────────
// For real cards: <img> from /static/cards/{filename}
// For empty piles or hidden cards: same special states as before
function renderCardFace(card, el) {
  if (!card) {
    el.className = 'card-face empty-pile';
    el.innerHTML = '';
    el.textContent = 'Empty';
    return;
  }
  if (card.hidden) {
    el.className = 'card-face hidden-card';
    el.innerHTML = '';
    return;
  }

  const filename = cardImageFilename(card);
  // Atomic update: build full new state once, then assign in one go (no flash)
  el.className = 'card-face image-card';
  el.innerHTML = `<img src="/static/cards/${filename}" alt="${card.display}" draggable="false">`;
}

function makeCardEl(card, extra = '') {
  const el = document.createElement('div');
  renderCardFace(card, el);
  if (extra) el.classList.add(extra);
  return el;
}

function popEl(el) {
  el.classList.remove('card-pop');
  void el.offsetWidth;
  el.classList.add('card-pop');
}

function flashDeck() {
  if (!deckPile) return;
  deckPile.classList.remove('deck-flash');
  void deckPile.offsetWidth;
  deckPile.classList.add('deck-flash');
  setTimeout(() => deckPile.classList.remove('deck-flash'), 1800);
}

// ── Drawn card floating display ───────────────────────────────────────────────
// Shows the drawn card floating next to the appropriate board box.
// Active player: face-up, left of their board.
// Observer: face-down, right of target player's board.
let drawnCardFloatEl = null;

// Creates the float element at its final resting position (invisible initially).
// Returns it so flyCardFrom can use it as the destination — direct flight, one arc.
function createDrawnCardFloat(cardData, targetBoardEl, placeLeft) {
  clearDrawnCard();
  if (!targetBoardEl) return null;

  const boardRect = targetBoardEl.getBoundingClientRect();
  const W = 52, H = 74;
  const margin = 14;   // gap between card and board frame edge

  // Vertically centred against the target element's full height
  const top = boardRect.top + (boardRect.height / 2) - (H / 2);

  // Horizontally: place fully outside the board frame
  const left = placeLeft
    ? boardRect.left - W - margin    // right edge of card = left edge of board - gap
    : boardRect.right + margin;      // left edge of card = right edge of board + gap

  const wrap = document.createElement('div');
  wrap.className = 'drawn-card-float';
  wrap.style.cssText = `left:${left}px; top:${top}px; opacity:0; pointer-events:none;`;

  const cardEl = document.createElement('div');
  renderCardFace(cardData || { hidden: true }, cardEl);
  wrap.appendChild(cardEl);

  document.body.appendChild(wrap);
  drawnCardFloatEl = wrap;
  return wrap;
}

// Reveal the float element after the flying card arrives
function revealDrawnCardFloat() {
  if (!drawnCardFloatEl) return;
  drawnCardFloatEl.style.transition = 'opacity 0.18s ease';
  drawnCardFloatEl.style.opacity = '1';
}

function clearDrawnCard() {
  drawnCardFloatEl?.remove();
  drawnCardFloatEl = null;
}

// ── Persistent slot-available highlight ───────────────────────────────────────
// Applied when player holds a card — stays until card is placed or discarded.
// Uses slot-available class (separate from one-shot queueAnim highlights).
function addSlotAvailable(pi) {
  if (gameState && pi !== null) {
    gameState.players[pi].board.forEach((card, i) => {
      if (card !== null) {
        const el = document.getElementById(`card-p${pi}-s${i}`);
        if (el) el.classList.add('slot-available');
      }
    });
  }
}

function clearSlotAvailable() {
  document.querySelectorAll('.slot-available').forEach(el => el.classList.remove('slot-available'));
}

// Highlight the discard pile when player holds a card (same glow as board slots)
function addDiscardAvailable() {
  const discardPileEl = document.getElementById('discard-pile');
  if (discardPileEl) discardPileEl.classList.add('pile-drawable');
}

function clearDiscardAvailable() {
  const discardPileEl = document.getElementById('discard-pile');
  if (discardPileEl) discardPileEl.classList.remove('pile-drawable');
}

// ── Flying card animation ─────────────────────────────────────────────────────
// Spawns a card element at `sourceEl`, flies it to `destEl`, then removes it.
// `cardData` is null for face-down (observers), or a card info object (active player).
// ── Flying card animation ─────────────────────────────────────────────────────
// Stage 1 (pile → held-area): called immediately on draw.
// Stage 2 (held-area → slot/discard): called when card is placed.
// cardData = null → face-down (card-back image), object → face-up with value.

function flyCardFrom(sourceEl, destEl, cardData, onArrival, durationMs = 480) {
  if (!sourceEl || !destEl) { onArrival?.(); return null; }

  const srcRect  = sourceEl.getBoundingClientRect();
  const destRect = destEl.getBoundingClientRect();

  // Use a fixed card size — never scale from a 0-size element
  const W = 60, H = 86;

  const el = document.createElement('div');
  el.className = 'flying-card ' + (cardData ? 'face-up' : 'face-down');

  // Centre the card over the source element
  el.style.cssText = `
    width:  ${W}px;
    height: ${H}px;
    left:   ${srcRect.left + srcRect.width  / 2 - W / 2}px;
    top:    ${srcRect.top  + srcRect.height / 2 - H / 2}px;
    transform: translate(0,0) scale(1);
    opacity: 0;
    transition: none;
  `;

  if (cardData) {
    // Use the same image rendering as static cards — no text/classes that could flash
    const filename = cardImageFilename(cardData);
    if (filename) {
      el.innerHTML = `<img src="/static/cards/${filename}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;border-radius:var(--card-radius);display:block;">`;
    }
  }

  document.body.appendChild(el);
  void el.offsetWidth; // force layout before animating

  const tx = (destRect.left + destRect.width  / 2) - (srcRect.left + srcRect.width  / 2);
  const ty = (destRect.top  + destRect.height / 2) - (srcRect.top  + srcRect.height / 2);

  // Fade in instantly then fly
  requestAnimationFrame(() => {
    el.style.transition = `transform ${durationMs}ms cubic-bezier(0.22,1,0.36,1), opacity 80ms ease`;
    el.style.opacity    = '1';
    el.style.transform  = `translate(${tx}px, ${ty}px)`;
  });

  setTimeout(() => {
    el.remove();
    onArrival?.();
  }, durationMs + 60);

  return el;
}

// Stage 2: fly card FROM held-area TO a destination element on the board.
// Pass null as cardData to use face-down (for observer animations).
function flyCardToDestination(destEl, cardData) {
  if (!heldDisplay || !destEl) return;
  flyCardFrom(heldDisplay, destEl, cardData, null, 380);
}

// ── Queen step-by-step peek reveal ───────────────────────────────────────────
// Shows a card face privately for the queen's looker, one at a time,
// with a highlight animation on the slot after each reveal.
// ── Card flip-reveal: overlay clone so DOM rebuilds cannot destroy it ─────────
// Creates a fixed-position clone of the card element, animates the clone,
// then removes it. The real card in the DOM is untouched — board rebuilds
// during state_update won't cancel the animation.
function flipRevealCard(card, targetPi, slotIdx) {
  const el = document.getElementById(`card-p${targetPi}-s${slotIdx}`);
  if (!el) {
    toast(`Slot ${slotIdx + 1}: ${card.display}`, 'good');
    return;
  }

  const DURATION   = 3000;   // total flip animation ms
  const MID_IN_MS  = 300;    // time before card is edge-on (show face)
  const MID_OUT_MS = DURATION - 300;  // time before second edge (hide face)

  // Get the card's screen position now (before any rebuild)
  const rect = el.getBoundingClientRect();

  // Create an overlay clone that sits exactly on top of the real card
  const clone = document.createElement('div');
  clone.style.cssText = `
    position: fixed;
    left: ${rect.left}px;
    top: ${rect.top}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    z-index: 150;
    pointer-events: none;
    border-radius: var(--card-radius, 4px);
    background: url('/static/card-back.jpg') center/cover no-repeat;
    border: 1px solid rgba(200,169,81,0.2);
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    backface-visibility: hidden;
    transition: transform ${MID_IN_MS}ms ease;
  `;
  document.body.appendChild(clone);

  // Phase 1: rotate to edge (90deg)
  requestAnimationFrame(() => {
    void clone.offsetWidth;
    clone.style.transform = 'rotateY(90deg)';
  });

  // Phase 2: at edge, swap to face-up appearance and rotate back
  setTimeout(() => {
    // Reset clone to look like a normal card-face element, then render the card properly
    clone.style.background = '';
    clone.style.border     = '';
    clone.style.color      = '';
    clone.style.display    = '';
    clone.style.alignItems = '';
    clone.style.justifyContent = '';
    clone.style.fontFamily = '';
    clone.style.fontSize   = '';
    clone.style.fontWeight = '';
    clone.textContent      = '';
    // Use the same renderer as everywhere else for consistent classic-card look
    renderCardFace(card, clone);
    // Re-apply position styles that renderCardFace cleared
    clone.style.position   = 'fixed';
    clone.style.left       = `${rect.left}px`;
    clone.style.top        = `${rect.top}px`;
    clone.style.width      = `${rect.width}px`;
    clone.style.height     = `${rect.height}px`;
    clone.style.zIndex     = '150';
    clone.style.pointerEvents = 'none';
    clone.style.boxShadow  = '0 4px 16px rgba(0,0,0,0.5)';

    // Rotate back to face-forward
    clone.style.transition = `transform ${MID_IN_MS}ms ease`;
    requestAnimationFrame(() => { clone.style.transform = 'rotateY(0deg)'; });
  }, MID_IN_MS + 20);

  // Phase 3: rotate back to edge before hiding
  setTimeout(() => {
    clone.style.transition = `transform ${MID_IN_MS}ms ease`;
    clone.style.transform  = 'rotateY(90deg)';
  }, MID_OUT_MS);

  // Phase 4: flip back to card-back
  setTimeout(() => {
    clone.className = '';
    clone.innerHTML = '';
    clone.style.background = "url('/static/card-back.jpg') center/cover no-repeat";
    clone.style.color      = 'transparent';
    clone.textContent      = '';
    clone.style.transition = `transform ${MID_IN_MS}ms ease`;
    clone.style.transform  = 'rotateY(0deg)';
  }, MID_OUT_MS + MID_IN_MS + 20);

  // Remove clone after full animation
  setTimeout(() => clone.remove(), DURATION + 200);

  // Slot pulse for the active player
  queueAnim(targetPi, slotIdx, 'slot-peeked');
  setTimeout(flushAnimQueue, 50);
}

// showQueenStepReveal: flip card 1 in-place, then flip card 2 in-place
function showQueenStepReveal(card, targetPi, slotIdx, _stepLabel) {
  flipRevealCard(card, targetPi, slotIdx);
}

// showPeekReveal: flip card in-place (used for 7/8/9/10)
function showPeekReveal(card, targetPi, slotIdx) {
  flipRevealCard(card, targetPi, slotIdx);
}

// ── Yussuf tension mode ───────────────────────────────────────────────────────
let tensionActive = false;

function enterYussufTension(callerName, turnsLeft) {
  if (tensionActive) return;
  tensionActive = true;
  screenGame.classList.add('yussuf-tension');

  // Remove any old banner
  document.getElementById('yussuf-banner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'yussuf-banner';
  banner.innerHTML =
    `<div class="banner-title">YUSSUF!</div>`;
  screenGame.appendChild(banner);

  setTimeout(() => banner.remove(), 3500);
}

function exitYussufTension() {
  tensionActive = false;
  screenGame.classList.remove('yussuf-tension');
  document.getElementById('yussuf-banner')?.remove();
}
// ── Temp-reveal schedule ──────────────────────────────────────────────────────
function scheduleTempRevealHide(pi, slot) {
  setTimeout(() => socket.emit('clear_temp_reveal', { player: pi, slot }), 3000);
}

// =============================================================================
// BOARD RENDERING
// =============================================================================
// MIRROR LAYOUT — 180° rotation for opponents:
//   Normal:   col0=[0,2]  col1=[1,3]  extraCols...
//   Mirrored: extraCols(reversed)... col0=[1,3]  col1=[0,2]
//   Within each column, rows are also reversed.
//   Punishment cols are always 2-slot pairs [slot, slot+1 or null]
//   so .reverse() correctly places single cards at the bottom when mirrored.

function renderBoardGrid(playerData, containerEl, pi, mirror = false) {
  containerEl.innerHTML = '';
  containerEl.className = 'board-columns';
  const board = playerData.board;
  const isMe  = (pi === myPlayerIndex);

  const baseCols = [[0, 2], [1, 3]];
  const extraCols = [];
  let idx = 4;
  while (idx < board.length) {
    const slotA = idx;
    const slotB = (idx + 1 < board.length) ? idx + 1 : null;
    extraCols.push([slotA, slotB]);
    idx += 2;
  }

  let columnDefs;
  if (mirror) {
    const reversedExtra = [...extraCols].reverse();
    columnDefs = [...reversedExtra, [1, 3], [0, 2]];
  } else {
    columnDefs = [...baseCols, ...extraCols];
  }

  columnDefs.forEach(slots => {
    const colEl = document.createElement('div');
    colEl.className = 'board-col';
    const orderedSlots = mirror ? [...slots].reverse() : slots;

    orderedSlots.forEach(slotIdx => {
      if (slotIdx === null) {
        const ph = document.createElement('div');
        ph.className = 'card-face card-slot-empty';
        colEl.appendChild(ph);
        return;
      }
      const card = board[slotIdx];
      if (card === null) {
        if (slotIdx < 4) {
          const ph = document.createElement('div');
          ph.className = 'card-face card-slot-empty';
          colEl.appendChild(ph);
        }
        return;
      }
      const el = makeCardEl(card);
      el.id             = `card-p${pi}-s${slotIdx}`;
      el.dataset.player = pi;
      el.dataset.slot   = slotIdx;
      el.style.cursor   = 'pointer';
      if (heldCard && isMe && isMyTurn) el.classList.add('clickable-slot');
      if (pendingEffect && isMyTurn && isValidEffectTarget(pi, slotIdx)) el.classList.add('effect-target');
      el.addEventListener('click', () => onBoardCardClick(pi, slotIdx));
      colEl.appendChild(el);
    });

    if (colEl.children.length > 0) containerEl.appendChild(colEl);
  });
}

function buildMyBoard(state) {
  const me = state.players[myPlayerIndex];
  if (!me) return;
  // Name always at top of the board — kept in the static HTML label
  myNameEl.textContent = me.name;
  renderBoardGrid(me, myGrid, myPlayerIndex, false);
  // Re-apply slot-available if we still hold a card (persists across re-renders)
  if (heldCard && isMyTurn) addSlotAvailable(myPlayerIndex);
}

function buildOpponents(state) {
  opponentsArea.innerHTML = '';
  state.players.forEach((player, pi) => {
    if (pi === myPlayerIndex || player.eliminated) return;
    const isCurrent = (pi === state.current_player_index);
    const wrap  = document.createElement('div');
    wrap.className = 'player-board' + (isCurrent ? ' is-current-player' : '');
    wrap.id = `board-p${pi}`;

    // Name always pinned at top-centre
    const label = document.createElement('div');
    label.className   = 'board-label';
    label.textContent = player.name + (isCurrent ? ' ◀' : '');
    if (isCurrent && state.held_card) {
      label.textContent += ' 🂠';
    }

    const grid = document.createElement('div');
    renderBoardGrid(player, grid, pi, true);
    wrap.appendChild(label);
    wrap.appendChild(grid);
    opponentsArea.appendChild(wrap);
  });
}

function buildScoreStrip(state) {
  scoreStrip.innerHTML = '';
  state.players.forEach((p, pi) => {
    const chip = document.createElement('div');
    chip.className = 'score-chip'
      + (pi === state.current_player_index ? ' current' : '')
      + (p.eliminated ? ' eliminated' : '');
    chip.innerHTML = `<span class="chip-name">${p.name}</span><span class="chip-score">${p.score}</span>`;
    scoreStrip.appendChild(chip);
  });
  // Show the elimination threshold as a small label after the chips
  const limit = state.score_limit ?? scoreLimit;
  if (limit) {
    const limitChip = document.createElement('div');
    limitChip.className = 'score-limit-chip';
    limitChip.innerHTML = `<span class="limit-text">Eliminated if points &gt; ${limit}</span>`;
    scoreStrip.appendChild(limitChip);
  }
}

function setStatus(msg) { statusMsg.textContent = msg; }

// ── Window bar ────────────────────────────────────────────────────────────────
const WINDOW_MS = 2000;
let   windowActive = false;   // true while matching-discard countdown is running

function startWindowBar() {
  clearInterval(windowTimer);
  windowActive = true;
  windowBar.classList.remove('hidden');
  windowFill.style.transform = 'scaleX(1)';
  const start = Date.now();
  windowTimer = setInterval(() => {
    const p = Math.max(0, 1 - (Date.now() - start) / WINDOW_MS);
    windowFill.style.transform = `scaleX(${p})`;
    if (p <= 0) {
      clearInterval(windowTimer);
      windowBar.classList.add('hidden');
      windowActive = false;
    }
  }, 50);
}

// ── Score limit UI ────────────────────────────────────────────────────────────
function updateScoreLimitDisplay(limit) {
  scoreLimit = limit;
  if (isHost) {
    scoreLimitSel.value = limit;
  } else if (scoreLimitView) {
    scoreLimitView.textContent = `Playing to ${limit} points`;
  }
}

// ── Click dispatch ────────────────────────────────────────────────────────────
function onBoardCardClick(pi, slotIdx) {
  if (isModalBlocking()) return;
  const isMe = (pi === myPlayerIndex);
  if (heldCard && isMe && isMyTurn) { socket.emit('replace_card', { slot: slotIdx }); heldCard = null; return; }
  if (pendingEffect && isMyTurn) { handleEffectClick(pi, slotIdx); return; }
  socket.emit('matching_discard', { target_player: pi, slot: slotIdx });
}

function isValidEffectTarget(pi, slotIdx) {
  if (!pendingEffect) return false;
  const isMe      = (pi === myPlayerIndex);
  const isElim    = gameState?.players[pi]?.eliminated;
  const isYCaller = (pi === gameState?.yussuf_caller_index);
  const card      = gameState?.players[pi]?.board?.[slotIdx];
  if (!card) return false;
  switch (pendingEffect.type) {
    case 'look_own':      return isMe && !isElim;
    case 'look_opponent': return !isMe && !isElim;
    case 'jack': case 'queen_look': case 'queen_swap': return !isElim && !isYCaller;
    default: return false;
  }
}

function handleEffectClick(pi, slotIdx) {
  if (!pendingEffect) return;
  switch (pendingEffect.type) {
    case 'look_own':
      if (pi !== myPlayerIndex) { toast('Pick one of YOUR own cards', 'error'); return; }
      socket.emit('effect_look_own', { slot: slotIdx }); pendingEffect = null; clearActionHint(); break;
    case 'look_opponent':
      if (pi === myPlayerIndex) { toast("Pick an OPPONENT's card", 'error'); return; }
      socket.emit('effect_look_opponent', { target_player: pi, slot: slotIdx }); pendingEffect = null; clearActionHint(); break;
    case 'jack': case 'queen_look': case 'queen_swap': {
      if (!pendingEffect.selections) pendingEffect.selections = [];
      pendingEffect.selections.push({ pi, slotIdx });
      const el = document.getElementById(`card-p${pi}-s${slotIdx}`);
      if (el) el.classList.add('card-selected');

      if (pendingEffect.type === 'queen_look' && pendingEffect.selections.length === 1) {
        // Queen step 1: user picked first card — send immediately so they can see it
        const [a] = pendingEffect.selections;
        socket.emit('effect_queen_look_step1', { p1: a.pi, s1: a.slotIdx });
        setActionHint('Queen 👁 now click the 2nd card to look at');

      } else if (pendingEffect.selections.length === 1) {
        const next = { jack:'Jack ↔ now click the 2nd card', queen_swap:'Queen ↔ now click the 2nd card to swap' };
        setActionHint(next[pendingEffect.type] || 'Now click the 2nd card');

      } else if (pendingEffect.selections.length === 2) {
        const [a, b] = pendingEffect.selections;
        if (pendingEffect.type === 'jack') {
          socket.emit('effect_jack_swap', { p1:a.pi, s1:a.slotIdx, p2:b.pi, s2:b.slotIdx });
          pendingEffect = null; clearActionHint();
        } else if (pendingEffect.type === 'queen_look') {
          // Step 2: send second card — server will reply with queen_look_result containing both cards
          socket.emit('effect_queen_look_step2', { p2: b.pi, s2: b.slotIdx });
          pendingEffect = { type:'queen_waiting', selections:[] }; clearActionHint();
        } else if (pendingEffect.type === 'queen_swap') {
          socket.emit('effect_queen_swap', { p1:a.pi, s1:a.slotIdx, p2:b.pi, s2:b.slotIdx });
          pendingEffect = null; clearActionHint();
        }
      }
      break;
    }
  }
}

// ── Main state update ─────────────────────────────────────────────────────────
function applyStateUpdate(state) {
  gameState = state;
  const wasMyTurn = isMyTurn;
  isMyTurn  = (myPlayerIndex !== null && myPlayerIndex === state.current_player_index);
  // Clear turnCompleted when a new turn begins for this player
  if (isMyTurn && !wasMyTurn) turnCompleted = false;
  roundNum.textContent   = state.round_number;
  phaseBadge.textContent = formatPhase(state.phase);
  deckCount.textContent  = state.deck_size;
  renderCardFace(state.discard_top, discardTop);
  buildScoreStrip(state);
  buildOpponents(state);
  if (myPlayerIndex !== null) buildMyBoard(state);
  flushAnimQueue();
  applyFlipSwap();
  if (isMyTurn && state.held_card && !state.held_card?.hidden) heldCard = state.held_card;
  // Yussuf button: visible only on my turn, no card held, no pending effect
  const showYussuf = isMyTurn && !heldCard && !pendingEffect && !turnCompleted
    && ['playing','final_turns'].includes(state.phase);
  btnYussuf?.classList.toggle('hidden', !showYussuf);
  // Position Yussuf button vertically centred with the discard pile
  // Always position Yussuf button aligned with the pile group vertical centre
  // (call positioning function which retries via rAF if pile-group has zero height)
  if (btnYussuf && !btnYussuf.classList.contains('hidden')) {
    positionYussufButton();
  }
  // action-bar no longer needed (Yussuf moved to pile area)
  actionBar.classList.add('hidden');
  heldArea.classList.add('hidden');

  // Piles glow when drawable (no card held yet)
  const canDraw = isMyTurn && !heldCard && !pendingEffect && !windowActive && ['playing','final_turns'].includes(state.phase);
  const pileBack = deckPile?.querySelector('.pile-back');
  if (pileBack) pileBack.classList.toggle('pile-drawable', canDraw);
  // Discard pile glow: when can draw OR when holding a card (to discard it)
  const discardPileEl = document.getElementById('discard-pile');
  if (discardPileEl) {
    const canDiscard = isMyTurn && !!heldCard;
    discardPileEl.classList.toggle('pile-drawable', (canDraw && !!state.discard_top) || canDiscard);
  }
  if (!isMyTurn) {
    const cName = state.players[state.current_player_index]?.name || '?';
    setStatus(state.phase === 'final_turns' ? `Final turns — ${cName} is playing (${state.final_turns_remaining} left)` : `${cName}'s turn`);
  } else {
    if (heldCard) setStatus('');  // drawn card next to board is the signal — no text
    else if (!pendingEffect) setStatus(state.phase === 'final_turns' ? 'Your final turn!' : 'Your turn!');
    else setStatus('');
  }
}

function formatPhase(p) {
  return {waiting:'Waiting',peek:'Peek',playing:'Playing',final_turns:'Final Turns',round_end:'Round Over',game_over:'Game Over'}[p]||p;
}

// =============================================================================
// PAUSE MENU
// =============================================================================

function showPauseMenu(reason, pausedBy) {
  pauseOverlay.classList.remove('hidden');
  unpauseStatus.textContent = '';
  exitStatus.textContent    = '';
  btnUnpause.disabled       = false;
  btnUnpause.textContent    = '▶ Continue';
  btnExitVote.disabled      = false;
  btnExitVote.textContent   = '🚪 Exit Game';
  pauseReason.textContent = pausedBy
    ? `Paused by ${pausedBy}`
    : reason === 'inactivity' ? 'Game paused due to 5 minutes of inactivity.' : '';
  // Random GIF
  const gif = PAUSE_GIFS[Math.floor(Math.random() * PAUSE_GIFS.length)];
  pauseGif.src = gif;
}

function hidePauseMenu() {
  pauseOverlay.classList.add('hidden');
}

// =============================================================================
// BUTTON LISTENERS
// =============================================================================

btnJoin.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { toast('Enter your name first', 'error'); return; }
  socket.emit('join_game', { name });
});
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnJoin.click(); });
btnStart.addEventListener('click',    () => socket.emit('start_game', {}));
scoreLimitSel.addEventListener('change', () => {
  if (!isHost) return;
  socket.emit('set_score_limit', { score_limit: parseInt(scoreLimitSel.value) });
});
btnYussuf.addEventListener('click', () => {
  if (isModalBlocking()) return;
  socket.emit('call_yussuf');
});
btnDiscardHeld.addEventListener('click', () => { socket.emit('discard_held'); heldCard = null; });

// ── Pile click handlers (replace Draw Deck / Draw Discard buttons) ────────────
deckPile.addEventListener('click', () => {
  if (isModalBlocking()) return;
  if (!isMyTurn || heldCard || pendingEffect || windowActive) return;
  socket.emit('draw_deck');
});

discardTop.addEventListener('click', () => {
  if (isModalBlocking()) return;
  if (!isMyTurn) return;
  if (heldCard) {
    socket.emit('discard_held');
    return;
  }
  if (!gameState?.discard_top || pendingEffect || windowActive) return;
  socket.emit('draw_discard');
});

// ── Chat bubble + close ───────────────────────────────────────────────────────
function openChat() {
  chatPanel.classList.remove('hidden');
  unreadCount = 0;
  updateChatBadge();
  chatLog.scrollTop = chatLog.scrollHeight;
}
function closeChat() { chatPanel.classList.add('hidden'); }
function updateChatBadge() {
  let badge = btnChatBubble.querySelector('.chat-badge');
  if (unreadCount > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'chat-badge'; btnChatBubble.appendChild(badge); }
    badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
  } else {
    badge?.remove();
  }
}
btnChatBubble.addEventListener('click', () => {
  if (chatPanel.classList.contains('hidden')) openChat(); else closeChat();
});
btnChatClose.addEventListener('click', closeChat);

document.querySelectorAll('.chat-phrase').forEach(btn => {
  btn.addEventListener('click', () => {
    socket.emit('chat_message', { msg: btn.dataset.msg });
  });
});
btnPeekReady.addEventListener('click',   () => { btnPeekReady.disabled = true; peekWaitMsg.classList.remove('hidden'); socket.emit('peek_done'); });
btnActionCancel.addEventListener('click', () => { pendingEffect = null; clearActionHint(); socket.emit('cancel_effect'); });

// Rules panel: shows backdrop that blocks all interaction with game underneath
function openRulesPanel() {
  rulesPanel.classList.remove('hidden');
  // Create backdrop if it doesn't exist
  let backdrop = document.getElementById('rules-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id        = 'rules-backdrop';
    backdrop.className = 'modal-backdrop';
    // Click on backdrop closes the rules panel
    backdrop.addEventListener('click', closeRulesPanel);
    document.body.appendChild(backdrop);
  }
  backdrop.style.display = 'block';
}
function closeRulesPanel() {
  rulesPanel.classList.add('hidden');
  const backdrop = document.getElementById('rules-backdrop');
  if (backdrop) backdrop.style.display = 'none';
}
function isModalBlocking() {
  return !rulesPanel.classList.contains('hidden')
      || !pauseOverlay.classList.contains('hidden');
}

document.getElementById('btn-lobby-rules').addEventListener('click', () => document.getElementById('lobby-rules-panel').classList.toggle('hidden'));
document.getElementById('btn-lobby-rules-close').addEventListener('click', () => document.getElementById('lobby-rules-panel').classList.add('hidden'));
document.getElementById('btn-rules-toggle').addEventListener('click', () => {
  if (rulesPanel.classList.contains('hidden')) openRulesPanel();
  else closeRulesPanel();
});
document.getElementById('btn-rules-close').addEventListener('click',  closeRulesPanel);

btnNextRound.addEventListener('click', () => {
  myReadyClicked = true;
  btnNextRound.disabled = true;
  btnNextRound.textContent = 'Waiting for others…';
  socket.emit('player_ready_next');
});

// Pause controls
btnPause.addEventListener('click', () => socket.emit('pause_game'));

btnUnpause.addEventListener('click', () => {
  btnUnpause.disabled = true;
  btnUnpause.textContent = 'Waiting for others…';
  socket.emit('unpause_ready');
});

btnExitVote.addEventListener('click', () => {
  btnExitVote.disabled = true;
  btnExitVote.textContent = 'Exit vote sent…';
  socket.emit('exit_vote');
});

// Game-over exit: no vote needed, immediate reset
btnGameOverExit?.addEventListener('click', () => {
  btnGameOverExit.disabled = true;
  btnGameOverExit.textContent = 'Returning to main menu…';
  socket.emit('game_over_exit');
});

btnPauseRules.addEventListener('click', () => pauseRulesContent.classList.toggle('hidden'));

// =============================================================================
// SOCKET EVENTS
// =============================================================================

socket.on('connect',    () => console.log('[socket] connected'));
socket.on('disconnect', () => toast('Disconnected — try refreshing', 'error'));

socket.on('joined', data => {
  myPlayerIndex = data.player_index;
  myName        = data.name;
  isHost        = data.is_host;
  scoreLimit    = data.score_limit || 50;
  toast(`Joined as ${myName}`, 'good');
  document.getElementById('join-form').style.display = 'none';
  btnStart.classList.remove('hidden');
  scoreLimitRow.classList.remove('hidden');
  if (isHost) {
    scoreLimitSel.classList.remove('hidden'); scoreLimitSel.value = scoreLimit;
    if (scoreLimitView) scoreLimitView.classList.add('hidden');
  } else {
    scoreLimitSel.classList.add('hidden');
    if (scoreLimitView) { scoreLimitView.classList.remove('hidden'); scoreLimitView.textContent = `Playing to ${scoreLimit} points`; }
  }
});

socket.on('lobby_update', data => {
  lobbyList.innerHTML = '';
  data.players.forEach(p => { const li = document.createElement('li'); li.textContent = p.name; lobbyList.appendChild(li); });
  const count = data.player_count;
  lobbyWait.textContent = count === 0 ? 'Waiting for players to join…' : count === 1 ? 'Waiting for at least 1 more player to join…' : `${count} players ready — host can start!`;
  if (data.score_limit && myPlayerIndex !== null) updateScoreLimitDisplay(data.score_limit);
  if (data.phase === 'peek' && myPlayerIndex !== null) showScreen('screen-peek');
  else if (['playing','final_turns'].includes(data.phase)) showScreen('screen-game');
});

socket.on('score_limit_updated', data => {
  updateScoreLimitDisplay(data.score_limit);
  if (!isHost) toast(`Score limit changed to ${data.score_limit} pts by host`);
});

socket.on('ready_status', data => {
  const readyRow = document.getElementById('ready-status-row');
  if (readyRow) readyRow.textContent = data.ready < data.needed ? `${data.names.join(', ')} ${data.ready === 1 ? 'is' : 'are'} ready (${data.ready}/${data.needed})` : '';
  if (!myReadyClicked) {
    btnNextRound.disabled = false;
    btnNextRound.classList.remove('hidden');
    btnNextRound.textContent = `Continue → (${data.ready}/${data.needed} ready)`;
  } else {
    btnNextRound.disabled = true;
    btnNextRound.textContent = `Waiting for others… (${data.ready}/${data.needed} ready)`;
  }
});

socket.on('round_started', data => {
  heldCard = null; lastHeldCard = null; pendingEffect = null; turnCompleted = false; windowActive = false;
  animQueue = []; swapAnimData = null; myReadyClicked = false;
  clearDrawnCard(); clearSlotAvailable(); clearDiscardAvailable();
  exitYussufTension();
  roundEndOverlay.classList.add('hidden'); clearActionHint();
  clearInterval(windowTimer); windowBar.classList.add('hidden');
  if (data.score_limit) scoreLimit = data.score_limit;
  if (myPlayerIndex !== null) {
    peekRoundNum.textContent = data.round_number;
    peekFace2.textContent = '…'; peekFace3.textContent = '…';
    peekFace2.className = 'card-face'; peekFace3.className = 'card-face';
    btnPeekReady.disabled = false; peekWaitMsg.classList.add('hidden');
    showScreen('screen-peek'); socket.emit('send_peek_cards');
  }
});

socket.on('peek_result', data => {
  renderCardFace(data.cards['2'], peekFace2); renderCardFace(data.cards['3'], peekFace3);
  popEl(peekFace2); popEl(peekFace3);
  peekFace0.className = 'card-face hidden-card'; peekFace1.className = 'card-face hidden-card';
  if (data.all_peeked) showScreen('screen-game');
});

socket.on('state_update', state => {
  applyStateUpdate(state);
  // Sync tension state (handles reconnections mid-final-turns)
  if (state.phase === 'final_turns' && !tensionActive) {
    const callerName = state.players[state.yussuf_caller_index]?.name || 'Someone';
    enterYussufTension(callerName, state.final_turns_remaining);
  } else if (state.phase !== 'final_turns' && tensionActive) {
    exitYussufTension();
  }
  // Always switch to game screen when playing (fixes round 2+ transition)
  if (['playing','final_turns'].includes(state.phase)) {
    roundEndOverlay.classList.add('hidden');
    if (!screenGame.classList.contains('active')) {
      showScreen('screen-game');
      btnChatBubble.classList.remove('hidden');
    }
  }
});

socket.on('player_drew_deck', data => {
  flashDeck();
  if (data.player_index !== myPlayerIndex) {
    // Create the float destination FIRST (invisible), then fly directly to it
    const boardEl  = document.getElementById(`board-p${data.player_index}`);
    const srcEl    = deckPile?.querySelector('.pile-back');
    const floatEl  = createDrawnCardFloat(null, boardEl, false); // face-down, right side
    if (floatEl) {
      flyCardFrom(srcEl, floatEl, null, revealDrawnCardFloat, 500);
    }
    toast(`${data.player_name} drew from the deck`);
  }
});

socket.on('draw_result', data => {
  heldCard     = data.held_card;
  lastHeldCard = data.held_card;

  // Use my-grid (card columns only) NOT my-board (includes name label)
  // so the float is vertically centred against the cards themselves
  // Use my-board (the visible framed box) so float is positioned outside the frame
  const anchorEl = document.getElementById('my-board') || myGrid;
  const srcEl    = deckPile?.querySelector('.pile-back');

  // Create the float destination FIRST (invisible, left of my board, face-up)
  const floatEl = createDrawnCardFloat(data.held_card, anchorEl, true);

  // Fly the card in ONE straight arc: pile → left of my board
  flyCardFrom(srcEl, floatEl, data.held_card, () => {
    revealDrawnCardFloat();
    heldArea.classList.add('hidden');     // no held-area bar at all
    actionBar.classList.add('hidden');
    // Highlight discard pile as a placement option (same glow as board slots)
    addSlotAvailable(myPlayerIndex);
    addDiscardAvailable();
  });
  setStatus('');
});

socket.on('draw_discard_result', data => {
  const activeIdx = gameState?.current_player_index;
  const isMe      = (myPlayerIndex === activeIdx);
  const srcEl     = discardTop;

  if (isMe) {
    heldCard     = data.held_card;
    lastHeldCard = data.held_card;
    // Use my-board (the visible framed box) so float is positioned outside the frame
  const anchorEl = document.getElementById('my-board') || myGrid;
    const floatEl   = createDrawnCardFloat(data.held_card, anchorEl, true);
    flyCardFrom(srcEl, floatEl, data.held_card, () => {
      revealDrawnCardFloat();
      heldArea.classList.add('hidden');
      actionBar.classList.add('hidden');
      addSlotAvailable(myPlayerIndex);
      addDiscardAvailable();
    });
    setStatus('');
  } else {
    const boardEl = document.getElementById(`board-p${activeIdx}`);
    const floatEl = createDrawnCardFloat(null, boardEl, false);
    if (floatEl) {
      flyCardFrom(srcEl, floatEl, null, revealDrawnCardFloat, 500);
    }
  }

  toast(`${gameState?.players[activeIdx]?.name || '?'} drew from the discard pile`);
  setTimeout(() => popEl(discardTop), 200);
});

socket.on('card_replaced', data => {
  if (data.acting_player === myPlayerIndex) turnCompleted = true;
  const destEl        = document.getElementById(`card-p${data.acting_player}-s${data.slot}`);
  const isMeReplacing = (data.acting_player === myPlayerIndex);

  // Capture old card position NOW before state_update destroys it
  // so we can fly the replaced (old) card to the discard pile
  const oldCardRect = destEl ? destEl.getBoundingClientRect() : null;

  if (destEl) {
    // Stage 2: drawn card flies from float → board slot
    const srcForStage2 = drawnCardFloatEl || heldDisplay;
    flyCardFrom(srcForStage2, destEl, isMeReplacing ? lastHeldCard : null, null, 380);
  }

  // After state_update rebuilds the board, fly the OLD card from its position to discard
  if (oldCardRect) {
    setTimeout(() => {
      // Create a temporary flying element at the old card's position
      const ghost = document.createElement('div');
      ghost.className = 'flying-card face-down';
      ghost.style.cssText = `width:60px;height:86px;left:${oldCardRect.left + oldCardRect.width/2 - 30}px;top:${oldCardRect.top + oldCardRect.height/2 - 43}px;opacity:0;transition:none;`;
      document.body.appendChild(ghost);
      void ghost.offsetWidth;
      const dr = discardTop.getBoundingClientRect();
      const tx = (dr.left + dr.width/2) - (oldCardRect.left + oldCardRect.width/2);
      const ty = (dr.top  + dr.height/2) - (oldCardRect.top  + oldCardRect.height/2);
      requestAnimationFrame(() => {
        ghost.style.transition = 'transform 1.26s cubic-bezier(0.4,0,0.2,1), opacity 80ms ease';
        ghost.style.opacity    = '0.9';
        ghost.style.transform  = `translate(${tx}px,${ty}px)`;
      });
      setTimeout(() => ghost.remove(), 1350);
    }, 80);
  }

  clearDrawnCard();
  clearSlotAvailable();
  clearDiscardAvailable();
  lastHeldCard = null;
  heldCard     = null;
  queueAnim(data.acting_player, data.slot, 'slot-highlight');
  startWindowBar();
});

socket.on('card_discarded', data => {
  if (isMyTurn) turnCompleted = true;
  // Stage 2: fly from float position → discard pile
  const srcForStage2 = drawnCardFloatEl || heldDisplay;
  flyCardFrom(srcForStage2, discardTop, isMyTurn ? lastHeldCard : null, null, 380);

  clearDrawnCard();
  clearSlotAvailable();
  clearDiscardAvailable();
  lastHeldCard = null;
  heldCard     = null;
  setTimeout(() => popEl(discardTop), 420);
  if (data.special_effect && isMyTurn) {
    const hints = { look_own:'7/8 · Click one of YOUR cards', look_opponent:'9/10 · Click any OPPONENT card', jack:'Jack ↔ Click 1st card to swap', queen:'Queen 👁 Click 1st of 2 cards to look at' };
    pendingEffect = { type: data.special_effect === 'queen' ? 'queen_look' : data.special_effect, selections: [] };
    setActionHint(hints[data.special_effect] || data.special_effect);
  } else { startWindowBar(); }
  if (data.special_effect && !isMyTurn) {
    const effectNames = { look_own:'7/8', look_opponent:'9/10', jack:'Jack (swap)', queen:'Queen (look+swap)' };
    toast(`${gameState?.players[gameState?.current_player_index]?.name || '?'} played ${effectNames[data.special_effect] || data.special_effect}`);
  }
});

socket.on('effect_cancelled', () => { pendingEffect = null; clearActionHint(); });

// ── Look result: 7/8/9/10 private peek ───────────────────────────────────────
socket.on('look_result', data => {
  const targetPi = data.target_player !== undefined ? data.target_player : myPlayerIndex;
  // Delay the flip until after state_update has rebuilt the board DOM,
  // so the clone is positioned against the card's final screen coordinates.
  const _card = data.card, _pi = targetPi, _slot = data.slot;
  setTimeout(() => showPeekReveal(_card, _pi, _slot), 120);
  pendingEffect = null; clearActionHint(); startWindowBar();
});

// ── Card peeked (PUBLIC: slot animation for all) ──────────────────────────────
socket.on('card_peeked', data => {
  queueAnim(data.target_player, data.slot, 'slot-peeked');
  if (data.looker === myPlayerIndex) return;
  const looker = gameState?.players[data.looker]?.name || '?';
  const target = gameState?.players[data.target_player]?.name || '?';
  toast(data.looker === data.target_player ? `${looker} peeked at their own card` : `${looker} peeked at ${target}'s card`);
});

// ── Queen look result: show card 1 immediately, then wait for card 2 ─────────
// The server now handles queen look in two steps.
// queen_look_step1_result: first card shown privately + slot highlighted
// queen_look_result: both cards shown, switch to swap mode
socket.on('queen_look_step1_result', data => {
  // Defer until after state_update rebuilds board — same fix as look_result
  const _c = data.card1, _pi = data.pos1.player, _sl = data.pos1.slot;
  setTimeout(() => showQueenStepReveal(_c, _pi, _sl, ''), 120);
});

socket.on('queen_look_result', data => {
  // Show second card deferred — board rebuilds first
  const _c = data.card2, _pi = data.pos2.player, _sl = data.pos2.slot;
  setTimeout(() => showQueenStepReveal(_c, _pi, _sl, ''), 120);
  setTimeout(() => {
    pendingEffect = { type: 'queen_swap', selections: [] };
    setActionHint(`Queen: saw ${data.card1.display} & ${data.card2.display} · Click 1st card to swap`);
    if (gameState) applyStateUpdate(gameState);
  }, 1500);
});

// ── Swap result: FLIP animation ───────────────────────────────────────────────
socket.on('swap_result', data => {
  const s = data.swap;
  const el1 = document.getElementById(`card-p${s.p1}-s${s.s1}`);
  const el2 = document.getElementById(`card-p${s.p2}-s${s.s2}`);
  if (el1 && el2) {
    swapAnimData = { p1:s.p1, s1:s.s1, p2:s.p2, s2:s.s2, r1:el1.getBoundingClientRect(), r2:el2.getBoundingClientRect() };
  } else {
    queueAnim(s.p1, s.s1, 'slot-highlight'); queueAnim(s.p2, s.s2, 'slot-highlight');
  }
  pendingEffect = null; clearActionHint(); startWindowBar();
  toast(`${gameState?.players[gameState?.current_player_index]?.name || '?'} swapped 2 cards`);
});

// ── Matching-discard ──────────────────────────────────────────────────────────
socket.on('matching_discard_result', data => {
  const actor  = gameState?.players[data.acting_player]?.name || '?';
  const target = data.target_player !== undefined ? gameState?.players[data.target_player]?.name : null;
  const mdPi   = data.target_player ?? data.acting_player;
  queueAnim(mdPi, data.slot, data.correct ? 'slot-success' : 'slot-error');
  // Animation:
  //  - Own match (card permanently leaves board): fly card to discard pile
  //  - Opponent match (card returns to owner): no fly animation — slot pulses
  //    in green via slot-success and the card stays in place
  if (data.correct && data.own) {
    setTimeout(() => {
      const slotEl = document.getElementById(`card-p${mdPi}-s${data.slot}`);
      if (slotEl) flyCardFrom(slotEl, discardTop, null, null, 1260);
    }, 60);
  }
  if (data.correct) {
    toast(data.own ? `✓ ${actor} matched ${data.card.display}!` : `✓ ${actor} matched ${target}'s ${data.card.display} — ${target} gets punishment!`, 'good');
  } else {
    toast(`✗ ${actor} wrong match — punishment card added`, 'error');
  }
  if (data.temp_reveal) scheduleTempRevealHide(data.temp_reveal.player, data.temp_reveal.slot);
  if (data.round_ended) showRoundEnd(data.result);
});

socket.on('yussuf_called', data => {
  toast(`🃏 ${data.caller_name} called YUSSUF! ${data.final_turns_remaining} final turn(s) left`, 'good');
  enterYussufTension(data.caller_name, data.final_turns_remaining);
});
socket.on('yussuf_failed', data => toast(`${data.player_name} tried Yussuf but total is over 5 — punishment card added!`, 'error'));
socket.on('window_closed', () => { clearInterval(windowTimer); windowBar.classList.add('hidden'); windowActive = false; });

socket.on('round_ended', result => {
  clearInterval(windowTimer); windowBar.classList.add('hidden'); windowActive = false;
  heldCard = null; lastHeldCard = null; pendingEffect = null;
  animQueue = []; swapAnimData = null; clearActionHint();
  clearDrawnCard(); clearSlotAvailable(); clearDiscardAvailable();
  exitYussufTension();
  showRoundEnd(result);
});

socket.on('error', data => toast(data.message, 'error'));

socket.on('special_effect_prompt', data => {
  if (!isMyTurn || pendingEffect) return;
  const hints = { look_own:'7/8 · Click one of YOUR cards', look_opponent:'9/10 · Click any OPPONENT card', jack:'Jack ↔ Click 1st card to swap', queen:'Queen 👁 Click 1st of 2 cards' };
  pendingEffect = { type: data.effect === 'queen' ? 'queen_look' : data.effect, selections: [] };
  setActionHint(hints[data.effect] || data.effect);
  if (gameState) applyStateUpdate(gameState);
});

// ── Pause events ──────────────────────────────────────────────────────────────
socket.on('game_paused',  data => showPauseMenu(data.reason, data.paused_by));
socket.on('game_resumed', ()   => hidePauseMenu());

socket.on('unpause_status', data => {
  unpauseStatus.textContent = `${data.ready} / ${data.needed} players ready to continue`;
});

socket.on('exit_status', data => {
  exitStatus.textContent = `${data.voted} / ${data.needed} voted to exit`;
});

socket.on('game_exit', () => {
  hidePauseMenu();
  closeRulesPanel();
  roundEndOverlay.classList.add('hidden');
  chatPanel.classList.add('hidden');
  chatLog.innerHTML = '';
  // Hide chat bubble and Yussuf button (game-only elements)
  btnChatBubble?.classList.add('hidden');
  btnYussuf?.classList.add('hidden');
  showScreen('screen-lobby');
  toast('Game ended — back to main menu');
  // Reset client state
  myPlayerIndex = null; myName = ''; isHost = false;
  gameState = null; heldCard = null; lastHeldCard = null; pendingEffect = null;
  turnCompleted = false; windowActive = false; tensionActive = false;
  document.getElementById('join-form').style.display = '';
  btnStart.classList.add('hidden');
  scoreLimitRow.classList.add('hidden');
  lobbyList.innerHTML = '';
});

// ── Chat message received ─────────────────────────────────────────────────────
socket.on('chat_message', data => {
  const isOwn      = (data.player_index === myPlayerIndex);
  const isPanelOpen = !chatPanel.classList.contains('hidden');

  // Always add to chat log
  const el = document.createElement('div');
  el.className = 'chat-msg' + (isOwn ? ' own-msg' : '');
  el.innerHTML =
    `<span class="chat-author">${data.name}:</span>` +
    `<span class="chat-text">${data.msg}</span>`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;

  // For messages from others: show toast, increment badge — do NOT auto-open
  if (!isOwn) {
    toast(`${data.name}: ${data.msg}`);
    if (!isPanelOpen) {
      unreadCount++;
      updateChatBadge();
    }
  }
});

// =============================================================================
// LEADERBOARD — round-by-round table
// =============================================================================

function showRoundEnd(result) {
  myReadyClicked = false;
  roundEndOverlay.classList.remove('hidden');
  btnNextRound.disabled = false;
  btnNextRound.classList.remove('hidden');

  // Title
  if (result.trigger === 'empty_board') {
    overlayTitle.textContent = `${gameState?.players[result.trigger_player]?.name || '?'} cleared their board!`;
  } else if (result.trigger === 'deck_empty') {
    overlayTitle.textContent = 'Deck ran out!';
  } else if (result.trigger === 'yussuf_complete') {
    const who = result.yussuf_result ? (gameState?.players[result.yussuf_result.caller]?.name || '?') : '?';
    overlayTitle.textContent = `Yussuf! — ${who} called it`;
  } else {
    overlayTitle.textContent = 'Round Over';
  }

  // ── Revealed boards ─────────────────────────────────────────────────────────
  revealBoards.innerHTML = '';
  if (result.revealed_boards) {
    Object.entries(result.revealed_boards).forEach(([piStr, cards]) => {
      const pi   = parseInt(piStr);
      const p    = gameState?.players[pi];
      const wrap = document.createElement('div');
      wrap.className = 'reveal-player';
      const nameEl = document.createElement('div');
      nameEl.className = 'reveal-name';
      nameEl.textContent = `${p?.name || 'P'+(pi+1)} (${result.board_values?.[pi] ?? '?'} pts)`;
      const row = document.createElement('div');
      row.className = 'reveal-cards';
      (cards || []).forEach(card => {
        if (!card) return;
        const el = makeCardEl(card);
        el.style.cssText = 'width:44px;height:62px;font-size:.85rem;flex-shrink:0';
        row.appendChild(el);
      });
      wrap.appendChild(nameEl); wrap.appendChild(row);
      revealBoards.appendChild(wrap);
    });
  }

  // ── Yussuf / exact-limit banners ────────────────────────────────────────────
  overlayYussuf.innerHTML = '';
  if (result.yussuf_result) {
    const yr  = result.yussuf_result;
    const who = gameState?.players[yr.caller]?.name || '?';
    const el  = document.createElement('div');
    el.className = `yussuf-banner ${yr.won ? 'won' : 'lost'}`;
    el.textContent = yr.won ? `🏆 ${who} won the Yussuf! (−5 pts)` : `✗ ${who} lost the Yussuf (+10 pts)`;
    overlayYussuf.appendChild(el);
  }
  (result.exact_limit_players || []).forEach(pi => {
    const el = document.createElement('p');
    el.style.cssText = 'color:#e8c96a;font-size:.82rem;text-align:center;margin-top:.4rem';
    el.textContent = `⚡ ${gameState?.players[pi]?.name} hit exactly ${result.score_limit} → score halved!`;
    overlayYussuf.appendChild(el);
  });

  // ── Round-by-round table ────────────────────────────────────────────────────
  overlayScores.innerHTML = '';
  const history = result.round_history || [];
  const allPis  = gameState ? gameState.players.map((_, i) => i) : [];

  // Show the elimination threshold above the score table
  const limit = result.score_limit ?? gameState?.score_limit ?? scoreLimit;
  if (limit) {
    const limitNote = document.createElement('div');
    limitNote.className = 'overlay-limit-note';
    limitNote.innerHTML = `<span>Playing to <strong>${limit}</strong> · Eliminated if points &gt; ${limit}</span>`;
    overlayScores.appendChild(limitNote);
  }

  if (history.length > 0 && allPis.length > 0) {
    const tableWrap = document.createElement('div');
    tableWrap.className = 'round-table-wrap';
    const table = document.createElement('table');
    table.className = 'round-table';

    // Header row: Player | R1 | R2 | ... | Total
    const thead = document.createElement('thead');
    const hrow  = document.createElement('tr');
    const thPlayer = document.createElement('th');
    thPlayer.textContent = 'Player';
    hrow.appendChild(thPlayer);
    history.forEach(h => {
      const th = document.createElement('th');
      th.textContent = `R${h.round}`;
      if (h.round === result.round_history[result.round_history.length - 1]?.round)
        th.style.color = 'var(--gold-light)';
      hrow.appendChild(th);
    });
    const thTotal = document.createElement('th');
    thTotal.textContent = 'Total';
    thTotal.style.borderLeft = '2px solid rgba(200,169,81,0.4)';
    hrow.appendChild(thTotal);
    thead.appendChild(hrow);
    table.appendChild(thead);

    // Body rows: one per player
    const tbody = document.createElement('tbody');
    allPis.forEach(pi => {
      const p   = gameState.players[pi];
      if (!p) return;
      const tr  = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = p.name + (p.eliminated ? ' 💀' : '');
      tr.appendChild(tdName);

      history.forEach(h => {
        const td  = document.createElement('td');
        const pts = h.points?.[pi];
        td.textContent = pts !== undefined ? (pts > 0 ? `+${pts}` : pts) : '—';
        if (pts > 0) td.style.color = '#e88';
        if (pts < 0) td.style.color = '#7ee';
        // Highlight the current round column
        if (h.round === history[history.length - 1]?.round) td.classList.add('current-round');
        tr.appendChild(td);
      });

      const tdTotal = document.createElement('td');
      tdTotal.className = 'total-col';
      const finalScore = result.scores_after?.[pi] ?? p.score;
      // If this player hit the exact limit, show "limit → halved" notation
      if ((result.exact_limit_players || []).includes(pi)) {
        tdTotal.innerHTML = `<span style="color:#e8c96a">${result.score_limit} → ${finalScore}</span>`;
      } else {
        tdTotal.textContent = finalScore;
      }
      tr.appendChild(tdTotal);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    overlayScores.appendChild(tableWrap);
  }

  // ── Eliminated notice ───────────────────────────────────────────────────────
  overlayElim.innerHTML = '';
  (result.newly_eliminated || []).forEach(pi => {
    const el = document.createElement('p');
    el.className = 'elim-notice';
    el.textContent = `💀 ${gameState?.players[pi]?.name} is eliminated`;
    overlayElim.appendChild(el);
  });

  // ── Game over / Continue ────────────────────────────────────────────────────
  if (result.phase === 'game_over') {
    overlayGameOver.classList.remove('hidden');
    btnNextRound.classList.add('hidden');
    const w = result.winner !== null ? (gameState?.players[result.winner]?.name || '?') : 'Nobody';
    overlayWinner.textContent = `${w} wins the whole game! 🎉`;
  } else {
    overlayGameOver.classList.add('hidden');
    btnNextRound.classList.remove('hidden');
    btnNextRound.disabled = false;
    btnNextRound.textContent = `Continue → Round ${(gameState?.round_number || 0) + 1}`;

    // Ready-status row
    let readyRow = document.getElementById('ready-status-row');
    if (!readyRow) {
      readyRow = document.createElement('p');
      readyRow.id = 'ready-status-row';
      readyRow.className = 'ready-status-row';
      btnNextRound.before(readyRow);
    }
    readyRow.textContent = '';
  }
}
