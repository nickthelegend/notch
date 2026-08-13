/**
 * Skills — SKILL.md context blocks injected into an agent's system prompt.
 *
 * A skill is a directory `skills/<id>/SKILL.md` with YAML frontmatter (name,
 * description) and a markdown body. Enabled skills (per project, in
 * .loom/config.json) get their bodies prepended to the briefing so every agent
 * follows the same conventions/procedures. Plus a keyword matcher that suggests
 * a relevant skill as the user types.
 */

import fs from "node:fs";
import path from "node:path";

export interface SkillManifest {
  id: string; // the directory name
  name: string;
  description: string;
  path: string;
  body: string;
  enabled: boolean;
}

/** Split a SKILL.md into its frontmatter fields and the body after it. */
export function parseSkillMd(text: string): { name: string; description: string; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return { name: "", description: "", body: text.trim() };
  const fm = m[1]!;
  const body = (m[2] ?? "").trim();
  const field = (key: string): string => {
    // key: value  (value may be a folded `>` block continued on indented lines)
    const re = new RegExp(`^${key}\\s*:\\s*(>-?|\\|-?)?[ \\t]*(.*)$`, "m");
    const fmm = re.exec(fm);
    if (!fmm) return "";
    if (fmm[1]) {
      // folded/literal block: gather the following indented lines
      const start = fm.indexOf(fmm[0]) + fmm[0].length;
      const rest = fm.slice(start).split("\n");
      const lines: string[] = fmm[2] ? [fmm[2]] : [];
      for (const l of rest) {
        if (/^\s+\S/.test(l) || l.trim() === "") lines.push(l.trim());
        else break;
      }
      return lines.join(" ").trim();
    }
    return fmm[2]!.replace(/^["']|["']$/g, "").trim();
  };
  return { name: field("name"), description: field("description"), body };
}

/** Scan the given roots for `<dir>/SKILL.md`, deduped by id (first root wins). */
export function loadSkills(roots: string[], enabledMap: Record<string, boolean> = {}): SkillManifest[] {
  const byId = new Map<string, SkillManifest>();
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue; // no such dir
    }
    for (const id of entries) {
      if (byId.has(id)) continue;
      const p = path.join(root, id, "SKILL.md");
      let raw: string;
      try {
        raw = fs.readFileSync(p, "utf8");
      } catch {
        continue; // no SKILL.md in this dir
      }
      const { name, description, body } = parseSkillMd(raw);
      byId.set(id, { id, name: name || id, description, path: p, body, enabled: enabledMap[id] === true });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The block prepended to a briefing for the enabled skills. Empty if none. */
export function buildSkillsBlock(skills: SkillManifest[]): string {
  const on = skills.filter((s) => s.enabled && s.body.trim());
  if (!on.length) return "";
  return `--- ACTIVE SKILLS ---\n${on.map((s) => s.body.trim()).join("\n---\n")}\n--- END ACTIVE SKILLS ---\n`;
}

/** Keyword → skill-id rules, most specific first. */
const SUGGEST_RULES: Array<{ id: RegExp; when: RegExp }> = [
  { id: /triage/i, when: /\btriage\b|why did|failing|failed|debug (the )?agent|root[- ]?cause|stall/i },
  { id: /clickhouse|generating-queries|query/i, when: /\bquery\b|clickhouse|\btraces?\b|\bspans?\b/i },
  { id: /creating-alerts|alert/i, when: /\balert\b|threshold|\bfire[sd]?\b|notify me|page me/i },
  { id: /creating-dashboards|dashboard/i, when: /dashboard/i },
];

/** The single best skill to suggest for a message, or null. */
export function suggestSkill(message: string, skills: SkillManifest[]): SkillManifest | null {
  const msg = message || "";
  if (msg.trim().length < 4) return null;
  for (const rule of SUGGEST_RULES) {
    if (!rule.when.test(msg)) continue;
    const hit = skills.find((s) => !s.enabled && rule.id.test(s.id));
    if (hit) return hit;
  }
  return null;
}
