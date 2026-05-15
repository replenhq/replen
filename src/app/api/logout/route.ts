import { NextRequest } from "next/server";
import { removeAuthCookies } from "next-firebase-auth-edge/lib/next/cookies";
import { authConfig } from "@/lib/auth/config";

export async function GET(request: NextRequest) {
  return removeAuthCookies(request.headers, {
    cookieName: authConfig.cookieName,
    cookieSerializeOptions: authConfig.cookieSerializeOptions,
  });
}
