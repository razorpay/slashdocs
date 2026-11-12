import { useCallback } from "react";
import { createPersistentStore } from "./persistent-store";

// The two ways to connect an agent: the CLI with its skill, or a remote MCP
// connector added inside the agent app.
export type SetupPath = "cli" | "mcp";

export type OnboardingState = {
  status: "active" | "skipped" | "complete";
  path: SetupPath;
  steps: {
    cli_installed: boolean;
    cli_authed: boolean;
    agent_configured: boolean;
    first_doc_seen: boolean;
  };
};

export type StepKey = keyof OnboardingState["steps"];

const initial: OnboardingState = {
  status: "active",
  path: "cli",
  steps: {
    cli_installed: false,
    cli_authed: false,
    agent_configured: false,
    first_doc_seen: false,
  },
};

const store = createPersistentStore<OnboardingState>(
  "slashdocs.onboarding",
  initial,
  (parsed) => {
    const p = parsed as Partial<OnboardingState>;
    return {
      status: p.status || "active",
      path: p.path === "mcp" ? "mcp" : "cli",
      steps: { ...initial.steps, ...(p.steps || {}) },
    };
  },
);

export const requiredSteps: Record<SetupPath, StepKey[]> = {
  cli: ["cli_installed", "cli_authed"],
  mcp: ["agent_configured"],
};

// Auto-completes setup once the required steps of the chosen path are done.
function settle(next: OnboardingState): OnboardingState {
  const done = requiredSteps[next.path].every((k) => next.steps[k]);
  return next.status === "active" && done ? { ...next, status: "complete" } : next;
}

export function useOnboarding() {
  const state = store.useStore();
  const setStep = useCallback((key: StepKey, value: boolean) => {
    const cur = store.read();
    store.write(settle({ ...cur, steps: { ...cur.steps, [key]: value } }));
  }, []);
  const setPath = useCallback(
    (path: SetupPath) => store.write(settle({ ...store.read(), path })),
    [],
  );
  const skip = useCallback(
    () => store.write({ ...store.read(), status: "skipped" }),
    [],
  );
  const reset = useCallback(() => store.write(initial), []);
  return { state, setStep, setPath, skip, reset };
}

export function onboardingProgress(s: OnboardingState) {
  const required = requiredSteps[s.path];
  const done = required.filter((k) => s.steps[k]).length;
  return { done, total: required.length };
}

export function onboardingActive(s: OnboardingState) {
  return s.status === "active";
}

// Marks the first-document step from the start page once documents exist.
export function autoMarkFirstDoc() {
  const cur = store.read();
  if (cur.steps.first_doc_seen) return;
  store.write({ ...cur, steps: { ...cur.steps, first_doc_seen: true } });
}
