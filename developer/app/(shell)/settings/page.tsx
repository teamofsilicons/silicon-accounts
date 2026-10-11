/** /settings held only the telemetry choice, and the developer site records no telemetry now: old links go to the apps. */
import { redirect } from "next/navigation";

export default function Settings(): never {
  redirect("/apps");
}
