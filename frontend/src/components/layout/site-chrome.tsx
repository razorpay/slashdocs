import { Link } from "react-router-dom";
import { Logo } from "./logo";

export const REPO_URL = "https://github.com/razorpay/slashdocs";
export const SELF_HOSTING_URL = `${REPO_URL}/blob/master/docs/self-hosting.md`;

export const siteLink =
  "whitespace-nowrap rounded-md px-3 py-2 text-sm text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]";

// The header and footer of the public pages (landing and sign in).
export function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
      <Link to="/" aria-label="slashdocs home">
        <Logo className="h-4 w-auto sm:h-5" />
      </Link>
      <nav className="-mr-3 flex items-center gap-1">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className={siteLink}>
          <GithubIcon /> GitHub
        </a>
        {children}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--color-border)]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-8 text-sm text-[var(--color-fg-muted)]">
        <span>slashdocs is open source under the MIT License.</span>
        <nav className="-mx-3 flex flex-wrap">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={siteLink}>
            Source
          </a>
          <a
            href={SELF_HOSTING_URL}
            target="_blank"
            rel="noreferrer"
            className={siteLink}
          >
            Self-hosting
          </a>
          <a href="/api-docs" className={siteLink}>
            API docs
          </a>
        </nav>
      </div>
    </footer>
  );
}

function GithubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="mr-1.5 inline h-4 w-4 align-[-3px]"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.18c-3.2.7-3.87-1.36-3.87-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.07.78 2.15v3.19c0 .31.21.67.8.56C20.22 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}
