"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { loginWithPassword, SaasAuthError } from "@/lib/server/saas";

const LoginSchema = z.object({
  account: z.string().trim().min(1, "请输入账号。"),
  password: z.string().min(1, "请输入密码。"),
});

export async function loginAction(_state: unknown, formData: FormData) {
  const validatedFields = LoginSchema.safeParse({
    account: formData.get("account"),
    password: formData.get("password"),
  });

  if (!validatedFields.success) {
    return {
      errors: validatedFields.error.flatten().fieldErrors,
      message: "请补充完整登录信息。",
    };
  }

  let tenantHashId: string;
  try {
    const tenant = await loginWithPassword(validatedFields.data);
    tenantHashId = tenant.hashId;
  } catch (error) {
    return {
      errors: {},
      message:
        error instanceof SaasAuthError || error instanceof Error
          ? error.message
          : "登录失败，请稍后重试。",
    };
  }

  redirect(`/${tenantHashId}`);
}
