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
}

registerAllRoundGames();
