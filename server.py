# =============================================================================
# server.py — Flask-SocketIO server for Yussuf
# HOW TO RUN:
#   pip install flask flask-socketio eventlet
#   python server.py
#   Open http://localhost:5000 in up to 4 browser tabs.
# =============================================================================

import os
import time
import threading
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room

from engine import GameEngine

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'yussuf-secret-2024')
# async_mode='threading' for local dev; production uses gevent or eventlet via gunicorn worker.
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# ── Game state ────────────────────────────────────────────────────────────────
engine            = GameEngine()
players_by_socket = {}   # socket_id -> player_index
sockets_by_player = {}   # player_index -> socket_id
GAME_ROOM         = 'yussuf_main'
HOST_PLAYER_INDEX = 0

# ── Ready-for-next-round tracking ─────────────────────────────────────────────
players_ready_for_next = set()

# ── Pause state ───────────────────────────────────────────────────────────────
game_paused          = False
players_ready_unpause = set()   # players who pressed Continue in pause menu
players_want_exit    = set()    # players who pressed Exit

# ── Inactivity timeout (5 minutes) ───────────────────────────────────────────
INACTIVITY_SECONDS = 300   # 5 minutes
last_activity_time = time.time()
inactivity_timer   = None

# ── Matching-discard window ───────────────────────────────────────────────────
discard_time  = 0.0
discard_owner = None
window_timer  = None
WINDOW_SECONDS = 2.0    # Player who placed the card is blocked from targeting opponents for 2s

# =============================================================================
# HELPERS
# =============================================================================

def broadcast_state():
    for socket_id, pi in list(sockets_by_player.items()):
        snap = engine.get_state_snapshot(for_player_index=pi)
        socketio.emit('state_update', snap, room=socket_id)
    lobby_info = {
        'phase':        engine.phase,
        'players':      [{'name': p.name, 'index': i, 'score': p.score, 'eliminated': p.eliminated}
                         for i, p in enumerate(engine.players)],
        'player_count': len(engine.players),
        'score_limit':  engine.score_limit,
    }
    socketio.emit('lobby_update', lobby_info, room=GAME_ROOM)


def reset_inactivity_timer():
    """Reset the 5-minute inactivity countdown on any player action."""
    global last_activity_time, inactivity_timer
    last_activity_time = time.time()
    if inactivity_timer and inactivity_timer.is_alive():
        inactivity_timer.cancel()
    if engine.phase in ('playing', 'final_turns'):
        inactivity_timer = threading.Timer(INACTIVITY_SECONDS, on_inactivity_timeout)
        inactivity_timer.daemon = True
        inactivity_timer.start()


def on_inactivity_timeout():
    """Called after 5 minutes of inactivity — pause the game."""
    global game_paused
    if engine.phase not in ('playing', 'final_turns'):
        return
    game_paused = True
    socketio.emit('game_paused', {
        'reason': 'inactivity',
        'message': 'Game paused due to 5 minutes of inactivity.',
    }, room=GAME_ROOM)


def start_window_timer(owner_index):
    global discard_time, discard_owner, window_timer
    if window_timer and window_timer.is_alive():
        window_timer.cancel()
    discard_time  = time.time()
    discard_owner = owner_index

    def window_expired():
        engine.advance_turn_after_window()
        broadcast_state()
        if engine.phase in ('round_end', 'game_over'):
            socketio.emit('round_ended', engine.last_round_result, room=GAME_ROOM)
        else:
            socketio.emit('window_closed', {}, room=GAME_ROOM)

    window_timer = threading.Timer(WINDOW_SECONDS, window_expired)
    window_timer.daemon = True
    window_timer.start()


def cancel_window_timer():
    global window_timer
    if window_timer and window_timer.is_alive():
        window_timer.cancel()
        window_timer = None


def is_window_active():
    return (time.time() - discard_time) < WINDOW_SECONDS


def get_pi(sid):
    return players_by_socket.get(sid)


def emit_error(msg):
    emit('error', {'message': msg})


# =============================================================================
# HTTP
# =============================================================================

@app.route('/')
def index():
    return render_template('index.html')


# =============================================================================
# CONNECTION
# =============================================================================

@socketio.on('connect')
def on_connect():
    join_room(GAME_ROOM)
    emit('lobby_update', {
        'phase':        engine.phase,
        'player_count': len(engine.players),
        'players':      [{'name': p.name, 'score': p.score, 'eliminated': p.eliminated}
                         for p in engine.players],
        'score_limit':  engine.score_limit,
    })


