import "server-only";

import { cookies } from "next/headers";
import {
  decryptSession,
  encryptSession,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
  type SaasSessionPayload,
} from "./session-core";

export async function createSaasSession(payload: {
  currentTenantHashId: string;
  userHashId: string;
}) {
  const token = await encryptSession(payload);
  const session = await decryptSession(token);
  const cookieStore = await cookies();

  cookieStore.set(
    SESSION_COOKIE_NAME,
    token,
    getSessionCookieOptions(session?.expiresAt),
  );
}

export async function deleteSaasSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function getSaasSession(): Promise<SaasSessionPayload | null> {
  const cookieStore = await cookies();
  return decryptSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}
