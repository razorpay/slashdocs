import type { Comment } from "@/api";
import { anchorLabel } from "@/lib/comment-pins";
import { principalLabel } from "@/lib/principals";

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

// agentPrompt gives the open threads of a document as one message that a
// reviewer pastes to an agent: where the document is, then each thread with
// what it is on and its messages, by id, so the agent can reply in it.
export function agentPrompt(
  doc: { id: string; title?: string; url: string },
  threads: Comment[],
) {
  const name = doc.title ? `“${doc.title}” (${doc.id})` : doc.id;
  const thread = (c: Comment, i: number) => {
    const on = anchorLabel(c);
    return [
      `${i + 1}. Thread ${c.id}${on ? ` on “${on}”` : ""}`,
      ...[c, ...(c.replies ?? [])].map(
        (m) => `   ${principalLabel(m.author)}: ${m.body.replace(/\n/g, "\n   ")}`,
      ),
    ].join("\n");
  };
  return [
    `Review comments on the slashdocs document ${name}: ${doc.url}`,
    ...threads.map(thread),
    "Address each thread: change the document, or answer in the thread. Then reply in each thread with what you did. With the slashdocs CLI, read `slashdocs guidelines review` first.",
  ].join("\n\n");
}
