import type { Comment } from "@/api";

// An agent request is a comment that asks an agent to change words, as "Ask
// an agent to change this" starts it. The comments know it by its words.
export const agentRequestBody = (quote: string) => `Please change “${quote}” to: `;

export const isAgentRequest = (body: string) =>
  /^Please change “[\s\S]*” to:/.test(body);

// agentThatSaw is the first bot that replied to or reacted to a thread,
// which tells its author that an agent saw the request.
export const agentThatSaw = (thread: Comment) =>
  [
    ...(thread.replies ?? []).map((reply) => reply.author),
    ...(thread.reactions ?? []).flatMap((reaction) => reaction.reactors ?? []),
  ].find((who) => who.type === "service_account");
