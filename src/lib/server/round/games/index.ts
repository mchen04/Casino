// Registers every stateful round game into the round registry.
// Importing this module for its side effects populates the registry.
import { registerRound } from "../engine";
import { casinoWarGame } from "./casino-war";

let done = false;
export function registerAllRoundGames(): void {
  if (done) return;
  done = true;
  registerRound(casinoWarGame);
}

registerAllRoundGames();
