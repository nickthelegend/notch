/**
 * Set up SigNoz *from* Notch — the dashboard, the alert rules, and the webhook
 * that routes those alerts back here.
 *
 * Notch already reads SigNoz (spans, health, burn) and already reacts to its
 * alerts (`POST /api/webhooks/signoz` quarantines the agent an alert names). But
 * the alerts had to be hand-built in the SigNoz UI first, and the dashboard
 * shipped as a JSON file with "import this yourself" instructions. So the
 * self-heal loop — the thing that makes this a control room rather than a
 * viewer — only worked for someone who had already done ten minutes of setup in
 * another product. This closes it: one call and the loop is wired.
 *
 * Every payload below was verified by issuing it against a live SigNoz v0.134
 * and reading the response, not by reading docs. The shapes are fussy and the
 * error messages are terse, so the notes matter:
 *
 *   - Login is `POST /api/v2/sessions/email_password` and **requires `orgID`**;
 *     without it you get `"orgID is required"`. The older `/api/v1/login` no
 *     longer exists and silently falls through to the SPA, so it answers 200
 *     with HTML — a 200 here does not mean you authenticated.
 *   - A rule must set `version: "v5"`, and v5 takes `condition.compositeQuery.queries`
 *     (an array of `{type, spec}` envelopes), *not* the older `builderQueries`
 *     map. Anything else returns a flat `"alert rule is not valid"`.
 *   - A rule with no channel is refused with `"at least one channel is required"`,
 *     so the channel has to exist first.
 *   - A channel is posted as the Alertmanager receiver itself
 *     (`{name, webhook_configs:[…]}`), not wrapped in `{name, type, data}`.
 */

import fs from "node:fs";
import path from "node:path";

export interface SignozAuth {
  /** Base URL of the SigNoz UI/API, e.g. http://localhost:8085 */
  url: string;
  email: string;
  password: string;
}

export interface ProvisionResult {
  ok: boolean;
  /** What this run actually created or found already present. */
  channel: { name: string; created: boolean } | null;
  rules: Array<{ alert: string; created: boolean }>;
  dashboard: { title: string; created: boolean } | null;
  /** Where alerts will be delivered. */
  webhookUrl: string;
  notes: string[];
}

const JSON_HEADERS = { "content-type": "application/json" };

