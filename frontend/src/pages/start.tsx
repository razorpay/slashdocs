import { useTitle } from "@/lib/use-title";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, ChevronDown, Circle, PartyPopper, X } from "lucide-react";
import { publicURL } from "@/lib/config";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/layout/page";
import { beat } from "@/lib/enter";
import { CodeBlock } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { Segmented } from "@/components/ui/segmented";
import { McpConnect } from "@/components/mcp-connect";
import {
  onboardingProgress,
  requiredSteps,
  useOnboarding,
  type OnboardingState,
  type SetupPath,
  type StepKey,
} from "@/lib/onboarding";

const PATHS: { value: SetupPath; label: string }[] = [
  { value: "cli", label: "Terminal (CLI)" },
  { value: "mcp", label: "Agent app (MCP)" },
];

export function StartPage() {
  useTitle("Get started");
  const { state, setStep, setPath, skip } = useOnboarding();
  const loginCmd = `slashdocs auth login ${publicURL()}`;
  const { done, total } = onboardingProgress(state);
  const nav = useNavigate();

  const skipTutorial = () => {
    skip();
    nav("/app/documents");
  };
  // The first incomplete step opens by default.
  const open = [...requiredSteps[state.path], "first_doc_seen" as const].find(
    (k) => !state.steps[k],
  );
  const step = { state, setStep, open };

  return (
    <Page lane="focus" backdrop="halo">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={skipTutorial}>
          Skip tutorial <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <header className="pb-10 pt-6 text-center md:pt-10">
        <p className="enter text-lg text-[var(--color-fg-muted)]">
          Setup guide · about 2 minutes
        </p>
        <h1
          className="enter mt-2 text-[32px] font-normal leading-tight tracking-[-0.02em] md:text-[40px]"
          style={beat(1)}
        >
          Get your agent publishing to slashdocs
        </h1>
        <p
          className="enter mx-auto mt-3 max-w-xl text-sm text-[var(--color-fg-muted)]"
          style={beat(2)}
        >
          slashdocs is meant to be driven by your AI agent — Claude Code, Codex, Cursor,
          Pi, OpenCode, Aider, or anything else. These steps wire it up.
        </p>
      </header>

      {done === total && state.status !== "skipped" && (
        <div className="glass-card enter mb-6 flex items-center gap-4 rounded-lg p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
            <PartyPopper className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <div className="font-heading font-medium">You're all set.</div>
            <div className="text-sm text-[var(--color-fg-muted)]">
              Ask your agent to publish something to slashdocs. It'll show up here.
            </div>
          </div>
          <Button asChild size="sm">
            <Link to="/app/documents">
              Open documents <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      )}

      <Segmented
        label="Setup path"
        value={state.path}
        onChange={setPath}
        options={PATHS}
        className="enter mb-4"
      />

      <div
        className="enter mb-4 flex items-center gap-3 text-xs text-[var(--color-fg-muted)]"
        style={beat(3)}
      >
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-muted)] ring-1 ring-[var(--color-border)] dark:ring-transparent">
          <div
            className="h-full rounded-full bg-[image:var(--razorsense-border)] bg-[length:240%_100%] transition-[width] duration-500 ease-[var(--ease-slash)]"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
        <span className="font-mono tabular-nums">
          {done}/{total} complete
        </span>
      </div>

      <ol className="enter space-y-3" style={beat(4)}>
        {state.path === "mcp" ? (
          <Step
            n={1}
            title="Add slashdocs to your agent app"
            stepKey="agent_configured"
            {...step}
          >
            <McpConnect />
          </Step>
        ) : (
          <>
            <Step
              n={1}
              title="Install the CLI and slashdocs skill"
              stepKey="cli_installed"
              {...step}
            >
              <p className="mb-3 text-sm text-[var(--color-fg-muted)]">
                One-time, on the machine where your agent runs. This installs the
                slashdocs CLI plus the bundled agent skill, so your agent knows when to
                publish docs to slashdocs.
              </p>
              <CodeBlock>{`curl -fsSL ${publicURL()}/install.sh | sh`}</CodeBlock>
              <p className="mt-3 text-xs text-[var(--color-fg-muted)]">
                Works on macOS and Linux. The skill is fetched from this slashdocs
                server and installed into the standard agent skills directory and
                Claude's skills directory — no GitHub auth or npx step required.
              </p>
            </Step>

            <Step
              n={2}
              title="Sign in once from your terminal"
              stepKey="cli_authed"
              {...step}
            >
              <p className="mb-3 text-sm text-[var(--color-fg-muted)]">
                One-time. After this, your agent can publish documents on your behalf —
                no keys or tokens to copy around.
              </p>
              <CodeBlock>{loginCmd}</CodeBlock>
            </Step>
          </>
        )}

        <Step
          n={requiredSteps[state.path].length + 1}
          title="Try it end-to-end"
          stepKey="first_doc_seen"
          {...step}
          optional
        >
          <TryItOut path={state.path} />
        </Step>
      </ol>
    </Page>
  );
}

