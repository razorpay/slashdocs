import { describe, expect, it } from "vitest";
import { agentRequestBody, isAgentRequest } from "./agent-request";

describe("agent requests", () => {
  it("knows the comment that Ask an agent starts, also after the reader adds words", () => {
    const body = agentRequestBody("3 open");
    expect(body).toBe("Please change “3 open” to: ");
    expect(isAgentRequest(body)).toBe(true);
    expect(isAgentRequest(body + "4 open")).toBe(true);
  });

  it("does not mark other comments", () => {
    expect(isAgentRequest("Please change this paragraph.")).toBe(false);
    expect(isAgentRequest("Looks good. Please change “3 open” to: 4")).toBe(false);
  });
});