async function sz<T>(
  auth: SignozAuth,
  jwt: string | null,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<{ status: number; json: T | null; text: string }> {
  const res = await fetch(`${auth.url.replace(/\/+$/, "")}${route}`, {
    method,
    headers: { ...JSON_HEADERS, ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  // SigNoz serves its SPA for unknown routes, so a 200 full of HTML means "that
  // endpoint does not exist" — treat it as a failure rather than parsing it.
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  let json: T | null = null;
  if (isJson) { try { json = JSON.parse(text) as T; } catch { json = null; } }
  return { status: res.status, json, text };
}

/**
 * The org this account belongs to; the login endpoint needs it explicitly.
 *
 * `/api/v2/sessions/context` is the one org lookup that is open-access — it is
 * what SigNoz's own login page calls before anyone is authenticated. `/api/v1/orgs`
 * requires a session, so using it here is circular: it answers 200 with the SPA's
 * HTML and looks like "there is no organisation" rather than "you are not logged
 * in yet".
 */
async function orgId(auth: SignozAuth): Promise<string | null> {
  const r = await sz<{ data?: { exists?: boolean; orgs?: Array<{ id?: string }> } }>(
    auth, null, "GET", `/api/v2/sessions/context?email=${encodeURIComponent(auth.email)}`,
  );
  return r.json?.data?.orgs?.[0]?.id ?? null;
}

export async function login(auth: SignozAuth): Promise<string> {
  const org = await orgId(auth);
  if (!org) throw new Error("SigNoz has no organisation yet — finish first-run setup in its UI, then retry.");
  // v0.134 answers `{data:{tokenType:"bearer", accessToken}}`; older builds used
  // `accessJwt`. Accept both rather than pinning to the one this machine runs.
  type LoginBody = { accessToken?: string; accessJwt?: string };
  const r = await sz<{ data?: LoginBody } & LoginBody>(
    auth, null, "POST", "/api/v2/sessions/email_password",
    { email: auth.email, password: auth.password, orgID: org },
  );
  const jwt = r.json?.data?.accessToken ?? r.json?.data?.accessJwt ?? r.json?.accessToken ?? r.json?.accessJwt;
  if (!jwt) throw new Error(`SigNoz login failed (${r.status}): ${r.text.slice(0, 160)}`);
  return jwt;
}

/**
 * The alert rules Notch knows how to act on.
 *
 * Each one is deliberately about the fleet, not the host: "an agent is failing"
 * and "an agent has gone slow" are the two conditions the self-heal loop can
 * actually do something about (quarantine it, hand the baton on). A CPU alert
 * would fire and leave Notch nothing to do.
 */
function ruleSet(webhookChannel: string): Array<Record<string, unknown>> {
  const base = (name: string, description: string, filter: string, target: number, agg: string) => ({
    alert: name,
    alertType: "TRACES_BASED_ALERT",
    ruleType: "threshold_rule",
    description,
    evalWindow: "5m0s",
    frequency: "1m0s",
    version: "v5",
    labels: { severity: "warning", source: "notch" },
    annotations: { summary: description },
    preferredChannels: [webhookChannel],
    condition: {
      compositeQuery: {
        queryType: "builder",
        panelType: "graph",
        queries: [{
          type: "builder_query",
          spec: {
            name: "A", signal: "traces", disabled: false, stepInterval: "60s",
            aggregations: [{ expression: agg }],
            filter: { expression: filter },
            // Grouped by agent so the alert names *which* agent to quarantine —
            // an alert that only says "something is wrong" can't drive a fix.
            groupBy: [{ name: "gen_ai.agent.id" }],
          },
        }],
      },
      op: ">", target, matchType: "1",
    },
  });

  return [
    base(
      "Notch · agent turn errors",
      "An agent's turns are failing — Notch will quarantine it and pass the baton on.",
      "has_error = true", 3, "count()",
    ),
    base(
      "Notch · agent turn latency",
      "An agent's turns have gone slow (p95 over 60s).",
      "name = 'gen_ai.agent.turn'", 60_000, "p95(duration_nano)/1000000",
    ),
  ];
}

/**
 * Create the channel, the rules and the dashboard — skipping anything already
 * there, so this is safe to run repeatedly (someone will press the button
 * twice; it should not produce two of everything).
 */
export async function provisionSignoz(
  auth: SignozAuth,
  opts: { webhookUrl: string; dashboardFile?: string; channelName?: string } = { webhookUrl: "" },
): Promise<ProvisionResult> {
  const notes: string[] = [];
  const channelName = opts.channelName ?? "notch-selfheal";
  const jwt = await login(auth);

  // ── channel ────────────────────────────────────────────────────────────
  const existingChannels = await sz<{ data?: Array<{ name?: string }> }>(auth, jwt, "GET", "/api/v1/channels");
  const haveChannel = (existingChannels.json?.data ?? []).some((c) => c.name === channelName);
  let channel: ProvisionResult["channel"] = { name: channelName, created: false };
  if (!haveChannel) {
    const r = await sz(auth, jwt, "POST", "/api/v1/channels", {
      name: channelName,
      webhook_configs: [{ send_resolved: true, url: opts.webhookUrl }],
    });
    if (r.status >= 300) {
      notes.push(`channel not created (${r.status}): ${r.text.slice(0, 140)}`);
      channel = null;
    } else {
      channel = { name: channelName, created: true };
    }
  }

  // ── rules ──────────────────────────────────────────────────────────────
  // The list endpoints are not consistent with each other: /channels and
  // /dashboards return `{data: [...]}` while /rules returns `{data: {rules: [...]}}`.
  // Accept either rather than crashing on the one that differs.
  const existingRules = await sz<{ data?: Array<{ alert?: string }> | { rules?: Array<{ alert?: string }> } }>(
    auth, jwt, "GET", "/api/v1/rules",
  );
  const rulesData = existingRules.json?.data;
  const ruleList = Array.isArray(rulesData) ? rulesData : (rulesData?.rules ?? []);
  const haveRule = new Set(ruleList.map((r) => r.alert));
  const rules: ProvisionResult["rules"] = [];
  for (const rule of ruleSet(channelName)) {
    const name = String(rule.alert);
    if (haveRule.has(name)) { rules.push({ alert: name, created: false }); continue; }
    const r = await sz(auth, jwt, "POST", "/api/v1/rules", rule);
    if (r.status >= 300) notes.push(`rule "${name}" not created (${r.status}): ${r.text.slice(0, 140)}`);
    rules.push({ alert: name, created: r.status < 300 });
  }

  // ── dashboard ──────────────────────────────────────────────────────────
  let dashboard: ProvisionResult["dashboard"] = null;
  const file = opts.dashboardFile ?? path.join(process.cwd(), "docs", "signoz-dashboard.json");
  if (fs.existsSync(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { title?: string };
      const title = doc.title ?? "Notch";
      const list = await sz<{ data?: Array<{ data?: { title?: string } }> }>(auth, jwt, "GET", "/api/v1/dashboards");
      const have = (list.json?.data ?? []).some((d) => d.data?.title === title);
      if (have) dashboard = { title, created: false };
      else {
        const r = await sz(auth, jwt, "POST", "/api/v1/dashboards", doc);
        if (r.status >= 300) notes.push(`dashboard not created (${r.status}): ${r.text.slice(0, 140)}`);
        dashboard = { title, created: r.status < 300 };
      }
    } catch (err) {
      notes.push(`dashboard file unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    notes.push(`no dashboard file at ${file}`);
  }

  return {
    ok: rules.some((r) => r.created) || rules.length > 0,
    channel, rules, dashboard, webhookUrl: opts.webhookUrl, notes,
  };
}

/**
 * Where SigNoz should POST its alerts.
 *
 * SigNoz runs in a container, so "localhost" there is the container, not this
 * machine — the webhook has to use the host gateway or the alert silently never
 * arrives and the self-heal loop looks broken rather than unwired.
 */
export function defaultWebhookUrl(port: number, host = "host.docker.internal"): string {
  return `http://${host}:${port}/api/webhooks/signoz`;
}
