// Registers every stateless game resolver into the engine registry.
// Importing this module for its side effects populates the registry.
// The fan-out adds one import + register() line per ported game here.
import { register } from "../engine";
import { diceSpec } from "./dice";

let done = false;
export function registerAll(): void {
  if (done) return;
  done = true;
  register(diceSpec);
}

registerAll();
