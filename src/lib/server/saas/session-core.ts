import { jwtVerify, SignJWT, type JWTPayload } from "jose";

export const SESSION_COOKIE_NAME = "my_ai_can_do_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type SaasSessionPayload = JWTPayload & {
  currentTenantHashId: string;
  expiresAt: string;
  userHashId: string;
};

export async function encryptSession(payload: {
  currentTenantHashId: string;
  userHashId: string;
}) {
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  return new SignJWT({
    currentTenantHashId: payload.currentTenantHashId,
    expiresAt: expiresAt.toISOString(),
    userHashId: payload.userHashId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getEncodedSessionSecret());
}

export async function decryptSession(
  token: string | undefined,
): Promise<SaasSessionPayload | null> {
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getEncodedSessionSecret(), {
      algorithms: ["HS256"],
    });

    if (!isSessionPayload(payload)) {
      return null;
    }

    if (new Date(payload.expiresAt).getTime() <= Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function getSessionCookieOptions(expiresAt?: string) {
  return {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    ...(expiresAt ? { expires: new Date(expiresAt) } : {}),
  };
}

function getEncodedSessionSecret() {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("未配置 SESSION_SECRET，无法创建或校验登录会话。");
  }

  return new TextEncoder().encode(secret);
}

function isSessionPayload(payload: JWTPayload): payload is SaasSessionPayload {
  return (
    typeof payload.userHashId === "string" &&
    Boolean(payload.userHashId.trim()) &&
    typeof payload.currentTenantHashId === "string" &&
    Boolean(payload.currentTenantHashId.trim()) &&
    typeof payload.expiresAt === "string" &&
    Number.isFinite(new Date(payload.expiresAt).getTime())
  );
}
