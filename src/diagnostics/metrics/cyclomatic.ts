/**
 * Cyclomatic complexity per method = `branchPoints + 1`. The branch points
 * are already counted in ClassIndex (if/elsif/unless/while/until/when/
 * rescue, &&, ||, ternary). This module just adds the +1 baseline and
 * keeps the calculation centralized so it's easy to retune later.
 */

import { ClassMethodInfo } from '../../rails/ClassIndex';

export function cyclomaticComplexity(method: ClassMethodInfo): number {
  return method.branchPoints + 1;
}
