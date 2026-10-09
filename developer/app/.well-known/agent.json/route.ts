/** GET /.well-known/agent.json: the A2A agent card (lib/agent/card.ts). */
import { agentCard } from "@/lib/agent/card";
import { jsonResponse, preflight } from "@/lib/server/public-response";

export function GET(request: Request) {
  return jsonResponse(request, agentCard(), { maxAge: 3600 });
}

export const OPTIONS = () => preflight();
