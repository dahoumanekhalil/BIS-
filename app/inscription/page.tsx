import { redirect } from "next/navigation";

/**
 * Legacy route — the registration experience now lives under /register with
 * a visitor / company selection. This preserves outbound links.
 */
export default function InscriptionLegacyRedirect() {
  redirect("/register");
}
