import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { History, MessageSquareQuote, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/misc";
import {
  SELF_HOSTING_URL,
  SiteFooter,
  SiteHeader,
  siteLink,
} from "@/components/layout/site-chrome";
import { AgentLoop } from "@/components/marketing/agent-loop";
import { Architecture } from "@/components/marketing/architecture";
import {
  DeckArt,
  GitHubArt,
  MagazineArt,
  ReceiptsArt,
  ReportArt,
  ScreenerArt,
  SketchArt,
  ThemeArt,
} from "@/components/marketing/doc-art";
import { RazorSenseBackdrop } from "@/components/razorsense-backdrop";
import { cn } from "@/lib/cn";
import { publicURL } from "@/lib/config";
import { useMe } from "@/lib/hooks";
import { useTitle } from "@/lib/use-title";

// The questions an HTML host leaves open, from the launch post.
const QUESTIONS = [
  {
    icon: Users,
    title: "Who can open it?",
    body: "Give a person, a Google Group, a bot, or the whole organization the viewer, commenter, or editor role. Share a folder to share everything in it.",
  },
  {
    icon: MessageSquareQuote,
    title: "Where does feedback go?",
    body: "On the exact words. Comments stay through new versions, with replies and reactions. Agents pull them, then revise or reply.",
  },
  {
    icon: History,
    title: "Which copy is current?",
    body: "Each push makes a version that never changes. You can roll back to any earlier version.",
  },
  {
    icon: ShieldCheck,
    title: "Is it safe to open?",
    body: "Documents render in a locked iframe on a separate origin. One bridge, which the platform controls, decides what a document can do.",
  },
];

// What the bridge does for the reader. The agent writes the code for it.
const BRIDGE = [
  {
    art: <ReceiptsArt />,
    title: "Documents that remember",
    body: "Clicks, checkboxes, and answers save to the document. Every reader sees the same state.",
    uses: ["Trackers", "Approvals", "Checklists", "Read receipts"],
  },
  {
    art: <GitHubArt />,
    title: "Live files from GitHub",
    body: "A document shows a file straight from a repository, so it stays current when the file changes.",
    uses: ["OpenAPI specs", "READMEs", "Repository data"],
  },
  {
    art: <ThemeArt />,
    title: "Your theme, diagrams included",
    body: "The document follows the reader's light or dark theme. Diagrams switch too, so every line stays readable.",
    uses: ["Text", "Tables", "SVG diagrams"],
  },
];

const CONNECT = [
  {
    title: "CLI and skill",
    body: "One command installs the CLI and a skill for Claude Code and other agents. The CLI covers everything the web app does.",
    code: `curl -fsSL ${publicURL()}/install.sh | sh
slashdocs auth login ${publicURL()}
slashdocs docs create report.html --title "Q3 incident review"`,
  },
  {
    title: "Remote MCP",
    body: "For agents without a terminal.",
    code: `claude mcp add --transport http slashdocs \\
  ${publicURL()}/mcp`,
  },
  {
    title: "Bots",
    body: "A bot has its own address, its own keys, and its own role on each document. Scheduled jobs and cloud agents publish as bots.",
    code: `slashdocs sa create nightly-reports
slashdocs sa key create sa_123
# In CI, set SLASHDOCS_TOKEN to the key, then:
slashdocs docs create report.html --title "Nightly report"`,
  },
];

const h2 = "text-3xl font-semibold tracking-[-0.02em] md:text-5xl";
const lead = "max-w-[60ch] text-lg text-[var(--color-fg-muted)]";
// Slash's card: a hairline in light, a borderless lift in dark.
const card =
  "min-w-0 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] dark:border-transparent";

export function LandingPage() {
  useTitle();
  const me = useMe();
  if (me.data) return <Navigate to="/app/documents" replace />;
  return (
    <div className="relative isolate min-h-full overflow-x-clip bg-[var(--color-bg)]">
      <RazorSenseBackdrop framing="halo" className="h-[600px]" />
      <SiteHeader>
        <a
          href={SELF_HOSTING_URL}
          target="_blank"
          rel="noreferrer"
          className={cn(siteLink, "max-sm:hidden")}
        >
          Self-hosting
        </a>
        <Link to="/login" className={siteLink}>
          Sign in
        </Link>
      </SiteHeader>
      <main>
        <section className="mx-auto max-w-6xl px-6 pb-24 pt-12 md:pt-20">
          <div className="mx-auto max-w-3xl text-center">
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--color-accent)]">
              Open source, self-hosted
            </p>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.05] tracking-[-0.02em] md:text-6xl">
              The collaborative workspace for agentic organizations.
            </h1>
            <p className={cn(lead, "mx-auto mt-6 md:text-xl")}>
              Agents choose the words and the form: the layout, the visuals, and how the
              document behaves. People comment in the browser. Agents read the comments
              and publish the next version.
            </p>
            <div className="mx-auto mt-10 flex max-w-xl flex-col gap-3 sm:flex-row sm:items-center">
              <CodeBlock className="min-w-0 flex-1 bg-[var(--color-surface)] text-left">{`curl -fsSL ${publicURL()}/install.sh | sh`}</CodeBlock>
              <Button asChild size="lg">
                <Link to="/login">Sign in</Link>
              </Button>
            </div>
          </div>
          <div className="mt-16 md:mt-20">
            <AgentLoop />
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24 md:pb-32">
          <h2 className={h2}>What agents make when the format is open.</h2>
          <p className={cn(lead, "mt-6")}>
            Each document is one HTML file, so it can be anything a web page can be.
          </p>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            <Shot art={<ReportArt />} title="A report that updates itself" wide>
              Agents keep live documents up to date on a schedule. Nobody updates them
              by hand.
            </Shot>
            <Shot art={<DeckArt />} title="A slide deck">
              Slides with much more flexible animations, and much faster for agents to
              make.
            </Shot>
            <Shot art={<MagazineArt />} title="A magazine">
              Release a magazine after an event.
            </Shot>
            <Shot art={<SketchArt />} title="An animated PR explainer" wide>
              A hand-drawn diagram of the change, attached to the pull request, so
              reviewers understand it faster.
            </Shot>
          </div>
        </section>

        <section className="border-y border-[var(--color-border)] bg-[var(--color-surface-muted)]">
          <div className="mx-auto grid max-w-6xl gap-14 px-6 py-24 md:grid-cols-[5fr_6fr] md:gap-20 md:py-32">
            <div className="md:sticky md:top-24 md:self-start">
              <h2 className={h2}>More than a link to an HTML file.</h2>
              <p className={cn(lead, "mt-6")}>
                A host gives you a link. A team needs four more answers, and the agent
                needs a place in the conversation.
              </p>
            </div>
            <ol className="grid gap-12">
              {QUESTIONS.map((q) => (
                <li key={q.title} className="grid grid-cols-[auto_1fr] gap-x-5">
                  <span className="grid h-10 w-10 place-items-center rounded-sm bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
                    <q.icon className="h-5 w-5" strokeWidth={1.75} />
                  </span>
                  <div>
                    <h3 className="text-xl font-semibold tracking-[-0.02em] md:text-2xl">
                      {q.title}
                    </h3>
                    <p className="mt-2 text-[var(--color-fg-muted)]">{q.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-24 md:py-32">
          <h2 className={h2}>HTML that does more than display.</h2>
          <p className={cn(lead, "mt-6")}>
            The platform gives each document a small bridge. A document can keep state,
            read from GitHub, and follow the reader's theme.
          </p>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {BRIDGE.map((b) => (
              <Shot key={b.title} art={b.art} title={b.title}>
                {b.body}
                <ul className="mt-4 flex flex-wrap gap-1.5">
                  {b.uses.map((use) => (
                    <li
                      key={use}
                      className="rounded-full bg-[var(--color-surface-muted)] px-2.5 py-1 text-xs text-[var(--color-fg)] ring-1 ring-[var(--color-border)] dark:ring-transparent"
                    >
                      {use}
                    </li>
                  ))}
                </ul>
              </Shot>
            ))}
          </div>
          <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
            Also: Vim keys to scroll, live presence to follow a reader, and Export as
            PDF with the live state of the document.
          </p>
        </section>

        <section className="border-t border-[var(--color-border)]">
          <div className="mx-auto max-w-6xl px-6 py-24 md:py-32">
            <h2 className={h2}>Anything a person can do, an agent can do.</h2>
            <div className="mt-12 grid gap-8 md:grid-cols-2 md:items-center md:gap-12">
              <Connect />
              <Shot art={<ScreenerArt />} title="A bot that reviews">
                A screener bot commented on every Day 0 hackathon idea. Teams pushed new
                versions, and the bot read them again.
              </Shot>
            </div>
          </div>
        </section>

        <section className="border-t border-[var(--color-border)]">
          <div className="mx-auto max-w-6xl px-6 py-24 md:py-32">
            <h2 className={h2}>Run it on your own servers.</h2>
            <p className={cn(lead, "mt-6")}>
              Your documents and your data stay with you. slashdocs is MIT licensed.
            </p>
            <div className="mt-12">
              <Architecture />
            </div>
            <div className="mt-12 grid gap-8 md:grid-cols-2 md:gap-12">
              <Start title="Try it with Docker Compose">{`git clone https://github.com/razorpay/slashdocs.git
cd slashdocs
docker compose up`}</Start>
              <Start title="Run it in a cluster with Helm">{`helm upgrade --install slashdocs ./charts/slashdocs \\
  --namespace slashdocs --create-namespace -f values.yaml`}</Start>
            </div>
            <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
              Compose starts slashdocs with Postgres, versitygw (S3), and a local Dex
              sign-in. For production, read the{" "}
              <a
                href={SELF_HOSTING_URL}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--color-fg)] underline underline-offset-2"
              >
                self-hosting guide
              </a>
              .
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

// A real document as a card: its drawing on top, what it shows below.
function Shot({
  art,
  title,
  wide,
  className,
  children,
}: {
  art: React.ReactNode;
  title: string;
  wide?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <figure className={cn(card, "group", wide && "md:col-span-2", className)}>
      {art}
      <figcaption className="p-5 md:p-6">
        <h3 className="text-lg font-semibold tracking-[-0.02em]">{title}</h3>
        <div className="mt-1 text-sm text-[var(--color-fg-muted)]">{children}</div>
      </figcaption>
    </figure>
  );
}

// One way to start slashdocs, with its commands.
function Start({ title, children }: { title: string; children: string }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-medium text-[var(--color-fg-muted)]">{title}</h3>
      <CodeBlock className="mt-3 bg-[var(--color-surface)]">{children}</CodeBlock>
    </div>
  );
}

// Each way to connect an agent, with the commands for the selected one.
function Connect() {
  const [active, setActive] = useState(0);
  const c = CONNECT[active];
  return (
    <div className="min-w-0">
      <div
        role="tablist"
        aria-label="Ways to connect an agent"
        className="flex w-fit gap-0.5 rounded-sm bg-[var(--color-surface-muted)] p-0.5 ring-1 ring-[var(--color-border)] dark:ring-transparent"
      >
        {CONNECT.map((t, i) => (
          <button
            key={t.title}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className="rounded-[6px] px-3 py-1.5 text-sm text-[var(--color-fg-muted)] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] aria-selected:bg-[var(--color-surface)] aria-selected:text-[var(--color-fg)] aria-selected:shadow-[var(--shadow-border)]"
          >
            {t.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" key={active} className="mt-6 animate-[rise_300ms_ease-out]">
        <p className="text-[var(--color-fg-muted)]">{c.body}</p>
        <CodeBlock className="mt-4 bg-[var(--color-surface)]">{c.code}</CodeBlock>
      </div>
    </div>
  );
}
