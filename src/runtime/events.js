import { EventEmitter } from 'events';

export class EventBus {
  constructor() {
    this.emitter = new EventEmitter();
  }

  subscribe(eventName, listener) {
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }

  once(eventName, listener) {
    this.emitter.once(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }

  publish(eventName, payload) {
    this.emitter.emit(eventName, payload);
  }

  removeAll(eventName) {
    if (eventName) {
      this.emitter.removeAllListeners(eventName);
      return;
    }
    this.emitter.removeAllListeners();
  }
}

export function createEventBus() {
  return new EventBus();
}
