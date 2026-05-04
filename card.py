# card.py — Card and Deck for Yussuf
# Nothing in this file changes for the multiplayer version.

import random


class Card:
    """
    One playing card.
    rank  — '2' through 'Ace', or 'Joker'
    suit  — 'Hearts', 'Diamonds', 'Clubs', 'Spades', or None for Joker
    """
    SUITS = ['Hearts', 'Diamonds', 'Clubs', 'Spades']
    RANKS = ['2','3','4','5','6','7','8','9','10','Jack','Queen','King','Ace']

    def __init__(self, rank, suit=None):
        self.rank = rank
        self.suit = suit

    def get_value(self):
        """
        Point value per Yussuf rules:
          Joker              →   0
          Ace                →   1
          2–10               →  face number
          Jack, Queen        →  10
          Black King (♣ ♠)   →  10
          Red King  (♥ ♦)    →  -1
        """
        if self.rank == 'Joker':
            return 0
        if self.rank == 'Ace':
            return 1
        if self.rank == 'King':
            return -1 if self.suit in ('Hearts', 'Diamonds') else 10
        if self.rank in ('Jack', 'Queen'):
            return 10
        return int(self.rank)

    def short_name(self):
        """Compact label for display: 'K♥', '10♠', 'JKR'"""
        if self.rank == 'Joker':
            return 'JKR'
        sym = {'Hearts':'♥','Diamonds':'♦','Clubs':'♣','Spades':'♠'}
        short = {'Jack':'J','Queen':'Q','King':'K','Ace':'A'}
        return f"{short.get(self.rank, self.rank)}{sym[self.suit]}"

    def __str__(self):
        return 'Joker' if self.rank == 'Joker' else f"{self.rank} of {self.suit}"

    def __repr__(self):
        return f"Card({self})"


def build_deck():
    """
    Build and shuffle a fresh 54-card deck (52 standard + 2 Jokers).
    Top card is the LAST element — use deck.pop() to draw.
    """
    deck = [Card(r, s) for s in Card.SUITS for r in Card.RANKS]
    # Two jokers — one tagged as 'red', one as 'black' so the client can
    # render different images. This does NOT affect game logic (joker rules
    # don't depend on suit; matching only checks rank == 'Joker').
    deck += [Card('Joker', 'red'), Card('Joker', 'black')]
    random.shuffle(deck)
    return deck
