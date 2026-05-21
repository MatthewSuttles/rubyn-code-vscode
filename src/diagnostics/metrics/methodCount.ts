/**
 * Method count signal — counts public methods declared on the class
 * (instance + class methods). Inherited methods are not counted because we
 * only see the file's own `def`s.
 */

import { ClassInfo } from '../../rails/ClassIndex';

export function publicMethodCount(c: ClassInfo): number {
  return c.methods.filter((m) => m.visibility === 'public').length;
}
