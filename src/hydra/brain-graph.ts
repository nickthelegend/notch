/**
 * The brain, as a graph.
 *
 * `core/brain.ts` owns what a memory *is* and folds the log into current state.
 * This owns what memories are *connected to*, which is the half a table cannot
 * hold and the half that changes what gets recalled.
 *
 * Retrieval before this was entities ∪ BM25 — two lexical channels. Both can
 * only find a memory that shares a literal string with the query. The memory
 * that matters most usually doesn't:
 *
 *     "the retry loop in src/daemon/runtime.ts is hanging"
 *
 * BM25 finds memories that say `runtime.ts`. What you actually need is the
 * failure recorded three weeks ago — *"the adapter never emits run_complete
 * when the child is SIGKILLed"* — which does not contain the word `runtime`,
 * was learned by a different agent, in a different chat, about a different
 * file. It is reachable in two hops: the failure was CAUSED_BY a decision that
 * is ABOUT `src/daemon/runtime.ts`. No amount of lexical scoring gets there;
 * one bounded traversal does.
 *
 * So there are now three channels, and the third is the graph:
 *
 *   entities  exact literal match          (precision)
 *   BM25      lemmatised lexical scoring   (recall)
 *   connected bounded path from the work's entities over ABOUT / CAUSED_BY /
 *             CONSTRAINED_BY / SUPERSEDES  (the ones the words miss)
 *
 * `Entity` nodes are deliberately **not** project-scoped. A constraint about
 * `src/core/baton.ts` learned in one run is about the same file in the next
 * one, which is what makes `crossRun()` possible at all: memory that outlives
 * the session it was learned in, without a second store to sync.
 */

import type { Memory, MemoryKind } from "../core/brain.js";
import type { ProjectGraph } from "./graph.js";
import { LABEL, REL, relId } from "./graph.js";
import { cypherString, type HydraPath } from "./client.js";
import { kindOf } from "./ids.js";

/** Two memories learned this close together, in one conversation, are plausibly
 * about the same problem. The weakest of the three inference tiers, and the
 * only one that uses time rather than content. */
const NEARBY_MS = 10 * 60 * 1000;

/**
 * Distinctive terms from a memory's lemmas.
 *
 * Short tokens carry no signal — "the", "run", "set" match everything — so the
 * floor keeps tier 2 from linking two memories because they both said "file".
 */
function terms(lemmas: string): Set<string> {
  return new Set(lemmas.split(/\s+/).filter((t) => t.length >= 5));
}

/** Edges a recall traversal is allowed to walk. */
const RECALL_RELS = [REL.about, REL.causedBy, REL.constrainedBy, REL.supersedes];

export interface ConnectedHit {
  memoryId: string;
  /** Hops from the nearest query entity. 1 = directly about it. */
  hops: number;
  /** The entity the path started from — why this surfaced. */
  via: string;
  /** The memory ids walked through to reach it, nearest-first. */
  path: string[];
}

export interface CausalLink {
  from: string;
  to: string;
  rel: "CAUSED_BY" | "CONSTRAINED_BY" | "SUPERSEDES";
  /** Why the edge exists: the shared entity that justified it, or "asserted". */
  basis: string;
}

export interface CausalNode {
  memoryId: string;
  kind: MemoryKind | string;
  text: string;
  agent: string;
  at: number;
}

export interface CausalChain {
  /** Nearest-first: the failure, then what caused it, then what constrained that. */
  nodes: CausalNode[];
  links: CausalLink[];
  /** The Cypher that produced this, so the UI can show its work. */
  cypher: string;
}

export class BrainGraph {
  /** Memory ids already projected in this process, to skip redundant writes. */
  private projected = new Set<string>();

  constructor(private graph: ProjectGraph) {}

  // -------------------------------------------------------------------------
  // Projection — log → graph
  // -------------------------------------------------------------------------

