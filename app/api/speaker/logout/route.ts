import { speakerLogout } from "@/app/speaker/login/actions";

export async function POST() {
  // speakerLogout() calls redirect() internally, which throws a Next.js
  // redirect error — no return value needed here.
  await speakerLogout();
}