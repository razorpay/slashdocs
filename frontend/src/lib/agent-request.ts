// An agent request is a comment that asks an agent to change words, as "Ask
// an agent to change this" starts it. The comments know it by its words.
export const agentRequestBody = (quote: string) => `Please change “${quote}” to: `;

export const isAgentRequest = (body: string) =>
  /^Please change “[\s\S]*” to:/.test(body);
