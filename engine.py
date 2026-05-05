# =============================================================================
# engine.py
# Core game logic for Yussuf — zero networking code in this file.
# The engine only manages game state and validates actions.
# It returns plain Python dicts that any interface (server, terminal) can use.
# =============================================================================

from deck import Deck
from player import Player


class GameEngine:
    """
    Controls one full Yussuf game (many rounds until 1 player remains).

    Phases:
        'waiting'      — game created, players are joining
        'peek'         — round started, players doing their initial peek
        'playing'      — main turn loop
        'final_turns'  — Yussuf was called, remaining players take their last turn
        'round_end'    — round finished, scores updated, waiting for next round
        'game_over'    — only 1 player remains, game is finished
    """

    def __init__(self):
        self.players        = []        # list of Player objects, in seat order
        self.phase          = 'waiting'
        self.deck           = None
        self.discard_pile   = []        # top card is the LAST element

        self.current_player_index = 0
        self.dealer_index         = 0
        self.round_number         = 0

        # Configurable score limit — set via set_score_limit() before first round
        # Players are eliminated at score_limit+, exact score_limit -> halved
        self.score_limit = 50

        # Card held by the active player after drawing (before placing / discarding)
        self.held_card        = None
        self.held_card_source = None    # 'deck' or 'discard'

        # Pending 2-step special effect (Queen: look first, then swap)
        self.pending_effect = None

        # Yussuf tracking
        self.yussuf_caller_index   = None
        self.final_turns_remaining = 0

        # S9 exception: player who just received back a wrongly-discarded opponent card
        # cannot immediately matching-discard that returned card.
        # Format: { player_index: set_of_blocked_slot_indices }
        # Cleared when the matching-discard window closes.
        self.matching_discard_blocked = {}

        # Set after each round ends; server reads this to display results
        self.last_round_result = {}

        # Tracks which active players have completed their initial peek this round
        self.peeked_players = set()

        # Full revealed boards at round end (all cards unmasked, sent to all clients)
        self.revealed_boards = {}

        # Per-round score history: list of {player_index: points_this_round}
        # appended after each round resolves — used for the leaderboard table
        self.round_history = []

    # =========================================================================
    # PLAYER MANAGEMENT
    # =========================================================================

    def set_score_limit(self, limit):
        """Set the score limit before the game starts. Players eliminated at limit+."""
        if self.phase != 'waiting':
            return {'ok': False, 'error': 'Cannot change score limit after game starts'}
        if not isinstance(limit, int) or limit < 10 or limit > 200:
            return {'ok': False, 'error': 'Score limit must be between 10 and 200'}
        self.score_limit = limit
        return {'ok': True, 'score_limit': limit}

    def add_player(self, name):
        """
        Add a player before the game starts. Returns their seat index.

        MULTIPLAYER NOTE:
        Call this in the 'join_game' socket event handler in server.py.
        Store the mapping  socket_id -> player_index  on the server side.
        """
        if self.phase != 'waiting':
            return {'ok': False, 'error': 'Game already in progress'}
        if len(self.players) >= 4:
            return {'ok': False, 'error': 'Game is full (max 4 players)'}
        index = len(self.players)
        self.players.append(Player(name))
        return {'ok': True, 'player_index': index, 'name': name}

    def get_active_players(self):
        """Returns list of (index, player) for all non-eliminated players."""
        return [(i, p) for i, p in enumerate(self.players) if not p.eliminated]

    def get_active_indices(self):
        """Returns just the indices of non-eliminated players."""
        return [i for i, p in enumerate(self.players) if not p.eliminated]

    def get_current_player(self):
        return self.players[self.current_player_index]

    def get_top_discard(self):
        """Returns the top card of the discard pile, or None if empty."""
        return self.discard_pile[-1] if self.discard_pile else None

    # =========================================================================
    # ROUND SETUP  (section 4)
    # =========================================================================

    def start_round(self):
        """
        Sets up a new round:
          - Resets active players boards
          - Creates and shuffles a fresh 54-card deck
          - Deals 4 cards to each active player (one at a time in seat order)
          - Flips the first discard card
          - Moves to 'peek' phase
        """
        if len(self.players) < 2:
            return {'ok': False, 'error': 'Need at least 2 players to start'}
        if self.phase not in ('waiting', 'round_end'):
            return {'ok': False, 'error': f'Cannot start a round in phase: {self.phase}'}

        self.round_number += 1

        # Reset all active players for the new round
        for p in self.players:
            if not p.eliminated:
                p.reset_for_new_round()

        # Fresh shuffled deck
        self.deck = Deck()
        self.deck.shuffle()
        self.discard_pile = []

        # Clear all round-level state
        self.held_card                = None
        self.held_card_source         = None
        self.pending_effect           = None
        self.yussuf_caller_index      = None
        self.final_turns_remaining    = 0
        self.matching_discard_blocked = {}
        self.last_round_result        = {}
        self.peeked_players           = set()

        # Deal 4 cards per active player, one card at a time in seat order (section 4)
        active = self.get_active_indices()
        for card_num in range(4):
            for pi in active:
                self.players[pi].place_card(card_num, self.deck.draw())

        # Flip the first discard card
        self.discard_pile.append(self.deck.draw())

        # First player to act is the one to the left of the dealer
        self.current_player_index = self._next_active_from(self.dealer_index)

        self.phase = 'peek'
        return {'ok': True, 'round_number': self.round_number}

    def do_initial_peek(self, player_index):
        """
        A player peeks at their bottom-left (slot 2) and bottom-right (slot 3) cards.
        Returns those two cards — must be sent ONLY to that player's socket.
        Moves phase to 'playing' once all active players have peeked.

        MULTIPLAYER NOTE:
        Emit the returned 'cards' dict ONLY to the requesting player's socket.
        NEVER broadcast to the room. Each player's peek is completely private.
        """
        if self.phase != 'peek':
            return {'ok': False, 'error': 'Not in the peek phase'}
        if player_index in self.peeked_players:
            return {'ok': False, 'error': 'You already peeked this round'}
        if player_index not in self.get_active_indices():
            return {'ok': False, 'error': 'Player is not active this round'}

        player = self.players[player_index]
        peeked_cards = {
            '2': self._card_info(player.board[2]),
            '3': self._card_info(player.board[3]),
        }
        player.known_positions.update([2, 3])
        self.peeked_players.add(player_index)

        # Transition to playing when everyone has peeked
        all_peeked = set(self.get_active_indices()).issubset(self.peeked_players)
        if all_peeked:
            self.phase = 'playing'

        return {
            'ok': True,
            'cards': peeked_cards,     # PRIVATE: emit only to player_index socket
            'all_peeked': all_peeked,
            'phase': self.phase,
        }

    # =========================================================================
    # TURN ACTIONS: Drawing  (section 6)
    # =========================================================================

    def action_draw_deck(self):
        """
        Active player draws the top card from the face-down deck.
        If the deck is empty, the round ends immediately (section 14).
        After drawing, the player must call action_replace_card or action_discard_held.
        """
        if not self._in_turn_phase():
            return {'ok': False, 'error': 'Wrong phase for this action'}
        if self.held_card is not None:
            return {'ok': False, 'error': 'You already have a card in hand'}

        if self.deck.is_empty():
            return self.trigger_round_end_deck_empty()

        self.held_card        = self.deck.draw()
        self.held_card_source = 'deck'

        return {
            'ok': True,
            'held_card': self._card_info(self.held_card),
            # Current player sees this. Other players see 'card in hand' (hidden).
        }

    def action_draw_discard(self):
        """
        Active player draws the top card from the face-up discard pile (section 6).
        Everyone sees what card was drawn (it was face-up).

        Q6 note (confirmed intentional): the player may immediately discard it back.
        Special effects do NOT apply to cards drawn from the discard pile (section 7).
        """
        if not self._in_turn_phase():
            return {'ok': False, 'error': 'Wrong phase for this action'}
        if self.held_card is not None:
            return {'ok': False, 'error': 'You already have a card in hand'}
        if not self.discard_pile:
            return {'ok': False, 'error': 'The discard pile is empty'}

        self.held_card        = self.discard_pile.pop()
        self.held_card_source = 'discard'

        return {
            'ok': True,
            'held_card': self._card_info(self.held_card),
        }

    def action_replace_card(self, slot):
        """
        Active player places their held card at 'slot' on their own board.
        The old card at that slot goes face-up onto the discard pile.

        Returns 'matching_discard_window: True'.
        The server MUST start a 1.5-second timer after this action.

        MULTIPLAYER NOTE: MATCHING-DISCARD WINDOW
        After this action returns ok=True:
          1. Record  discard_time = time.time()  and  discard_owner = current_player_index
          2. For the next 1.5 seconds: only the owner may call action_matching_discard
             (check this in the socket event handler before calling the engine)
          3. After 1.5 seconds: any player may call action_matching_discard
          4. When window fully closes: call advance_turn_after_window()
        """
        if not self._in_turn_phase():
            return {'ok': False, 'error': 'Wrong phase for this action'}
        if self.held_card is None:
            return {'ok': False, 'error': 'You have no card in hand'}

        pi     = self.current_player_index
        player = self.players[pi]

        if slot >= len(player.board) or player.board[slot] is None:
            return {'ok': False, 'error': f'Slot {slot} is empty or invalid'}

        old_card = player.board[slot]
        player.place_card(slot, self.held_card)
        player.known_positions.add(slot)       # player knows what they just placed
        player.public_positions.discard(slot)  # not public knowledge, only theirs

        self.discard_pile.append(old_card)
        placed                = self.held_card
        self.held_card        = None
        self.held_card_source = None

        # Clear the section 9 block (new card on discard resets blocking)
        self.matching_discard_blocked = {}

        return {
            'ok': True,
            'placed_card':    self._card_info(placed),
            'discarded_card': self._card_info(old_card),
            'discard_top':    self._card_info(self.get_top_discard()),
            'matching_discard_window': True,  # server: start 1.5s timer now
        }

    def action_discard_held(self):
        """
        Active player discards their held card directly onto the discard pile.
        If drawn from the deck, a special effect may fire (section 7).

        Returns 'matching_discard_window: True'. Same timing rules apply as above.
        If 'special_effect' is not None, resolve it BEFORE starting the timer.

        MULTIPLAYER NOTE: Same 1.5-second matching-discard window as action_replace_card.
        """
        if not self._in_turn_phase():
            return {'ok': False, 'error': 'Wrong phase for this action'}
        if self.held_card is None:
            return {'ok': False, 'error': 'You have no card in hand'}

        card   = self.held_card
        source = self.held_card_source
        self.discard_pile.append(card)
        self.held_card        = None
        self.held_card_source = None

        # Special effects only fire when drawn from the deck (section 7)
        special_effect = self._get_special_effect(card.rank) if source == 'deck' else None

        # Clear section 9 block
        self.matching_discard_blocked = {}

        return {
            'ok': True,
            'discarded_card': self._card_info(card),
            'discard_top':    self._card_info(self.get_top_discard()),
            'special_effect': special_effect,
            # special_effect: None / 'look_own' / 'look_opponent' / 'jack' / 'queen'
            'matching_discard_window': True,  # server: start 1.5s timer now
        }

    def advance_turn_after_window(self):
        """
        Called by the server once the matching-discard window has closed
        (1.5s elapsed or no one acted). Advances to the next player's turn.

        MULTIPLAYER NOTE:
        Fire this from the server-side timer callback, not from within
        action_replace_card or action_discard_held.
        """
        self._advance_turn()
        return {
            'ok': True,
            'current_player_index': self.current_player_index,
            'phase': self.phase,
        }

    # =========================================================================
    # CALLING YUSSUF  (section 12)
    # =========================================================================

    def action_call_yussuf(self):
        """
        Active player calls Yussuf instead of drawing (section 12).
        Only allowed if their TRUE total is 5 or lower.

        Q1 answer (A): if total is actually > 5, silently reject.
        No penalty, player must take a normal draw turn instead.
        """
        if not self._in_turn_phase():
            return {'ok': False, 'error': 'Wrong phase for this action'}
        if self.held_card is not None:
            return {'ok': False, 'error': 'Place your held card first'}

        pi     = self.current_player_index
        player = self.players[pi]
        total  = player.get_board_value()

        if total > 5:
            # Invalid Yussuf attempt: player receives a punishment card
            punishment = self._give_punishment(pi)
            return {
                'ok': False,
                'error': 'Yussuf not allowed — your total is above 5. Punishment card added!',
                'true_total': total,
                'punishment': punishment,
            }

        # Valid call
        self.yussuf_caller_index   = pi
        self.phase                 = 'final_turns'
        active                     = self.get_active_indices()
        self.final_turns_remaining = len(active) - 1   # every other active player gets 1 turn

        # Advance to the first player who gets a final turn (not the caller)
        self.current_player_index = self._next_active_from(pi)
        if self.final_turns_remaining == 0:
            # Edge case: only the caller is active (should not happen in normal play)
            self._resolve_round(trigger='yussuf_complete')

        return {
            'ok': True,
            'caller_index':          pi,
            'caller_name':           player.name,
            'final_turns_remaining': self.final_turns_remaining,
            'next_player_index':     self.current_player_index,
        }

    # =========================================================================
    # SPECIAL EFFECTS  (section 7)
    # =========================================================================

    def effect_look_own(self, acting_player_index, slot):
        """
        Cards 7 / 8: acting player privately looks at one of their OWN board cards.
        Returns card info. Send ONLY to acting player's socket.

        MULTIPLAYER NOTE:
        socketio.emit('look_result', result, room=socket_id_of_acting_player)
        Do NOT broadcast to the whole room.
        """
        player = self.players[acting_player_index]
        if slot not in player.get_active_positions():
            return {'ok': False, 'error': 'Invalid slot'}
        card = player.board[slot]
        player.known_positions.add(slot)
        return {
            'ok': True,
            'slot': slot,
            'card': self._card_info(card),  # PRIVATE to acting_player_index only
        }

    def effect_look_opponent(self, acting_player_index, target_player_index, slot):
        """
        Cards 9 / 10: acting player privately looks at ONE card of an opponent.
        Returns card info. Send ONLY to acting player's socket.

        MULTIPLAYER NOTE:
        Other players (including the target) do NOT learn which card was seen.
        Emit only to the acting player's socket.
        """
        if acting_player_index == target_player_index:
            return {'ok': False, 'error': 'Must target an opponent, not yourself'}
        target = self.players[target_player_index]
        if target.eliminated:
            return {'ok': False, 'error': 'Target player is eliminated'}
        if slot not in target.get_active_positions():
            return {'ok': False, 'error': 'Invalid slot on target player'}
        card = target.board[slot]
        return {
            'ok': True,
            'target_player': target_player_index,
            'slot': slot,
            'card': self._card_info(card),  # PRIVATE to acting_player_index only
        }

    def effect_jack_swap(self, p1, s1, p2, s2):
        """
        Jack: swap any 2 board cards across any active players (section 7).
        Cannot target Yussuf caller's cards after Yussuf has been called (section 13).
        Broadcast the swap to all players (they see positions swap, not values).
        """
        err = self._validate_board_targets(p1, s1, p2, s2)
        if err:
            return {'ok': False, 'error': err}
        self._perform_swap(p1, s1, p2, s2)
        return {
            'ok': True,
            'swap': {'p1': p1, 's1': s1, 'p2': p2, 's2': s2},
        }

    def effect_queen_look(self, p1, s1, p2, s2):
        """
        Queen step 1 of 2: look at any 2 board cards.
        Returns both cards. Send ONLY to acting player's socket (private).
        Stores pending state so effect_queen_swap() can be called next.

        MULTIPLAYER NOTE: TWO-STEP INTERACTION
        After emitting the private card info to the acting player,
        wait for them to respond with a 'queen_swap' socket event.
        The engine stores self.pending_effect to validate the second step.
        """
        err = self._validate_board_targets(p1, s1, p2, s2)
        if err:
            return {'ok': False, 'error': err}

        card1 = self.players[p1].board[s1]
        card2 = self.players[p2].board[s2]

        self.pending_effect = {
            'type': 'queen_look',
            'p1': p1, 's1': s1,
            'p2': p2, 's2': s2,
        }

        return {
            'ok': True,
            'card1': self._card_info(card1),  # PRIVATE to acting player only
            'card2': self._card_info(card2),  # PRIVATE to acting player only
            'pos1':  {'player': p1, 'slot': s1},
            'pos2':  {'player': p2, 'slot': s2},
        }

    def effect_queen_swap(self, p1, s1, p2, s2):
        """
        Queen step 2 of 2: swap any 2 board cards.
        The swapped cards may be the same 2 that were just looked at, or different.
        Must be called after effect_queen_look().
        """
        if not self.pending_effect or self.pending_effect.get('type') != 'queen_look':
            return {'ok': False, 'error': 'No pending Queen look in progress'}
        err = self._validate_board_targets(p1, s1, p2, s2)
        if err:
            return {'ok': False, 'error': err}
        self._perform_swap(p1, s1, p2, s2)
        self.pending_effect = None
        return {
            'ok': True,
            'swap': {'p1': p1, 's1': s1, 'p2': p2, 's2': s2},
        }

    # =========================================================================
    # MATCHING-DISCARD  (sections 8, 9, 10)
    # =========================================================================

    def action_matching_discard(self, acting_player_index, target_player_index, slot):
        """
        A player attempts to matching-discard a card (their own OR an opponent's).

        Engine validates:
          - Same rank as top of discard pile
          - Different suit from top of discard pile
          - Section 9 exception (cannot re-discard a just-returned card)

        Server must validate timing (NOT done here):
          - Own card: allowed from the moment a card is placed on discard
          - Opponent card: only after the 1.5-second window expires

        MULTIPLAYER NOTE: TIMING ENFORCEMENT IN SERVER.PY
        When a card is placed on the discard pile, record:
            discard_time  = time.time()
            discard_owner = the player whose card was placed (for replace_card)

        In the 'matching_discard' socket event handler:
            is_own = (acting_player_index == target_player_index)
            if not is_own and (time.time() - discard_time) < 1.5:
                emit('error', 'Protection window active, wait 1.5 seconds')
                return
        """
        top = self.get_top_discard()
        if top is None:
            return {'ok': False, 'error': 'Discard pile is empty'}

        if target_player_index >= len(self.players):
            return {'ok': False, 'error': 'Invalid target player'}

        target = self.players[target_player_index]
        if target.eliminated:
            return {'ok': False, 'error': 'Target player is eliminated'}
        if slot not in target.get_active_positions():
            return {'ok': False, 'error': 'That slot is empty or invalid'}

        # Section 9 exception: blocked from re-discarding a just-returned card
        # This blocks ANY player from attempting to matching-discard a slot
        # that was just successfully matched (until a new card hits the discard pile).
        blocked = self.matching_discard_blocked.get(target_player_index, set())
        if slot in blocked:
            return {'ok': False, 'error': 'This action is not allowed'}

        attempted   = target.board[slot]
        is_own_card = (acting_player_index == target_player_index)

        # Same rank, DIFFERENT suit — Jokers are suitless so two Jokers always match
        if attempted.rank == 'Joker' and top.rank == 'Joker':
            correct = True
        else:
            correct = (attempted.rank == top.rank and attempted.suit != top.suit)

        # The attempted card is always shown to all players (section 8)
        target.public_positions.add(slot)

        if correct:
            return self._md_success(acting_player_index, target_player_index, slot, attempted, is_own_card)
        else:
            return self._md_failure(acting_player_index, target_player_index, slot, attempted, is_own_card)

    def _md_success(self, acting, target_idx, slot, card, is_own):
        target = self.players[target_idx]
        if is_own:
            # Section 8: correct own match, card is removed
            target.remove_card(slot)
            self.discard_pile.append(card)
            result = {
                'ok': True, 'correct': True, 'own': True,
                'card': self._card_info(card),
                'acting_player': acting, 'target_player': target_idx, 'slot': slot,
            }
        else:
            # Section 9: correct opponent match — card is shown then returned to opponent
            # The card never actually joins the discard pile (it goes board → shown → board)
            # so the discard pile's previous top remains the top.
            target.remove_card(slot)
            target.place_card(slot, card)  # card returned to opponent

            # Mark slot as temporarily public (client shows face-up for 3s then hides)
            target.public_positions.add(slot)
            target.temp_public_slots.add(slot)

            # Section 9 exception: opponent cannot immediately re-discard this card
            self.matching_discard_blocked.setdefault(target_idx, set()).add(slot)

            punishment = self._give_punishment(target_idx)
            result = {
                'ok': True, 'correct': True, 'own': False,
                'card': self._card_info(card),
                'acting_player': acting, 'target_player': target_idx, 'slot': slot,
                'punishment': punishment,
                'temp_reveal': {'player': target_idx, 'slot': slot},
            }

        # Section 11: if target has 0 cards, round ends immediately
        if target.has_no_cards():
            end = self._resolve_round(trigger='empty_board', trigger_player=target_idx)
            return {**result, **end}

        return result

    def _md_failure(self, acting, target_idx, slot, card, is_own):
        if is_own:
            # Section 8: wrong own match — card stays, player gets punishment
            acting_player = self.players[acting]
            acting_player.public_positions.add(slot)
            acting_player.temp_public_slots.add(slot)
            punishment = self._give_punishment(acting)
            return {
                'ok': True, 'correct': False, 'own': True,
                'card': self._card_info(card),
                'acting_player': acting, 'slot': slot,
                'punishment': punishment,
                'temp_reveal': {'player': acting, 'slot': slot},
            }
        else:
            # Section 9: wrong opponent match — acting player gets punishment,
            # opponent's card is shown temporarily
            target = self.players[target_idx]
            target.public_positions.add(slot)
            target.temp_public_slots.add(slot)
            punishment = self._give_punishment(acting)
            return {
                'ok': True, 'correct': False, 'own': False,
                'card': self._card_info(card),
                'acting_player': acting, 'target_player': target_idx, 'slot': slot,
                'punishment': punishment,
                'temp_reveal': {'player': target_idx, 'slot': slot},
            }

    # =========================================================================
    # ROUND END TRIGGERS  (sections 11, 14)
    # =========================================================================

    def trigger_round_end_deck_empty(self):
        """Called when a player tries to draw from an empty deck (section 14)."""
        return self._resolve_round(trigger='deck_empty')

    def _resolve_round(self, trigger, trigger_player=None):
        """
        Ends the current round and applies all scoring:
          1. Adds board values + pending penalties to each player's score
          2. Applies Yussuf bonus or penalty (section 15)
          3. Applies the exact-50 -> 25 rule (section 16)
          4. Checks for elimination (section 17)
          5. Rotates the dealer to the next active player
          6. Sets phase to 'round_end' (or 'game_over' if only 1 player remains)
        """
        self.phase = 'round_end'

        active        = self.get_active_indices()
        scores_before = {i: self.players[i].score for i in active}
        board_values  = {i: self.players[i].get_board_value() for i in active}
        penalties     = {i: self.players[i].pending_penalty for i in active}

        # Step 1: Add board values + pending penalties
        for i in active:
            self.players[i].score += board_values[i] + self.players[i].pending_penalty

        # Step 2: Yussuf bonus / penalty (section 15)
        yussuf_result = None
        if self.yussuf_caller_index is not None:
            caller     = self.yussuf_caller_index
            caller_val = board_values.get(caller, 0)
            others     = [i for i in active if i != caller]

            # Caller wins only if STRICTLY lower than ALL opponents (section 15)
            caller_wins = all(caller_val < board_values[i] for i in others)
            if caller_wins:
                self.players[caller].score -= 5
                yussuf_result = {'caller': caller, 'won': True, 'modifier': -5}
            else:
                self.players[caller].score += 10
                yussuf_result = {'caller': caller, 'won': False, 'modifier': +10}

        # Step 3: Exact-score_limit rule (score == limit → halved)
        exact_limit = []
        for i in active:
            if self.players[i].score == self.score_limit:
                self.players[i].score = self.score_limit // 2
                exact_limit.append(i)

        # Step 4: Elimination (score >= score_limit + 1)
        newly_eliminated = []
        for i in active:
            if self.players[i].score > self.score_limit:
                self.players[i].eliminated = True
                newly_eliminated.append(i)

        # Step 5: Check if game is over
        remaining = self.get_active_indices()
        winner    = None
        if len(remaining) <= 1:
            self.phase = 'game_over'
            winner = remaining[0] if remaining else None
        else:
            self.dealer_index = self._next_active_from(self.dealer_index)

        # Capture full revealed boards (all cards unmasked) for end-of-round display
        self.revealed_boards = {}
        for i in active:
            self.revealed_boards[i] = [
                self._card_info(card) for card in self.players[i].board
            ]

        # Record per-round points for leaderboard table
        # points_this_round = board_value + penalty + yussuf modifier
        points_this_round = {}
        for i in active:
            pts = board_values[i] + penalties[i]
            if yussuf_result and yussuf_result['caller'] == i:
                pts += yussuf_result['modifier']
            points_this_round[i] = pts
        self.round_history.append({
            'round': self.round_number,
            'points': points_this_round,
            'scores_after': {i: self.players[i].score for i in active},
        })

        self.last_round_result = {
            'trigger':           trigger,
            'trigger_player':    trigger_player,
            'board_values':      board_values,
            'pending_penalties': penalties,
            'scores_before':     scores_before,
            'scores_after':      {i: self.players[i].score for i in active},
            'yussuf_result':     yussuf_result,
            'exact_limit_players': exact_limit,
            'score_limit':       self.score_limit,
            'newly_eliminated':  newly_eliminated,
            'winner':            winner,
            'phase':             self.phase,
            'revealed_boards':   self.revealed_boards,
            'round_history':     self.round_history,
        }

        return {'ok': True, 'round_ended': True, 'result': self.last_round_result}

    # =========================================================================
    # TURN ADVANCEMENT
    # =========================================================================

    def _advance_turn(self):
        """
        Moves to the next active player's turn.
        In 'final_turns' phase: decrements counter and ends round when it hits 0.
        """
        if self.phase == 'final_turns':
            self.final_turns_remaining -= 1
            if self.final_turns_remaining <= 0:
                self._resolve_round(trigger='yussuf_complete')
                return

        next_pi = self._next_active_from(self.current_player_index)

        # In final_turns, skip the Yussuf caller (section 13)
        if self.phase == 'final_turns' and next_pi == self.yussuf_caller_index:
            next_pi = self._next_active_from(next_pi)

        self.current_player_index = next_pi

    def _next_active_from(self, index):
        """Returns the index of the next non-eliminated player after 'index'."""
        active = self.get_active_indices()
        if not active:
            return index
        for i in range(1, len(self.players) + 1):
            candidate = (index + i) % len(self.players)
            if candidate in active:
                return candidate
        return index

    # =========================================================================
    # INTERNAL HELPERS
    # =========================================================================

    def _in_turn_phase(self):
        return self.phase in ('playing', 'final_turns')

    def _get_special_effect(self, rank):
        """Maps a card rank to its special effect name (section 7)."""
        return {
            '7': 'look_own',  '8': 'look_own',
            '9': 'look_opponent', '10': 'look_opponent',
            'Jack': 'jack', 'Queen': 'queen',
        }.get(rank)

    def _give_punishment(self, player_index):
        """
        Give the player a punishment card from the deck.
        If the deck is empty, add +5 to their pending penalty instead (section 8, Q5).
        The player does NOT learn what punishment card they received.
        """
        player = self.players[player_index]
        if self.deck.is_empty():
            player.pending_penalty += 5
            return {'type': 'penalty_points', 'amount': 5, 'player_index': player_index}
        else:
            card = self.deck.draw()
            slot = player.add_card_to_first_empty_slot(card)
            return {'type': 'card', 'slot': slot, 'player_index': player_index}

    def _validate_board_targets(self, p1, s1, p2, s2):
        """Validates two board positions for Jack / Queen effects. Returns error or None."""
        active = self.get_active_indices()
        for pi, slot in [(p1, s1), (p2, s2)]:
            if pi not in active:
                return f'Player {pi} is not active in this round'
            if self.yussuf_caller_index is not None and pi == self.yussuf_caller_index:
                return "Cannot target the Yussuf caller's cards after Yussuf is called (section 13)"
            if slot not in self.players[pi].get_active_positions():
                return f'Slot {slot} is empty or invalid for player {pi}'
        return None

    def _perform_swap(self, p1, s1, p2, s2):
        """Swaps the cards at two board positions."""
        b1 = self.players[p1].board
        b2 = self.players[p2].board
        b1[s1], b2[s2] = b2[s2], b1[s1]

    def _card_info(self, card):
        """Converts a Card object to a JSON-serialisable dict."""
        if card is None:
            return None
        return {
            'rank':    card.rank,
            'suit':    card.suit,
            'value':   card.get_value(),
            'display': card.short_name(),
        }

    # =========================================================================
    # STATE SNAPSHOT  (server calls this to broadcast game state)
    # =========================================================================

    def get_state_snapshot(self, for_player_index=None):
        """
        Returns a full snapshot of the current game state.

        If for_player_index is provided, cards this player does not know are
        masked as {'hidden': True}. All other players get their own masked view.

        MULTIPLAYER NOTE:
        NEVER send the unmasked snapshot (for_player_index=None) to any client.
        Generate a personalised snapshot for each connected socket:

            for socket_id, pi in sockets_by_player.items():
                snap = engine.get_state_snapshot(for_player_index=pi)
                socketio.emit('state_update', snap, room=socket_id)
        """
        players_state = []
        for i, p in enumerate(self.players):
            board = []
            for slot_idx, card in enumerate(p.board):
                if card is None:
                    board.append(None)
                elif for_player_index is None:
                    board.append(self._card_info(card))  # unmasked (debug / server logs only)
                else:
                    is_own_known = (i == for_player_index and slot_idx in p.known_positions)
                    is_public    = (slot_idx in p.public_positions)
                    if is_own_known or is_public:
                        board.append(self._card_info(card))
                    else:
                        board.append({'hidden': True})

            players_state.append({
                'index':            i,
                'name':             p.name,
                'score':            p.score,
                'eliminated':       p.eliminated,
                'board':            board,
                'card_count':       p.get_card_count(),
                'temp_public_slots': list(getattr(p, 'temp_public_slots', set())),
            })

        return {
            'phase':                 self.phase,
            'round_number':          self.round_number,
            'current_player_index':  self.current_player_index,
            'yussuf_caller_index':   self.yussuf_caller_index,
            'final_turns_remaining': self.final_turns_remaining,
            'score_limit':           self.score_limit,
            'discard_top':           self._card_info(self.get_top_discard()),
            'deck_size':             self.deck.size() if self.deck else 0,
            'held_card': (
                self._card_info(self.held_card)
                if (for_player_index is None or for_player_index == self.current_player_index)
                else ({'hidden': True} if self.held_card else None)
            ),
            'players': players_state,
        }