@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    pi  = players_by_socket.pop(sid, None)
    if pi is not None:
        sockets_by_player.pop(pi, None)
        socketio.emit('player_disconnected', {'player_index': pi}, room=GAME_ROOM)


# =============================================================================
# LOBBY
# =============================================================================

@socketio.on('join_game')
def on_join_game(data):
    sid  = request.sid
    name = (data.get('name') or '').strip()
    if not name:                 return emit_error('Please enter a name')
    if sid in players_by_socket: return emit_error('You are already seated')

    # Reject duplicate names (case-insensitive)
    existing = [p.name.lower() for p in engine.players]
    if name.lower() in existing:
        return emit_error(f'The name "{name}" is already taken — please choose a different name')
    result = engine.add_player(name)
    if not result['ok']:         return emit_error(result['error'])
    pi = result['player_index']
    players_by_socket[sid] = pi
    sockets_by_player[pi]  = sid
    is_host = (pi == HOST_PLAYER_INDEX)
    emit('joined', {'player_index': pi, 'name': name, 'is_host': is_host, 'score_limit': engine.score_limit})
    broadcast_state()


@socketio.on('set_score_limit')
def on_set_score_limit(data):
    pi = get_pi(request.sid)
    if pi != HOST_PLAYER_INDEX:  return emit_error('Only the host can change the score limit')
    if engine.phase != 'waiting': return emit_error('Cannot change score limit after game starts')
    try:
        limit = int(data.get('score_limit', 50))
    except (TypeError, ValueError):
        return emit_error('Invalid score limit')
    result = engine.set_score_limit(limit)
    if not result['ok']: return emit_error(result['error'])
    socketio.emit('score_limit_updated', {'score_limit': limit}, room=GAME_ROOM)


@socketio.on('start_game')
def on_start_game(data=None):
    pi = get_pi(request.sid)
    if pi is None:                 return emit_error('You must join the game first')
    if len(engine.players) < 2:    return emit_error('Need at least 2 players to start')
    result = engine.start_round()
    if not result['ok']:           return emit_error(result['error'])
    reset_inactivity_timer()
    socketio.emit('round_started', {
        'round_number': result['round_number'],
        'score_limit':  engine.score_limit,
    }, room=GAME_ROOM)
    broadcast_state()


# =============================================================================
# PEEK
# =============================================================================

@socketio.on('send_peek_cards')
def on_send_peek_cards():
    pi = get_pi(request.sid)
    if pi is None or engine.phase != 'peek': return
    player = engine.players[pi]
    cards  = {'2': engine._card_info(player.board[2]), '3': engine._card_info(player.board[3])}
    emit('peek_result', {'ok': True, 'cards': cards, 'all_peeked': False})


@socketio.on('peek_done')
def on_peek_done():
    pi = get_pi(request.sid)
    if pi is None: return emit_error('You are not in this game')
    result = engine.do_initial_peek(pi)
    if not result['ok']: return emit_error(result['error'])
    emit('peek_result', result)
    broadcast_state()


# =============================================================================
# TURN ACTIONS
# =============================================================================

@socketio.on('draw_deck')
def on_draw_deck():
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    if game_paused:                        return emit_error('Game is paused')
    reset_inactivity_timer()
    result = engine.action_draw_deck()
    if not result['ok']:                   return emit_error(result['error'])
    if result.get('round_ended'):
        cancel_window_timer()
        socketio.emit('round_ended', result['result'], room=GAME_ROOM)
        broadcast_state()
        return
    socketio.emit('player_drew_deck', {'player_index': pi, 'player_name': engine.players[pi].name}, room=GAME_ROOM)
    emit('draw_result', result)
    broadcast_state()


@socketio.on('draw_discard')
def on_draw_discard():
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    if game_paused:                        return emit_error('Game is paused')
    reset_inactivity_timer()
    result = engine.action_draw_discard()
    if not result['ok']:                   return emit_error(result['error'])
    socketio.emit('draw_discard_result', result, room=GAME_ROOM)
    broadcast_state()


@socketio.on('replace_card')
def on_replace_card(data):
    pi   = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    if game_paused:                        return emit_error('Game is paused')
    reset_inactivity_timer()
    slot = data.get('slot')
    if slot is None: return emit_error('No slot provided')
    result = engine.action_replace_card(int(slot))
    if not result['ok']: return emit_error(result['error'])
    result['acting_player'] = pi
    result['slot']          = int(slot)
    socketio.emit('card_replaced', result, room=GAME_ROOM)
    broadcast_state()
    start_window_timer(owner_index=pi)


