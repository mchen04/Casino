export const meta = {
  name: 'build-casino-games',
  description: 'Implement all 33 Neon Royale casino games to the author contract, then verify each.',
  phases: [
    { title: 'Implement', detail: 'one agent per game writes src/games/<slug>.tsx' },
    { title: 'Verify', detail: 'adversarial contract + correctness check, fix in place' },
  ],
};

const CONTRACT = 'Read docs/GAME_CONTRACT.md in full FIRST. Then read the real shared module sources you will use: src/lib/wallet.tsx, src/lib/cards.ts, src/lib/rng.ts, src/lib/format.ts, src/lib/sound.ts, src/components/ui/Button.tsx, src/components/ui/Chip.tsx, src/components/PlayingCard.tsx, src/components/BetControls.tsx — so you use their EXACT exported names and signatures. Do NOT guess APIs.';

const RULES = [
  'Write the COMPLETE implementation by OVERWRITING src/games/<slug>.tsx (it currently holds a stub). Use the Write tool.',
  'First line must be "use client";. Default-export a React function component with NO required props.',
  'Money ONLY through useWallet(): bet(amount) deducts & returns boolean (false if unaffordable -> abort round); win(gross) credits stake+profit. Push = win(stake). Loss = credit nothing. A multiplier x means win(stake*x) where x already includes the stake.',
  'Only import from react, framer-motion, and @/lib/* or @/components/* listed in the contract. NO new packages, NO network, NO image/audio asset files. Draw with CSS/SVG/canvas/emoji.',
  'Must compile under TypeScript strict (no implicit any, handle null/undefined). Keep it in ONE file.',
  'Heavy, polished framer-motion animation is the headline requirement: deals, flips, spins, chip flight, rolling dice, win bursts, counters. Make it feel premium and alive.',
  'Responsive layout. Wrap the surface in a .felt or .glass rounded container with good padding. Use the theme tokens and the game accent color.',
  'data-testid="play-btn" on the primary action button. data-testid="round-result" on the element showing the round outcome text. Give other action buttons descriptive data-testid values.',
  'Let the player set their bet before a round (BetControls or chips), default 25-100, disable bet edits mid-round. Never let a bet exceed balance.',
  'Show a paytable/odds panel where relevant. Make outcomes unmistakable (color + sound + animation).',
  'Do NOT run "npm run build", "next dev", or "tsc" (it conflicts with parallel agents and the shared .next dir). Self-review your code against the contract instead.',
  'Do NOT edit any file other than your own src/games/<slug>.tsx. Do NOT touch the registry or shared files.',
];

