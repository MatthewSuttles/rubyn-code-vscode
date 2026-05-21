/**
 * Fan-out signal — count of distinct external class constants the class
 * refers to. Self-references are excluded; stdlib / Ruby-core / common-Rails
 * helpers are stripped via the stop-list.
 *
 * The stop-list is conservative on purpose: it covers types that show up
 * everywhere in normal Ruby code (Array, Hash, String, …) and a handful of
 * AR/Rails internals that aren't meaningful as a fan-out signal. Project-
 * specific noise can be silenced via the `fanOutThreshold` setting until we
 * make this list configurable.
 */

import { ClassInfo } from '../../rails/ClassIndex';

export const DEFAULT_STOP_LIST = new Set<string>([
  // Ruby core
  'Array', 'Hash', 'String', 'Symbol', 'Integer', 'Float', 'Numeric',
  'Range', 'Regexp', 'Proc', 'Lambda', 'NilClass', 'TrueClass', 'FalseClass',
  'Object', 'Kernel', 'BasicObject', 'Comparable', 'Enumerable', 'Module',
  'Class', 'Struct', 'Set', 'Exception', 'StandardError', 'RuntimeError',
  'ArgumentError', 'TypeError', 'NoMethodError', 'NameError',
  'NotImplementedError', 'IOError', 'IO', 'File', 'Dir', 'Pathname',
  'Time', 'Date', 'DateTime', 'Math', 'JSON', 'YAML', 'URI', 'CSV', 'ENV',
  // ActiveSupport / ActiveRecord internals
  'ActiveRecord', 'ActiveSupport', 'ActiveModel', 'ActionController',
  'ActionView', 'ActionMailer', 'ActionDispatch', 'ApplicationRecord',
  'ApplicationController', 'ApplicationMailer', 'ApplicationJob',
  'Rails', 'Logger',
]);

export interface FanOutResult {
  count: number;
  classes: string[];
}

export function fanOut(
  c: ClassInfo,
  stopList: ReadonlySet<string> = DEFAULT_STOP_LIST,
): FanOutResult {
  const seen = new Set<string>();
  const selfNames = collectSelfNames(c.name);
  for (const method of c.methods) {
    for (const ref of method.classRefs) {
      if (selfNames.has(ref)) continue;
      const root = ref.split('::')[0];
      if (selfNames.has(root)) continue;
      if (stopList.has(root)) continue;
      seen.add(ref);
    }
  }
  const sorted = Array.from(seen).sort();
  return { count: sorted.length, classes: sorted };
}

function collectSelfNames(qualified: string): Set<string> {
  const segments = qualified.split('::');
  const out = new Set<string>();
  out.add(qualified);
  if (segments.length > 0) out.add(segments[segments.length - 1]);
  return out;
}
