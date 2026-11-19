import { lazy, Suspense, useEffect, useState } from "react";
import { api, onUnauthorized } from "./api";
import { ActivityPage } from "./pages/Activity";
import { DashboardPage } from "./pages/Dashboard";
import { PluginsPage } from "./pages/Plugins";
import { SettingsPage } from "./pages/Settings";
import { WorkflowsPage } from "./pages/Workflows";
import { Link, match, useLocation } from "./router";

// The editor pulls in the yaml and croner packages; load it only when needed.
const WorkflowEditorPage = lazy(() => import("./pages/WorkflowEditor").then((m) => ({ default: m.WorkflowEditorPage })));

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/workflows", label: "Workflows" },
  { to: "/activity", label: "Activity" },
  { to: "/plugins", label: "Plugins" },
  { to: "/settings", label: "Settings" },
];

export function App() {
  const { path, search } = useLocation();
  const [user, setUser] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => onUnauthorized(() => setSignedOut(true)), []);
  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.identity.name))
      .catch(() => {});
  }, []);

  let page;
  let m: Record<string, string> | null;
  if (path === "/" || path === "") page = <DashboardPage />;
  else if (path === "/workflows") page = <WorkflowsPage />;
  else if ((m = match("/workflows/:id", path))) page = <WorkflowEditorPage key={m.id} id={m.id} isNew={search.get("new") === "1"} />;
  else if (path === "/activity") page = <ActivityPage />;
  else if (path === "/plugins") page = <PluginsPage />;
  else if ((m = match("/plugins/:name", path))) page = <PluginsPage selected={m.name} />;
  else if (path === "/settings") page = <SettingsPage />;
  else
    page = (
      <div className="card">
        <h1>Not found</h1>
        <p>
          There is no page at <code>{path}</code>. <Link to="/">Go to the dashboard</Link>.
        </p>
      </div>
    );

  const section = "/" + (path.split("/")[1] ?? "");
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          Jeeves
        </Link>
        <nav>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={section === n.to ? "active" : undefined} aria-current={section === n.to ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <span className="user muted small">{user ? `Signed in as ${user}` : ""}</span>
      </header>
      {signedOut && (
        <div className="notice warn banner" role="alert">
          You are signed out. <a href={window.location.href}>Reload to sign in</a> again; unsaved changes on this page will be lost.
        </div>
      )}
      <main>
        <Suspense fallback={<div className="muted small">Loading…</div>}>{page}</Suspense>
      </main>
    </>
  );
}
