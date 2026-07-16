import "server-only";

import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_PREFIX = "scrypt";

export async function verifyPassword(password: string, passwordHash: string) {
  const [prefix, saltHex, keyHex] = passwordHash.split(":");
  if (prefix !== PASSWORD_PREFIX || !saltHex || !keyHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const storedKey = Buffer.from(keyHex, "hex");
  const candidateKey = (await scrypt(password, salt, storedKey.length)) as Buffer;

  if (storedKey.length !== candidateKey.length) {
    return false;
  }

  return timingSafeEqual(storedKey, candidateKey);
}
