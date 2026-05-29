import bcrypt from "bcryptjs";
import crypto from "crypto";
import { kv, SESSION_KEY, SESSION_TTL } from "./kv";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(username: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await kv.set(SESSION_KEY(token), username, { ex: SESSION_TTL });
  return token;
}

export async function resolveSession(token: string): Promise<string | null> {
  const username = await kv.get<string>(SESSION_KEY(token));
  return username ?? null;
}
