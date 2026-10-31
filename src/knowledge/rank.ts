const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

/** Keyword-overlap ranking: dependency-free and predictable; swap the store for embeddings if needed. */
export function rank<T extends { text: string; tags?: string[] }>(notes: T[], query: string, limit: number): T[] {
  const q = words(query);
  return notes
    .map((n, i) => {
      const w = words(`${n.text} ${(n.tags ?? []).join(' ')}`);
      let score = 0;
      for (const t of q) if (w.has(t)) score++;
      return { n, score: score + i / (notes.length * 1000) }; // recency breaks ties
    })
    .filter((x) => x.score >= 1 || !q.size)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.n);
}
