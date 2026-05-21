/**
 * LCOM4 (Lack of Cohesion of Methods, version 4) via union-find.
 *
 * Treat each method as a node. Add an undirected edge between two methods
 * when they share at least one ivar reference, or one method's body
 * references the other method's name. Count the resulting connected
 * components. The phase-4 contract: a class is cohesive when components
 * == 1; multiple components are a "wants to be split" signal.
 *
 * Class-constant references are intentionally NOT used as edges — they're
 * the fan-out signal, and dropping them keeps LCOM4 focused on intra-class
 * structure.
 */

import { ClassInfo } from '../../rails/ClassIndex';

export interface LcomResult {
  components: number[];
  total: number;
}

export function lcom4(c: ClassInfo): LcomResult {
  const methods = c.methods;
  const n = methods.length;
  if (n === 0) return { components: [], total: 0 };

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const nameToIdx = new Map<string, number>();
  methods.forEach((m, i) => nameToIdx.set(m.name, i));

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (sharesIvar(methods[i].ivarRefs, methods[j].ivarRefs)) {
        union(i, j);
        continue;
      }
      if (methods[i].methodCalls.has(methods[j].name)) {
        union(i, j);
        continue;
      }
      if (methods[j].methodCalls.has(methods[i].name)) {
        union(i, j);
        continue;
      }
    }
  }

  const componentSizes = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    componentSizes.set(root, (componentSizes.get(root) ?? 0) + 1);
  }
  const components = Array.from(componentSizes.values()).sort((a, b) => b - a);
  return { components, total: components.length };
}

function sharesIvar(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (b.has(v)) return true;
  return false;
}