const SPECS = [
  { slug: 'blackjack', name: 'Blackjack', accent: '#d4af37', spec:
`Classic blackjack vs the dealer. Use a 6-deck shoe via makeShoe(6), reshuffle when low. Use blackjackTotal() for hand values.
Flow: player sets bet -> Deal. Deal 2 to player (face up) and 2 to dealer (one face up, one face down), animated one card at a time.
Player actions: Hit, Stand, Double (only on first two cards; doubles the bet via a second bet(), deals exactly one card, then auto-stands), Split (only when the two cards share the same rank; create two hands, place an equal bet on the second; play each hand in turn; no resplit needed but allowed if simple). Offer Insurance prompt when dealer upcard is an Ace (pays 2:1, costs half the bet) — optional but nice.
Dealer reveals hole card then hits until total >= 17 (stands on all 17, including soft 17). Animate dealer drawing.
Payouts: natural blackjack (2 cards = 21) pays 3:2 -> win(bet*2.5). Regular win -> win(bet*2). Push -> win(bet). Bust or lose -> nothing. Player blackjack beats dealer non-blackjack 21.
Show both totals live, "BUST"/"BLACKJACK"/"WIN"/"PUSH" banners. Smooth card-deal animation and chip placement.` },

  { slug: 'spanish-21', name: 'Spanish 21', accent: '#e0b341', spec:
`Spanish 21 — blackjack played with Spanish decks (all four 10-spot cards removed; Jacks/Queens/Kings remain). Build a shoe of 6 Spanish decks: take makeDeck(6) and filter out every card whose rank === "10". Use blackjackTotal().
Key rule differences from blackjack: a player total of 21 ALWAYS wins immediately (dealer cannot tie or beat a player 21). A player blackjack BEATS a dealer blackjack. Blackjack pays 3:2. Dealer hits soft 17.
Allow Hit, Stand, Double (any number of cards), Split equal ranks.
Bonus payouts on a player 21 (paid even after doubling at the base bet rate): five-card 21 pays 3:2, six-card 21 pays 2:1, seven-or-more-card 21 pays 3:1; 6-7-8 or 7-7-7 of mixed suits pays 3:2, same suit pays 2:1, all spades pays 3:1. Implement at least the 5/6/7-card 21 bonuses and the 6-7-8 / 7-7-7 bonus.
Show the "no tens" note and a bonus paytable. Same premium card animations as blackjack.` },

  { slug: 'baccarat', name: 'Baccarat', accent: '#c0392b', spec:
`Punto Banco baccarat. Player bets on PLAYER, BANKER, or TIE (and optionally Player Pair / Banker Pair side bets at 11:1). Use makeShoe(8). Card values: A=1, 2-9 face value, 10/J/Q/K = 0; hand total = sum mod 10.
Deal two cards to Player and two to Banker. Apply the official third-card rules: Natural 8 or 9 (either hand) -> stand both. Else: Player draws a third card if Player total <= 5 (stands on 6-7). Banker drawing depends on Banker total and Player's third card per the standard tableau: Banker total 0-2 always draws; 3 draws unless player third card is 8; 4 draws if player third card in 2-7; 5 draws if 4-7; 6 draws if 6-7; 7 stands. If player did not draw, banker draws on 0-5, stands 6-7.
Payouts: Player wins 1:1 -> win(bet*2). Banker wins pays 0.95:1 (5% commission) -> win(bet*1.95). Tie pays 8:1 -> win(bet*9); on a non-tie result a Tie bet loses, and Player/Banker bets PUSH on a tie (refund). Pair side bets 11:1.
Beautiful card reveal, a bead-road / scoreboard of recent results (P/B/T), and clear total displays.` },

  { slug: 'video-poker', name: 'Video Poker', accent: '#22e1ff', spec:
`Jacks or Better video poker. Bet in coins 1-5 (coin value selectable, e.g. 5/25/100); total bet = coins * coinValue. Use a single makeShoe(1) per hand.
Flow: Deal 5 cards face up. Player toggles HOLD on any cards (click the card). Then Draw replaces non-held cards from the same deck. Evaluate final 5 with evaluate5().
Paytable per coin (multiply by coins): Royal Flush 250 (but 800 when betting 5 coins), Straight Flush 50, Four of a Kind 25, Full House 9, Flush 6, Straight 4, Three of a Kind 3, Two Pair 2, Jacks or Better (pair of J/Q/K/A) 1. Anything less pays 0. Payout: win(coinValue * payoutPerCoin * coins)? NOTE: paytable is per-coin multiplier of TOTAL — standard is payout = totalBet * (payPerCoin) ... implement as: credits returned = payPerCoin * coins * coinValue, i.e. win(payPerCoin * coins * coinValue). Verify Jacks-or-Better returns the bet (push-like 1x) -> payPerCoin 1 => returns totalBet.
Highlight the winning rank row in the paytable. Animate the draw (held cards stay, others flip to new). Show "HOLD" badges. Neon arcade aesthetic.` },

  { slug: 'texas-holdem', name: "Texas Hold'em", accent: '#2ecc71', spec:
`Heads-up No-Limit Texas Hold'em: human vs ONE house bot. Use makeShoe(1) per hand.
Structure: small blind / big blind (e.g. SB 25, BB 50), alternate the button each hand. Deal 2 hole cards each (bot's face down). Four streets: preflop, flop (3), turn (1), river (1). On each street a betting round: actions Fold, Check/Call, Bet/Raise (offer a few sizes: min, 1/2 pot, pot, all-in). Track the pot precisely; deduct player wagers via bet() and pay the winner via win(pot share). Ensure the wallet math nets out exactly (player's net = winnings - amount they put in this hand).
Bot AI: estimate hand strength from evaluateBest of (hole+board); fold weak hands to big bets, call medium, raise strong, with occasional bluff via chance(). Must never make illegal actions; cap raises to avoid infinite loops.
Showdown: reveal bot cards, compare evaluateBest, award pot (split on tie).
Show pot, both stacks (display-only beyond wallet), board cards dealt with animation, action buttons with data-testid (fold-btn, call-btn, raise-btn) and play-btn to start a hand. Clear winner banner = round-result.
Keep betting increments clean so pot accounting always balances. This is complex — prioritize a CORRECT, non-crashing betting loop and accurate pot payout over exotic features.` },

  { slug: 'ultimate-texas', name: "Ultimate Texas Hold'em", accent: '#27ae60', spec:
`Ultimate Texas Hold'em vs dealer. Player posts equal ANTE and BLIND. Optional Trips side bet.
Flow: deal 2 hole cards to player and dealer, 5 community face down.
Pre-flop: player may CHECK or make a PLAY bet of 3x or 4x the ante.
If checked, reveal flop (3 cards): player may CHECK or make PLAY bet of 2x ante.
If checked again, reveal turn+river: player may make PLAY bet of 1x ante or FOLD (fold loses ante+blind).
Reveal all; both make best 5-card hand via evaluateBest(hole+5 community).
Dealer QUALIFIES with a pair or better.
Settlement: PLAY bet pays 1:1 if player beats dealer (push if tie). ANTE: if player beats dealer, ante pays 1:1 BUT pushes if dealer does not qualify; loses if dealer wins. BLIND: pays only when player wins, per a bonus paytable on the player's hand: Royal Flush 500:1, Straight Flush 50:1, Quads 10:1, Full House 3:1, Flush 3:2, Straight 1:1, less than straight pushes. On a loss everything loses.
Trips side bet pays on player's hand regardless (Trips 3:1 up to Royal 50:1).
Show the three decision points clearly with raise buttons (raise-4x, raise-3x, raise-2x, raise-1x, check-btn, fold-btn). Animate community reveal.` },

  { slug: 'three-card-poker', name: 'Three Card Poker', accent: '#9b59b6', spec:
`Three Card Poker. Two wagers: ANTE (required) and optional PAIR PLUS. Use makeShoe(1). IMPORTANT: use evaluate3()/ThreeCardCategory for 3-card ranking (straight beats flush here).
Flow: place Ante (+ optional Pair Plus) -> deal 3 to player face up and 3 to dealer face down. Player decides PLAY (matching Ante bet) or FOLD (forfeits ante + pair plus... pair plus actually resolves independently in many rules; here resolve Pair Plus on the dealt hand regardless of fold).
Dealer QUALIFIES with Queen-high or better. If dealer does NOT qualify: Ante pays 1:1, Play bet pushes (returned). If dealer qualifies: compare evaluate3 — player wins -> Ante 1:1 and Play 1:1; tie -> push both; lose -> lose both.
Ante Bonus (paid regardless of dealer, on player's hand): Straight 1:1, Three of a Kind 4:1, Straight Flush 5:1.
Pair Plus paytable (on player's 3 cards): Pair 1:1, Flush 3:1, Straight 6:1, Three of a Kind 30:1, Straight Flush 40:1; no pair loses the Pair Plus.
Show both paytables, animate the reveal of dealer cards, clear result banner.` },

  { slug: 'caribbean-stud', name: 'Caribbean Stud', accent: '#1abc9c', spec:
`Caribbean Stud Poker. Player places an ANTE. Deal 5 cards to player (face up) and 5 to dealer (one face up, four face down). Use makeShoe(1) and evaluate5().
Player chooses RAISE (an additional bet of exactly 2x the ante) or FOLD (forfeits ante).
Dealer QUALIFIES with Ace-King high or better (i.e. at least Ace+King, or any pair or higher).
If dealer does NOT qualify: Ante pays 1:1 and the Raise pushes (returned).
If dealer qualifies: compare hands. Player loses -> lose ante + raise. Player wins -> Ante pays 1:1, and Raise pays per paytable based on the PLAYER's hand: Pair or less 1:1, Two Pair 2:1, Three of a Kind 3:1, Straight 4:1, Flush 5:1, Full House 7:1, Four of a Kind 20:1, Straight Flush 50:1, Royal Flush 100:1. Tie -> push.
Animate dealer's four hidden cards flipping over one by one. Show the raise paytable and dealer-qualify status.` },

  { slug: 'let-it-ride', name: 'Let It Ride', accent: '#e67e22', spec:
`Let It Ride. Player makes three equal bets (call them bet 1, 2, 3) plus a base unit. Deal 3 cards to the player and 2 community cards face down. Use makeShoe(1), final hand = player's 3 + 2 community = 5 cards via evaluate5().
Decisions: after seeing the 3 cards, player may PULL BACK bet 1 (reclaim it) or LET IT RIDE. Then reveal the first community card; player may PULL BACK bet 2 or LET IT RIDE. The third bet always stays; reveal the second community card.
Payout applies to EACH remaining bet, based on the final 5-card hand: Pair of 10s or better 1:1, Two Pair 2:1, Three of a Kind 3:1, Straight 5:1, Flush 8:1, Full House 11:1, Four of a Kind 50:1, Straight Flush 200:1, Royal Flush 1000:1. Lower than a pair of tens loses all remaining bets. (Pairs below tens lose.)
Each remaining bet pays the multiplier independently. Clear "Let it Ride / Pull Back" buttons, animate community reveal, show paytable.` },

  { slug: 'pai-gow-poker', name: 'Pai Gow Poker', accent: '#e74c3c', spec:
`Pai Gow Poker. 53-card deck = makeDeck(1) plus one JOKER (a special card; treat joker as wild that can complete a straight or flush, otherwise counts as an Ace). Deal 7 cards to player and 7 to dealer.
Player arranges 7 cards into a 5-card HIGH hand and a 2-card LOW hand; the 5-card hand MUST rank higher than the 2-card hand (else it's a foul -> auto-fix or reject). Provide an auto "House Way" arrange button AND let the player swap cards between hands manually, with validation.
Dealer sets their hand by House Way (a reasonable heuristic: put the highest pair/trips in the high hand, keep the two highest remaining for the low hand, etc.).
Compare: player's high vs dealer's high (use evaluate5 with joker substitution) and player's low vs dealer's low (2-card: pair beats high card, then by rank). Player wins BOTH -> win even money minus 5% commission -> win(bet*1.95). Wins one / loses one (or any tie on one) -> PUSH (return bet). Loses both (or ties the copy) -> lose. Dealer wins ties (copies).
This is intricate — prioritize: correct foul prevention, a working House Way, correct both-hands comparison, and a clear UI to arrange cards. Animate the 7-card deal and the split.` },

  { slug: 'casino-war', name: 'Casino War', accent: '#c0392b', spec:
`Casino War. Single bet. Use makeShoe(6). Deal one card to player and one to dealer (Ace high; rank via rankValue). Higher card wins 1:1 (win(bet*2)).
On a TIE: player chooses SURRENDER (forfeit half the bet -> win(bet/2)) or GO TO WAR (place an additional war bet equal to the original; burn 3 cards, deal one more to each). If player's war card is >= dealer's, player wins: the WAR bet pays 1:1 and the original bet PUSHES -> total win(originalBet + warBet*2)... standard rule: on a war win the raised (war) bet wins 1:1 and the original bet pushes, so return = original (push) + warBet*2. If dealer wins the war, player loses both. (Optionally a tie on the war pays a 2:1 bonus on the original.)
Fast, punchy, big card flip animations and a dramatic "WAR!" banner. Clear surrender/war buttons (data-testid war-btn, surrender-btn).` },

  { slug: 'red-dog', name: 'Red Dog', accent: '#d35400', spec:
`Red Dog (Acey-Deucey). Single deck makeShoe(1). Place an ANTE. Deal two cards. Rank by rankValue (Ace high =14).
If the two cards are CONSECUTIVE (e.g. 7 and 8) -> immediate PUSH (return ante). If the two cards are a PAIR (equal rank) -> deal a third card; if it matches (three of a kind) pay 11:1, otherwise PUSH.
Otherwise compute the SPREAD = (difference in ranks - 1) = number of ranks strictly between them. Show the spread. Player may RAISE (double the ante) or stay. Then deal a third card.
If the third card's rank falls strictly BETWEEN the two cards, player wins based on spread: spread 1 -> 5:1, spread 2 -> 4:1, spread 3 -> 2:1, spread 4 or more -> 1:1. The winning multiplier pays on the TOTAL wager (ante + raise). If not between, lose all wagered.
Animate the two cards, the spread meter, and the third card sliding in between. Show the spread paytable.` },

  { slug: 'dragon-tiger', name: 'Dragon Tiger', accent: '#f39c12', spec:
`Dragon Tiger (fast Sino-baccarat). Bets: DRAGON, TIGER, TIE (and optional suit-tie). Use makeShoe(8). Deal exactly one card to Dragon and one to Tiger. Card rank order: Ace LOW (=1), then 2..10, J, Q, K high (K highest).
Higher card wins its side 1:1 (win(bet*2)). TIE (equal rank) pays 8:1 -> win(bet*9); and on a tie, DRAGON/TIGER bets lose HALF (return bet/2). Tie bet loses on a non-tie.
Super fast and flashy: two big cards flip simultaneously, dragon (red/gold) vs tiger (blue/cyan) themed sides, recent-results streak board. Bet buttons data-testid bet-dragon, bet-tiger, bet-tie.` },

  { slug: 'andar-bahar', name: 'Andar Bahar', accent: '#16a085', spec:
`Andar Bahar. Use makeShoe(1) (reshuffle each round). Draw one "JOKER"/game card and display it. Player bets ANDAR (left) or BAHAR (right).
Deal cards alternately to the two sides. By convention the first card goes to the side opposite... use this simple convention: if the joker card is black suit, first card goes to Andar; if red, to Bahar (or just always start Andar). Continue alternating until a dealt card MATCHES the joker's RANK; the side it lands on WINS.
Payouts (account for the first-card edge): ANDAR pays 0.9:1 (win(bet*1.9)) when Andar starts / BAHAR pays 1:1 (win(bet*2)). Use a consistent rule; keep it simple and clearly stated in the UI.
Animate cards being laid out alternately on the two sides, building two rows, with the matching card highlighted. Indian/festive gold-and-teal aesthetic.` },

  { slug: 'teen-patti', name: 'Teen Patti', accent: '#e84393', spec:
`Teen Patti (Indian 3-card poker) vs dealer. Use makeShoe(1). Place a BOOT (ante). Deal 3 cards to player and 3 to dealer.
IMPORTANT ranking (DIFFERENT from standard 3-card poker): Trail/Trio (three of a kind) is HIGHEST, then Pure Sequence (straight flush), then Sequence (straight), then Color (flush), then Pair, then High Card. Implement this ranking yourself (do not reuse evaluate3's order directly, since there a straight flush outranks trips). Ace is high; A-2-3 and A-K-Q are valid sequences; the highest sequence is A-K-Q.
Flow: player sees their cards (seen play), then choose PLAY (match the boot) or FOLD. Reveal dealer; dealer must qualify with at least a defined minimum (use: dealer always plays / or qualifies with a Pair or better — keep simple: dealer always shows). Compare hands; higher wins.
Payout: win pays 1:1 on total staked (win(total*2)); add bonus payouts for strong player hands (e.g. Pure Sequence, Trail) if you like. Tie -> dealer wins or push (pick push).
Festive lotus/pink-gold theme, dramatic card reveal, show the Teen Patti ranking chart.` },

  { slug: 'hi-lo', name: 'Hi-Lo', accent: '#00cec9', spec:
`Hi-Lo (higher/lower) streak game. Show one card from a shuffled makeShoe(1). The player predicts whether the NEXT card will be HIGHER or LOWER (ties: decide a rule — e.g. "higher or same" vs "lower or same", and reflect that in the displayed odds). Rank by rankValue, Ace high.
On each correct guess, multiply the running payout by fair odds derived from the remaining-probability (use cards remaining in the conceptual deck OR a simple model: probability higher = (count of higher-or-equal)/13 using rank only, with replacement). multiplier_step = (1 / probability) * (1 - houseEdge), houseEdge ~0.03. Accumulate multiplier across the streak.
Player can CASH OUT at any time to win(bet * runningMultiplier). A wrong guess loses the whole bet and ends the streak. After resolving, reset for a new bet.
Show the live multiplier, the per-choice odds/percentages on the Higher and Lower buttons, the previous card, and a smooth card-slide animation. Modern crypto-casino look. Buttons data-testid higher-btn, lower-btn, cashout-btn.` },

  { slug: 'roulette', name: 'Roulette', accent: '#e3342f', spec:
`Roulette with a EUROPEAN (single 0) default and an AMERICAN (0 and 00) toggle. Number colors: 0/00 green; standard red set {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36}, rest black.
Provide a clickable BETTING LAYOUT: the player selects a chip denomination, then clicks to place chips on: straight (single number), red/black, odd/even, 1-18/19-36 (high/low), the three dozens (1-12,13-24,25-36), and the three columns. (Splits/streets/corners optional bonus.) Show stacked chips on each placed bet. Multiple simultaneous bets allowed; total must not exceed balance (deduct on spin).
Spin: animate a wheel rotating and a ball settling on a pocket (randInt result). Payouts: straight 35:1 (win 36x stake), red/black/odd/even/high/low 1:1 (2x), dozen/column 2:1 (3x). Pay every winning bet, clear losers.
Show last-spin number, a history strip, and a "CLEAR BETS"/"SPIN" control (spin-btn). The wheel + ball animation should be a showpiece.` },

  { slug: 'craps', name: 'Craps', accent: '#e67e22', spec:
`Craps with two dice. Implement at least: PASS LINE, DON'T PASS, FIELD, and PLACE 6 / PLACE 8, plus PASS/DON'T-PASS ODDS after a point. Animate two tumbling dice on each roll (roll-btn / play-btn).
Come-out roll (no point): Pass wins on 7/11, loses on 2/3/12 (craps); Don't Pass wins on 2/3 loses on 7/11, pushes on 12. Any other number (4,5,6,8,9,10) becomes the POINT.
Point phase: roll until the point repeats (Pass wins 1:1, Don't Pass loses) or a 7 (Pass loses, Don't Pass wins 1:1). After a point is set, allow taking ODDS on Pass (true odds: 4/10 -> 2:1, 5/9 -> 3:2, 6/8 -> 6:5).
FIELD (resolves every roll): wins on 2 (2:1), 12 (3:1 or 2:1), and 3,4,9,10,11 (1:1); loses on 5,6,7,8. PLACE 6/8 win 7:6 when the number rolls before a 7, lose on 7.
Show the puck ON/OFF and the point, a clear bet layout with current wagers, and the dice result. Settle wallet exactly.` },

  { slug: 'sic-bo', name: 'Sic Bo', accent: '#fd79a8', spec:
`Sic Bo — three dice. Animate three dice rolling. Provide a bet grid with: SMALL (total 4-10) and BIG (total 11-17), each 1:1 but LOSE on any triple; SPECIFIC TRIPLE (choose a number 1-6, all three match) 150:1; ANY TRIPLE 24:1; SPECIFIC DOUBLE (a chosen number appears at least twice) 8:1; SINGLE NUMBER bets 1-6 paying 1:1 / 2:1 / 3:1 if the number appears once / twice / thrice; and TOTAL bets (e.g. 4&17 -> 50:1, 5&16 -> 18:1, 6&15 -> 14:1, 7&14 -> 12:1, 8&13 -> 8:1, 9..12 -> 6:1).
Player selects a chip value and places bets on the grid (multiple allowed), deduct total on roll, settle each bet against the three dice. Show the three dice prominently and a payout table. roll-btn / play-btn.` },

  { slug: 'money-wheel', name: 'Money Wheel', accent: '#f5d060', spec:
`Big Six Money Wheel (Wheel of Fortune). A vertical/round wheel of 54 segments labeled with multipliers: 1 (24 segments), 2 (15), 5 (7), 10 (4), 20 (2), and two special JOKER and CASINO logo segments (1 each) paying 40:1.
Player bets on a segment value (1,2,5,10,20, or the 40:1 logos). Spin the wheel (animate rotation decelerating to a pointer). If the landed segment equals the bet, pay value:1 — e.g. landing on "5" with a bet on 5 pays 5:1 -> win(bet*6); the 40:1 logos pay win(bet*41).
Show the wheel as a showpiece (SVG or CSS conic-gradient wheel) with a pointer, the segment distribution/odds, and bet buttons for each value. spin-btn.` },

  { slug: 'coin-flip', name: 'Coin Flip', accent: '#bdc3c7', spec:
`Coin Flip. Player picks HEADS or TAILS and a bet, then flips. A correct call pays ~1.96:1 (win(bet*1.96)) to bake in a small house edge; wrong loses.
Add a STREAK mode option: keep flipping and let winnings ride, each correct call multiplying by ~1.96, with a CASH OUT button — wrong flip loses it all.
The coin flip itself must be a gorgeous 3D animation (rotateX/rotateY spinning coin with heads/tails faces, settling to the result). Buttons data-testid heads-btn, tails-btn, flip-btn, cashout-btn.` },

  { slug: 'slots-classic', name: 'Lucky Sevens', accent: '#e74c3c', spec:
`Classic 3-reel slot, single center payline. Symbols (with rarity weights): "7" (rare), "BAR", "BELL", "CHERRY", "LEMON", "PLUM". Use weightedPick per reel.
Spin animation: each reel scrolls a strip of symbols with motion blur and stops sequentially left-to-right with a thud.
Paytable (3 of a kind on the line): 7-7-7 = 100x, BAR-BAR-BAR = 40x, BELL x3 = 20x, CHERRY x3 = 12x, others x3 = 6x; any two CHERRY = 4x, single CHERRY = 2x; mixed BARs = 8x. win(bet * multiplier).
Show 3 rows (display) but pay only the center line, with the winning line highlighted and a coin-burst on win. Retro red/gold cabinet aesthetic. spin-btn / play-btn.` },

  { slug: 'slots-fruit', name: 'Fruit Frenzy', accent: '#2ecc71', spec:
`5-reel x 3-row video slot, 10 fixed paylines. Symbols: CHERRY, LEMON, ORANGE, PLUM, GRAPE, WATERMELON, BELL, STAR (wild), SCATTER (e.g. a "FREE" coin). Use weighted reels.
Wild substitutes for any symbol except scatter. 3+ scatters anywhere award 8 FREE SPINS (auto-played, wins added). Line wins: 3/4/5 of a kind left-to-right on a payline pay increasing multipliers per the paytable you define (higher symbols pay more). win(bet * lineMultiplier summed across winning lines, where bet is per-spin total).
Animate all 5 reels spinning and stopping with stagger, highlight winning paylines with glowing lines, show free-spin counter and a big "FREE SPINS!" banner. Define and SHOW the paytable. spin-btn.` },

  { slug: 'slots-egypt', name: "Pharaoh's Fortune", accent: '#f1c40f', spec:
`Egyptian-themed 5-reel x 3-row slot, 10-20 paylines. Symbols: PHARAOH (top), ANUBIS, SCARAB, EYE OF HORUS, ANKH, PYRAMID (wild), BOOK/SCATTER, plus low card symbols.
Book SCATTER: 3+ trigger 10 FREE SPINS during which a special EXPANDING symbol is chosen and expands to cover full reels when it appears (classic Book-of-Ra style). Wild (pyramid) substitutes.
Line wins pay per paytable (Pharaoh highest). win(bet * total line multiplier). Auto-play free spins and sum winnings.
Sandstone/gold aesthetic with hieroglyph glow, staggered reel stops, expanding-symbol animation in free spins, winning-line highlights, visible paytable. spin-btn.` },

  { slug: 'slots-megaways', name: 'Neon Megaways', accent: '#a855f7', spec:
`Megaways-style CASCADING slot. 6 reels, each shows a RANDOM number of symbols per spin (2-7 rows per reel), giving a variable number of "ways" (ways = product of symbols-per-reel). A win = 3+ matching symbols on consecutive reels left-to-right (counting all positions, ways-style, not fixed lines).
CASCADE mechanic: winning symbols explode and remaining symbols drop down with new ones falling in; consecutive cascades increase a WIN MULTIPLIER (x1, x2, x3...). Continue cascading until no win.
Symbols: neon gems of several colors + a wild + a scatter. Pay per symbol count via a paytable. win(bet * totalAcrossCascades).
This is the flashy showpiece: smooth drop/cascade physics, neon glow, mounting multiplier display, "ways" counter. spin-btn.` },

  { slug: 'dice', name: 'Dice', accent: '#22e1ff', spec:
`Modern "dice" (over/under) game. A result is a number 0.00-99.99 (use randFloat(0,100)). Player sets a TARGET via a slider and chooses ROLL OVER or ROLL UNDER.
Win chance = (for roll-over) (100 - target)/100, (for roll-under) target/100. Payout multiplier = (100 / (winChance*100)) * (1 - houseEdge) with houseEdge ~0.01, i.e. payout = (99 / winChancePercent). Display the live multiplier, win chance %, and target as the slider moves.
On roll: animate the result number ticking/sliding to its value on a 0-100 track with a marker at the target; if it lands on the winning side, win(bet * multiplier).
Clean crypto-casino UI: big slider, ROLL button (play-btn), over/under toggle, live stats. Keep bet sizing with chips or a bet input.` },

  { slug: 'limbo', name: 'Limbo', accent: '#8aff80', spec:
`Limbo. Player picks a TARGET MULTIPLIER (e.g. 2.00x, via input or +/- buttons; min 1.01x). On play, generate a random RESULT multiplier from a crash-style distribution with house edge: result = max(1.00, (1 - edge) / (1 - random)) using random in [0,1), edge ~0.01. If result >= target, the player wins win(bet * target); otherwise loses.
Win chance displayed = (1-edge)/target * 100%.
Animation: a large multiplier number rapidly counts UP and stops at the result value, glowing green if it reached/passed the target (win) or red if it fell short. Show target vs result clearly. play-btn. Sleek minimal neon UI.` },

  { slug: 'crash', name: 'Crash', accent: '#ff2bd1', spec:
`Crash. Before the round, player sets a bet and an optional AUTO CASH-OUT multiplier. On start, a rocket launches and a multiplier rises from 1.00x in real time (use requestAnimationFrame or a state interval; grow roughly exponentially, e.g. multiplier = 1.00 * growthRate^elapsed).
A hidden CRASH POINT is pre-rolled from a house-edge distribution: crashPoint = max(1.00, floor(100*(1-edge)/(1-random))/100), edge ~0.01; ~ small chance of instant 1.00x bust.
The player clicks CASH OUT (cashout-btn) before the multiplier reaches the crash point to win win(bet * currentMultiplier). If auto-cashout is set and reached first, auto-cash. If the multiplier hits the crash point first, the player loses and the rocket explodes.
Showpiece animation: a rising rocket along a curve, a growing multiplier readout, screen shake / explosion on crash, a history strip of past crash points (green if you'd have cashed, red bust). play-btn to launch.` },

  { slug: 'plinko', name: 'Plinko', accent: '#22e1ff', spec:
`Plinko. A triangular peg board with selectable ROWS (8/12/16) and RISK (low/medium/high). Player sets bet and clicks DROP (play-btn / drop-btn): a ball falls from the top center and bounces left/right off pegs (each peg ~50/50 via chance(0.5)), animated with realistic bouncing, landing in one of (rows+1) multiplier buckets at the bottom.
Bucket multipliers are symmetric (low in the middle, high at the edges) and depend on rows+risk — define sensible tables (e.g. 16-row high risk edges up to ~1000x, middle ~0.2x). The landing bucket index = number of right-bounces (binomial). win(bet * bucketMultiplier).
Animate the ball physically bouncing peg to peg and the landing bucket flashing. Multiple balls can be dropped in succession. Show the multiplier row and highlight the hit bucket.` },

  { slug: 'mines', name: 'Mines', accent: '#8aff80', spec:
`Mines. A 5x5 grid (25 tiles). Player sets a bet and the NUMBER OF MINES (1-24), then starts a round (bet is deducted). Mines are placed at random hidden positions. Player clicks tiles to reveal: a GEM is safe and increases the running multiplier; a MINE ends the round (lose).
Multiplier after revealing k gems = product over i=0..k-1 of (25-i)/(25-mines-i), times (1 - houseEdge ~0.01). Show the NEXT-tile multiplier and current cash-out value live.
Player may CASH OUT (cashout-btn) anytime after at least one gem to win win(bet * currentMultiplier). Revealing a mine reveals the whole board (show all mines) and loses.
Animate tile flips, gem sparkle, and a bomb explosion. Clean modern grid UI; show mines count selector and multiplier.` },

  { slug: 'keno', name: 'Keno', accent: '#22e1ff', spec:
`Keno. An 80-number grid (1-80). Player picks 1-10 numbers (spots), sets a bet, then DRAW (play-btn) reveals 20 random drawn numbers (no repeats) lighting up one by one.
Count HITS (player's picks that were drawn). Payout depends on (spots picked, hits) via a paytable you define (more spots + more hits = bigger multiplier; e.g. pick 10 hit 10 -> ~1000x). win(bet * multiplier). Include a quick-pick (random) and clear buttons.
Animate the 20 balls being drawn and the grid cells flashing as matches are found; tally hits and show the payout. Show the paytable for the current pick count.` },

  { slug: 'scratch', name: 'Scratch Cards', accent: '#f5d060', spec:
`Scratch Cards. Player buys a card for the bet amount. The card has a grid (e.g. 3x3 or 9 panels) of hidden prize symbols. Pre-roll the contents so the win/lose and prize are fixed at purchase (with a house-edge-appropriate prize distribution).
Reveal mechanic: either a real canvas "scratch to reveal" (pointer/drag erases a foil overlay) OR click-to-reveal panels with a satisfying flip. Win condition: match 3 of the same prize symbol -> win that prize amount (win(prizeMultiplier * bet)); otherwise no win.
Offer at least 2-3 card "themes" with different prize tables. Animate the reveal, sparkle on a winning match, and a "REVEAL ALL" button. Show the prize legend. buy-btn / play-btn.` },

  { slug: 'bingo', name: 'Bingo', accent: '#fd79a8', spec:
`75-ball Bingo, single player vs the draw. Player buys 1-4 cards (each a 5x5 grid; columns B(1-15) I(16-30) N(31-45 with FREE center) G(46-60) O(61-75), no repeats). Set bet (cost scales with number of cards).
On START (play-btn), draw balls one at a time (animated, with the called letter+number, e.g. "B-7") and AUTO-DAUB matching cells on the player's cards. Detect winning patterns: any line (row, column, or diagonal) and full-house (blackout).
Payout: completing a LINE pays a small multiplier (e.g. 2x), and a full BLACKOUT pays a big multiplier (e.g. 50x) — scale by how many balls it took / standard fixed odds is fine. win(bet * multiplier). Stop drawing once the best achievable win is locked or all 75 balls drawn.
Animate the ball hopper/call display, daubing marks, and highlight completed lines. Show called-numbers board.` },
];