@socketio.on('discard_held')
def on_discard_held():
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    if game_paused:                        return emit_error('Game is paused')
    reset_inactivity_timer()
    result = engine.action_discard_held()
    if not result['ok']: return emit_error(result['error'])
    socketio.emit('card_discarded', result, room=GAME_ROOM)
    broadcast_state()
    if result.get('special_effect'):
        emit('special_effect_prompt', {'effect': result['special_effect'], 'discard_top': result['discard_top']})
    else:
        start_window_timer(owner_index=pi)


@socketio.on('call_yussuf')
def on_call_yussuf():
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    if game_paused:                        return emit_error('Game is paused')
    reset_inactivity_timer()
    result = engine.action_call_yussuf()
    if not result['ok']:
        socketio.emit('yussuf_failed', {
            'player_index': pi, 'player_name': engine.players[pi].name,
            'punishment': result.get('punishment'),
        }, room=GAME_ROOM)
        broadcast_state()
        return
    socketio.emit('yussuf_called', result, room=GAME_ROOM)
    broadcast_state()


@socketio.on('cancel_effect')
def on_cancel_effect():
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    engine.pending_effect = None
    engine.advance_turn_after_window()
    socketio.emit('effect_cancelled', {'player_index': pi}, room=GAME_ROOM)
    broadcast_state()
    if engine.phase in ('round_end', 'game_over'):
        socketio.emit('round_ended', engine.last_round_result, room=GAME_ROOM)


# =============================================================================
# SPECIAL EFFECTS
# =============================================================================

@socketio.on('effect_look_own')
def on_effect_look_own(data):
    pi   = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    slot   = int(data.get('slot', -1))
    result = engine.effect_look_own(pi, slot)
    if not result['ok']: return emit_error(result['error'])
    emit('look_result', result)
    socketio.emit('card_peeked', {'looker': pi, 'target_player': pi, 'slot': slot}, room=GAME_ROOM)
    start_window_timer(owner_index=pi)
    broadcast_state()


@socketio.on('effect_look_opponent')
def on_effect_look_opponent(data):
    pi     = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    target = int(data.get('target_player', -1))
    slot   = int(data.get('slot', -1))
    result = engine.effect_look_opponent(pi, target, slot)
    if not result['ok']: return emit_error(result['error'])
    emit('look_result', result)
    socketio.emit('card_peeked', {'looker': pi, 'target_player': target, 'slot': slot}, room=GAME_ROOM)
    start_window_timer(owner_index=pi)
    broadcast_state()


@socketio.on('effect_jack_swap')
def on_effect_jack_swap(data):
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    p1, s1 = int(data['p1']), int(data['s1'])
    p2, s2 = int(data['p2']), int(data['s2'])
    result = engine.effect_jack_swap(p1, s1, p2, s2)
    if not result['ok']: return emit_error(result['error'])
    socketio.emit('swap_result', result, room=GAME_ROOM)
    start_window_timer(owner_index=pi)
    broadcast_state()


@socketio.on('effect_queen_look')
def on_effect_queen_look(data):
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    p1, s1 = int(data['p1']), int(data['s1'])
    p2, s2 = int(data['p2']), int(data['s2'])
    result = engine.effect_queen_look(p1, s1, p2, s2)
    if not result['ok']: return emit_error(result['error'])
    emit('queen_look_result', result)
    socketio.emit('card_peeked', {'looker': pi, 'target_player': p1, 'slot': s1}, room=GAME_ROOM)
    socketio.emit('card_peeked', {'looker': pi, 'target_player': p2, 'slot': s2}, room=GAME_ROOM)


@socketio.on('effect_queen_look_step1')
def on_effect_queen_look_step1(data):
    """
    Queen step-by-step: player clicked the FIRST card they want to look at.
    We send back only that card privately. The engine look is deferred until step2.
    """
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    p1, s1 = int(data['p1']), int(data['s1'])
    # Peek at card 1 privately without committing the full queen look yet
    if p1 >= len(engine.players): return emit_error('Invalid player')
    player = engine.players[p1]
    if s1 not in player.get_active_positions(): return emit_error('Invalid slot')
    card1 = engine._card_info(player.board[s1])
    # Store partial state on engine so step2 knows card1
    engine._queen_step1 = {'p1': p1, 's1': s1, 'card1': card1}
    emit('queen_look_step1_result', {
        'card1': card1,
        'pos1':  {'player': p1, 'slot': s1},
    })
    socketio.emit('card_peeked', {'looker': pi, 'target_player': p1, 'slot': s1}, room=GAME_ROOM)
    broadcast_state()   # flush so opponents' card_peeked animation fires immediately


