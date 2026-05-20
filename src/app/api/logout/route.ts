import { NextRequest, NextResponse } from "next/server";
import { removeAuthCookies } from "next-firebase-auth-edge/lib/next/cookies";
import { authConfig } from "@/lib/auth/config";
import { publicUrlFrom } from "@/lib/forwarded-url";

export async function GET(request: NextRequest) {
  // Clear the Firebase session cookies. removeAuthCookies returns
  // a JSON Response with the cookie-clearing Set-Cookie headers
  // attached. We want the headers + a redirect to /signed-out so the
  // user lands on a real page, not a bare JSON body.
  const cleared = await removeAuthCookies(request.headers, {
    cookieName: authConfig.cookieName,
    cookieSerializeOptions: authConfig.cookieSerializeOptions,
  });
  const target = publicUrlFrom(request, "/signed-out");
  const res = NextResponse.redirect(target);
  // Copy the Set-Cookie headers from the cleared response so the
  // browser actually drops the session cookies on this redirect.
  cleared.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") res.headers.append("set-cookie", value);
  });
  return res;
}
