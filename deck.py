# =============================================================================
# deck.py
# A standard 54-card deck (52 regular cards + 2 Jokers).
# Cards are drawn from the "top" (the end of the list).
# =============================================================================

import random
from card import Card


class Deck:
    """
    The face-down draw pile.
    The LAST element of self.cards is the "top" card — pop() draws it.
    """

    STANDARD_RANKS = [
        '2', '3', '4', '5', '6', '7', '8', '9', '10',
        'Jack', 'Queen', 'King', 'Ace'
    ]
    SUITS = ['Hearts', 'Diamonds', 'Clubs', 'Spades']

    def __init__(self):
        self.cards = []
        self._build()

    def _build(self):
        """Creates all 54 cards."""
        self.cards = []
        for suit in self.SUITS:
            for rank in self.STANDARD_RANKS:
                self.cards.append(Card(rank, suit))
        self.cards.append(Card('Joker'))
        self.cards.append(Card('Joker'))

    def shuffle(self):
        """Randomly shuffles the deck."""
        random.shuffle(self.cards)

    def draw(self):
        """
        Removes and returns the top card.
        Returns None if the deck is empty — callers must check for this!
        """
        if self.is_empty():
            return None
        return self.cards.pop()

    def is_empty(self):
        """Returns True when no cards remain."""
        return len(self.cards) == 0

    def size(self):
        """Returns how many cards remain."""
        return len(self.cards)