@socketio.on('effect_queen_look_step2')
def on_effect_queen_look_step2(data):
    """
    Queen step-by-step: player clicked the SECOND card. Complete the queen look.
    """
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    step1 = getattr(engine, '_queen_step1', None)
    if not step1: return emit_error('Queen step 1 not completed')
    p1, s1 = step1['p1'], step1['s1']
    p2, s2 = int(data['p2']), int(data['s2'])
    # Now do the full engine queen_look
    result = engine.effect_queen_look(p1, s1, p2, s2)
    if not result['ok']: return emit_error(result['error'])
    engine._queen_step1 = None
    # Send full result (both cards) to the acting player
    emit('queen_look_result', result)
    socketio.emit('card_peeked', {'looker': pi, 'target_player': p2, 'slot': s2}, room=GAME_ROOM)
    broadcast_state()   # flush so opponents' card_peeked animation fires immediately


@socketio.on('effect_queen_swap')
def on_effect_queen_swap(data):
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if pi != engine.current_player_index:  return emit_error('It is not your turn')
    p1, s1 = int(data['p1']), int(data['s1'])
    p2, s2 = int(data['p2']), int(data['s2'])
    result = engine.effect_queen_swap(p1, s1, p2, s2)
    if not result['ok']: return emit_error(result['error'])
    socketio.emit('swap_result', result, room=GAME_ROOM)
    start_window_timer(owner_index=pi)
    broadcast_state()


# =============================================================================
# MATCHING-DISCARD
# =============================================================================

@socketio.on('matching_discard')
def on_matching_discard(data):
    pi = get_pi(request.sid)
    if pi is None: return emit_error('You are not in this game')
    if game_paused: return emit_error('Game is paused')
    reset_inactivity_timer()
    target_player = int(data.get('target_player', pi))
    slot          = int(data.get('slot', -1))
    is_own        = (pi == target_player)

    # The player who placed the card (discard_owner) cannot target opponents
    # for 2 seconds after placing. Everyone else has no restriction.
    if not is_own and is_window_active() and pi == discard_owner:
        return emit_error('This action is not allowed yet')
    result = engine.action_matching_discard(pi, target_player, slot)
    if not result['ok']:
        return emit_error(result['error'])
    socketio.emit('matching_discard_result', result, room=GAME_ROOM)
    broadcast_state()
    if result.get('round_ended'):
        cancel_window_timer()
        socketio.emit('round_ended', result['result'], room=GAME_ROOM)


# =============================================================================
# ROUND MANAGEMENT
# =============================================================================

@socketio.on('player_ready_next')
def on_player_ready_next():
    global players_ready_for_next
    pi = get_pi(request.sid)
    if pi is None:                         return emit_error('You are not in this game')
    if engine.phase not in ('round_end',): return emit_error('Round has not ended yet')
    players_ready_for_next.add(pi)
    active  = engine.get_active_indices()
    needed  = len(active)
    ready   = len(players_ready_for_next & set(active))
    socketio.emit('ready_status', {
        'ready':  ready,
        'needed': needed,
        'names':  [engine.players[i].name for i in players_ready_for_next if i < len(engine.players)],
    }, room=GAME_ROOM)
    if ready >= needed:
        players_ready_for_next = set()
        result = engine.start_round()
        if not result['ok']: return emit_error(result['error'])
        reset_inactivity_timer()
        socketio.emit('round_started', {
            'round_number': result['round_number'],
            'score_limit':  engine.score_limit,
        }, room=GAME_ROOM)
        broadcast_state()


@socketio.on('next_round')
def on_next_round():
    on_player_ready_next()


@socketio.on('clear_temp_reveal')
def on_clear_temp_reveal(data):
    pi   = data.get('player')
    slot = data.get('slot')
    if pi is None or slot is None or pi >= len(engine.players): return
    p = engine.players[pi]
    p.public_positions.discard(slot)
    if hasattr(p, 'temp_public_slots'):
        p.temp_public_slots.discard(slot)
    broadcast_state()