  /**
   * Mirror memories into the graph.
   *
   * This is an index, not a second source of truth: every field written here
   * comes from a `memory_add` / `memory_update` event, and dropping the whole
   * projection and rebuilding it from the log is always safe.
   */
  async sync(memories: Memory[], opts: { force?: boolean } = {}): Promise<number> {
    await this.graph.open();
    const todo = opts.force ? memories : memories.filter((m) => !this.projected.has(sig(m)));
    if (!todo.length) return 0;

    const rows = [];
    for (const m of todo) {
      rows.push({
        id: await this.graph.memoryVid(m.id),
        mid: m.id,
        kind: m.kind,
        text: m.text.slice(0, 8000),
        agent: m.provenance.agentId,
        conf: m.confidence,
        created: m.createdAt,
        updated: m.updatedAt,
        expires: m.expiresAt ?? 0,
        chat: m.scope.chat ?? "",
        proj: this.graph.slot,
        ev: m.provenance.eventId,
      });
    }
    await this.graph.client.query(
      "UNWIND $rows AS row MERGE (m {id: row.id}) SET m:" +
        LABEL.memory +
        ", m.mid = row.mid, m.kind = row.kind, m.text = row.text, m.agent = row.agent, " +
        "m.conf = row.conf, m.created = row.created, m.updated = row.updated, " +
        "m.expires = row.expires, m.chat = row.chat, m.proj = row.proj, m.ev = row.ev",
      { rows },
    );

    // Agents, and who asserted what.
    const agentRows = new Map<string, number>();
    for (const m of todo) {
      const a = m.provenance.agentId;
      if (!agentRows.has(a)) agentRows.set(a, await this.graph.agentVid(a));
    }
    await this.graph.client.upsertNodes(
      LABEL.agent,
      [...agentRows].map(([aid, id]) => ({ id, aid, proj: this.graph.slot })),
      ["aid", "proj"],
    );
    await this.graph.client.relate(
      LABEL.project,
      REL.hasAgent,
      LABEL.agent,
      [...agentRows].map(([, id]) => ({
        src: this.graph.vid,
        dst: id,
        rid: relId(this.graph.vid, id, REL.hasAgent),
      })),
    );
    await this.graph.client.relate(
      LABEL.agent,
      REL.asserted,
      LABEL.memory,
      await Promise.all(
        todo.map(async (m) => {
          const src = agentRows.get(m.provenance.agentId)!;
          const dst = await this.graph.memoryVid(m.id);
          return { src, dst, rid: relId(src, dst, REL.asserted) };
        }),
      ),
    );

    // Entities, and what each memory is about. This is the edge recall walks.
    const entityRows = new Map<string, number>();
    const aboutRows: { src: number; dst: number; rid: number }[] = [];
    for (const m of todo) {
      const mv = await this.graph.memoryVid(m.id);
      for (const raw of m.entities.slice(0, 40)) {
        const name = raw.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!entityRows.has(key)) entityRows.set(key, await this.graph.entityVid(key));
        const ev = entityRows.get(key)!;
        aboutRows.push({ src: mv, dst: ev, rid: relId(mv, ev, REL.about) });
      }
    }
    if (entityRows.size) {
      await this.graph.client.upsertNodes(
        LABEL.entity,
        [...entityRows].map(([name, id]) => ({ id, name })),
        ["name"],
      );
      await this.graph.client.relate(LABEL.memory, REL.about, LABEL.entity, aboutRows);
    }

    // Provenance: one click from a memory back to the turn that produced it.
    await this.graph.client.relate(
      LABEL.project,
      REL.hasMemory,
      LABEL.memory,
      await Promise.all(
        todo.map(async (m) => {
          const dst = await this.graph.memoryVid(m.id);
          return { src: this.graph.vid, dst, rid: relId(this.graph.vid, dst, REL.hasMemory) };
        }),
      ),
    );

