import { describe, expect, it } from "vitest";
import type { Comment, Principal } from "@/api";
import { agentPrompt, agentRequestBody, isAgentRequest } from "./agent-request";

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

describe("agentPrompt", () => {
  const asha: Principal = { type: "user", id: "usr_1", name: "Asha" };
  const bot: Principal = { type: "service_account", id: "sa_1", name: "writer-bot" };
  const thread = (c: Partial<Comment>): Comment => ({
    id: "cmt_1",
    body: "",
    status: "open",
    author: asha,
    created_on_version_id: "ver_1",
    ...c,
  });

  it("gives each thread with what it is on and every message, by id", () => {
    const prompt = agentPrompt(
      { id: "doc_1", title: "Retry spec", url: "https://docs.example/app/d/doc_1" },
      [
        thread({
          selected_text: "three times",
          body: "Why three?\nThe data says four.",
          replies: [thread({ id: "cmt_2", author: bot, body: "Four it is." })],
        }),
        thread({
          id: "cmt_3",
          anchor: {
            quote: "",
            prefix: "",
            suffix: "",
            point: { target: "chart", label: "Revenue chart", x: 0, y: 0 },
          },
          body: "Label the axis.",
        }),
      ],
    );
    expect(prompt).toBe(
      [
        "Review comments on the slashdocs document “Retry spec” (doc_1): https://docs.example/app/d/doc_1",
        "1. Thread cmt_1 on “three times”\n   Asha: Why three?\n   The data says four.\n   writer-bot: Four it is.",
        "2. Thread cmt_3 on “Revenue chart”\n   Asha: Label the axis.",
        "Address each thread: change the document, or answer in the thread. Then reply in each thread with what you did. With the slashdocs CLI, read `slashdocs guidelines review` first.",
      ].join("\n\n"),
    );
  });

  it("names the document by its id when its title is not known", () => {
    const prompt = agentPrompt({ id: "doc_1", url: "u" }, [thread({ body: "Hi" })]);
    expect(prompt.split("\n")[0]).toBe(
      "Review comments on the slashdocs document doc_1: u",
    );
    expect(prompt).toContain("1. Thread cmt_1\n   Asha: Hi");
  });
});
