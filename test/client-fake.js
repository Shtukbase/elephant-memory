// A fake of the harness's browser side, enough to run the plugin's real bundle
// (lib/client.js) under node: the module loader it registers with, a tiny React
// (elements as plain objects, hooks with state and effects, re-render on a
// state change), and the services the bundle asks `ctx` for. No DOM.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const Fragment = Symbol('Fragment');

/** An element as data. */
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity);
  return { type, props: props ?? {}, children: flat };
}

/** @param {any} node @param {(node: any) => boolean} test @returns {any[]} */
export function findAll(node, test, found = []) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return found;
  if (Array.isArray(node)) { for (const child of node) findAll(child, test, found); return found; }
  if (test(node)) found.push(node);
  for (const child of node.children ?? []) findAll(child, test, found);
  return found;
}

/** The words a tree shows, depth first, joined by single spaces. @param {any} node */
export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ');
  return (node.children ?? []).map(textOf).filter(Boolean).join(' ');
}

/**
 * A component mounted by hand, with the components it draws expanded: hooks keep
 * their state between renders (per place in the tree), effects run after a
 * render whose dependencies changed, and a state change renders the whole tree
 * again. Host elements come back as plain data a test can search.
 * @param {(props: any) => any} Component @param {any} props
 */
export function mount(Component, props) {
  /** @type {Map<string, { slots: any[], effects: { deps?: any[], cleanup?: any }[] }>} */
  const instances = new Map();
  /** @type {(() => void)[]} */ let pending = [];
  let rendering = false;
  let dirty = false;
  let output = null;
  const same = (/** @type {any[] | undefined} */ a, /** @type {any[] | undefined} */ b) => a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

  function hooksFor(/** @type {string} */ key) {
    let inst = instances.get(key);
    if (inst === undefined) { inst = { slots: [], effects: [] }; instances.set(key, inst); }
    const cursor = { hook: 0, effect: 0 };
    return {
      useState(/** @type {any} */ initial) {
        const at = cursor.hook++;
        const held = /** @type {any} */ (inst);
        if (!(at in held.slots)) held.slots[at] = typeof initial === 'function' ? initial() : initial;
        const set = (/** @type {any} */ value) => {
          const next = typeof value === 'function' ? value(held.slots[at]) : value;
          if (Object.is(next, held.slots[at])) return;
          held.slots[at] = next;
          if (rendering) dirty = true; else render();
        };
        return [held.slots[at], set];
      },
      useMemo(/** @type {() => any} */ make, /** @type {any[]} */ deps) {
        const at = cursor.hook++;
        const held = /** @type {any} */ (inst);
        if (!(at in held.slots) || !same(held.slots[at].deps, deps)) held.slots[at] = { deps, value: make() };
        return held.slots[at].value;
      },
      useRef(/** @type {any} */ initial) {
        const at = cursor.hook++;
        const held = /** @type {any} */ (inst);
        if (!(at in held.slots)) held.slots[at] = { current: initial };
        return held.slots[at];
      },
      useEffect(/** @type {() => any} */ run, /** @type {any[]} */ deps) {
        const at = cursor.effect++;
        const held = /** @type {any} */ (inst);
        if (held.effects[at] === undefined || !same(held.effects[at].deps, deps)) pending.push(() => {
          held.effects[at]?.cleanup?.();
          held.effects[at] = { deps, cleanup: run() };
        });
      },
    };
  }

  /** @param {any} node @param {string} path */
  function expand(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}.${i}`));
    if (typeof node.type === 'function' && node.type.fake !== true) {
      const key = `${path}:${node.type.name}`;
      mount.current = hooksFor(key);
      const drawn = node.type({ ...node.props, children: node.children });
      return expand(drawn, `${key}/`);
    }
    const type = typeof node.type === 'function' ? node.type.name : node.type;
    return { ...node, type, children: node.children.map((child, i) => expand(child, `${path}.${i}`)) };
  }

  function render() {
    rendering = true;
    do {
      dirty = false;
      pending = [];
      output = expand(createElement(Component, props), 'root');
      const run = pending;
      pending = [];
      for (const task of run) task();
    } while (dirty);
    rendering = false;
  }
  render();
  return {
    get tree() { return output; },
    rerender(/** @type {any} */ next) { Object.assign(props, next); render(); },
    unmount() { for (const inst of instances.values()) for (const e of inst.effects) e?.cleanup?.(); },
  };
}

/** The fake `react` the bundle resolves: hooks route to the component being mounted. */
export const fakeReact = {
  Fragment,
  createElement,
  useState: (/** @type {any} */ v) => mount.current.useState(v),
  useMemo: (/** @type {any} */ f, /** @type {any} */ d) => mount.current.useMemo(f, d),
  useEffect: (/** @type {any} */ f, /** @type {any} */ d) => mount.current.useEffect(f, d),
  useRef: (/** @type {any} */ v) => mount.current.useRef(v),
  useCallback: (/** @type {any} */ f) => f,
};

/** Let promises and timers settle. */
export const settle = async (rounds = 20) => { for (let k = 0; k < rounds; k++) await new Promise((r) => setImmediate(r)); };

/** The primitives the bundle draws with: named components, so a test can find them. */
export const fakePrimitives = (() => {
  /** @type {Record<string, any>} */
  const made = {};
  return new Proxy(made, {
    get(target, name) {
      if (typeof name !== 'string' || !/^[A-Z]/.test(name)) return undefined;
      if (!(name in target)) {
        const component = () => null;
        Object.defineProperty(component, 'name', { value: name });
        component.fake = true;
        target[name] = component;
      }
      return target[name];
    },
  });
})();

/**
 * Run the real bundle and take what it registered.
 * @param {{ client?: string, console?: { warn(line: string): void } }} [options] the bundle's source (default lib/client.js) and the console it sees
 */
export function loadBundle(options = {}) {
  const source = options.client ?? fs.readFileSync(path.join(PACKAGE, 'lib', 'client.js'), 'utf8');
  /** @type {any} */ let definition;
  const styles = [];
  const document = {
    head: { appendChild: (/** @type {any} */ tag) => styles.push(tag) },
    createElement: () => ({ dataset: {} }),
    querySelector: () => null,
  };
  const prims = fakePrimitives;
  const sandbox = {
    window: { __ModuleLoader__: { load: (/** @type {any} */ d) => { definition = d; } } },
    document,
    console: { log: () => {}, ...options.console, warn: options.console?.warn ?? (() => {}) },
    AbortController,
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  const resolve = (/** @type {string} */ name) => {
    if (name === 'react') return fakeReact;
    if (name === 'react/jsx-runtime') return { jsx: (/** @type {any} */ type, /** @type {any} */ props) => createElement(type, props) };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return prims;
    throw new Error(`the bundle asked for ${name}`);
  };
  const exported = definition.factory(resolve);
  return { definition, exported, styles, primitives: prims };
}

/**
 * A fake client root context. Records every slot registration, tab type,
 * command and opened tab. `services` adds services by name, and a service set
 * to null is one the harness lacks; `inject` runs its callback at once, with this
 * same context, when every service it names stands, as the harness does.
 * @param {{ services?: Record<string, any>, entries?: boolean }} [options]
 */
export function fakeContext({ services = {}, entries = true } = {}) {
  /** @type {{ seat: string, options: any, component: any }[]} */ const registered = [];
  /** @type {any[]} */ const tabTypes = [];
  /** @type {any[]} */ const commands = [];
  /** @type {string[]} */ const opened = [];
  /** @type {Record<string, any>} */
  const all = {
    sidebarRightTabs: { register: (/** @type {any} */ type) => { tabTypes.push(type); return () => {}; } },
    commandUi: { register: (/** @type {any} */ command) => { commands.push(command); return () => {}; } },
    sidebarRight: { openTab: (/** @type {string} */ kind) => { opened.push(kind); } },
    ...services,
  };
  const slots = {
    ...(entries ? { entries: (/** @type {string} */ seat) => registered.filter((r) => r.seat === seat).map((r) => ({ options: r.options, component: r.component })) } : {}),
    inject(/** @type {string} */ _seat, /** @type {any} */ make) {
      const made = make();
      return typeof made?.[Symbol.iterator] === 'function' ? [...made] : made;
    },
    register(/** @type {any} */ options, /** @type {any} */ component) {
      registered.push({ seat: options.name, options, component });
      return () => {};
    },
  };
  /** @type {any} */
  const ctx = {
    slots,
    effect: (/** @type {() => any} */ make) => make(),
    get: (/** @type {string} */ name) => all[name] ?? undefined,
    inject: (/** @type {string[]} */ names, /** @type {(scope: any) => void} */ run) => { if (names.every((n) => all[n] != null)) run(ctx); },
    ...Object.fromEntries(Object.entries(all).filter(([, value]) => value != null)),
    slots,
  };
  return { ctx, registered, tabTypes, commands, opened };
}

/**
 * The pure fragments of the browser half (client/constants.js, words.js,
 * days.js), run alone, and the named functions out of them.
 * @param {string[]} names
 * @returns {Record<string, any>}
 */
export function pureFunctions(names) {
  const code = ['constants.js', 'words.js', 'days.js']
    .map((file) => fs.readFileSync(path.join(PACKAGE, 'client', file), 'utf8'))
    .join('\n')
    .replaceAll('@PACKAGE_NAME@', 'package').replaceAll('@NOTE_PREFIX@', 'Endless memory:');
  const inside = vm.runInNewContext(`${code}\n;({ ${names.join(', ')} })`);
  // Results come back as this realm's own arrays and objects, so deepStrictEqual compares them.
  return Object.fromEntries(Object.entries(inside).map(([name, fn]) => [name, (/** @type {any[]} */ ...args) => {
    const result = /** @type {any} */ (fn)(...args);
    return result !== null && typeof result === 'object' ? JSON.parse(JSON.stringify(result)) : result;
  }]));
}
