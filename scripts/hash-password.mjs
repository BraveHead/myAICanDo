import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error("用法：bun run hash-password <password>");
  process.exit(1);
}

const salt = randomBytes(16);
const key = scryptSync(password, salt, 64);

console.log(`scrypt:${salt.toString("hex")}:${key.toString("hex")}`);