# =============================================================================
# PAUSE SYSTEM
# =============================================================================

@socketio.on('pause_game')
def on_pause_game():
    global game_paused, players_ready_unpause, players_want_exit
    pi = get_pi(request.sid)
    if pi is None: return emit_error('You are not in this game')
    if engine.phase not in ('playing', 'final_turns', 'peek'):
        return emit_error('Cannot pause now')
    game_paused           = True
    players_ready_unpause = set()
    players_want_exit     = set()
    socketio.emit('game_paused', {
        'reason': 'manual',
        'paused_by': engine.players[pi].name,
    }, room=GAME_ROOM)


@socketio.on('unpause_ready')
def on_unpause_ready():
    """Player pressed Continue in the pause menu."""
    global game_paused, players_ready_unpause
    pi = get_pi(request.sid)
    if pi is None: return
    players_ready_unpause.add(pi)
    active = [i for i in range(len(engine.players)) if not engine.players[i].eliminated]
    needed = len(active)
    ready  = len(players_ready_unpause & set(active))
    socketio.emit('unpause_status', {'ready': ready, 'needed': needed}, room=GAME_ROOM)
    if ready >= needed:
        game_paused           = False
        players_ready_unpause = set()
        players_want_exit     = set()
        reset_inactivity_timer()
        socketio.emit('game_resumed', {}, room=GAME_ROOM)


@socketio.on('game_over_exit')
def on_game_over_exit():
    """Player pressed Exit on the game-over screen. No vote needed — game is finished."""
    global engine, players_by_socket, sockets_by_player
    global players_ready_for_next, players_ready_unpause, players_want_exit
    global game_paused, inactivity_timer
    if engine.phase != 'game_over':
        return  # only valid after game is over
    # Cancel all timers
    cancel_window_timer()
    if inactivity_timer and inactivity_timer.is_alive():
        inactivity_timer.cancel()
    # Full game reset
    engine                 = GameEngine()
    players_by_socket      = {}
    sockets_by_player      = {}
    players_ready_for_next = set()
    players_ready_unpause  = set()
    players_want_exit      = set()
    game_paused            = False
    socketio.emit('game_exit', {}, room=GAME_ROOM)


@socketio.on('exit_vote')
def on_exit_vote():
    """Player pressed Exit in the pause menu."""
    global players_want_exit, game_paused, engine
    global players_by_socket, sockets_by_player
    global players_ready_for_next, players_ready_unpause, inactivity_timer
    pi = get_pi(request.sid)
    if pi is None: return
    players_want_exit.add(pi)
    active = [i for i in range(len(engine.players)) if not engine.players[i].eliminated]
    needed = len(active)
    voted  = len(players_want_exit & set(active))
    socketio.emit('exit_status', {'voted': voted, 'needed': needed}, room=GAME_ROOM)
    if voted >= needed:
        # Cancel all timers
        cancel_window_timer()
        if inactivity_timer and inactivity_timer.is_alive():
            inactivity_timer.cancel()
        # Full game reset — new engine, cleared player maps
        engine                 = GameEngine()
        players_by_socket      = {}
        sockets_by_player      = {}
        players_ready_for_next = set()
        players_ready_unpause  = set()
        players_want_exit      = set()
        game_paused            = False
        socketio.emit('game_exit', {}, room=GAME_ROOM)


@socketio.on('chat_message')
def on_chat_message(data):
    pi  = get_pi(request.sid)
    if pi is None: return
    msg  = (data.get('msg') or '').strip()
    if not msg or len(msg) > 200: return
    name = engine.players[pi].name if pi < len(engine.players) else '?'
    socketio.emit('chat_message', {'name': name, 'msg': msg, 'player_index': pi}, room=GAME_ROOM)


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == '__main__':
    # Port: use $PORT if set (production cloud platforms), else default to 5000 (local dev)
    # Debug: only enable when explicitly running locally (FLASK_ENV=development) or when no env vars set
    port    = int(os.environ.get('PORT', 5000))
    is_prod = bool(os.environ.get('PORT'))   # cloud platforms set PORT
    debug   = not is_prod
    print('=' * 60)
    print(f'  Yussuf Game Server  (port {port}, debug={debug})')
    if not is_prod:
        print(f'  Open http://localhost:{port} in up to 4 browser tabs')
    print('=' * 60)
    socketio.run(app, host='0.0.0.0', port=port, debug=debug, allow_unsafe_werkzeug=True)