function Step({
  n,
  title,
  stepKey,
  state,
  setStep,
  open,
  optional,
  children,
}: {
  n: number;
  title: string;
  stepKey: StepKey;
  state: OnboardingState;
  setStep: (k: StepKey, v: boolean) => void;
  open?: StepKey;
  optional?: boolean;
  children: React.ReactNode;
}) {
  const done = state.steps[stepKey];
  const [forced, setForced] = useState<boolean | null>(null);
  const expanded = forced ?? open === stepKey;
  return (
    <li>
      <div
        className={cn(
          "glass-card rounded-lg transition-shadow",
          expanded && !done && "razorsense-ring",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setForced((v) => (v === null ? !expanded : !v))}
          className="flex w-full items-center gap-3 px-5 py-4 text-left"
        >
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs",
              done
                ? "bg-[var(--color-success)] text-white"
                : "bg-[var(--color-surface)] text-[var(--color-fg-muted)] ring-1 ring-[var(--color-border)]",
            )}
          >
            {done ? <Check className="h-4 w-4" /> : n}
          </span>
          <span
            className={cn(
              "flex-1 font-heading font-medium",
              done && "text-[var(--color-fg-muted)]",
            )}
          >
            {title}
            {optional && (
              <span className="ml-2 rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-sans text-[11px] font-normal text-[var(--color-fg-muted)]">
                optional
              </span>
            )}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-[var(--color-fg-muted)] transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        {expanded && (
          <div className="px-5 pb-5 pl-[60px]">
            {children}
            <div className="mt-4 flex justify-end">
              {done ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep(stepKey, false)}
                >
                  <Circle className="h-3.5 w-3.5" /> Mark incomplete
                </Button>
              ) : (
                <Button size="sm" onClick={() => setStep(stepKey, true)}>
                  <Check className="h-3.5 w-3.5" /> Mark done
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

const TRY_IT_PROMPT = `Write an explainer, "How GPS knows where you are", for technical readers who are not GPS experts. Cover:
- how a receiver finds its position from the distances to four satellites
- why the satellite clocks must agree to a few nanoseconds
- why relativity makes those clocks drift, and how the system corrects it

Make it visual. Use as many diagrams and illustrations as the story needs. For example:
- circles that grow from three satellites and meet at one point
- a slider that turns a clock error in nanoseconds into a position error in meters
- two clocks, one on the ground and one in orbit, that drift apart by 38 microseconds a day
- a map pin that wanders about 10 km a day when nobody corrects the drift

These are ideas, not a checklist. Use your creative liberty and add your own touch.

`;

const PUBLISH: Record<SetupPath, string> = {
  cli: `Run "slashdocs guidelines" first and follow it. Then publish the explainer with the slashdocs CLI and give me the document URL.`,
  mcp: `Read the slashdocs authoring guidelines first and follow them. Then publish the explainer to slashdocs and give me the document URL.`,
};

function TryItOut({ path }: { path: SetupPath }) {
  return (
    <div>
      <p className="mb-3 text-sm text-[var(--color-fg-muted)]">
        Copy this prompt into your agent. It writes an illustrated explainer and
        publishes it to slashdocs.
      </p>
      <CodeBlock wrap>{TRY_IT_PROMPT + PUBLISH[path]}</CodeBlock>
    </div>
  );
}
