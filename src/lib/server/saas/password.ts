import "server-only";

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_PREFIX = "scrypt";
const KEY_LENGTH = 64;

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;

  return [PASSWORD_PREFIX, salt.toString("hex"), key.toString("hex")].join(":");
}

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
