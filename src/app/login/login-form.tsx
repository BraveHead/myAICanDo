"use client";

import { LogIn } from "lucide-react";
import { useActionState } from "react";
import { loginAction } from "./actions";

type LoginState = {
  errors?: {
    account?: string[];
    password?: string[];
  };
  message?: string;
};

const initialState: LoginState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, initialState);

  return (
    <form action={action} className="space-y-5">
      <div className="space-y-2">
        <label className="text-sm font-medium text-[#2a2a2a]" htmlFor="account">
          账号
        </label>
        <input
          autoComplete="username"
          className="h-11 w-full rounded-lg border border-[#dedede] bg-white px-3 text-[15px] outline-none transition-colors focus:border-[#111111]"
          id="account"
          name="account"
          placeholder="请输入账号"
          type="text"
        />
        {state.errors?.account && (
          <p className="text-sm text-red-600">{state.errors.account[0]}</p>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-[#2a2a2a]" htmlFor="password">
          密码
        </label>
        <input
          autoComplete="current-password"
          className="h-11 w-full rounded-lg border border-[#dedede] bg-white px-3 text-[15px] outline-none transition-colors focus:border-[#111111]"
          id="password"
          name="password"
          placeholder="请输入密码"
          type="password"
        />
        {state.errors?.password && (
          <p className="text-sm text-red-600">{state.errors.password[0]}</p>
        )}
      </div>

      {state.message && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700">
          {state.message}
        </div>
      )}

      <button
        className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#111111] px-4 text-[15px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        <LogIn size={18} />
        {pending ? "登录中" : "登录"}
      </button>
    </form>
  );
}
