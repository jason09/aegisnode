export class Container {
  constructor(parent = null) {
    this.parent = parent;
    this.registry = new Map();
  }

  set(token, value) {
    this.registry.set(token, value);
    return value;
  }

  has(token) {
    return this.registry.has(token) || Boolean(this.parent?.has(token));
  }

  get(token) {
    if (this.registry.has(token)) {
      return this.registry.get(token);
    }

    if (this.parent) {
      return this.parent.get(token);
    }

    throw new Error(`Container token not found: ${token}`);
  }

  getOrNull(token) {
    try {
      return this.get(token);
    } catch {
      return null;
    }
  }

  createChild() {
    return new Container(this);
  }
}

export function createContainer() {
  return new Container();
}
