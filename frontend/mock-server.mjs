/**
 * Dev-only mock server for the document comment navigation flow.
 *
 * The mock handles /v1/* itself and proxies all frontend assets/routes to Vite,
 * keeping the rendered document bridge and app on a single origin.
 *
 * Usage:
 *   npm run dev
 *   npm run mock
 *   open http://localhost:8080/app/d/testdoc
 */
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = process.env.MOCK_PORT || "8080";
const VITE_PORT = process.env.VITE_PORT || "5173";
const APP_ORIGIN = `http://localhost:${MOCK_PORT}`;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;

const ME = {
  type: "user",
  id: "dev-1",
  email: "dev@local.test",
  name: "Dev User",
};

const REVIEWER = {
  type: "user",
  id: "dev-2",
  email: "reviewer@local.test",
  name: "Reviewer",
};

const COMMENT_ANCHORS = [
  ["c1", 3, "ANCHOR-C01 approval gateway baseline"],
  ["c2", 6, "ANCHOR-C02 rollout ownership matrix"],
  ["c3", 9, "ANCHOR-C03 nightly reconciliation window"],
  ["c4", 12, "ANCHOR-C04 event schema compatibility"],
  ["c5", 16, "ANCHOR-C05 retry budget threshold"],
  ["c6", 20, "ANCHOR-C06 reconciliation backfill path"],
  ["c7", 24, "ANCHOR-C07 consumer lag alerting"],
  ["c8", 28, "ANCHOR-C08 audit evidence retention"],
  ["c9", 32, "ANCHOR-C09 disaster recovery rehearsal"],
  ["c10", 36, "ANCHOR-C10 operational handoff checklist"],
  ["c11", 40, "ANCHOR-C11 rate limit migration guardrail"],
  ["c12", 44, "ANCHOR-C12 final launch decision record"],
];

function fixtureSection(index) {
  const anchor = COMMENT_ANCHORS.find(([, section]) => section === index);
  const anchorText = anchor ? anchor[2] : "";
  return `<section>
    <h2>Section ${index}: Launch Readiness Area</h2>
    <p>
      This section captures operational context, ownership notes, rollout constraints,
      support expectations, and follow-up work for a production launch plan. The text is
      intentionally verbose so the rendered document has enough vertical space to test
      navigation between distant comment anchors and the side panel.
    </p>
    <p>
      Each team should review the measurable outcome, the escalation owner, and the
      expected remediation path. The goal is to make reviewer comments land on specific
      phrases instead of forcing readers to scan the whole document after every click.
    </p>
    ${
      anchorText
        ? `<p>The review target for this section is <strong>${anchorText}</strong>, and it should remain visible when the linked comment is activated.</p>`
        : `<p>The review target for this section is informational and has no active comment anchor.</p>`
    }
    <p>
      Additional detail: capacity planning, dependency status, data migration risk,
      release communication, rollback signals, and post-launch monitoring need to stay
      aligned across product, engineering, support, and operations.
    </p>
  </section>`;
}

const SAMPLE_USER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Large Comment Navigation Fixture</title>
  <style>
    :root { color-scheme: light dark; }
    html { scroll-behavior: smooth; }
    body {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.65;
      margin: 0 auto;
      max-width: 860px;
      padding: 40px 48px 96px;
    }
    h1 { font-size: 34px; line-height: 1.1; margin: 0 0 8px; }
    h2 {
      border-top: 1px solid rgba(148, 163, 184, 0.35);
      font-size: 22px;
      margin: 44px 0 10px;
      padding-top: 28px;
    }
    p { font-size: 16px; margin: 0 0 18px; }
    strong { font-weight: 700; }
  </style>
</head>
<body>
  <h1>Large Comment Navigation Fixture</h1>
  <p><strong>Author:</strong> Dev User | <strong>Status:</strong> In review</p>
  <p>This mock document is deliberately long and has twelve comments distributed from top to bottom.</p>
  ${Array.from({ length: 46 }, (_, index) => fixtureSection(index + 1)).join("\n")}
</body>
</html>`;

const bridgeJS = readFileSync(
  join(__dirname, "../api/internal/server/bridge.js"),
  "utf8",
);

let nextComment = COMMENT_ANCHORS.length + 1;
let nextReply = 2;

const comments = COMMENT_ANCHORS.map(([id, section, quote], index) => ({
  id,
  body: `Review comment ${index + 1}: validate the decision around section ${section} before the launch review.`,
  selected_text: quote,
  status: "open",
  author: index % 2 === 0 ? REVIEWER : ME,
  created_on_version_id: "v1",
  replies:
    index % 3 === 0
      ? [
          {
            id: `${id}r1`,
            body: "Adding this to the follow-up list for the architecture review.",
            status: "open",
            author: ME,
            created_on_version_id: "v1",
            parent_comment_id: id,
            root_comment_id: id,
          },
        ]
      : [],
}));

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function noContent(res) {
  res.writeHead(204);
  res.end();
}

function notFound(res) {
  json(res, { error: { code: "not_found", message: "Not found" } }, 404);
}

function readJSON(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function escapeAttr(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderWrapper(userHTML) {
  const appOrigin = JSON.stringify(APP_ORIGIN);
  return `<!doctype html><html><head><meta charset="utf-8"><title>aidocs render</title><style>html,body{margin:0;height:100%;overflow:hidden}#aidocs-doc{border:0;width:100%;height:100vh}</style></head><body><iframe id="aidocs-doc" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeAttr(userHTML)}"></iframe><script>window.__AIDOCS_APP_ORIGIN__=${appOrigin};(${bridgeJS})();</script></body></html>`;
}

