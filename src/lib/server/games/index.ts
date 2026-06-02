// Registers every stateless game resolver into the engine registry.
// Importing this module for its side effects populates the registry.
// One import + register() line per ported game.
import { register } from "../engine";
import { diceSpec } from "./dice";
import { limboSpec } from "./limbo";
import { dragonTigerSpec } from "./dragon-tiger";

let done = false;
export function registerAll(): void {
  if (done) return;
  done = true;
  register(diceSpec);
  register(limboSpec);
  register(dragonTigerSpec);
}

registerAll();
