/**
 * Union-Find (Disjoint Set Union)
 *
 * Order-independent clustering primitive shared by the fuzzy and semantic
 * dedup stages: if A~B and B~C, all three end up in one cluster regardless
 * of comparison order. Path compression + union by rank.
 *
 * @module memory/dedup/union-find
 */

export function makeUnionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array<number>(n).fill(0);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) { parent[ra] = rb; }
    else if (rank[ra] > rank[rb]) { parent[rb] = ra; }
    else { parent[rb] = ra; rank[ra]++; }
  }

  return { find, union };
}