function withPlacement(comment) {
  return {
    current_placement: {
      status: "attached",
      confidence: 1,
      matched_text: comment.selected_text || comment.anchor?.quote || "",
    },
    ...comment,
  };
}

async function route(req, res) {
  const url = new URL(req.url || "/", APP_ORIGIN);
  const path = url.pathname;
  const method = req.method || "GET";

  if (method === "GET" && path === "/v1/me") {
    return json(res, { principal: ME, user: ME });
  }

  if (method === "GET" && path === "/v1/config") {
    return json(res, {
      deployment: "public",
      org_name: "",
      everyone_label: "Anyone with the link",
    });
  }

  if (method === "GET" && path === "/v1/users") {
    return json(res, { items: [ME, REVIEWER] });
  }

  if (method === "GET" && path === "/v1/documents") {
    return json(res, {
      items: [
        {
          id: "testdoc",
          title: "Large Comment Navigation Fixture",
          owner: ME,
          current_version_id: "v1",
        },
      ],
    });
  }

  const docMatch = path.match(/^\/v1\/documents\/([^/]+)$/);
  if (method === "GET" && docMatch) {
    return json(res, {
      id: docMatch[1],
      title: "Large Comment Navigation Fixture",
      owner: ME,
      current_version_id: "v1",
    });
  }

  const versionsMatch = path.match(/^\/v1\/documents\/([^/]+)\/versions$/);
  if (method === "GET" && versionsMatch) {
    return json(res, {
      items: [
        {
          id: "v1",
          number: 1,
          document_id: versionsMatch[1],
          created_by: ME,
          change_summary: "Initial review fixture",
        },
      ],
    });
  }

  const commentsMatch = path.match(/^\/v1\/documents\/([^/]+)\/comments$/);
  if (method === "GET" && commentsMatch) {
    return json(res, { items: comments.map(withPlacement) });
  }

  if (method === "POST" && commentsMatch) {
    const body = await readJSON(req);
    const comment = {
      id: `c${nextComment++}`,
      body: body.body || "",
      selected_text: body.anchor?.quote || "",
      anchor: body.anchor,
      status: "open",
      author: ME,
      created_on_version_id: body.version_id || "v1",
      replies: [],
    };
    comments.unshift(comment);
    return json(res, withPlacement(comment), 201);
  }

  const replyMatch = path.match(
    /^\/v1\/documents\/([^/]+)\/comments\/([^/]+)\/replies$/,
  );
  if (method === "POST" && replyMatch) {
    const parent = comments.find((comment) => comment.id === replyMatch[2]);
    if (!parent) return notFound(res);
    const body = await readJSON(req);
    const reply = {
      id: `${parent.id}r${nextReply++}`,
      body: body.body || "",
      status: "open",
      author: ME,
      created_on_version_id: parent.created_on_version_id,
      parent_comment_id: parent.id,
      root_comment_id: parent.id,
    };
    parent.replies = [...(parent.replies || []), reply];
    return json(res, withPlacement(parent));
  }

  const commentMatch = path.match(/^\/v1\/documents\/([^/]+)\/comments\/([^/]+)$/);
  if (commentMatch) {
    const index = comments.findIndex((comment) => comment.id === commentMatch[2]);
    if (index < 0) return notFound(res);

    if (method === "PATCH") {
      const body = await readJSON(req);
      comments[index] = {
        ...comments[index],
        body: body.body ?? comments[index].body,
        status: body.status ?? comments[index].status,
      };
      return json(res, withPlacement(comments[index]));
    }

    if (method === "DELETE") {
      comments.splice(index, 1);
      return noContent(res);
    }
  }

  const grantsMatch = path.match(/^\/v1\/documents\/([^/]+)\/grants$/);
  if (method === "GET" && grantsMatch) {
    return json(res, { items: [] });
  }

  const accessMatch = path.match(/^\/v1\/documents\/([^/]+)\/access$/);
  if (method === "GET" && accessMatch) {
    return json(res, {
      items: [
        {
          principal: ME,
          effective_role: "owner",
          sources: [
            {
              resource_type: "document",
              resource_id: accessMatch[1],
              resource_title: "Large Comment Navigation Fixture",
              role: "owner",
            },
          ],
        },
      ],
    });
  }

  const renderTokenMatch = path.match(
    /^\/v1\/documents\/([^/]+)\/versions\/([^/]+)\/render-token$/,
  );
  if (method === "POST" && renderTokenMatch) {
    return json(res, { token: "mock-token", url: "/v1/render/mock" });
  }

  if (method === "GET" && path === "/v1/render/mock") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderWrapper(SAMPLE_USER_HTML));
    return;
  }

  return notFound(res);
}

function proxyToVite(req, res) {
  const target = new URL(req.url || "/", VITE_ORIGIN);
  const proxyReq = httpRequest(
    target,
    {
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (error) => {
    json(res, { error: { code: "vite_proxy_error", message: String(error) } }, 502);
  });
  req.pipe(proxyReq);
}

createServer((req, res) => {
  const url = new URL(req.url || "/", APP_ORIGIN);
  if (!url.pathname.startsWith("/v1/")) {
    proxyToVite(req, res);
    return;
  }
  route(req, res).catch((error) => {
    console.error(error);
    json(res, { error: { code: "mock_error", message: String(error) } }, 500);
  });
}).listen(Number(MOCK_PORT), () => {
  console.log(`Mock server: ${APP_ORIGIN}`);
  console.log(`Proxying app assets from: ${VITE_ORIGIN}`);
  console.log(`Open: ${APP_ORIGIN}/app/d/testdoc`);
});
