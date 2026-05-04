# =============================================================================
# player.py
# Represents one Yussuf player: their board, score, and knowledge tracking.
# =============================================================================


class Player:
    """
    One Yussuf player.

    Board layout (2x2 grid):
        Index 0 = top-left       Index 1 = top-right
        Index 2 = bottom-left    Index 3 = bottom-right

    A slot is None if the card was removed (e.g. via matching-discard).
    The board can grow beyond index 3 when punishment cards overflow.
    """

    def __init__(self, name):
        self.name  = name
        self.board = [None, None, None, None]
        self.score = 0
        self.eliminated = False

        # known_positions  : positions THIS player has privately seen
        # public_positions : positions everyone knows (shown publicly at some point)
        #
        # MULTIPLAYER NOTE:
        # known_positions drives what get_state_snapshot() reveals back to this player.
        # public_positions reveals that slot to ALL players' snapshots.
        self.known_positions  = set()
        self.public_positions = set()

        # +5 penalties deferred until round scoring (section 8, Q5 confirmed)
        self.pending_penalty = 0

        # Slots temporarily revealed to all (e.g. returned matching-discard card).
        # The client shows them face-up for 3 seconds then hides them automatically.
        # This set is cleared at the start of each round.
        self.temp_public_slots = set()

    # ── Board manipulation ─────────────────────────────────────────────────────

    def place_card(self, slot, card):
        """Put a card in a slot. Extends the board if the slot is beyond current length."""
        while len(self.board) <= slot:
            self.board.append(None)
        self.board[slot] = card

    def get_card(self, slot):
        """Return the card at a slot without removing it."""
        return self.board[slot] if slot < len(self.board) else None

    def remove_card(self, slot):
        """Remove and return the card at a slot (leaves the slot as None)."""
        if slot >= len(self.board):
            return None
        card = self.board[slot]
        self.board[slot] = None
        self.known_positions.discard(slot)
        self.public_positions.discard(slot)
        return card

    def add_card_to_first_empty_slot(self, card):
        """
        Add a punishment card as a new column to the RIGHT of the existing board.
        Always appends — never fills empty slots in the 2x2 grid.
        Returns the slot index used. Player does NOT know the card value.
        """
        self.board.append(card)
        return len(self.board) - 1

    # ── Board queries ──────────────────────────────────────────────────────────

    def get_active_positions(self):
        """Returns the list of board indices that currently hold a card."""
        return [i for i, card in enumerate(self.board) if card is not None]

    def active_slots(self):
        """Alias for get_active_positions (used by some helpers)."""
        return self.get_active_positions()

    def get_card_count(self):
        """Returns the number of cards currently on the board."""
        return sum(1 for c in self.board if c is not None)

    def card_count(self):
        """Alias for get_card_count."""
        return self.get_card_count()

    def has_no_cards(self):
        """Returns True if the player has no cards left on the board."""
        return self.get_card_count() == 0

    def get_board_value(self):
        """Returns the TRUE total point value of all board cards."""
        return sum(card.get_value() for card in self.board if card is not None)

    def true_total(self):
        """Alias for get_board_value."""
        return self.get_board_value()

    # ── Round lifecycle ────────────────────────────────────────────────────────

    def reset_for_new_round(self):
        """Clears the board and all knowledge at the start of a new round."""
        self.board            = [None, None, None, None]
        self.known_positions  = set()
        self.public_positions = set()
        self.temp_public_slots = set()
        self.pending_penalty  = 0

    def reset_for_round(self):
        """Alias for reset_for_new_round."""
        self.reset_for_new_round()

    def add_to_score(self, points):
        """Add points to this player's cumulative score."""
        self.score += points

    # ── Repr ───────────────────────────────────────────────────────────────────

    def __str__(self):
        status = '  [ELIMINATED]' if self.eliminated else ''
        return f'{self.name} (score: {self.score}{status})'

    def __repr__(self):
        return f'Player({self.name!r}, score={self.score})'
