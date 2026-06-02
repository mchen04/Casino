// Registers every stateful round game into the round registry.
// Importing this module for its side effects populates the registry.
import { registerRound } from "../engine";
import { casinoWarGame } from "./casino-war";
import { redDogGame } from "./red-dog";
import { hiLoGame } from "./hi-lo";
import { minesGame } from "./mines";
import { threeCardPokerGame } from "./three-card-poker";
import { caribbeanStudGame } from "./caribbean-stud";
import { teenPattiGame } from "./teen-patti";
import { letItRideGame } from "./let-it-ride";
import { blackjackGame } from "./blackjack";
import { videoPokerGame } from "./video-poker";
import { ultimateTexasGame } from "./ultimate-texas";
import { crashGame } from "./crash";
import { spanish21Game } from "./spanish-21";
import { paiGowPokerGame } from "./pai-gow-poker";
import { crapsGame } from "./craps";
import { texasHoldemGame } from "./texas-holdem";

let done = false;
export function registerAllRoundGames(): void {
  if (done) return;
  done = true;
  registerRound(casinoWarGame);
  registerRound(redDogGame);
  registerRound(hiLoGame);
  registerRound(minesGame);
  registerRound(threeCardPokerGame);
  registerRound(caribbeanStudGame);
  registerRound(teenPattiGame);
  registerRound(letItRideGame);
  registerRound(blackjackGame);
  registerRound(videoPokerGame);
  registerRound(ultimateTexasGame);
  registerRound(crashGame);
  registerRound(spanish21Game);
  registerRound(paiGowPokerGame);
  registerRound(crapsGame);
  registerRound(texasHoldemGame);
}

registerAllRoundGames();
