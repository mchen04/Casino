// Registers every stateless game resolver into the engine registry.
// Importing this module for its side effects populates the registry.
// One import + register() line per ported game.
import { register } from "../engine";
import { diceSpec } from "./dice";
import { limboSpec } from "./limbo";
import { dragonTigerSpec } from "./dragon-tiger";
import { moneyWheelSpec } from "./money-wheel";
import { andarBaharSpec } from "./andar-bahar";
import { baccaratSpec } from "./baccarat";

let done = false;
export function registerAll(): void {
  if (done) return;
  done = true;
  register(diceSpec);
  register(limboSpec);
  register(dragonTigerSpec);
  register(moneyWheelSpec);
  register(andarBaharSpec);
  register(baccaratSpec);
}

registerAll();