phase('Implement');
log(`Implementing ${SPECS.length} games (implement -> verify per game)`);

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    slug: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial'] },
    summary: { type: 'string', description: 'one sentence on what was built' },
    deviations: { type: 'string', description: 'any rule/contract deviations or known gaps; empty if none' },
  },
  required: ['slug', 'status', 'summary'],
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    slug: { type: 'string' },
    issuesFound: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'boolean', description: 'true if all found issues were fixed in place' },
    remaining: { type: 'string', description: 'any issue left unfixed; empty if none' },
    compileConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['slug', 'issuesFound', 'fixed', 'compileConfidence'],
};

function implPrompt(g) {
  return `You are implementing ONE casino game for the "Neon Royale" Next.js site.

GAME: ${g.name} (slug: ${g.slug}, accent color ${g.accent})
TARGET FILE: src/games/${g.slug}.tsx  (currently a stub — OVERWRITE it completely)

${CONTRACT}

GAME SPEC:
${g.spec}

NON-NEGOTIABLE RULES:
${RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Build a complete, polished, ACCURATE, self-contained implementation now. Make the animations genuinely impressive. When done, return your structured report.`;
}

function verifyPrompt(g, impl) {
  return `Adversarially review and FIX the casino game at src/games/${g.slug}.tsx (${g.name}).

Implementation report from the author: ${JSON.stringify(impl)}

Do ALL of the following, editing src/games/${g.slug}.tsx in place to fix any problems (use Edit/Write):
1. Read docs/GAME_CONTRACT.md and the shared sources (src/lib/wallet.tsx, src/lib/cards.ts, src/lib/rng.ts, src/lib/format.ts, src/lib/sound.ts, src/components/ui/Button.tsx, src/components/ui/Chip.tsx, src/components/PlayingCard.tsx, src/components/BetControls.tsx). Confirm EVERY import name and prop the game uses actually exists with that exact signature — fix any mismatch (wrong export name, wrong prop, wrong arg order).
2. Verify TypeScript-strict safety: no implicit any, no use of possibly-undefined array elements without guards, all hooks called unconditionally, no missing "use client", a valid default export, all JSX props typed. Fix issues.
3. Verify the MONEY MODEL: bet() return value is checked before playing; win(gross) credits stake+profit (not just profit); pushes refund the stake; multipliers include the stake. Fix any payout bug.
4. Verify the game RULES/payouts match the spec and real casino math. Fix incorrect payouts or rule logic.
5. Confirm data-testid="play-btn" exists on the primary action and data-testid="round-result" on the outcome element. Add if missing.
6. Confirm no forbidden imports (only react, framer-motion, @/lib/*, @/components/*), no network, no asset files. Fix.
7. Confirm it won't crash on edge cases (empty deck, insufficient balance, rapid clicks during animation — disable controls while resolving).
Do NOT run npm build / tsc / next dev (it conflicts with other agents). Review by reading. Then return your structured verdict.`;
}

const reports = await pipeline(
  SPECS,
  (g) => agent(implPrompt(g), {
    label: `impl:${g.slug}`,
    phase: 'Implement',
    schema: IMPL_SCHEMA,
    agentType: 'general-purpose',
  }),
  (impl, g) => agent(verifyPrompt(g, impl), {
    label: `verify:${g.slug}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
    agentType: 'general-purpose',
    model: 'sonnet',
  }).then((v) => ({ slug: g.slug, name: g.name, impl, verify: v })),
);

const ok = reports.filter(Boolean);
log(`Done: ${ok.length}/${SPECS.length} games processed`);
return ok;
