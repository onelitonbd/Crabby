// The shell's shared facts, in one tiny store: the connection word (W1-04), the pending-approval count (W1-05), the
// current session (its id and title — W1-02), the model badge (W1-03) and the Gateway version (W1-09). Screens set;
// the shell subscribes. It is a pub/sub of primitives, not a framework: D-068 promised custom elements, and a state
// library would be a framework with another name.
let state = {
  connection: "offline",
  lastConfirmed: undefined,
  approvals: 0,
  sessionId: undefined,
  sessionTitle: undefined,
  model: undefined,
  version: undefined,
  vaultUnlocked: true,
};

const subscribers = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of subscribers) fn(state);
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