    for (const m of todo) this.projected.add(sig(m));
    return todo.length;
  }

  /** Drop the memo of what has been projected (after a forget, or in tests). */
  resetProjectionCache(): void {
    this.projected.clear();
  }

  /** Remove a forgotten memory from the index. The log keeps every byte. */
  async unproject(memoryId: string): Promise<void> {
    const mv = await this.graph.memoryVid(memoryId);
    await this.graph.client.query("MATCH (m:MemoryUnit {id: $id}) DETACH DELETE m", { id: mv });
    for (const s of [...this.projected]) if (s.startsWith(`${memoryId}:`)) this.projected.delete(s);
  }

  // -------------------------------------------------------------------------
  // Causal structure
  // -------------------------------------------------------------------------

  /**
   * Record that one memory explains another.
   *
   * `failure -CAUSED_BY-> decision` and `decision -CONSTRAINED_BY-> constraint`
   * are the two that make the Decision Explorer a traversal. `supersedes` is
   * the correction chain, which is how a fact's provenance survives being
   * revised.
   */
  async link(
    fromMemoryId: string,
    rel: CausalLink["rel"],
    toMemoryId: string,
    /** Why this edge exists — a shared entity, or "asserted" when a human said so. */
    basis = "asserted",
  ): Promise<void> {
    const src = await this.graph.memoryVid(fromMemoryId);
    const dst = await this.graph.memoryVid(toMemoryId);
    const relName =
      rel === "CAUSED_BY" ? REL.causedBy : rel === "CONSTRAINED_BY" ? REL.constrainedBy : REL.supersedes;
    await this.graph.client.relate(
      LABEL.memory,
      relName,
      LABEL.memory,
      [{ src, dst, rid: relId(src, dst, relName), basis: basis.slice(0, 200) }],
      ["basis"],
    );
  }

  /**
   * Propose causal edges for a memory that has just been learned.
   *
   * Deterministic and explainable on purpose. The rule is narrow — a failure is
   * caused by the most recent *decision* it shares a concrete entity with; a
   * decision is constrained by the most recent *constraint* it shares one with
   * — and every edge it creates records the entity that justified it, so a
   * wrong link is visible and arguable rather than mysterious.
   *
   * No model is consulted. An LLM would propose better edges and would also
   * invent them, and an invented causal link is worse than a missing one: it
   * puts a confident wrong "why" in front of whoever is debugging. Links can
   * still be asserted explicitly through `link()` when something knows better.
   */
  async inferLinks(
    memory: Memory,
    known: Memory[],
  ): Promise<{ rel: CausalLink["rel"]; to: string; basis: string }[]> {
    const want: MemoryKind | null =
      memory.kind === "failure" ? "decision" : memory.kind === "decision" ? "constraint" : null;
    if (!want) return [];

    const mineEntities = new Set(memory.entities.map((e) => e.toLowerCase()));
    const mineTerms = terms(memory.lemmas);

    // Three tiers, strongest first. Entity overlap is near-certain evidence
    // that two memories are about the same thing; shared distinctive terms are
    // good; being learned in the same conversation minutes apart is weak but
    // real, and it is the tier that saves the common case where an agent
    // describes a failure in prose that names nothing the extractor can see.
    const scored = known
      .filter((k) => k.kind === want && k.id !== memory.id)
      .map((k) => {
        const sharedEntities = k.entities.filter((e) => mineEntities.has(e.toLowerCase()));
        if (sharedEntities.length) {
          return {
            memory: k,
            tier: 3,
            weight: sharedEntities.length,
            basis: `shared entity: ${sharedEntities.slice(0, 3).join(", ")}`,
          };
        }
        const sharedTerms = [...terms(k.lemmas)].filter((t) => mineTerms.has(t));
        if (sharedTerms.length >= 2) {
          return {
            memory: k,
            tier: 2,
            weight: sharedTerms.length,
            basis: `shared terms: ${sharedTerms.slice(0, 4).join(", ")}`,
          };
        }
        const sameChat = (k.scope.chat ?? "") === (memory.scope.chat ?? "");
        const gap = Math.abs(memory.createdAt - k.createdAt);
        if (sameChat && gap <= NEARBY_MS) {
          return {
            memory: k,
            tier: 1,
            weight: 1 - gap / NEARBY_MS,
            basis: `learned in the same conversation, ${Math.round(gap / 1000)}s apart`,
          };
        }
        return null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort(
        (a, b) =>
          b.tier - a.tier || b.weight - a.weight || b.memory.updatedAt - a.memory.updatedAt,
      );

    const pick = scored[0];
    if (!pick) return [];
    const rel: CausalLink["rel"] = memory.kind === "failure" ? "CAUSED_BY" : "CONSTRAINED_BY";
    await this.link(memory.id, rel, pick.memory.id, pick.basis);
    return [{ rel, to: pick.memory.id, basis: pick.basis }];
  }

  /**
   * Why did this actually fail?
   *
   * One bounded path query, walking causation outward from the failure. The
   * SQLite version could not express this at all: each hop was another join
   * against a table whose depth is not known until you have walked it.
   */
  async causalChain(memoryId: string, maxLen = 4): Promise<CausalChain> {
    const src = await this.graph.memoryVid(memoryId);
    const cypher =
      `CALL algo.SSpaths({sourceNode: ${src}, ` +
      `relTypes: ['${REL.causedBy}', '${REL.constrainedBy}', '${REL.supersedes}'], ` +
      `relDirection: 'outgoing', maxLen: ${maxLen}, pathCount: 64}) YIELD path RETURN path`;
    const res = await this.graph.client.query(cypher);
    const nodes = new Map<string, CausalNode>();
    const links = new Map<string, CausalLink>();
    for (const row of res.rows) {
      const p = row.path as HydraPath | undefined;
      if (!p?.nodes) continue;
      for (const n of p.nodes) {
        const mid = String(n.properties.mid ?? "");
        if (!mid) continue;
        nodes.set(mid, {
          memoryId: mid,
          kind: String(n.properties.kind ?? ""),
          text: String(n.properties.text ?? ""),
          agent: String(n.properties.agent ?? ""),
          at: Number(n.properties.updated ?? n.properties.created ?? 0),
        });
      }
      const byVid = new Map(p.nodes.map((n) => [n.id, String(n.properties.mid ?? "")]));
      for (const r of p.relationships ?? []) {
        const from = byVid.get(r.src);
        const to = byVid.get(r.dst);
        if (!from || !to) continue;
        links.set(`${from}|${r.edge_type}|${to}`, {
          from,
          to,
          rel: r.edge_type as CausalLink["rel"],
          basis: String(r.properties.basis ?? "asserted"),
        });
      }
    }
    return { nodes: [...nodes.values()], links: [...links.values()], cypher };
  }

  // -------------------------------------------------------------------------
  // Connected recall
  // -------------------------------------------------------------------------

  /**
   * Memories reachable from the entities this turn is about.
   *
   * One `algo.MSpaths` call resolves every query entity at once, rather than a
   * traversal per entity — which is the difference between one round trip and
   * twenty when a turn touches twenty files.
   */
  async connected(
    entities: string[],
    opts: { maxHops?: number; limit?: number } = {},
  ): Promise<{ hits: ConnectedHit[]; cypher: string }> {
    const names = [...new Set(entities.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(
      0,
      32,
    );
    if (!names.length) return { hits: [], cypher: "" };
    await this.graph.open();

    const maxLen = Math.max(1, Math.min(opts.maxHops ?? 3, 6));
    // `sourceValues` cannot be a parameter — HydraDB only accepts a
    // list-valued parameter as UNWIND input — so the names are escaped into
    // the literal. See `cypherString`.
    const cypher =
      `CALL algo.MSpaths({sourceLabel: 'Entity', sourceProperty: 'name', ` +
      `sourceValues: [${names.map(cypherString).join(", ")}], ` +
      `relTypes: [${RECALL_RELS.map((r) => `'${r}'`).join(", ")}], ` +
      `relDirection: 'both', maxLen: ${maxLen}, pathCount: 8, resultLimit: 400}) ` +
      `YIELD path RETURN path`;
    const res = await this.graph.client.query(cypher);

    // Nearest wins: a memory reachable in one hop and again in three is a
    // one-hop hit. Anything else would let a long path dilute a short one.
    const best = new Map<string, ConnectedHit>();
    for (const row of res.rows) {
      const p = row.path as HydraPath | undefined;
      if (!p?.nodes?.length) continue;
      const origin = p.nodes[0];
      const via = String(origin?.properties.name ?? "");
      const trail: string[] = [];
      for (let i = 1; i < p.nodes.length; i++) {
        const n = p.nodes[i]!;
        if (kindOf(n.id) !== "memory") continue;
        const mid = String(n.properties.mid ?? "");
        if (!mid) continue;
        trail.push(mid);
        const proj = Number(n.properties.proj ?? -1);
        if (proj !== this.graph.slot) continue; // cross-project: crossRun() asks for those
        const prev = best.get(mid);
        if (!prev || prev.hops > i) best.set(mid, { memoryId: mid, hops: i, via, path: [...trail] });
      }
    }
    const hits = [...best.values()]
      .sort((a, b) => a.hops - b.hops || a.memoryId.localeCompare(b.memoryId))
      .slice(0, opts.limit ?? 40);
    return { hits, cypher };
  }

  /**
   * What every past run of this project learned about these entities.
   *
   * The point of the shared `Entity` nodes. A local SQLite log could only ever
   * answer "what did *this* run learn", because its rows died with the file
   * they were in. Here the question is one traversal wider, and the answer
   * outlives the session — Track 3's cross-session continuity, without a
   * synchronisation problem.
   */
  /**
   * Entity names starting with a term.
   *
   * The structured extractor in `brain-index.ts` only recognises things that
   * *look* like identifiers — paths, filenames, CamelCase, SCREAMING_CASE. It
   * is right to be strict when it is deciding what a memory is about, but it
   * makes a plain typed word ("baton") resolve to nothing at all, which is a
   * dead end for a human with a search box.
   *
   * This closes that gap without loosening the extractor: a prefix match over
   * the entity names that actually exist. It works because file entities are
   * recorded under their basename as well as their path, so "baton" reaches
   * `baton.ts` and through it every memory about that file.
   *
   * `STARTS WITH` rather than a substring test because the Cypher subset here
   * has no `CONTAINS` — measured against the node, not assumed.
   */
  async entitiesMatching(term: string, limit = 12): Promise<string[]> {
    const t = String(term ?? "").trim().toLowerCase();
    if (t.length < 2) return [];
    await this.graph.open();
    const res = await this.graph.client.query(
      `MATCH (e:${LABEL.entity}) WHERE e.name STARTS WITH $t RETURN e.name AS name LIMIT $limit`,
      { t, limit: Math.min(50, limit) },
    );
    const out: string[] = [];
    for (const r of res.rows) {
      const n = String(r.name ?? "").trim();
      if (n) out.push(n);
    }
    return out;
  }

  async crossRun(
    entities: string[],
    opts: { limit?: number; includeThisProject?: boolean } = {},
  ): Promise<
    { memoryId: string; text: string; kind: string; agent: string; project: number; at: number }[]
  > {
    const names = [...new Set(entities.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(
      0,
      32,
    );
    if (!names.length) return [];
    await this.graph.open();
    const out = new Map<string, {
      memoryId: string;
      text: string;
      kind: string;
      agent: string;
      project: number;
      at: number;
    }>();
    for (const name of names) {
      const ev = await this.graph.entityVid(name);
      const res = await this.graph.client.query(
        "MATCH (m:MemoryUnit)-[:ABOUT]->(e:Entity {id: $ev}) " +
          "RETURN m.mid AS mid, m.text AS text, m.kind AS kind, m.agent AS agent, " +
          "m.proj AS proj, m.updated AS updated ORDER BY updated DESC LIMIT 50",
        { ev },
      );
      for (const r of res.rows) {
        const proj = Number(r.proj ?? -1);
        if (!opts.includeThisProject && proj === this.graph.slot) continue;
        const mid = String(r.mid ?? "");
        if (!mid) continue;
        // Keyed by text, not by id. The same lesson learned independently in
        // two projects is one lesson to whoever is reading it; showing it twice
        // because it has two ids is the store's problem leaking into the answer.
        const key = String(r.text ?? "").trim().toLowerCase();
        if (!key || out.has(key)) continue;
        out.set(key, {
          memoryId: mid,
          text: String(r.text ?? ""),
          kind: String(r.kind ?? ""),
          agent: String(r.agent ?? ""),
          project: proj,
          at: Number(r.updated ?? 0),
        });
      }
    }
    return [...out.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, opts.limit ?? 20);
  }

  // -------------------------------------------------------------------------
  // Handoff provenance
  // -------------------------------------------------------------------------

  /**
   * Record exactly which memories were injected into which handoff.
   *
   * Notch always projected the brain one-shot at handoff and then forgot what
   * it had sent. Writing the edge makes "what did this agent actually know when
   * it took over" answerable after the fact — which is the question you ask
   * when an agent does something inexplicable, and the one nothing could
   * answer before.
   */
  async recordProjection(
    handoffKey: string,
    memoryIds: string[],
    meta: { from: string | null; to: string; epoch: number; at: number },
  ): Promise<void> {
    // The handoff itself is always recorded, even when nothing was injected —
    // it is the baton's route, and the Handoffs view is drawn from these
    // nodes. Only the PROJECTED_AT edges are conditional.
    await this.graph.open();
    const hv = await this.graph.handoffVid(handoffKey);
    await this.graph.client.upsertNodes(
      LABEL.handoff,
      [
        {
          id: hv,
          hkey: handoffKey,
          from_agent: meta.from ?? "",
          to_agent: meta.to,
          epoch: meta.epoch,
          at: meta.at,
          proj: this.graph.slot,
        },
      ],
      ["hkey", "from_agent", "to_agent", "epoch", "at", "proj"],
    );
    await this.graph.client.relate(LABEL.project, REL.hasHandoff, LABEL.handoff, [
      { src: this.graph.vid, dst: hv, rid: relId(this.graph.vid, hv, REL.hasHandoff) },
    ]);
    const toVid = await this.graph.agentVid(meta.to);
    await this.graph.client.upsertNodes(
      LABEL.agent,
      [{ id: toVid, aid: meta.to, proj: this.graph.slot }],
      ["aid", "proj"],
    );
    await this.graph.client.relate(LABEL.handoff, REL.to, LABEL.agent, [
      { src: hv, dst: toVid, rid: relId(hv, toVid, REL.to) },
    ]);
    if (meta.from) {
      const fromVid = await this.graph.agentVid(meta.from);
      await this.graph.client.upsertNodes(
        LABEL.agent,
        [{ id: fromVid, aid: meta.from, proj: this.graph.slot }],
        ["aid", "proj"],
      );
      await this.graph.client.relate(LABEL.handoff, REL.from, LABEL.agent, [
        { src: hv, dst: fromVid, rid: relId(hv, fromVid, REL.from) },
      ]);
    }
    if (!memoryIds.length) return;
    const rows = [];
    for (const mid of memoryIds) {
      const mv = await this.graph.memoryVid(mid);
      rows.push({ src: mv, dst: hv, rid: relId(mv, hv, REL.projectedAt) });
    }
    await this.graph.client.relate(LABEL.memory, REL.projectedAt, LABEL.handoff, rows);
  }

  /** What was injected into a given handoff. */
  async projectedAt(handoffKey: string): Promise<CausalNode[]> {
    const hv = await this.graph.handoffVid(handoffKey);
    const res = await this.graph.client.query(
      "MATCH (m:MemoryUnit)-[:PROJECTED_AT]->(h:Handoff {id: $hv}) " +
        "RETURN m.mid AS mid, m.kind AS kind, m.text AS text, m.agent AS agent, m.updated AS updated",
      { hv },
    );
    return res.rows.map((r) => ({
      memoryId: String(r.mid ?? ""),
      kind: String(r.kind ?? ""),
      text: String(r.text ?? ""),
      agent: String(r.agent ?? ""),
      at: Number(r.updated ?? 0),
    }));
  }

  /**
   * What this agent itself learned — the memories it asserted.
   *
   * The `ASSERTED` edge is written when a memory is folded, so this is the
   * agent's own contribution to the shared brain as distinct from what it was
   * handed. The difference matters: an agent that has asserted nothing has
   * only ever been told things.
   */
  async assertedBy(agentId: string, limit = 60): Promise<CausalNode[]> {
    const av = await this.graph.agentVid(agentId);
    const res = await this.graph.client.query(
      `MATCH (a:${LABEL.agent} {id: $av})-[:${REL.asserted}]->(m:${LABEL.memory}) ` +
        "RETURN m.mid AS mid, m.kind AS kind, m.text AS text, m.agent AS agent, m.updated AS updated " +
        "ORDER BY updated DESC LIMIT $limit",
      { av, limit: Math.min(200, limit) },
    );
    return res.rows.map((r) => ({
      memoryId: String(r.mid ?? ""),
      kind: String(r.kind ?? ""),
      text: String(r.text ?? ""),
      agent: String(r.agent ?? ""),
      at: Number(r.updated ?? 0),
    }));
  }

  /**
   * Every handoff this project has had, newest first, with how many memories
   * were injected into each.
   *
   * The count is the interesting column: a handoff that carried nothing is a
   * handoff where the receiving agent started cold, and until these edges
   * existed there was no way to tell that apart from one that carried twelve.
   */
  async handoffs(limit = 50): Promise<
    { key: string; from: string; to: string; epoch: number; at: number; injected: number }[]
  > {
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasHandoff}]->(h:${LABEL.handoff}) ` +
        "RETURN h.hkey AS hkey, h.from_agent AS f, h.to_agent AS t, h.epoch AS epoch, h.at AS at " +
        "ORDER BY at DESC LIMIT $limit",
      { pv: this.graph.vid, limit },
    );
    // Scoped through THIS project's handoff edges. Counted by hkey alone, the
    // number leaked across projects: a handoff key is "<epoch>:<from>-><to>",
    // and every project on the node has agents called claude-code and codex, so
    // "2:claude-code->codex" is the same string in all of them. A project with
    // no injections showed somebody else's count.
    const counts = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasHandoff}]->(h:${LABEL.handoff})` +
        `<-[:${REL.projectedAt}]-(m:${LABEL.memory}) ` +
        "RETURN h.hkey AS hkey, count(*) AS n",
      { pv: this.graph.vid },
    );
    const byKey = new Map(counts.rows.map((r) => [String(r.hkey ?? ""), Number(r.n ?? 0)]));
    return res.rows.map((r) => {
      const key = String(r.hkey ?? "");
      return {
        key,
        from: String(r.f ?? ""),
        to: String(r.t ?? ""),
        epoch: Number(r.epoch ?? 0),
        at: Number(r.at ?? 0),
        injected: byKey.get(key) ?? 0,
      };
    });
  }

  /** The baton's actual route, as walked. Backs the Handoffs view. */
  async handoffGraph(): Promise<{ from: string; to: string; count: number }[]> {
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasHandoff}]->(h:${LABEL.handoff}) ` +
        "RETURN h.from_agent AS f, h.to_agent AS t, count(*) AS n",
      { pv: this.graph.vid },
    );
    return res.rows
      .map((r) => ({ from: String(r.f ?? ""), to: String(r.t ?? ""), count: Number(r.n ?? 0) }))
      .filter((e) => e.to);
  }
}

/** Changes when the memory changes, so an edit re-projects and a no-op doesn't. */
function sig(m: Memory): string {
  return `${m.id}:${m.updatedAt}:${m.hash}`;
}
